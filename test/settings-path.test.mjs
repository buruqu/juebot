import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, lstat, readdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSettingsPath } from '../candidates/0.2.0-dev.1/bundle/settings-path.js';
import { createControlService, initialControl } from '../candidates/0.2.0-dev.1/bundle/lib/control.js';

const code = expected => error => error?.code === expected;
// Real filesystem metadata tests on disposable synthetic files. Never import a
// SQL driver or open a database; the .sqlite files contain synthetic plain text.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'juebot-settings-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('preview of missing file is metadata-only and never creates a file', async t => {
  const root = await fixture(t); const target = path.join(root, 'new.sqlite');
  const before = await readdir(root);
  const first = await inspectSettingsPath(target);
  assert.equal(first.exists, false); assert.equal(first.canonicalPath, target);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readdir(root), before);
  assert.deepEqual(await inspectSettingsPath(target), first);
});
test('existing synthetic file metadata is stable and content is untouched', async t => {
  const root = await fixture(t); const target = path.join(root, 'file.sqlite');
  await writeFile(target, 'not a database');
  const before = await lstat(target);
  const first = await inspectSettingsPath(target);
  assert.equal(first.exists, true); assert.deepEqual(await inspectSettingsPath(target), first);
  const after = await lstat(target);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
});
test('package paths and excluded profile paths are forbidden even when leaf is absent', async t => {
  const root = await fixture(t);
  const packageFile = fileURLToPath(new URL('../candidates/0.2.0-dev.1/bundle/not-created.sqlite', import.meta.url));
  await assert.rejects(inspectSettingsPath(packageFile), code('DATA_PATH_FORBIDDEN'));
  await assert.rejects(inspectSettingsPath(path.join(root, 'private.sqlite'), undefined, { excludedRoots: [root] }), code('DATA_PATH_FORBIDDEN'));
});
for (const folder of ['node_modules', '.git', '.install-backup']) {
  test(`restricted directory ${folder} is forbidden`, async t => {
    const root = await fixture(t); const directory = path.join(root, folder); await mkdir(directory);
    await assert.rejects(inspectSettingsPath(path.join(directory, 'file.sqlite')), code('DATA_PATH_FORBIDDEN'));
  });
}
test('directory leaf and hardlinked file are rejected', async t => {
  const root = await fixture(t); const directory = path.join(root, 'dir.sqlite'); await mkdir(directory);
  await assert.rejects(inspectSettingsPath(directory), code('DATA_PATH_NOT_REGULAR'));
  const target = path.join(root, 'target.sqlite'); await writeFile(target, 'synthetic');
  const alias = path.join(root, 'hardlink.sqlite'); await link(target, alias);
  await assert.rejects(inspectSettingsPath(alias), code('DATA_PATH_NOT_REGULAR'));
  await assert.rejects(inspectSettingsPath(target), code('DATA_PATH_NOT_REGULAR'));
});
test('directory junction/symlink ancestors are rejected', async t => {
  const root = await fixture(t); const directory = path.join(root, 'real'); await mkdir(directory);
  const alias = path.join(root, 'alias');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectSettingsPath(path.join(alias, 'file.sqlite')), code('DATA_PATH_NOT_REGULAR'));
});
test('leaf symbolic link is rejected when OS permits creation', async t => {
  const root = await fixture(t); const target = path.join(root, 'real.sqlite'); await writeFile(target, 'synthetic');
  const alias = path.join(root, 'alias.sqlite');
  try { await symlink(target, alias, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows denies file symlink creation without privilege; junction and hardlink cases still execute'); return; }
    throw error;
  }
  await assert.rejects(inspectSettingsPath(alias), code('DATA_PATH_NOT_REGULAR'));
});
for (const target of ['relative.sqlite', 'file.txt', '\\\\server\\share\\file.sqlite', '//server/share/file.sqlite']) {
  test(`reject invalid or remote path ${target}`, async () => {
    await assert.rejects(inspectSettingsPath(target), code('INVALID_DATA_PATH'));
  });
}
test('abort rejects without creating a target', async t => {
  const root = await fixture(t); const abort = new AbortController(); abort.abort();
  await assert.rejects(inspectSettingsPath(path.join(root, 'new.sqlite'), abort.signal), { name: 'AbortError' });
  assert.deepEqual(await readdir(root), []);
});
test('confirmation rejects real file creation, replacement, or changed metadata since preview', async t => {
  const root = await fixture(t);
  for (const fault of ['create', 'replace', 'modify']) {
    const target = path.join(root, `${fault}.sqlite`);
    if (fault !== 'create') await writeFile(target, 'synthetic');
    let state = initialControl('a'.repeat(64)); let writes = 0;
    // Persistence only is a contract double; path observation uses real fs above.
    const service = createControlService({
      read: () => state,
      update: async (revision, change) => { const next = change(state); if (next) { state = { ...next, revision: revision + 1 }; writes++; } return state; },
      close: async () => {},
    }, { now: () => Date.now(), token: () => 'synthetic-confirm-token-12345', inspectPath: inspectSettingsPath });
    const checked = await service.owner.checkPath({ expectedRevision: 0, candidate: target });
    if (fault === 'replace') await rm(target);
    await writeFile(target, 'changed synthetic content with different size');
    await assert.rejects(service.owner.confirmPath({ expectedRevision: 0, token: checked.token, acknowledge: true }), code('PATH_CHANGED_RECHECK'));
    assert.equal(writes, 0); assert.equal(service.readSummary().dataPathConfirmed, false);
    await service.close();
  }
});
