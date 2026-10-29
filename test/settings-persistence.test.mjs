import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { integration, profileA, profileB } from './helpers/settings-integration.mjs';

// A synthetic filesystem storage facility, NOT dsh-storage-json or real SDK IO.
// Exercises adapter integration across actual JSON files/reopen/failure; does not
// establish production backend rename/fsync, crash durability, or multiprocess CAS.
class SyntheticDiskStorage {
  constructor(root) { this.root = root; }
  failWrite = false; writes = 0; opened = [];
  file(name) { return join(this.root, name + '.json'); }
  async open(spec) {
    this.opened.push(spec.name);
    let value;
    try { value = spec.global.schema.parse(JSON.parse(await readFile(this.file(spec.name), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; value = spec.global.initial; }
    return { global: { get: () => value, set: async next => {
      if (this.failWrite) throw new Error('synthetic disk failure');
      await writeFile(this.file(spec.name) + '.tmp', JSON.stringify(next));
      await rename(this.file(spec.name) + '.tmp', this.file(spec.name));
      this.writes++; value = next;
    } }, close: async () => {} };
  }
}
async function diskFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'juebot-synthetic-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, facility: new SyntheticDiskStorage(root) };
}
test('synthetic disk survives close/reopen; failed later write preserves prior disk revision', async t => {
  const { root, facility } = await diskFixture(t);
  const first = await integration({ facility });
  await first.service.updateIdentity({ expectedRevision: 0, patch: { name: 'on-disk' } });
  const file = facility.file(facility.opened[0]);
  const bytes = await readFile(file, 'utf8');
  facility.failWrite = true;
  await assert.rejects(first.service.updateIdentity({ expectedRevision: 1, patch: { name: 'uncommitted' } }), /synthetic disk failure/);
  assert.equal(first.service.readOwner().revision, 1);
  await first.service.close();
  assert.equal(await readFile(file, 'utf8'), bytes);
  const reopened = await integration({ facility: new SyntheticDiskStorage(root) });
  assert.equal(reopened.service.readOwner().identity.name, 'on-disk');
  assert.equal(reopened.service.readOwner().revision, 1);
  await reopened.service.close();
});

test('synthetic disk corrupt JSON/schema fail closed with bytes unchanged and no default reset', async t => {
  const { facility } = await diskFixture(t);
  const first = await integration({ facility });
  await first.service.updateIdentity({ expectedRevision: 0, patch: { name: 'original' } });
  await first.service.close();
  const file = facility.file(facility.opened[0]);
  const original = JSON.parse(await readFile(file, 'utf8'));
  for (const bad of ['{broken-json', JSON.stringify({ ...original, schemaVersion: 999 }), JSON.stringify({ ...original, admin: { qq: '1', proofState: 'verified', bindingEpoch: 1 } })]) {
    await writeFile(file, bad);
    await assert.rejects(integration({ facility }));
    assert.equal(await readFile(file, 'utf8'), bad);
    assert.equal(facility.writes, 1);
  }
});

test('synthetic disk namespaces profiles and rejects a copied foreign-profile snapshot', async t => {
  const { root, facility } = await diskFixture(t);
  const alpha = await integration({ facility, profile: profileA });
  const beta = await integration({ facility, profile: profileB });
  await alpha.service.updateIdentity({ expectedRevision: 0, patch: { name: 'alpha' } });
  await beta.service.updateIdentity({ expectedRevision: 0, patch: { name: 'beta' } });
  await Promise.all([alpha.service.close(), beta.service.close()]);
  const [aFile, bFile] = facility.opened.map(name => facility.file(name));
  const betaBytes = await readFile(bFile, 'utf8');
  assert.notEqual(aFile, bFile);
  await writeFile(aFile, betaBytes);
  await assert.rejects(integration({ facility: new SyntheticDiskStorage(root), profile: profileA }));
  assert.equal(await readFile(aFile, 'utf8'), betaBytes);
  const reopened = await integration({ facility: new SyntheticDiskStorage(root), profile: profileB });
  assert.equal(reopened.service.readOwner().identity.name, 'beta');
  await reopened.service.close();
});

test('synthetic disk reopen IO failure does not reset configuration or attempt a write', async t => {
  const { root, facility } = await diskFixture(t);
  const first = await integration({ facility });
  await first.service.updateIdentity({ expectedRevision: 0, patch: { name: 'retained' } });
  await first.service.close();
  const file = facility.file(facility.opened[0]);
  const saved = file + '.saved';
  const bytes = await readFile(file, 'utf8');
  await rename(file, saved);
  await mkdir(file); // Real filesystem path collision; no permissions or production paths touched.
  const reopenedFacility = new SyntheticDiskStorage(root);
  await assert.rejects(integration({ facility: reopenedFacility }));
  assert.equal(reopenedFacility.writes, 0);
  assert.equal(await readFile(saved, 'utf8'), bytes);
  await rm(file, { recursive: true });
  await rename(saved, file);
  const recovered = await integration({ facility: reopenedFacility });
  assert.equal(recovered.service.readOwner().identity.name, 'retained');
  await recovered.service.close();
});
