import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreError } from '../src/contracts.ts';
import { createControlService, initialControl, publicControl, validateControl, cloneControl } from '../src/control.ts';
import type { ControlState, ControlPersistence, PathObservation } from '../src/control.ts';

const PROFILE = 'a'.repeat(64);
const code = (name: string) => (error: unknown) => error instanceof CoreError && error.code === name;
function memoryPort(): ControlPersistence & { writes: number; rejectWrite: boolean } {
  let current = initialControl(PROFILE);
  let queue = Promise.resolve();
  let closed = false;
  const port = {
    writes: 0, rejectWrite: false,
    read() { if (closed) throw new CoreError('CONTROL_CLOSED'); return cloneControl(current); },
    update(expected: number, change: (value: ControlState) => ControlState | undefined, signal?: AbortSignal) {
      if (closed) return Promise.reject(new CoreError('CONTROL_CLOSED'));
      const result = queue.then(() => {
        signal?.throwIfAborted();
        if (current.revision !== expected) throw new CoreError('CONTROL_REVISION_CONFLICT');
        const next = change(cloneControl(current));
        if (!next) return cloneControl(current);
        if (port.rejectWrite) throw new Error('synthetic disk failure');
        current = validateControl({ ...next, revision: current.revision + 1 }, PROFILE);
        port.writes += 1;
        return cloneControl(current);
      });
      queue = result.then(() => {}, () => {});
      return result;
    },
    async close() { closed = true; await queue; },
  };
  return port;
}
function fixture() {
  const port = memoryPort();
  let now = 1000000;
  let serial = 0;
  let observation: PathObservation = { canonicalPath: 'C:\\synthetic\\juebot.sqlite', fingerprint: 'b'.repeat(64), exists: false };
  const service = createControlService(port, { now: () => now, token: () => `opaque-token-${++serial}-1234567890`, inspectPath: async () => cloneControl(observation) });
  return { port, service, advance: (ms: number) => { now += ms; }, changePath: () => { observation = { ...observation, fingerprint: 'c'.repeat(64) }; } };
}

test('control defaults are unconfigured and never claim verified or enabled business', () => {
  const value = initialControl(PROFILE);
  assert.equal(value.identity.name, '撅撅');
  assert.equal(value.admin.qq, null);
  assert.equal(value.admin.proofState, 'unconfigured');
  assert.equal(publicControl(value).businessEnabled, false);
});

test('identity UI and agent method share validation, CAS and public redaction', async () => {
  const { service, port } = fixture();
  const state = await service.updateIdentity({ expectedRevision: 0, patch: { name: ' 新名字 ', mode: 'persona', personaCard: 'PRIVATE-PERSONA' } });
  assert.equal(state.identity.name, '新名字');
  assert.equal(state.revision, 1);
  const summary = await service.executeIdentityRequest({ action: 'read_summary' });
  assert.equal(summary.identity.personaCardConfigured, true);
  assert.equal(summary.identity.personaCardLength, 15);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE-PERSONA'));
  assert.equal(port.writes, 1);
  await assert.rejects(() => service.updateIdentity({ expectedRevision: 0, patch: { name: 'stale' } }), code('CONTROL_REVISION_CONFLICT'));
  const noChange = await service.updateIdentity({ expectedRevision: 1, patch: { name: '新名字' } });
  assert.equal(noChange.revision, 1);
  assert.equal(port.writes, 1);
  await service.close();
});

for (const input of [
  { action: 'set_admin', qq: '10001' },
  { action: 'read_summary', expectedRevision: 0 },
  { action: 'update_identity', patch: { name: 'bad' } },
  { action: 'update_identity', expectedRevision: 0, patch: { name: 'bad', adminQQ: '10001' } },
  { action: 'update_identity', expectedRevision: 0, patch: { verified: true } },
  { action: 'update_identity', expectedRevision: 0, patch: { storagePath: 'C:\\bad.sqlite' } },
  { action: 'update_identity', expectedRevision: 0, patch: { mode: 'code' } },
  { action: 'update_identity', expectedRevision: 0, patch: {}, actor: 'owner' },
]) {
  test(`identity boundary rejects ${JSON.stringify(input)}`, async () => {
    const { service, port } = fixture();
    await assert.rejects(() => service.executeIdentityRequest(input));
    assert.equal(port.writes, 0);
    assert.equal(service.readSummary().revision, 0);
    await service.close();
  });
}

test('operator authorization runs again at the queued commit boundary', async () => {
  const { service, port } = fixture();
  let calls = 0;
  await assert.rejects(() => service.executeIdentityRequest({ action: 'update_identity', expectedRevision: 0, patch: { name: 'not committed' } }, undefined, () => {
    calls += 1;
    if (calls === 2) throw new CoreError('IDENTITY_WRITE_NOT_AUTHORIZED');
  }), code('IDENTITY_WRITE_NOT_AUTHORIZED'));
  assert.equal(calls, 2);
  assert.equal(port.writes, 0);
});

test('admin registration remains pending, changes epoch, and never leaks through summary', async () => {
  const { service } = fixture();
  await assert.rejects(() => service.owner.setAdmin({ expectedRevision: 0, qq: '123456789', acknowledgeReset: false }), code('USER_ACKNOWLEDGEMENT_REQUIRED'));
  const registered = await service.owner.setAdmin({ expectedRevision: 0, qq: '123456789', acknowledgeReset: true });
  assert.equal(registered.admin.proofState, 'pending-proof');
  assert.equal(registered.admin.bindingEpoch, 1);
  assert.ok(!JSON.stringify(service.readSummary()).includes('123456789'));
  const noOp = await service.owner.setAdmin({ expectedRevision: 1, qq: '123456789', acknowledgeReset: true });
  assert.equal(noOp.revision, 1);
  await assert.rejects(() => service.owner.setAdmin({ expectedRevision: 1, qq: '123456789', acknowledgeReset: true, verified: true }), code('UNKNOWN_CONTROL_FIELD'));
  const cleared = await service.owner.setAdmin({ expectedRevision: 1, qq: null, acknowledgeReset: true });
  assert.equal(cleared.admin.proofState, 'unconfigured');
  assert.equal(cleared.admin.bindingEpoch, 2);
  assert.equal(cleared.revision, 2);
});

