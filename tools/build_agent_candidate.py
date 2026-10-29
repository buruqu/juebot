#!/usr/bin/env python3
"""Build an inert, independent candidate. Never install or call npm/build scripts."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile

VERSION = '0.3.0-dev.6'
OLD_VERSION = '0.2.0-dev.1'
ROOT = Path(__file__).absolute().parents[1]
NODE = Path(r'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
TSC = Path(r'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\node_modules\typescript\lib\_tsc.js')
PEERS = {'@deepseek-ai/dsh-storage-domain': '0.2.1-rc.3', '@deepseek-ai/dsh-llm': '0.2.1-rc.3', 'zod': '4.4.3'}
OLD_PATCH = "- insert:\n    - id: juebot-console\n      name: '@local/dsh-juebot'\n      config: {}\n    - id: juebot-host\n      name: '@local/dsh-juebot/storage-host'\n      disabled: true\n      config:\n        storagePath: null\n"
PATCH = OLD_PATCH + "    - id: juebot-agent\n      name: '@local/dsh-juebot/agent-host'\n      disabled: true\n      config:\n        enabled: false\n        initializeEmpty: false\n        dataRoot: null\n        namespace: juebot-agent\n        localChat: false\n        dshModel:\n          enabled: false\n"
ENTRY = "export { inject, apply } from './dsh-entry.js';\n"
VM_CHECK = r'''
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(process.argv[1],'utf8'),definitions=[],registrations=[],locales=[];
vm.runInNewContext(source,{window:{__ModuleLoader__:{load:d=>definitions.push(d)}}},{timeout:1000});
assert.equal(definitions.length,1,'one native loader registration');
assert.equal(definitions[0].id,'@local/dsh-juebot');
const module=definitions[0].factory(name=>{assert.equal(name,'react');return {createElement(){return {};}};});
assert.deepEqual(Array.from(module.inject).sort(),['layout','locale','slots']);
module.apply({effect:fn=>fn(),locale:{register:(ns)=>{locales.push(ns);return ()=>{};},bind:()=>key=>key},
 layout:{selectPanel(){}},slots:{inject:(_slot,fn)=>fn(),register:(slot)=>{registrations.push(slot);return ()=>{};}}});
for(const name of ['main','sidebar.panellist'])assert.deepEqual(registrations.filter(s=>s.name===name).map(s=>s.key??s.id).sort(),['juebot','juebot-setup']);
assert.deepEqual(locales.sort(),['juebot','juebot-agent']);
console.log('one loader; both native panels registered (VM, no real Host/render)');
'''

def need(ok, message):
    if not ok:
        raise RuntimeError(message)

def guard(path: Path, boundary: Path = ROOT):
    """Reject links/reparse points/hardlinks, including each existing ancestor."""
    path = path.absolute()
    boundary = boundary.absolute()
    need('..' not in path.parts and path.is_relative_to(boundary), 'Path outside permitted build boundary')
    current = path
    while True:
        if current.exists() or current.is_symlink():
            info = current.lstat()
            need(not stat.S_ISLNK(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400), 'Linked/reparse path forbidden')
            if stat.S_ISREG(info.st_mode):
                need(info.st_nlink == 1, 'Hardlinked file forbidden')
            else:
                need(stat.S_ISDIR(info.st_mode), 'Special file forbidden')
        if current.parent == current:
            break
        current = current.parent
    return path

def digest(data):
    return hashlib.sha256(data).hexdigest()

def records(directory: Path):
    guard(directory)
    need(directory.is_dir(), 'Missing protected/input directory: ' + str(directory))
    result = []
    for path in sorted(directory.rglob('*')):
        guard(path)
        if path.is_file():
            data = path.read_bytes()
            result.append({'file': path.relative_to(directory).as_posix(), 'bytes': len(data), 'sha256': digest(data)})
    return result

def write(path: Path, data: bytes):
    guard(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    guard(path.parent)
    # Atomic replace avoids truncating an existing candidate on interrupted writes.
    temporary = path.with_name(path.name + '.agent-build-tmp')
    guard(temporary)
    with temporary.open('xb') as stream:
        stream.write(data)
    os.replace(temporary, path)

def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')

def once(source, old, new):
    need(source.count(old) == 1, 'Client/source shape drift: expected exactly one ' + old)
    return source.replace(old, new)

def merge_client(old, new):
    old = once(old, "const PANEL_ID = 'juebot';", "const PANEL_ID = 'juebot-setup';")
    old = once(old, "const PACKAGE_VERSION = '" + OLD_VERSION + "';", "const PACKAGE_VERSION = '" + VERSION + "';")
    old = once(old, 'window.__ModuleLoader__.load({', 'capture({')
    new = once(new, 'window.__ModuleLoader__.load({', 'capture({')
    return "(function () {\nconst definitions = [];\nconst capture = definition => definitions.push(definition);\n" + old + '\n' + new + "\nif (definitions.length !== 2 || definitions.some(d => d.id !== '@local/dsh-juebot')) throw new Error('JUEBOT_CLIENT_SHAPE');\nwindow.__ModuleLoader__.load({ id: '@local/dsh-juebot', factory(require) {\n const parts = definitions.map(d => d.factory(require));\n return { inject: [...new Set(parts.flatMap(p => p.inject))], apply(ctx) { for (const part of parts) part.apply(ctx); } };\n} });\n})();\n"

def inputs():
    paths = [Path(__file__), ROOT / 'tsconfig.json']
    for name in ['agent-v1', 'conversation-v1', 'social-v1']:
        base = ROOT / 'next' / name
        paths.extend(base.glob('tsconfig*.json'))
        paths.extend((base / 'src').rglob('*.ts'))
    paths.extend((ROOT / 'next/agent-v1/host').glob('*.js'))
    paths.extend((ROOT / ('candidates/' + OLD_VERSION + '/bundle')).rglob('*'))
    result = []
    for path in sorted(set(paths)):
        guard(path)
        if path.is_file():
            data = path.read_bytes()
            result.append({'file': path.relative_to(ROOT).as_posix(), 'bytes': len(data), 'sha256': digest(data)})
    return result

def validate_manifest(bundle):
    guard(bundle)
    manifest = json.loads((bundle / 'package.json').read_text(encoding='utf-8'))
    need(manifest['name'] == '@local/dsh-juebot' and manifest['version'] == VERSION, 'Manifest version mismatch')
    need(manifest['private'] is True and manifest['type'] == 'module', 'Unexpected package mode')
    need(manifest['peerDependencies'] == PEERS and not manifest.get('dependencies') and not manifest.get('scripts'), 'Unexpected dependency/script')
    need(manifest['engines'] == {'dsh': '0.2.1-rc.3', 'node': '>=22.18.0'}, 'Engine mismatch')
    need(manifest['dsh']['bundle']['patch'] == './cordis.patch.yml', 'Patch reference mismatch')
    need((bundle / 'cordis.patch.yml').read_text(encoding='utf-8') == PATCH, 'Candidate activation defaults changed')
    for file, marker in [('client.js', "PACKAGE_VERSION = '" + VERSION + "'"), ('diagnostics.js', "CONSOLE_VERSION = '" + VERSION + "'"), ('NOTICE', 'Version: ' + VERSION)]:
        need(marker in (bundle / file).read_text(encoding='utf-8'), 'Version marker mismatch')
    selected = {'package.json'}
    for pattern in manifest['files']:
        need(not Path(pattern).is_absolute() and '..' not in Path(pattern).parts, 'Unsafe files pattern')
        matches = list(bundle.glob(pattern))
        need(bool(matches), 'Empty package pattern: ' + pattern)
        for path in matches:
            guard(path)
            need(path.is_file(), 'Non-file package selection')
            selected.add(path.relative_to(bundle).as_posix())
    actual = {record['file'] for record in records(bundle)}
    need(selected == actual, 'Package allowlist does not equal complete payload')
    for export in manifest['exports'].values():
        need(export.startswith('./') and '..' not in Path(export).parts, 'Unsafe export')
        matches = list(bundle.glob(export[2:]))
        need(bool(matches) and all(p.relative_to(bundle).as_posix() in selected for p in matches), 'Unpackaged export')
    for name in sorted(selected):
        need(not re.search(r'(^|/)(node_modules|runtime-data|\.env)(/|$)|\.(sqlite|db|log)(-|$)', name), 'Forbidden data in package')
        if not name.endswith('.js'):
            continue
        source = (bundle / name).read_text(encoding='utf-8')
        for specifier in re.findall(r'''(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]''', source):
            if specifier.startswith('.'):
                target = ((bundle / name).parent / specifier).resolve()
                need(target.is_relative_to(bundle.resolve()) and target.relative_to(bundle.resolve()).as_posix() in selected and target.suffix == '.js', 'Missing/unsafe runtime import: ' + name + ' ' + specifier)
            else:
                need(specifier.startswith('node:') or specifier in PEERS, 'Undeclared runtime import: ' + specifier)
    return manifest

def vm_check(node, client):
    subprocess.run([str(node), '--input-type=module', '-e', VM_CHECK, str(client)], check=True, cwd=ROOT, timeout=20)

def archive_bytes(bundle):
    payload = io.BytesIO()
    with gzip.GzipFile(filename='', fileobj=payload, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for record in records(bundle):
                data = (bundle / record['file']).read_bytes()
                info = tarfile.TarInfo('package/' + record['file'])
                info.size, info.mode, info.mtime = len(data), 0o644, 0
                archive.addfile(info, io.BytesIO(data))
    return payload.getvalue()

def check_archive(archive, bundle):
    with tarfile.open(archive, 'r:gz') as stream:
        expected = records(bundle)
        need(stream.getnames() == ['package/' + item['file'] for item in expected], 'Archive members mismatch')
        for member, record in zip(stream.getmembers(), expected):
            need(member.isfile() and not member.issym() and not member.islnk(), 'Unsafe archive member')
            need(stream.extractfile(member).read() == (bundle / record['file']).read_bytes(), 'Archive bytes mismatch')

def build(node, tsc, candidate):
    source_inputs = inputs()
    lib = ROOT / 'next/agent-v1/lib'
    guard(lib)
    # Clean only prior compiler output under this explicit next/ tree. Reject unexpected files.
    if lib.exists():
        for item in sorted(lib.rglob('*'), reverse=True):
            guard(item)
            if item.is_file():
                need(item.suffix in ('.js', '.ts'), 'Unexpected compiler output file')
                item.unlink()
            else:
                item.rmdir()
    config = ROOT / 'next/agent-v1/tsconfig.build.json'
    subprocess.run([str(node), str(tsc), '-p', str(config), '--outDir', str(lib), '--rootDir', str(ROOT / 'next'), '--noEmit', 'false', '--noEmitOnError', 'true', '--incremental', 'false', '--declaration', 'true', '--rewriteRelativeImportExtensions', 'true'], cwd=ROOT, check=True, timeout=120)
    need(source_inputs == inputs(), 'Sources changed during build; rerun after edits finish')
    old = ROOT / ('candidates/' + OLD_VERSION + '/bundle')
    need((old / 'cordis.patch.yml').read_text(encoding='utf-8') == OLD_PATCH, 'Old patch shape drift')
    files = {item['file']: (old / item['file']).read_bytes() for item in records(old)}
    manifest = json.loads(files['package.json'])
    manifest['version'] = VERSION
    manifest['peerDependencies'] = PEERS
    manifest['description'] = 'Independent agent candidate with retained setup console; agent and storage backends disabled by default; trusted Host ports require configuration.'
    manifest['exports']['./agent-host'] = './agent/host/entry.js'
    manifest['exports']['./qq-official-code-channel'] = './agent/host/qq-official-code-channel.js'
    manifest['files'] += ['agent/host/*.js', 'agent/lib/**/*.js', 'agent/lib/**/*.d.ts']
    files['package.json'] = json_bytes(manifest)
    files['cordis.patch.yml'] = PATCH.encode()
    files['client.js'] = merge_client(files['client.js'].decode('utf-8'), (ROOT / 'next/agent-v1/host/client.js').read_text(encoding='utf-8')).encode('utf-8')
    for name, marker in [('diagnostics.js', "CONSOLE_VERSION = '"), ('NOTICE', 'Version: ')]:
        files[name] = once(files[name].decode('utf-8'), marker + OLD_VERSION, marker + VERSION).encode('utf-8')
    for item in records(lib):
        files['agent/lib/' + item['file']] = (lib / item['file']).read_bytes()
    for path in sorted((ROOT / 'next/agent-v1/host').glob('*.js')):
        guard(path)
        if path.name != 'client.js':
            files['agent/host/' + path.name] = path.read_bytes()
    files['agent/host/entry.js'] = ENTRY.encode()
    bundle = candidate / 'bundle'
    if bundle.exists():
        receipt_path = candidate / 'build-receipt.json'
        need(receipt_path.is_file(), 'Existing candidate has no managed build receipt')
        previous = json.loads(receipt_path.read_text(encoding='utf-8'))
        need(previous.get('builder') == 'build_agent_candidate.py' and previous.get('version') == VERSION, 'Unowned candidate output')
        previous_files = {item['file'] for item in previous['files']}
        actual = {item['file'] for item in records(bundle)}
        need(actual <= previous_files, 'Unmanaged candidate file; refusing replacement')
        for name in actual - set(files):
            guard(bundle / name).unlink()
    for name, data in sorted(files.items()):
        write(bundle / name, data)
    validate_manifest(bundle)
    # Check every JS syntax in its package's actual ESM scope, without importing it.
    for item in records(bundle):
        if item['file'].endswith('.js'):
            subprocess.run([str(node), '--check', str(bundle / item['file'])], check=True, cwd=ROOT, timeout=20, capture_output=True)
    need(source_inputs == inputs(), 'Sources changed during packaging; rerun')
    return source_inputs

def run(args):
    node, tsc = Path(args.node).absolute(), Path(args.tsc).absolute()
    need(node.is_file() and tsc.is_file(), 'Explicit Node/TypeScript executable missing')
    candidate = guard(ROOT / ('candidates/' + VERSION))
    protected_paths = [ROOT / 'bundle', ROOT / ('candidates/' + OLD_VERSION), ROOT / 'candidates/0.3.0-dev.1', ROOT / 'candidates/0.3.0-dev.2', ROOT / 'candidates/0.3.0-dev.3', ROOT / 'candidates/0.3.0-dev.4', ROOT / 'candidates/0.3.0-dev.5']
    protected = {p.relative_to(ROOT).as_posix(): records(p) for p in protected_paths}
    try:
        if args.verify_only:
            guard(candidate / 'build-receipt.json')
            receipt = json.loads((candidate / 'build-receipt.json').read_text(encoding='utf-8'))
            need(receipt['builder'] == 'build_agent_candidate.py' and receipt['version'] == VERSION and receipt['inputs'] == inputs(), 'Stale build inputs; rebuild candidate')
            need(receipt['files'] == records(candidate / 'bundle'), 'Payload changed since build')
            need(receipt['protected'] == protected, 'Protected baseline changed since build')
            guard(candidate / 'artifacts/bundle-manifest.json')
            need(json.loads((candidate / 'artifacts/bundle-manifest.json').read_text(encoding='utf-8')) == receipt, 'Inventory receipt mismatch')
        else:
            source_inputs = build(node, tsc, candidate)
            archive = candidate / ('artifacts/dsh-juebot-' + VERSION + '.tgz')
            write(archive, archive_bytes(candidate / 'bundle'))
            receipt = {'builder': 'build_agent_candidate.py', 'version': VERSION, 'installed': False,
                'agentDefaultDisabled': True, 'initializeEmpty': False, 'businessDatabaseOpened': False,
                'inputs': source_inputs, 'files': records(candidate / 'bundle'), 'protected': protected,
                'archive': archive.relative_to(candidate).as_posix(), 'archiveSha256': digest(archive.read_bytes()),
                'notVerified': ['real DSH lifecycle/authentication', 'native browser rendering', 'QQ/Bilibili/model ports or account connectivity']}
            write(candidate / 'build-receipt.json', json_bytes(receipt))
            write(candidate / 'artifacts/bundle-manifest.json', json_bytes(receipt))
            write(candidate / 'README.md', ('# ' + VERSION + ' independent candidate\n\nNot installed. Retains the complete 0.2 setup/storage payload; only the setup console is active in the patch. New agent and legacy storage hosts default disabled. No database initialization by default.\n\nOne native client loader registers agent panel `juebot` and legacy setup panel `juebot-setup`. Agent Host entry binds the application factory, but real connector, model, permissions and account ports remain explicitly unconfigured.\n\nRebuild with `tools/build_agent_candidate.py`; inspect `build-receipt.json` and `artifacts/bundle-manifest.json` for exact inputs, payload hashes and protected baselines. No installation or deployment command is invoked. VM panel verification is not real DSH/browser acceptance.\n').encode())
        bundle = candidate / 'bundle'
        validate_manifest(bundle)
        vm_check(node, bundle / 'client.js')
        need(receipt['archive'] == 'artifacts/dsh-juebot-' + VERSION + '.tgz', 'Unexpected archive path')
        archive = guard(candidate / receipt['archive'])
        need(digest(archive.read_bytes()) == receipt['archiveSha256'], 'Archive SHA mismatch')
        check_archive(archive, bundle)
        print(json.dumps({'version': VERSION, 'files': len(receipt['files']), 'archiveSha256': receipt['archiveSha256'], 'installed': False, 'verified': True}))
    finally:
        for path in protected_paths:
            need(records(path) == protected[path.relative_to(ROOT).as_posix()], 'PROTECTED DIRECTORY CHANGED: ' + str(path))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', default=str(NODE))
    parser.add_argument('--tsc', default=str(TSC))
    parser.add_argument('--verify-only', action='store_true')
    run(parser.parse_args())
