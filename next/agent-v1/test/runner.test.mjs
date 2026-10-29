import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRunner } from '../host/runner.js';
import { SqliteStateStore } from '../src/store.ts';
import { DurableOutbox } from '../src/outbox.ts';
import { DispatchCoordinator } from '../src/dispatch.ts';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => error?.code === expected;
function clock() {
  let serial = 0; const timers = new Map();
  return { timers, now: () => 100,
    setTimer(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async fire() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); await flush(); },
  };
}
function fixture(changes = {}) {
  const timer = clock(); const diagnostics = []; const calls = { receives: [], idle: [], dispatch: [] }; let handler;
  const runtime = { receive: async envelope => { calls.receives.push(envelope); return { status: 'received' }; }, idle: async (...args) => { calls.idle.push(args); } };
  const dispatcher = { dispatch: async (...args) => { calls.dispatch.push(args); return null; } };
  const options = { runtime, dispatcher, accounts: [{ id: 'account', budget: () => ({ id: 'window', limit: 3 }), send: async () => ({ status: 'confirmed', receipt: 'synthetic' }) }],
    subscribe: async receive => { handler = receive; return () => {}; }, decode: raw => raw?.trusted ? raw.envelope : null,
    intervalMs: 100, now: timer.now, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    onDiagnostic: value => diagnostics.push(value), ...changes };
  return { timer, diagnostics, calls, options, runner: createRunner(options), handler: () => handler };
}

