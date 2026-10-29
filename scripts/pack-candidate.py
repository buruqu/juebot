"""Create and verify an npm-layout tarball without npm installs, scripts, or network."""
import gzip
import hashlib
import io
import json
import re
import tarfile
import sys
from pathlib import Path

if not __debug__:
    raise SystemExit('Validation requires Python without -O')
root = Path(__file__).resolve().parents[1]
assert len(sys.argv) == 2 and re.fullmatch(r'\d+\.\d+\.\d+-dev\.\d+', sys.argv[1]), 'Explicit candidate version required'
version = sys.argv[1]
candidate = root / 'candidates' / version
bundle = candidate / 'bundle'
for directory in (root / 'candidates', candidate, bundle):
    assert directory.is_dir() and not directory.is_symlink() and not directory.is_junction(), 'Linked candidate forbidden'
assert bundle.resolve() == bundle.absolute()
for entry in bundle.rglob('*'):
    assert not entry.is_symlink() and not entry.is_junction(), 'Linked package content forbidden'
    assert not entry.is_file() or entry.stat().st_nlink == 1, 'Hardlinked package content forbidden'

receipt = json.loads((candidate / 'build-receipt.json').read_text(encoding='utf-8'))
assert receipt['version'] == version
expected_inputs = {p.relative_to(root).as_posix() for p in (root / 'src').rglob('*.ts')} | {'tsconfig.json', f'candidates/{version}/tsconfig.json'}
expected_outputs = {p.relative_to(root).as_posix() for p in (bundle / 'lib').glob('*') if p.suffix in ('.js', '.ts')}
assert {r['file'] for r in receipt['inputs']} == expected_inputs
assert {r['file'] for r in receipt['outputs']} == expected_outputs
for record in receipt['inputs'] + receipt['outputs']:
    assert record['file'] in expected_inputs | expected_outputs
    assert hashlib.sha256((root / record['file']).read_bytes()).hexdigest() == record['sha256'], 'Stale build: ' + record['file']

manifest = json.loads((bundle / 'package.json').read_text(encoding='utf-8'))
assert manifest['name'] == '@local/dsh-juebot'
assert manifest['version'] == version
assert manifest['peerDependencies'] == {'@deepseek-ai/dsh-storage-domain': '0.2.1-rc.3', 'zod': '4.4.3'}
assert f"CONSOLE_VERSION = '{version}'" in (bundle / 'diagnostics.js').read_text(encoding='utf-8')
assert f"PACKAGE_VERSION = '{version}'" in (bundle / 'client.js').read_text(encoding='utf-8')
assert f"Version: {version}" in (bundle / 'NOTICE').read_text(encoding='utf-8')
assert manifest['private'] is True and manifest['type'] == 'module'
assert not manifest.get('dependencies') and not manifest.get('scripts')
assert manifest['engines']['dsh'] == '0.2.1-rc.3'
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', manifest['version'])
expected_patch = "- insert:\n    - id: juebot-console\n      name: '@local/dsh-juebot'\n      config: {}\n    - id: juebot-host\n      name: '@local/dsh-juebot/storage-host'\n      disabled: true\n      config:\n        storagePath: null\n"
assert (bundle / 'cordis.patch.yml').read_text(encoding='utf-8').replace('\r\n', '\n') == expected_patch

selected = {'package.json': bundle / 'package.json'}
for pattern in manifest['files']:
    assert not Path(pattern).is_absolute() and '..' not in Path(pattern).parts
    matched = list(bundle.glob(pattern))
    assert matched, f'No package files match {pattern}'
    for source in matched:
        assert source.is_file() and not source.is_symlink(), source
        actual = source.resolve()
        actual.relative_to(bundle)
        relative = source.relative_to(bundle).as_posix()
        assert not any(part in ('node_modules', 'runtime-data', '.test-tmp') for part in Path(relative).parts)
        assert not re.search(r'\.(?:sqlite|db)(?:-|$)|(?:^|/)\.env|\.log$', relative)
        selected[relative] = actual

for export in manifest['exports'].values():
    assert export.startswith('./') and '..' not in Path(export).parts
    matches = list(bundle.glob(export[2:]))
    assert matches, f'Missing export {export}'
    for source in matches:
        assert source.relative_to(bundle).as_posix() in selected
for name, source in selected.items():
    if not name.endswith('.js'):
        continue
    text = source.read_text(encoding='utf-8')
    for match in re.finditer(r'''(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]''', text):
        if not match.group(1).startswith('.'):
            assert match.group(1).startswith('node:') or match.group(1) in manifest['peerDependencies'], (name, 'Undeclared dependency', match.group(1))
            continue
        target = (source.parent / match.group(1)).resolve()
        assert target.relative_to(bundle).as_posix() in selected, (name, match.group(1))
        assert target.suffix == '.js', (name, 'runtime still imports a source module')

assert set(selected) == {p.relative_to(bundle).as_posix() for p in bundle.rglob('*') if p.is_file()}, 'Unlisted bundle file'
artifacts = candidate / 'artifacts'
artifacts.mkdir(exist_ok=True)
assert artifacts.resolve().parent == candidate.resolve() and not artifacts.is_symlink()
archive = artifacts / f"dsh-juebot-{manifest['version']}.tgz"
inventory = artifacts / 'bundle-manifest.json'
for target in (archive, inventory):
    assert target.parent.resolve() == artifacts.resolve() and not target.is_symlink()
    assert not target.exists() or target.is_file()
    assert not target.exists() or target.stat().st_nlink == 1, 'Hardlinked output forbidden'

payload = io.BytesIO()
with gzip.GzipFile(filename='', fileobj=payload, mode='wb', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for name, source in sorted(selected.items()):
            data = source.read_bytes()
            item = tarfile.TarInfo('package/' + name)
            item.size = len(data)
            item.mode = 0o644
            item.mtime = 0
            item.uid = item.gid = 0
            item.uname = item.gname = ''
            tar.addfile(item, io.BytesIO(data))
archive.write_bytes(payload.getvalue())

records = []
with tarfile.open(archive, mode='r:gz') as tar:
    assert tar.getnames() == ['package/' + name for name in sorted(selected)]
    for member in tar.getmembers():
        assert member.isfile() and not member.issym() and not member.islnk()
        assert not Path(member.name).is_absolute() and '..' not in Path(member.name).parts
        name = member.name.removeprefix('package/')
        packaged = tar.extractfile(member).read()
        assert packaged == selected[name].read_bytes(), f'Archive mismatch: {name}'
        records.append({'file': name, 'bytes': len(packaged), 'sha256': hashlib.sha256(packaged).hexdigest()})
result = {
    'package': manifest['name'], 'version': manifest['version'], 'backendDefaultDisabled': True, 'setupConsoleEnabled': True, 'businessDatabaseOpened': False, 'installed': False,
    'archive': archive.relative_to(root).as_posix(), 'archiveBytes': archive.stat().st_size,
    'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'fileCount': len(records),
    'files': records, 'checked': ['source/emission build receipt', 'manifest/version/peers', 'exact disabled patch', 'export targets', 'static/dynamic JS imports', 'complete allowlist', 'archive paths and byte equality'],
    'notVerified': ['real DSH mount/unmount', 'authenticated Host HTTP', 'native UI rendering', 'QQ/Bilibili/model connectivity', 'real SDK storage durability'],
}
inventory.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'files'}, ensure_ascii=False, indent=2))
