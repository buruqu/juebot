import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.JUEBOT_TEST_PYTHON ?? 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const version = '0.2.0-dev.1';
const relative = `candidates/${version}`;

test('candidate archive validates exact contents and rejects stale or unsafe inputs before writing', async t => {
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  const fixture = await fs.mkdtemp(path.join(root, 'work', 'package-test-'));
  t.after(async () => {
    assert.equal(path.dirname(fixture), path.join(root, 'work'));
    await fs.rm(fixture, { recursive: true, force: true });
  });
  for (const name of ['src', 'tsconfig.json', 'scripts/build-candidate.mjs', 'scripts/pack-candidate.py', `${relative}/bundle`, `${relative}/tsconfig.json`, `${relative}/build-receipt.json`]) {
    await fs.mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
    await fs.cp(path.join(root, name), path.join(fixture, name), { recursive: true });
  }
  const run = (args = [version]) => {
    const result = spawnSync(python, ['-I', '-B', path.join(fixture, 'scripts/pack-candidate.py'), ...args], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const archive = path.join(fixture, relative, 'artifacts', `dsh-juebot-${version}.tgz`);
  const good = await fs.readFile(archive);
  assert.equal(run().status, 0);
  assert.deepEqual(await fs.readFile(archive), good, 'packaging is reproducible');
  const bad = async (name, mutate, expected) => {
    const file = path.join(fixture, name);
    const before = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, mutate(before));
    const failed = run();
    assert.notEqual(failed.status, 0, name);
    if (expected) assert.match(failed.stderr, expected);
    assert.deepEqual(await fs.readFile(archive), good, 'failure preserves existing candidate archive');
    await fs.writeFile(file, before);
  };
  await bad('src/control.ts', text => text + '\n// stale source mutation\n', /Stale build/);
  await bad(`${relative}/bundle/lib/control.js`, text => text + '\n// stale output mutation\n', /Stale build/);
  await bad(`${relative}/bundle/package.json`, text => text.replace('0.2.0-dev.1', '0.1.0-dev.2'));
  await bad(`${relative}/bundle/package.json`, text => text.replace('"zod": "4.4.3"', '"zod": "4.0.0"'));
  await bad(`${relative}/bundle/package.json`, text => text.replace('"settings-http.js",', ''), /AssertionError/);
  await bad(`${relative}/bundle/settings-http.js`, text => text + '\nimport("./missing.js");\n', /AssertionError/);
  await bad(`${relative}/bundle/settings-http.js`, text => text + '\nimport("unexpected-sdk");\n', /Undeclared dependency/);
  const secret = path.join(fixture, relative, 'bundle', '.env');
  await fs.writeFile(secret, 'SYNTHETIC_TEST_ONLY=not-a-secret');
  assert.notEqual(run().status, 0, 'unlisted private files must block packaging');
  await fs.unlink(secret);
  for (const args of [[], ['../../bundle'], ['0.2.0-dev.1', 'extra']]) assert.notEqual(run(args).status, 0);
  assert.equal(run().status, 0, 'restored fixture passes');
  const sentinel = path.join(fixture, 'synthetic-live-file');
  for (const target of [archive, path.join(fixture, relative, 'artifacts/bundle-manifest.json')]) {
    const saved = await fs.readFile(target);
    await fs.writeFile(sentinel, saved);
    await fs.unlink(target); await fs.link(sentinel, target);
    const rejected = run();
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Hardlinked output/);
    assert.deepEqual(await fs.readFile(sentinel), saved);
    await fs.unlink(target); await fs.writeFile(target, saved); await fs.unlink(sentinel);
  }
  const compiler = process.env.JUEBOT_TSC_PATH ?? 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\openclaw\\node_modules\\typescript\\lib\\_tsc.js';
  const build = () => spawnSync(process.execPath, [path.join(fixture, 'scripts/build-candidate.mjs'), version, compiler], { encoding: 'utf8' });
  const configPath = path.join(fixture, relative, 'tsconfig.json');
  const originalConfig = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, originalConfig.replace('"noEmit": false', '"noEmit": true'));
  result = build(); assert.notEqual(result.status, 0); assert.match(result.stderr, /UNSAFE_CANDIDATE_TSC_CONFIG/);
  await fs.writeFile(configPath, originalConfig);
  for (const target of [path.join(fixture, relative, 'build-receipt.json'), path.join(fixture, relative, 'bundle/lib/control.js')]) {
    const saved = await fs.readFile(target);
    await fs.writeFile(sentinel, saved); await fs.unlink(target); await fs.link(sentinel, target);
    result = build(); assert.notEqual(result.status, 0); assert.match(result.stderr, /CANDIDATE_LINK_FORBIDDEN/);
    assert.deepEqual(await fs.readFile(sentinel), saved);
    await fs.unlink(target); await fs.writeFile(target, saved); await fs.unlink(sentinel);
  }
});

test('legacy build and pack commands fail closed and require explicit candidate selection', () => {
  for (const [executable, args] of [
    [process.execPath, ['scripts/build.mjs']],
    [python, ['-I', '-B', 'scripts/pack-bundle.py']],
    [process.execPath, ['scripts/build-candidate.mjs']],
    [process.execPath, ['scripts/build-candidate.mjs', '../../bundle', process.execPath]],
  ]) {
    const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LIVE_BUILD_DISABLED|LIVE_PACK_DISABLED|Usage:/);
  }
});
