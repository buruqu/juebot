import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { openDshApplication } from '../host/dsh-application.js';
const owner = { principal: 'synthetic-dsh-owner' };
class SyntheticAssembler {
  data = ''; finish = { kind: 'stop' }; usage;
  push(chunk) { if (chunk.type === 'text-delta') this.data += chunk.text; if (chunk.type === 'finish') this.finish = chunk.reason; if (chunk.type === 'usage') this.usage = chunk.usage; }
  blocks() { return [{ type: 'text', text: this.data }]; }
}
function assembler() {
  if (!process.env.JUEBOT_DSH_ASSEMBLER_SOURCE) return SyntheticAssembler;
  const source = readFileSync(process.env.JUEBOT_DSH_ASSEMBLER_SOURCE, 'utf8'); const start = source.indexOf('export class BlockAssembler');
  assert.ok(start >= 0);
  return vm.runInNewContext(`${source.slice(start).replace('export class', 'class')}\nBlockAssembler`, { brandString: value => value, assertNever() { throw new Error('Unexpected chunk'); } });
}
function folder(t) {
  const parent = realpathSync(tmpdir()); const root = mkdtempSync(path.join(parent, 'juebot-dsh-app-'));
  t.after(() => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('juebot-dsh-app-')); rmSync(root, { recursive: true, force: true }); }); return root;
}
const config = root => ({ enabled: true, dataRoot: root, namespace: 'synthetic-native', initializeEmpty: true, localChat: true,
  dshModel: { enabled: true, provider: 'synthetic-provider', model: 'synthetic-model', maxTokens: 512, timeoutMs: 1000, dailyUnits: 100000 } });
const post = (name, body) => new Request('http://localhost/api/juebot/agent/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function sdk() {
  const calls = [];
  return { calls, ctx: { llm: { prepareCall: async config => {
    calls.push(config); return { config, retryPolicy: { mode: 'normal', maxRetries: 0 }, stream: options => (async function* () {
      assert.equal(options.provider, 'synthetic-provider'); assert.ok(!options.tools);
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ text: '合成本地回答', learning: [] }) };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })() };
  } } } };
}
test('disabled native entry never reads model/SDK/defaults or touches requested data path', async t => {
  const root = path.join(folder(t), 'must-not-exist');
  const cfg = { enabled: false, dataRoot: root, get dshModel() { assert.fail('model config read'); } };
  const ctx = { get llm() { assert.fail('SDK read'); } };
  const app = await openDshApplication(ctx, cfg, owner); assert.equal(existsSync(root), false);
  assert.equal((await app.fetch(new Request('http://localhost/api/juebot/agent/status'))).status, 503); app.close();
});
test('native model config fails before DB mutation; local chat is opt-in and never grants Code', async t => {
  const root = folder(t); const f = sdk();
  for (const bad of [{ model: '' }, { provider: '' }, { dailyUnits: 0 }, { timeoutMs: 0 }, { maxTokens: 0 }]) {
    const cfg = config(root); cfg.dshModel = { ...cfg.dshModel, ...bad };
    await assert.rejects(openDshApplication(f.ctx, cfg, owner, { BlockAssembler: assembler() }), /APPLICATION_INVALID_CONFIG/);
    assert.deepEqual(readdirSync(root), []);
  }
  const app = await openDshApplication({ get llm() { assert.fail('disabled model read SDK'); } }, { ...config(root), localChat: undefined, dshModel: { enabled: false } }, owner);
  try { assert.equal(app.runtime.conversations().length, 0); assert.equal(app.runtime.modelConfigured, false); assert.equal(app.code.snapshot().value.enabled, false); assert.equal(app.runner, null); }
  finally { app.close(); }
});
test('native owner app uses synthetic SDK over real SQLite, preserves daily budget and scopes identity changes', async t => {
  const root = folder(t); const f = sdk(); const cfg = config(root); const deps = { BlockAssembler: assembler(), now: () => Date.UTC(2026, 9, 28, 10) };
  let app = await openDshApplication(f.ctx, cfg, owner, deps);
  try {
    assert.equal(f.calls.length, 0); assert.equal(app.runner, null); const key = app.runtime.conversations()[0].key;
    assert.throws(() => app.code.enable(deps.now()), /CODE_NOT_AUTHORIZED/);
    assert.deepEqual(app.runtime.memory.effective(key).permissions, { receive: false, save: false, learn: false, reply: false, proactive: false });
    let response = await app.fetch(post('local-message', { key, text: 'blocked by default' })); assert.equal(response.status, 403); assert.equal(f.calls.length, 0);
    app.runtime.memory.configure(0, { permissions: { receive: true, save: true, learn: true, reply: true }, typing: { enabled: false } });
    app.runtime.outbox.setPause(0, false);
    app.runtime.observe(key, { eventId: 'synthetic-interest', revision: 1, kind: 'external', topic: 'music', feedback: 'interest', interestDelta: 10, affect: { valence: 60, intensity: 80 } });
    const envelope = { key, bindingRevision: 1, eventId: 'untrusted', actor: 'outsider', actorKind: 'human', plain: true, text: 'no', observedAt: deps.now() };
    await assert.rejects(app.runtime.receive(envelope), /UNTRUSTED_INGRESS/); assert.equal(f.calls.length, 0);
    const foreign = app.runtime.register({ botId: app.runtime.profile.botId, personaId: app.runtime.profile.personaId,
      connector: 'local-test', issuer: 'dsh-owner', accountId: 'local-owner', kind: 'direct', remoteId: 'someone-else' }, 1, 'foreign');
    await assert.rejects(app.runtime.receive({ ...envelope, key: foreign, actor: owner.principal }), /UNTRUSTED_INGRESS/);
    assert.equal((await app.fetch(post('local-message', { key: foreign, text: 'foreign local stream' }))).status, 403);
    response = await app.fetch(post('local-message', { key, text: 'synthetic hello' }));
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.data.status, 'queued'); assert.equal(f.calls.length, 1);
    assert.equal(app.modelBudget.snapshot().chargedUnits, 25);
    assert.ok(app.runtime.ledger.pageEvents(key, 1, 0, 20).some(event => event.eventType === 'reply.draft'));
    const budget = app.modelBudget;
    response = await app.fetch(post('identity', { expectedRevision: 0, profile: { ...app.runtime.profile, mode: 'persona', name: '合成人设', roleCore: '本地合成人设' } }));
    assert.equal(response.status, 200); assert.equal(app.modelBudget, budget); assert.equal(app.modelBudget.snapshot().chargedUnits, 25);
    const next = app.runtime.conversations()[0]; assert.notEqual(next.key, key); assert.equal(next.identity.personaId, 'persona');
    response = await app.fetch(new Request('http://localhost/api/juebot/agent/conversations')); const visible = (await response.json()).data.items;
    assert.deepEqual(visible.map(item => item.key), [next.key]);
    assert.equal((await app.fetch(post('local-message', { key, text: 'old identity' }))).status, 403);
    app.close(); cfg.initializeEmpty = false; cfg.dshModel.model = 'another-explicit-model';
    app = await openDshApplication(f.ctx, cfg, owner, deps); assert.equal(app.modelBudget.snapshot().chargedUnits, 25); assert.equal(f.calls.length, 1);
  } finally { app.close(); }
});
