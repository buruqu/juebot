import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { ConversationLedger } from '../../conversation-v1/src/ledger.ts';
import { BotRuntime } from '../src/runtime.ts';
import { CreationService } from '../src/creation.ts';
import { CodeTasks } from '../src/code-jobs.ts';
import { DispatchCoordinator } from '../src/dispatch.ts';
import { createCodeBridge } from '../host/code-bridge.js';

function fixture(t, executor) {
  const db = new DatabaseSync(':memory:'), events = new DatabaseSync(':memory:');
  const store = new SqliteStateStore(db, { namespace: 'bridge', initialize: true });
  const ledger = new ConversationLedger(events, { namespace: 'bridge', initialize: true });
  const runtime = new BotRuntime(store, ledger, { profile: { botId: 'bot', personaId: 'juejue', mode: 'juejue', name: '撅撅', roleCore: 'synthetic' },
    now: () => 1000, model: null, acceptIngress: () => false, authorizeLearning: () => false,
    participation: () => ({ enabled: false, allowedTargets: [], deniedTargets: [], timeZoneOffsetMinutes: 0, windows: [], cooldownMs: 0, dailyLimit: 0, unansweredLimit: 0 }) });
  const key = runtime.register({ botId: 'bot', personaId: 'juejue', connector: 'qq-official', issuer: 'synthetic', accountId: 'app', kind: 'direct', remoteId: 'admin-open-id' }, 1, 'synthetic');
  const account = JSON.stringify(['qq-official', 'synthetic', 'app']);
  let grant = { revision: 1, adminActor: 'admin-open-id', conversationKey: key, account: 'app', workspaceId: 'test', sessionId: 'dedicated',
    modelConfigured: true, budgetAvailable: true, sandboxVerified: true, toolsRestricted: true, allowedTools: ['read'], verified: true };
  const code = new CodeTasks(store, { getAuthorization: () => grant });
  const creation = new CreationService(store, { now: () => 1000, authorizeHuman: () => false, resolveAsset: () => null, currentAuthority: () => ({ publishAllowed: false }) });
  const dispatcher = new DispatchCoordinator(runtime, creation, code, () => 1000, { resolveAccount: handle => handle === 'app' ? account : null });
  let insertionFailure = false;
  const bridge = createCodeBridge({ code, executor, getDispatcher: () => { if (insertionFailure) throw new Error('SENSITIVE MATERIAL'); return dispatcher; }, now: () => 1000 });
  t.after(async () => { await bridge.close(); runtime.close(); store.close(); db.close(); events.close(); });
  return { code, bridge, runtime, dispatcher, account, key, revoke() { grant = null; }, failInsertion(value) { insertionFailure = value; },
    input: id => ({ eventId: id, actor: 'admin-open-id', conversationKey: key, account: 'app', plain: true, text: 'SYNTHETIC CODE ' + id }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('trusted message executes once and result uses original private shared Outbox without social learning', async t => {
  let calls = 0; const f = fixture(t, async ({ task, gateModel, gateTool }) => { gateModel(); gateTool('read'); calls++; return 'output ' + task.input.eventId; });
  assert.throws(() => f.bridge.admit(f.input('a')), /CODE_DISABLED/); assert.equal(calls, 0);
  f.code.enable(1000); const admitted = f.bridge.admit(f.input('a')); assert.equal(f.bridge.admit(f.input('a')).duplicate, true);
  await f.bridge.idle(); assert.equal(calls, 1);
  const entry = f.runtime.outbox.list()[0]; assert.equal(entry.kind, 'code-result'); assert.equal(entry.conversation, f.key); assert.equal(entry.account, f.account);
  assert.equal(entry.body, 'output a'); assert.equal(f.code.get(admitted.task.id).resultDelivery, 'ready');
  assert.equal(f.runtime.ledger.pageEvents(f.key, 1, 0, 20).length, 0);
  f.runtime.outbox.setPause(f.runtime.outbox.state().revision, false);
  await f.dispatcher.dispatch(f.account, 'test', { id: 'synthetic-budget', limit: 10 }, async item => { assert.equal(item.body, 'output a'); return { status: 'confirmed', receipt: 'synthetic' }; });
  assert.equal(f.code.get(admitted.task.id).resultDelivery, 'delivered');
  assert.equal(f.bridge.admit(f.input('a')).duplicate, true); await f.bridge.idle(); assert.equal(calls, 1);
});

test('serial DSH conversation preserves ordering and OFF keeps running but holds queued input', async t => {
  let release; const seen = [];
  const f = fixture(t, async ({ task, gateModel }) => { seen.push(task.input.eventId); await new Promise(resolve => { release = resolve; }); gateModel(); return 'done'; });
  f.code.enable(1000); const a = f.bridge.admit(f.input('a')), b = f.bridge.admit(f.input('b'));
  await tick(); assert.deepEqual(seen, ['a']); f.code.disable(1000);
  assert.throws(() => f.bridge.admit(f.input('c')), /CODE_DISABLED/); release(); await f.bridge.idle();
  assert.equal(f.code.get(a.task.id).state, 'completed'); assert.equal(f.code.get(b.task.id).state, 'held');
  assert.deepEqual(seen, ['a']); assert.equal(f.runtime.outbox.list().length, 1);
});

test('revocation blocks completion delivery; executor failure never becomes successful result', async t => {
  let release; const f = fixture(t, async ({ gateModel }) => { await new Promise(resolve => { release = resolve; }); gateModel(); return 'should not escape'; });
  f.code.enable(1000); const a = f.bridge.admit(f.input('a')); await tick(); f.revoke(); release(); await f.bridge.idle();
  assert.equal(f.code.get(a.task.id).state, 'needs-review'); assert.equal(f.runtime.outbox.list().length, 0);
  assert.equal(f.bridge.status().lastFailure.code, 'CODE_NOT_AUTHORIZED');
});

test('queue insertion failure retains result; explicit enqueue never reruns Code', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return 'completed'; });
  f.failInsertion(true); f.code.enable(1000); const a = f.bridge.admit(f.input('a')); await f.bridge.idle();
  assert.equal(f.code.get(a.task.id).state, 'completed'); assert.equal(f.code.get(a.task.id).result, 'completed');
  assert.equal(f.bridge.status().lastFailure.code, 'CODE_BRIDGE_FAILED');
  f.failInsertion(false); f.bridge.enqueueResult(a.task.id); assert.equal(calls, 1); assert.equal(f.runtime.outbox.list().length, 1);
});

test('unload aborts and settles before DB release; new or queued messages cannot run after close', async t => {
  let aborted = false;
  const f = fixture(t, ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })));
  f.code.enable(1000); const a = f.bridge.admit(f.input('a')), b = f.bridge.admit(f.input('b')); await tick();
  await f.bridge.close(); assert.equal(aborted, true); assert.equal(f.code.get(a.task.id).state, 'needs-review'); assert.equal(f.code.get(b.task.id).state, 'held');
  assert.throws(() => f.bridge.admit(f.input('c')), /CODE_BRIDGE_CLOSED/); assert.equal(f.runtime.outbox.list().length, 0);
});