test('construction is inert and explicit start schedules only one one-shot timer', async () => {
  const f = fixture(); assert.equal(f.timer.timers.size, 0); assert.equal(f.calls.dispatch.length, 0);
  await assert.rejects(f.runner.runOnce(), code('RUNNER_NOT_STARTED'));
  const first = f.runner.start(); assert.equal(f.runner.start(), first); await first;
  assert.equal(f.timer.timers.size, 1); assert.equal(f.calls.dispatch.length, 0);
  await f.timer.fire(); assert.equal(f.calls.dispatch.length, 1); assert.equal(f.timer.timers.size, 1);
  await f.runner.stop(); assert.equal(f.timer.timers.size, 0);
});
test('configuration rejects unbounded accounts/intervals and duplicate account senders', () => {
  for (const intervalMs of [0, 99, 3600001, NaN, 100.5]) assert.throws(() => fixture({ intervalMs }), code('RUNNER_INVALID_CONFIG'));
  const account = { id: 'same', budget: () => null, send: async () => null };
  assert.throws(() => fixture({ accounts: [account, account] }), code('RUNNER_INVALID_CONFIG'));
  assert.throws(() => fixture({ accounts: Array.from({ length: 17 }, (_, index) => ({ ...account, id: String(index) })) }), code('RUNNER_INVALID_CONFIG'));
  assert.throws(() => fixture({ setTimer: undefined }), code('RUNNER_INVALID_CONFIG'));
});
test('concurrent runOnce calls share the same cycle and never overlap account dispatch', async () => {
  const gate = deferred(); let active = 0; let maximum = 0; let count = 0;
  const f = fixture({ dispatcher: { dispatch: async () => { count++; active++; maximum = Math.max(maximum, active); await gate.promise; active--; return null; } } });
  await f.runner.start(); const first = f.runner.runOnce(); const second = f.runner.runOnce();
  assert.equal(first, second); assert.equal(count, 1); assert.equal(f.timer.timers.size, 0);
  gate.resolve(); await first; assert.equal(maximum, 1); assert.equal(f.timer.timers.size, 1); await f.runner.stop();
});
test('single-dispatcher ownership prevents two simultaneous runners', async () => {
  const f = fixture(); const otherTimer = clock(); const second = createRunner({ ...f.options, ...{ setTimer: otherTimer.setTimer, clearTimer: otherTimer.clearTimer } });
  await f.runner.start(); await assert.rejects(second.start(), code('RUNNER_ALREADY_RUNNING'));
  await f.runner.stop(); await second.start(); assert.equal(otherTimer.timers.size, 1); await second.stop();
});
test('transport receives the coordinator cancellation signal without inventing a non-submission receipt',async()=>{
  const controller=new AbortController();let received;
  const f=fixture({accounts:[{id:'account',budget:()=>({id:'day',limit:1}),send:async(_item,signal)=>{received=signal;return{status:'unknown',receipt:null};}}],
    dispatcher:{dispatch:async(_id,_owner,_budget,send)=>send({id:'synthetic'},controller.signal)}});
  await f.runner.start();await f.runner.runOnce();assert.equal(received,controller.signal);controller.abort();assert.equal(received.aborted,true);await f.runner.stop();
});
test('stop before late subscribe return closes the late handle once and refuses late ingress', async () => {
  const subscription = deferred(); let handler; let released = 0; let decoded = 0;
  const f = fixture({ subscribe: receive => { handler = receive; return subscription.promise; }, decode: raw => { decoded++; return raw; } });
  const starting = f.runner.start(); await f.runner.stop();
  assert.deepEqual(await handler({ secret: 'not an owner' }), { accepted: false, code: 'RUNNER_STOPPED' }); assert.equal(decoded, 0);
  subscription.resolve(() => { released++; }); await starting;
  await f.runner.stop(); assert.equal(released, 1); assert.equal(f.timer.timers.size, 0);
  await assert.rejects(f.runner.start(), code('RUNNER_STOPPED'));
});
test('normal stop disposes subscription once and catches a hostile diagnostic observer', async () => {
  let disposed = 0;
  const f = fixture({ subscribe: async () => () => { disposed++; }, onDiagnostic: () => { throw new Error('observer failure'); } });
  await f.runner.start(); const a = f.runner.stop(); const b = f.runner.stop(); assert.equal(a, b); await a;
  assert.equal(disposed, 1); assert.equal(f.timer.timers.size, 0);
});
test('late subscription disposal remains exactly once after a replacement runner has started', async () => {
  const late = deferred(); let released = 0;
  const f = fixture({ subscribe: () => late.promise }); const starting = f.runner.start();
  await f.runner.stop();
  const timer = clock(); const replacement = createRunner({ ...f.options, subscribe: undefined, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  await replacement.start(); assert.equal(timer.timers.size, 1);
  late.resolve(async () => { released++; await flush(); });
  await starting; await f.runner.stop(); await f.runner.stop();
  assert.equal(released, 1); assert.equal(timer.timers.size, 1, 'old cleanup cannot remove new runner timer');
  assert.equal(replacement.status().closed, false); await replacement.stop();
});
test('stop waits accepted failures and throwing unsubscribe without hanging or leaking diagnostics', { timeout: 1000 }, async () => {
  const receiving = deferred(); const dispatching = deferred(); let disposed = 0;
  const f = fixture({
    runtime: { idle: async () => {}, receive: async () => { await receiving.promise; throw Object.assign(new Error('PRIVATE-RECEIVE'), { code: 'ACCESS_DENIED' }); } },
    dispatcher: { dispatch: async () => { await dispatching.promise; throw new Error('PRIVATE-DISPATCH'); } },
    subscribe: async receive => { f.accept = receive; return () => { disposed++; throw new Error('PRIVATE-UNSUBSCRIBE'); }; },
  });
  await f.runner.start(); const ingress = f.accept({ trusted: true, envelope: {} }); const cycle = f.runner.runOnce(); await flush();
  const stopping = f.runner.stop(); assert.equal(f.runner.status().closed, true);
  receiving.resolve(); dispatching.resolve(); await Promise.all([stopping, ingress, cycle]);
  assert.equal(disposed, 1); assert.equal(f.runner.status().pendingIngress, 0); assert.equal(f.timer.timers.size, 0);
  assert.ok(f.diagnostics.some(item => item.code === 'ACCESS_DENIED')); assert.ok(f.diagnostics.some(item => item.code === 'UNSUBSCRIBE_FAILED'));
  assert.ok(f.diagnostics.some(item => item.code === 'DISPATCH_FAILED')); assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE'));
});
test('subscribe and timer setup failures relinquish ownership and clean registrations', async () => {
  const f = fixture({ subscribe: async () => { throw Object.assign(new Error('SECRET-BODY'), { code: 'TOKEN_SECRET' }); } });
  await assert.rejects(f.runner.start(), code('RUNNER_START_FAILED')); assert.equal(f.runner.status().closed, true);
  assert.ok(f.diagnostics.some(item => item.code === 'SUBSCRIBE_FAILED')); assert.ok(!JSON.stringify(f.diagnostics).includes('SECRET'));
  let released = 0;
  const g = fixture({ subscribe: async () => () => { released++; }, setTimer: () => { throw new Error('PRIVATE-PATH'); }, clearTimer: () => {} });
  await assert.rejects(g.runner.start(), code('RUNNER_START_FAILED')); assert.equal(released, 1); assert.equal(g.runner.status().closed, true);
});
test('raw messages never become owner input without an explicit trusted decoder', async () => {
  const f = fixture({ decode: undefined }); await f.runner.start();
  const result = await f.handler()({ owner: true, actor: 'admin', text: 'SECRET-RAW' });
  assert.equal(result.code, 'DECODE_NOT_CONFIGURED'); assert.equal(f.calls.receives.length, 0);
  await f.runner.stop();
});
test('trusted decode passes envelopes and preserves model/permission error codes with bounded diagnostics', async () => {
  let count = 0;
  const f = fixture({ runtime: { idle: async () => {}, receive: async () => { count++; throw Object.assign(new Error('PRIVATE-BODY-STACK'), { code: count === 1 ? 'MODEL_NOT_CONFIGURED' : 'ACCESS_DENIED' }); } } });
  await f.runner.start();
  assert.equal((await f.handler()({ trusted: true, envelope: { key: 'synthetic', text: 'SECRET-MESSAGE' } })).code, 'MODEL_NOT_CONFIGURED');
  assert.equal((await f.handler()({ trusted: true, envelope: { key: 'synthetic', text: 'SECRET-MESSAGE' } })).code, 'ACCESS_DENIED');
  assert.ok(f.diagnostics.every(item => Object.keys(item).sort().join(',') === 'code,stage'));
  assert.ok(!JSON.stringify(f.diagnostics).includes('SECRET')); assert.ok(!JSON.stringify(f.diagnostics).includes('STACK'));
  await f.runner.stop();
});
test('ignored/synchronous decoder failures release ingress slots and stop waits accepted work', async () => {
  const f = fixture(); await f.runner.start();
  for (let index = 0; index < 100; index++) assert.equal((await f.handler()({ trusted: false })).accepted, false);
  assert.equal(f.runner.status().pendingIngress, 0); await f.runner.stop();
  const gate = deferred(); const entered = deferred();
  const g = fixture({ runtime: { idle: async () => {}, receive: async () => { entered.resolve(); await gate.promise; return { status: 'done' }; } } });
  await g.runner.start(); const receiving = g.handler()({ trusted: true, envelope: {} }); await entered.promise;
  let stopped = false; const stopping = g.runner.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false);
  gate.resolve(); await receiving; await stopping; assert.equal(g.runner.status().pendingIngress, 0);
});
test('idle plans are fetched fresh, bounded and never replayed on start or catch-up', async () => {
  let plans = [{ key: 'conversation', topic: 'synthetic topic', action: 'idle-topic' }];
  const f = fixture({ idlePlans: () => plans }); await f.runner.start(); assert.equal(f.calls.idle.length, 0);
  await f.runner.runOnce(); assert.equal(f.calls.idle.length, 1);
  plans = []; await f.runner.runOnce(); assert.equal(f.calls.idle.length, 1);
  plans = Array.from({ length: 17 }, () => ({ key: 'x', topic: 'x', action: 'idle-topic' }));
  await f.runner.runOnce(); assert.equal(f.calls.idle.length, 1); assert.ok(f.diagnostics.some(item => item.code === 'IDLE_PLAN_FAILED'));
  await f.runner.stop();
});
test('stop does not report an in-flight send as not-submitted or start another account', async () => {
  const gate = deferred(); let sends = 0; let dispatched = 0;
  const accounts = ['a', 'b'].map(id => ({ id, budget: () => ({ id: 'window', limit: 10 }), send: async () => { sends++; await gate.promise; return { status: 'unknown', receipt: null }; } }));
  const f = fixture({ accounts, dispatcher: { dispatch: async (_id, _owner, _budget, send) => { dispatched++; return send({ id: 'synthetic' }); } } });
  await f.runner.start(); const running = f.runner.runOnce(); await flush(); const stopping = f.runner.stop();
  gate.resolve(); await running; await stopping;
  assert.equal(sends, 1); assert.equal(dispatched, 1); assert.ok(f.diagnostics.some(item => item.code === 'DELIVERY_UNCERTAIN'));
  assert.ok(!JSON.stringify(f.diagnostics).includes('not-submitted'));
});
test('real SQLite Outbox/DispatchCoordinator sends once and never retries unknown', async t => {
  const db = new DatabaseSync(':memory:', { allowExtension: false }); const store = new SqliteStateStore(db, { namespace: 'test', initialize: true });
  t.after(() => { store.close(); db.close(); });
  const outbox = new DurableOutbox(store); outbox.setPause(0, false);
  outbox.enqueue({ id: 'synthetic-message', account: JSON.stringify(['local-test', 'fixture', 'account']), conversation: 'synthetic-conversation', kind: 'social', body: 'SYNTHETIC-BODY', payload: {},
    revisions: { binding: 1, policy: 1, memory: 1, identity: 1, expression: 1 }, sourceRefs: [], createdAt: 1, dueAt: 1, expiresAt: 1000, costUnits: 1 });
  // Only trusted runtime gate/ingress are doubles; sender, leases, SQLite and
  // uncertain outcome persistence use the real coordinator and Outbox.
  const runtime = { outbox, sendGate: () => ({ allowed: true, reason: 'NONE' }), recordDelivery:()=>{}, receive: async () => {}, idle: async () => {} };
  const dispatcher = new DispatchCoordinator(runtime, {}, {}, () => 100); let sends = 0;
  const timer = clock(); const runner = createRunner({ runtime, dispatcher, accounts: [{ id: JSON.stringify(['local-test', 'fixture', 'account']), budget: () => ({ id: 'window', limit: 10 }), send: async () => { sends++; throw new Error('uncertain network'); } }],
    now: timer.now, setTimer: timer.setTimer, clearTimer: timer.clearTimer, intervalMs: 100 });
  await runner.start(); await runner.runOnce(); assert.equal(outbox.list()[0].status, 'unknown');
  await runner.runOnce(); assert.equal(sends, 1); assert.equal(outbox.list()[0].status, 'unknown');
  await runner.stop();
});
