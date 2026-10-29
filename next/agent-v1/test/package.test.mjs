import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, linkSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const candidate = path.join(root, 'candidates/0.3.0-dev.7');
const bundle = path.join(candidate, 'bundle');
const python = 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const builder = path.join(root, 'tools/build_agent_candidate.py');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(path.join(bundle, name), 'utf8');
const pythonCheck = source => {
  const execution = spawnSync(python, ['-I', '-B', '-c', source, builder], { encoding: 'utf8', cwd: root, timeout: 30000 });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
};

// Real generated payload; VM only mocks native UI registration, never rendering or real Host auth.
test('single native loader retains both panels and independent locale namespaces', () => {
  const definitions = [], slots = [], locales = [];
  vm.runInNewContext(read('client.js'), { window: { __ModuleLoader__: { load: descriptor => definitions.push(descriptor) } } }, { timeout: 1000 });
  assert.equal(definitions.length, 1);
  const client = definitions[0].factory(name => { assert.equal(name, 'react'); return { createElement() {} }; });
  client.apply({ effect: setup => setup(), layout: { selectPanel() {} },
    locale: { register(namespace) { locales.push(namespace); return () => {}; }, bind: () => key => key },
    slots: { inject: (_name, setup) => setup(), register: config => { slots.push(config); return () => {}; } } });
  for (const name of ['main', 'sidebar.panellist']) assert.deepEqual(slots.filter(s => s.name === name).map(s => s.key ?? s.id).sort(), ['juebot', 'juebot-setup']);
  assert.deepEqual(locales.sort(), ['juebot', 'juebot-agent']);
});

test('default candidate Host is inert and registers no business storage initialization', async () => {
  const entry = await import(pathToFileURL(path.join(bundle, 'agent/host/entry.js')));
  const routes = [], releases = [];
  const dispose = await entry.apply({ effect(setup) { releases.push(setup()); }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } });
  assert.ok(routes.length > 0);
  const route = routes.find(route => route.path.endsWith('/status'));
  const response = await route.fetch(new Request('http://synthetic.invalid/api/juebot/agent/status'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AGENT_NOT_ENABLED');
  if (typeof dispose === 'function') await dispose();
  for (const release of releases) if (typeof release === 'function') await release();
});

test('package versions, default disabled patch and complete payload hashes match receipt', () => {
  const manifest = JSON.parse(read('package.json'));
  const receipt = JSON.parse(readFileSync(path.join(candidate, 'build-receipt.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.0-dev.7');
  assert.equal(receipt.version, manifest.version);
  assert.equal(manifest.exports['./agent-host'], './agent/host/entry.js');
  assert.equal(manifest.exports['./qq-official-code-channel'], './agent/host/qq-official-code-channel.js');
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.match(read('cordis.patch.yml'), /id: juebot-agent\n[\s\S]*disabled: true\n[\s\S]*enabled: false\n[\s\S]*initializeEmpty: false\n[\s\S]*dataRoot: null/);
  assert.equal(receipt.installed, false);
  for (const file of receipt.files) assert.equal(hash(readFileSync(path.join(bundle, file.file))), file.sha256, file.file);
  assert.equal(hash(readFileSync(path.join(candidate, receipt.archive))), receipt.archiveSha256);
});

test('packaged Code channel is an inert library with explicit native service scope', async () => {
  const channel = await import(pathToFileURL(path.join(bundle, 'agent/host/qq-official-code-channel.js')));
  assert.deepEqual(channel.inject, ['agents', 'sandboxPolicy']);
  assert.equal(typeof channel.createQQOfficialCodeChannel, 'function');
  assert.equal(channel.apply, undefined);
});

test('builder verifies full archive, imports, source receipt and protected baselines without deployment', () => {
  const result = spawnSync(python, ['-I', '-B', builder, '--verify-only'], { encoding: 'utf8', cwd: root, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"verified": true/);
});

test('strict source transform rejects changed or duplicate old panel declaration', () => {
  pythonCheck(`import runpy,sys\nm=runpy.run_path(sys.argv[1])\nold="window.__ModuleLoader__.load({const PANEL_ID = 'juebot'; const PACKAGE_VERSION = '0.2.0-dev.1';});"\nnew="window.__ModuleLoader__.load({});"\nfor changed in [old.replace("const PANEL_ID = 'juebot';", "const PANEL_ID = 'other';"),old+"const PANEL_ID = 'juebot';"]:\n try: m['merge_client'](changed,new)\n except RuntimeError: pass\n else: raise AssertionError('shape drift accepted')\n`);
});

test('package guard rejects actual hardlink and path escape on synthetic files', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'juebot-package-'));
  try {
    const first = path.join(directory, 'first');
    writeFileSync(first, 'synthetic');
    linkSync(first, path.join(directory, 'linked'));
    const source = `import runpy,sys\nfrom pathlib import Path\nm=runpy.run_path(sys.argv[1])\nbase=Path(${JSON.stringify(directory)})\nfor target in [base/'first',base.parent/'outside',base/'..'/'outside']:\n try: m['guard'](target,base)\n except RuntimeError: pass\n else: raise AssertionError('unsafe path accepted')\n`;
    pythonCheck(source);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('package guard rejects a real directory junction and descendant traversal', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'juebot-package-'));
  try {
    const target = path.join(directory, 'target');
    mkdirSync(target);
    writeFileSync(path.join(target, 'synthetic.js'), 'synthetic');
    symlinkSync(target, path.join(directory, 'junction'), 'junction');
    pythonCheck(`import runpy,sys\nfrom pathlib import Path\nm=runpy.run_path(sys.argv[1]);base=Path(${JSON.stringify(directory)})\nfor target in [base/'junction',base/'junction'/'synthetic.js']:\n try:m['guard'](target,base)\n except RuntimeError:pass\n else:raise AssertionError('junction accepted')\n`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('archive verifier rejects tampered synthetic member bytes', () => {
  pythonCheck(`import runpy,sys,tempfile,tarfile,io\nfrom pathlib import Path\nm=runpy.run_path(sys.argv[1])\nwith tempfile.TemporaryDirectory(prefix='juebot-package-') as temporary:\n base=Path(temporary); bundle=base/'bundle';bundle.mkdir();(bundle/'x.js').write_text('good')\n m['records'].__globals__['ROOT']=base\n # guard has a fixed default boundary, so use an explicit synthetic-only wrapper.\n original=m['guard'];m['records'].__globals__['guard']=lambda p:original(p,base)\n archive=base/'test.tgz'\n with tarfile.open(archive,'w:gz') as tar:\n  info=tarfile.TarInfo('package/x.js');info.size=4;tar.addfile(info,io.BytesIO(b'evil'))\n try:m['check_archive'](archive,bundle)\n except RuntimeError:pass\n else:raise AssertionError('tampered member accepted')\n`);
});