test('path preview does not persist; confirmation binds token, revision and fresh metadata', async () => {
  const { service, port } = fixture();
  const checked = await service.owner.checkPath({ expectedRevision: 0, candidate: 'C:\\synthetic\\juebot.sqlite' });
  assert.equal(checked.opensDatabase, false);
  assert.equal(port.writes, 0);
  const saved = await service.owner.confirmPath({ expectedRevision: 0, token: checked.token, acknowledge: true });
  assert.equal(saved.dataPath.candidate, checked.observation.canonicalPath);
  assert.equal(saved.dataPath.confirmedCandidate, checked.observation.canonicalPath);
  assert.equal(service.readSummary().dataPathConfirmed, true);
  assert.ok(!JSON.stringify(service.readSummary()).includes('synthetic'));
  assert.equal(port.writes, 1);
  await assert.rejects(() => service.owner.confirmPath({ expectedRevision: 1, token: checked.token, acknowledge: true }), code('PATH_CHECK_REQUIRED'));
  const cleared = await service.owner.clearPath({ expectedRevision: 1, acknowledge: true });
  assert.equal(cleared.dataPath.candidate, null);
  assert.equal(cleared.dataPath.confirmedCandidate, null);
});

test('expired, changed and stale configuration path checks cannot be confirmed', async () => {
  for (const fault of ['expired','changed','revision'] as const) {
    const f = fixture();
    const checked = await f.service.owner.checkPath({ expectedRevision: 0, candidate: 'C:\\synthetic\\juebot.sqlite' });
    if (fault === 'expired') f.advance(300001);
    if (fault === 'changed') f.changePath();
    if (fault === 'revision') await f.service.updateIdentity({ expectedRevision: 0, patch: { name: 'new revision' } });
    await assert.rejects(() => f.service.owner.confirmPath({ expectedRevision: 0, token: checked.token, acknowledge: true }));
    assert.equal(f.service.readSummary().dataPathConfigured, false);
  }
});

test('persistence failure leaves visible revision unchanged and can be retried', async () => {
  const { service, port } = fixture();
  port.rejectWrite = true;
  await assert.rejects(() => service.updateIdentity({ expectedRevision: 0, patch: { name: 'retry' } }), /synthetic disk failure/);
  assert.equal(service.readSummary().revision, 0);
  port.rejectWrite = false;
  assert.equal((await service.updateIdentity({ expectedRevision: 0, patch: { name: 'retry' } })).revision, 1);
});

test('strict input rejects accessors without running them; close is idempotent', async () => {
  const { service } = fixture();
  let called = false;
  const input = { get action() { called = true; return 'update_identity'; } };
  await assert.rejects(() => service.executeIdentityRequest(input));
  assert.equal(called, false);
  const first = service.close();
  assert.equal(service.close(), first);
  await first;
  assert.throws(() => service.readSummary(), code('CONTROL_CLOSED'));
});

// Synthetic persistence and clock only; no filesystem/SDK/database is opened.
test('path token expires while confirmation waits in the persistence queue', async () => {
  const port = memoryPort();
  const originalUpdate = port.update.bind(port);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const queued = new Promise<void>(resolve => { reached = resolve; });
  port.update = async (revision, change, signal) => {
    reached(); await gate;
    return originalUpdate(revision, change, signal);
  };
  let now = 1000000;
  const service = createControlService(port, {
    now: () => now, token: () => 'synthetic-token-123456789',
    inspectPath: async () => ({ canonicalPath: 'C:\\synthetic\\ttl.sqlite', fingerprint: 'd'.repeat(64), exists: false }),
  });
  const checked = await service.owner.checkPath({ expectedRevision: 0, candidate: 'C:\\synthetic\\ttl.sqlite' });
  const confirmation = service.owner.confirmPath({ expectedRevision: 0, token: checked.token, acknowledge: true });
  const rejected = assert.rejects(confirmation, code('PATH_CHECK_REQUIRED'));
  await queued; now += 300000; release(); await rejected;
  assert.equal(port.writes, 0);
  assert.equal(service.readSummary().dataPathConfirmed, false);
  await service.close();
});

test('path token expiry during metadata await and canonical path changes reject without writing', async () => {
  for (const fault of ['expiry', 'canonical'] as const) {
    const port = memoryPort();
    let now = 1000000;
    let calls = 0;
    const original = { canonicalPath: 'C:\\synthetic\\await.sqlite', fingerprint: 'e'.repeat(64), exists: false };
    const service = createControlService(port, {
      now: () => now, token: () => 'synthetic-token-123456789',
      inspectPath: async () => {
        if (++calls === 2) {
          await Promise.resolve();
          if (fault === 'expiry') now += 300000;
          else return { ...original, canonicalPath: 'C:\\synthetic\\other.sqlite' };
        }
        return original;
      },
    });
    const checked = await service.owner.checkPath({ expectedRevision: 0, candidate: original.canonicalPath });
    await assert.rejects(service.owner.confirmPath({ expectedRevision: 0, token: checked.token, acknowledge: true }), code('PATH_CHANGED_RECHECK'));
    assert.equal(port.writes, 0);
    assert.equal(service.readSummary().revision, 0);
    await service.close();
  }
});
