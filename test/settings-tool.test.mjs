import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityTool } from '../candidates/0.2.0-dev.1/bundle/settings-tool.js';
import { integration, deferred } from './helpers/settings-integration.mjs';

const exec = () => ({ signal: new AbortController().signal, agent: { session: { synthetic: true } } });
const update = { action: 'update_identity', expectedRevision: 0, patch: { name: 'updated' } };
test('Tool summary redacts private configuration even without an Agent', async () => {
  const { service } = await integration();
  try {
    const secret = 'synthetic-persona-private';
    await service.updateIdentity({ expectedRevision: 0, patch: { personaCard: secret } });
    await service.owner.setAdmin({ expectedRevision: 1, qq: '123456789', acknowledgeReset: true });
    const tool = createIdentityTool(() => service, {});
    const result = await tool.execute({ action: 'read_summary' }, { signal: new AbortController().signal });
    assert.equal(result.identity.personaCardLength, secret.length);
    assert.equal(result.adminConfigured, true);
    for (const privateValue of [secret, '123456789', service.readOwner().profileKey]) assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.equal(result.businessEnabled, false);
    assert.equal(Object.hasOwn(result, 'dataPath'), false);
  } finally { await service.close(); }
});

test('Tool refuses forged permissions, missing Session, bot role and non-full-access Host policy', async () => {
  const { service, facility } = await integration();
  try {
    const allowed = { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } };
    const tool = createIdentityTool(() => service, allowed);
    for (const key of ['role', 'approved', 'source', 'sandboxMode', 'admin', 'dataPath', 'businessEnabled']) {
      await assert.rejects(tool.execute({ ...update, [key]: 'owner' }, exec()), /UNKNOWN_CONTROL_FIELD/);
    }
    await assert.rejects(tool.execute(update, { signal: exec().signal }), /IDENTITY_OPERATOR_REQUIRED/);
    const bot = exec(); bot.agent.ctx = { get: () => 'bot' };
    await assert.rejects(tool.execute(update, bot), /BOT_CONFIGURATION_WRITE_FORBIDDEN/);
    const restricted = createIdentityTool(() => service, { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } });
    await assert.rejects(restricted.execute(update, exec()), /IDENTITY_WRITE_NOT_AUTHORIZED/);
    assert.equal(facility.commits.length, 0);
  } finally { await service.close(); }
});

test('Tool validates action/root/patch before getters can run or forbidden fields can mutate state', async () => {
  const { service, facility } = await integration();
  try {
    const tool = createIdentityTool(() => service, { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } });
    const inputs = [ { action: 'set_admin', qq: '123' }, { action: 'read_summary', patch: {} },
      { ...update, patch: { name: 'x', qq: '123' } }, { ...update, patch: {} },
      { ...update, patch: { mode: 'admin' } }, { ...update, expectedRevision: -1 } ];
    for (const input of inputs) await assert.rejects(tool.execute(input, exec()));
    let calls = 0;
    const accessor = { get action() { calls++; return 'update_identity'; } };
    await assert.rejects(tool.execute(accessor, exec()), /INVALID_CONTROL_INPUT/);
    assert.equal(calls, 0); assert.equal(facility.commits.length, 0);
  } finally { await service.close(); }
});

test('Tool rechecks authorization when a queued write finally reaches the reducer', async () => {
  const { service, facility } = await integration();
  try {
    const entered = deferred(), release = deferred();
    facility.beforeSet = async () => { entered.release(); await release.promise; };
    const first = service.updateIdentity({ expectedRevision: 0, patch: { name: 'first' } });
    await entered.promise;
    let mode = 'danger-full-access'; let resolves = 0;
    const tool = createIdentityTool(() => service, { sandboxPolicy: { resolve: () => { resolves++; return { mode }; } } });
    const queued = assert.rejects(tool.execute({ ...update, expectedRevision: 1 }, exec()), /IDENTITY_WRITE_NOT_AUTHORIZED/);
    assert.equal(resolves, 1);
    mode = 'read-only'; release.release();
    await first; await queued;
    assert.equal(resolves, 2); assert.equal(facility.commits.length, 1);
    assert.equal(service.readOwner().identity.name, 'first');
  } finally { await service.close(); }
});

test('Tool successful update uses canonical public output; failures never echo private backend text', async () => {
  const { service, facility } = await integration();
  try {
    const tool = createIdentityTool(() => service, { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } });
    const result = await tool.execute(update, exec());
    assert.equal(result.revision, 1); assert.equal(result.identity.name, 'updated');
    assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: JSON.stringify(result) }]);
    facility.fail = new Error('synthetic-private-path-QQ-persona');
    await assert.rejects(tool.execute({ ...update, expectedRevision: 1, patch: { name: 'fail' } }, exec()), error => error.message === 'CONTROL_OPERATION_FAILED');
    assert.equal(service.readOwner().revision, 1);
  } finally { await service.close(); }
});
