import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { CodeTasks } from '../src/code-jobs.ts';
import { DurableOutbox } from '../src/outbox.ts';
import { createCodeInteractions } from '../host/code-interactions.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); const store = new SqliteStateStore(db, { namespace: 'interaction-test', initialize: true });
  const key = JSON.stringify(['juebot-conversation-v1', 'bot', 'persona', 'qq-personal', 'fixture', 'one', 'direct', 'admin']);
  const grant = { revision: 1, adminActor: 'admin', conversationKey: key, account: 'one', workspaceId: 'work', sessionId: 'session',
    modelConfigured: true, budgetAvailable: true, sandboxVerified: true, toolsRestricted: true, allowedTools: ['read'], verified: true };
  const code = new CodeTasks(store, { getAuthorization: () => grant }); code.enable(1);
  const task = code.admit({ eventId: 'original-event', actor: 'admin', conversationKey: key, account: 'one', plain: true, text: 'Original task' }, 2).task;
  code.start(task.id, 3); const outbox = new DurableOutbox(store); let now = 1000, allowed = true;
  const deps = { store, code, getOutbox: () => outbox, now: () => now, timeoutMs: 60000, ...options };
  const broker = createCodeInteractions(deps);
  t.after(() => { broker.close(); store.close(); db.close(); });
  const check = () => { if (!allowed) throw Object.assign(Error('CODE_AUTH_CHANGED'), { code: 'CODE_AUTH_CHANGED' }); };
  const payload = { kind: 'approval', taskId: task.id, sessionId: 'juebot-code-derived-sdk-session', callId: 'call-1',
    approval: { toolName: 'read', args: { path: '/synthetic/file' }, reason: 'Read required', displayReason: 'Read this exact file' } };
  const start = (input = payload, signal) => { const promise = broker.request(input, { check, signal }); promise.catch(() => {}); return promise; };
  const source = (eventId = 'reply-event') => ({ eventId, actor: 'admin', conversationKey: key, account: 'one', plain: true, text: 'Trusted parsed reply', observedAt: now });
  return { db, store, code, task, outbox, broker, deps, payload, check, start, source, key, revoke: () => { allowed = false; }, time: value => { now = value; } };
}
const approvalResponse = (f, row, extra = {}) => ({ requestId: row.id, revision: row.revision, kind: 'approval', decision: 'allowed-once', source: f.source(), ...extra });
async function settledForArchive(f, { task = f.task, callId = 'call-1', stop = true } = {}) {
  const promise = f.start({ ...f.payload, taskId: task.id, callId }); const row = f.broker.list().find(item => item.callId === callId && item.taskId === task.id);
  f.broker.respond(approvalResponse(f, row, { source: f.source('reply-' + callId), decision: 'rejected' })); await promise;
  f.outbox.cancel(row.id + ':notice'); if (stop) f.code.stop(task.id, 1001);
  return f.broker.get(row.id);
}
const archiveInput = (...rows) => ({ ids: rows.map(row => ({ id: row.id, revision: row.revision })), reviewer: 'human-maintainer', reason: 'Reviewed completed local interaction' });

test('real SQLite approval notice and record commit together; same running promise resumes once while OFF and task input is immutable', async t => {
  const f = fixture(t); const before = f.code.get(f.task.id); const promise = f.start(); const row = f.broker.list()[0];
  assert.equal(row.status, 'pending'); assert.equal(row.revision, 1); assert.match(row.id, /^interaction-[a-f0-9-]+$/);
  const notice = f.outbox.list()[0]; assert.equal(notice.kind, 'code-interaction'); assert.equal(notice.account, JSON.stringify(['qq-personal', 'fixture', 'one']));
  assert.equal(notice.conversation, f.key); assert.equal(notice.body, row.text); assert.ok(notice.body.includes('/synthetic/file')); assert.ok(notice.body.includes(`/code审批 ${row.id} 1`));
  assert.deepEqual(notice.payload, { taskId: f.task.id, requestId: row.id, requestRevision: 1 }); assert.equal(f.broker.gate(notice).allowed, true);
  assert.throws(() => f.start(), /CODE_INTERACTION_PENDING/); f.code.disable(1001);
  assert.equal(f.broker.respond(approvalResponse(f, row)).accepted, true); assert.equal(await promise, 'allowed-once');
  assert.deepEqual(f.code.get(f.task.id).input, before.input); assert.equal(f.code.get(f.task.id).state, 'running');
  assert.equal(f.broker.replyEventId(f.task.id), 'reply-event'); assert.equal(f.broker.get(row.id).sourceHistory[0].observedAt, 1000);
  assert.equal(f.broker.gate(notice).allowed, false); assert.throws(() => f.broker.respond(approvalResponse(f, row)));
  assert.throws(() => f.start(), /CODE_INTERACTION_DUPLICATE/);
});

test('SDK question answers match exact IDs/options and multiSelect, allow bounded custom, and preserve new reply source', async t => {
  const f = fixture(t); const questions = [{ id: 'q1', question: 'Choose one', options: [{ label: 'A', description: 'First' }, { label: 'B' }] },
    { id: 'q2', question: 'Choose several', options: [{ label: 'C' }, { label: 'D' }], multiSelect: true }, { id: 'q3', question: 'Explain' }];
  const promise = f.start({ kind: 'question', taskId: f.task.id, sessionId: f.payload.sessionId, callId: 'questions', questions }); const row = f.broker.list()[0];
  assert.ok(row.text.includes(`/code答复 ${row.id} 1`));
  const answers = [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['C', 'D'] }, { id: 'q3', selected: [], custom: 'Human explanation' }];
  for (const invalid of [answers.slice(1), [...answers, answers[0]], [{ ...answers[0], selected: ['UNKNOWN'] }, ...answers.slice(1)],
    [{ ...answers[0], selected: ['A', 'B'] }, ...answers.slice(1)], [{ ...answers[0], approved: true }, ...answers.slice(1)]]) {
    assert.throws(() => f.broker.respond({ requestId: row.id, revision: 1, kind: 'question', answers: invalid, source: f.source() }));
    assert.equal(f.broker.get(row.id).revision, 1); assert.equal(f.broker.replyEventId(f.task.id), 'original-event');
  }
  f.broker.respond({ requestId: row.id, revision: 1, kind: 'question', answers, source: f.source() });
  assert.deepEqual(await promise, { answers });
  const next = f.start({ ...f.payload, callId: 'next' }); const nextRow = f.broker.list().find(item => item.status === 'pending');
  assert.throws(() => f.broker.respond(approvalResponse(f, nextRow)), /CODE_INTERACTION_EVENT_CONFLICT/);
  f.broker.respond(approvalResponse(f, nextRow, { decision: 'rejected', source: f.source('next-reply') })); assert.equal(await next, 'rejected');
  assert.equal(f.broker.replyEventId(f.task.id), 'next-reply');
});

test('route, stale revision, nonplain, replayed origin, future/stale source and non-single-use approval cannot answer', async t => {
  const f = fixture(t); const promise = f.start(); const row = f.broker.list()[0];
  for (const patch of [{ actor: 'other' }, { account: 'other' }, { conversationKey: 'other' }, { plain: false },
    { eventId: 'original-event' }, { observedAt: 999 }, { observedAt: 1001 }]) {
    assert.throws(() => f.broker.respond(approvalResponse(f, row, { source: { ...f.source(), ...patch } })));
  }
  for (const patch of [{ revision: 0 }, { kind: 'question' }, { decision: 'allowed-always' }, { answers: [] }, { principal: 'forged' }]) assert.throws(() => f.broker.respond(approvalResponse(f, row, patch)));
  assert.equal(f.broker.get(row.id).status, 'pending'); assert.equal(f.broker.replyEventId(f.task.id), 'original-event');
  f.broker.respond(approvalResponse(f, row, { decision: 'rejected' })); assert.equal(await promise, 'rejected');
});

test('revocation is rechecked at answer and send; it never grants approval or changes the original source', async t => {
  const f = fixture(t); const controller = new AbortController(); const promise = f.start(f.payload, controller.signal); const row = f.broker.list()[0];
  f.revoke(); assert.equal(f.broker.gate(f.outbox.list()[0]).allowed, false); assert.throws(() => f.broker.respond(approvalResponse(f, row)), /CODE_AUTH_CHANGED/);
  assert.equal(f.broker.replyEventId(f.task.id), 'original-event'); controller.abort(); await assert.rejects(promise, /CODE_INTERACTION_CANCELLED/);
  assert.equal(f.broker.get(row.id).status, 'cancelled');
});

test('expiry and close reject the existing promise, preserve records, and cannot be answered later', async t => {
  const f = fixture(t, { timeoutMs: 10 }); const promise = f.start(); const row = f.broker.list()[0];
  await assert.rejects(promise, /CODE_INTERACTION_EXPIRED/); assert.equal(f.broker.get(row.id).status, 'expired');
  assert.throws(() => f.broker.respond(approvalResponse(f, row))); assert.equal(f.broker.gate(f.outbox.list()[0]).allowed, false);
  const next = f.start({ ...f.payload, callId: 'call-2' }); f.broker.close(); await assert.rejects(next, /CODE_INTERACTION_CLOSED/);
  assert.equal(f.broker.list().find(item => item.callId === 'call-2').status, 'needs-review'); assert.throws(() => f.start({ ...f.payload, callId: 'call-3' }));
});

test('new broker sees persisted pending records as needs-review without a live resolver and refuses stale replies', async t => {
  const f = fixture(t); const promise = f.start(); const row = f.broker.list()[0];
  const restarted = createCodeInteractions(f.deps); t.after(() => restarted.close());
  assert.equal(restarted.get(row.id).status, 'needs-review'); assert.equal(restarted.get(row.id).revision, 2);
  assert.throws(() => restarted.respond(approvalResponse(f, row))); assert.equal(restarted.gate(f.outbox.list()[0]).allowed, false);
  f.broker.close(); await assert.rejects(promise, /CODE_INTERACTION_CLOSED/);
  assert.equal(restarted.replyEventId(f.task.id), 'original-event');
});

test('Outbox enqueue failure after its SQLite write rolls back both notice and request; oversized args fail closed without truncation', t => {
  const f = fixture(t);
  const failing = createCodeInteractions({ ...f.deps, getOutbox: () => ({ enqueueIn(tx, input) { f.outbox.enqueueIn(tx, input); throw Error('Synthetic enqueue failure'); } }) });
  t.after(() => failing.close());
  assert.throws(() => failing.request(f.payload, { check: f.check })); assert.equal(failing.list().length, 0); assert.equal(f.outbox.list().length, 0);
  assert.throws(() => f.start({ ...f.payload, approval: { ...f.payload.approval, args: { value: 'x'.repeat(12001) } } }));
  assert.equal(f.broker.list().length, 0); assert.equal(f.outbox.list().length, 0);
});

test('logical grant session differs from trusted derived SDK session; omitted SDK reasons work and later session changes fail', async t => {
  const f = fixture(t); assert.notEqual(f.payload.sessionId, f.task.authorization.sessionId);
  const promise = f.start({ ...f.payload, approval: { toolName: 'read', args: { path: '/exact/file' }, reason: undefined, displayReason: undefined } });
  const row = f.broker.list()[0]; assert.equal(row.sessionId, f.payload.sessionId); assert.equal(row.authorization.sessionId, 'session');
  assert.deepEqual(row.approval, { toolName: 'read', args: { path: '/exact/file' } });
  f.broker.respond(approvalResponse(f, row, { decision: 'rejected' })); assert.equal(await promise, 'rejected');
  assert.throws(() => f.start({ ...f.payload, callId: 'another', sessionId: 'other-derived-sdk-session' }), /CODE_INTERACTION_SESSION_CHANGED/);
  const g = fixture(t); assert.throws(() => g.broker.request(g.payload, { check: () => false })); assert.equal(g.broker.list().length, 0);
});

test('second precision source time is preserved and prototype-like event IDs are globally deduplicated', async t => {
  const f = fixture(t); f.time(1555); const promise = f.start(); const row = f.broker.list()[0];
  f.broker.respond(approvalResponse(f, row, { source: { ...f.source('__proto__'), observedAt: 1000 } }));
  assert.equal(await promise, 'allowed-once'); assert.equal(f.broker.get(row.id).sourceHistory[0].observedAt, 1000);
  assert.equal(f.broker.replyEventId(f.task.id), '__proto__');
  const next = f.start({ ...f.payload, callId: 'next' }); const pending = f.broker.list().find(item => item.status === 'pending');
  assert.throws(() => f.broker.respond(approvalResponse(f, pending, { source: f.source('__proto__') })), /CODE_INTERACTION_EVENT_CONFLICT/);
  f.broker.respond(approvalResponse(f, pending, { source: f.source('actual-next-event'), decision: 'rejected' })); assert.equal(await next, 'rejected');
});

test('prototype-like request IDs are absent and state capacity reserves room for a worst-case escaped human source', async t => {
  const f = fixture(t);
  for (const id of ['constructor', '__proto__', 'toString']) assert.throws(() => f.broker.get(id), /CODE_INTERACTION_NOT_FOUND/);
  const key = JSON.stringify(['code-interactions-v1', 'default']);
  f.store.atomic(tx => tx.write(key, 0, { records: { history: { id: 'history', status: 'answered', text: 'x'.repeat(7 * 1024 * 1024 - 400000) } }, replies: {}, events: {} }));
  const promise = f.start(); const row = f.broker.list().find(item => item.status === 'pending');
  f.broker.respond(approvalResponse(f, row, { source: { ...f.source(), text: '\u0001'.repeat(16000) } }));
  assert.equal(await promise, 'allowed-once'); assert.equal(f.broker.replyEventId(f.task.id), 'reply-event');
  const current = f.store.read(key);
  f.store.atomic(tx => { current.value.records.history.text += 'x'.repeat(190000); tx.write(key, current.revision, current.value); });
  const before = f.outbox.list().length;
  assert.throws(() => f.start({ ...f.payload, callId: 'cannot-reserve' }), /CODE_INTERACTION_CAPACITY/);
  assert.equal(f.outbox.list().length, before);
});

test('real SQLite write failure in timeout/abort callbacks rejects the original wait without an uncaught error or approval', async t => {
  for (const path of ['timeout', 'abort']) {
    const f = fixture(t, { timeoutMs: path === 'timeout' ? 15 : 60000 }); const controller = new AbortController();
    const promise = f.start(f.payload, controller.signal); const row = f.broker.list()[0], notices = f.outbox.list(); let resolved = false;
    promise.then(() => { resolved = true; }, () => {});
    f.db.exec('PRAGMA query_only=ON');
    const rejected = assert.rejects(promise, /CODE_INTERACTION_STORAGE_FAILURE/);
    if (path === 'abort') assert.doesNotThrow(() => controller.abort());
    await rejected;
    assert.equal(resolved, false); assert.deepEqual(f.broker.get(row.id), row); assert.deepEqual(f.outbox.list(), notices);
    assert.equal(f.broker.gate(notices[0]).allowed, false); assert.throws(() => f.broker.respond(approvalResponse(f, row)));
    assert.equal(f.broker.replyEventId(f.task.id), 'original-event');
    f.db.exec('PRAGMA query_only=OFF');
    const restarted = createCodeInteractions(f.deps); t.after(() => restarted.close());
    assert.equal(restarted.get(row.id).status, 'needs-review'); assert.equal(f.outbox.list().length, 1);
  }
});

test('close cleans every live waiter even when SQLite rejects all persistent status updates', async t => {
  const f = fixture(t); const first = f.start();
  const secondTask = f.code.admit({ ...f.task.input, eventId: 'second-original-event' }, 4).task;
  f.code.start(secondTask.id, 5);
  const second = f.start({ ...f.payload, taskId: secondTask.id, callId: 'second-call' });
  const before = f.broker.list(), notices = f.outbox.list();
  f.db.exec('PRAGMA query_only=ON');
  const rejectedFirst = assert.rejects(first, /CODE_INTERACTION_STORAGE_FAILURE/);
  const rejectedSecond = assert.rejects(second, /CODE_INTERACTION_STORAGE_FAILURE/);
  assert.doesNotThrow(() => f.broker.close()); assert.doesNotThrow(() => f.broker.close());
  await Promise.all([rejectedFirst, rejectedSecond]);
  assert.deepEqual(f.broker.list(), before); assert.deepEqual(f.outbox.list(), notices);
  for (const notice of notices) assert.equal(f.broker.gate(notice).allowed, false);
  assert.throws(() => f.start({ ...f.payload, callId: 'after-close' }), /CODE_INTERACTION_UNAVAILABLE/);
  f.db.exec('PRAGMA query_only=OFF');
  const restarted = createCodeInteractions(f.deps); t.after(() => restarted.close());
  assert.equal(restarted.list().every(row => row.status === 'needs-review'), true);
});

test('respond SQLite write failure propagates and does not consume the response or resolve an approval', async t => {
  const f = fixture(t); const controller = new AbortController(), promise = f.start(f.payload, controller.signal);
  const row = f.broker.list()[0], before = f.outbox.list(); let resolved = false;
  promise.then(() => { resolved = true; }, () => {});
  f.db.exec('PRAGMA query_only=ON');
  assert.throws(() => f.broker.respond(approvalResponse(f, row)), /STORAGE_FAILURE/);
  await Promise.resolve(); assert.equal(resolved, false);
  assert.deepEqual(f.broker.get(row.id), row); assert.deepEqual(f.outbox.list(), before);
  assert.equal(f.broker.replyEventId(f.task.id), 'original-event');
  f.db.exec('PRAGMA query_only=OFF');
  // A failed durable response remains pending; only a new successful transaction may resolve it.
  f.broker.respond(approvalResponse(f, row, { decision: 'rejected' }));
  assert.equal(await promise, 'rejected'); assert.equal(f.broker.get(row.id).response, 'rejected');
});

test('Chinese and emoji tool arguments exceeding QQ UTF8 notice bytes fail closed with zero durable request or notice', async t => {
  const f = fixture(t); const key = JSON.stringify(['code-interactions-v1', 'default']);
  for (const value of ['汉'.repeat(6000), '😀'.repeat(4500)]) {
    const input = { ...f.payload, approval: { toolName: 'read', args: { value } } };
    assert.ok(JSON.stringify(input).length <= 12000, 'payload fits the character bound but must fail the notice byte bound');
    assert.throws(() => f.start(input), /CODE_INTERACTION_TOO_LARGE/);
    assert.equal(f.broker.list().length, 0); assert.equal(f.outbox.list().length, 0); assert.equal(f.store.read(key), null);
  }
  const promise = f.start({ ...f.payload, approval: { toolName: 'read', args: { value: '汉'.repeat(2000) } } });
  const row = f.broker.list()[0]; assert.ok(Buffer.byteLength(row.text, 'utf8') <= 16000); assert.ok(row.text.includes('汉'.repeat(2000)));
  f.broker.respond(approvalResponse(f, row, { decision: 'rejected' })); assert.equal(await promise, 'rejected');
});

test('explicit authorized archive moves complete settled records to cold storage with hash receipts and bounded metadata only', async t => {
  let checks = 0;
  const f = fixture(t, { authorizeMaintenance: reviewer => { checks++; return reviewer === 'human-maintainer'; } });
  const row = await settledForArchive(f); const outbox = f.outbox.list(); const source = f.broker.replyEventId(f.task.id);
  const receipt = f.broker.archive(archiveInput(row));
  assert.equal(checks, 2); assert.equal(receipt.archived, true); assert.equal(receipt.count, 1); assert.match(receipt.batchHash, /^[a-f0-9]{64}$/);
  assert.equal(f.broker.list().length, 0); const cold = f.broker.get(row.id);
  const { archive, ...original } = cold; assert.deepEqual(original, row); assert.equal(archive.sha256, receipt.receipts[0].sha256);
  assert.equal(archive.reviewer, 'human-maintainer'); assert.equal(archive.reason, archiveInput(row).reason);
  assert.deepEqual(f.outbox.list(), outbox); assert.equal(f.broker.replyEventId(f.task.id), source);
  const page = f.broker.listArchives(); assert.equal(page.total, 1); assert.equal(page.nextOffset, null);
  assert.equal(page.items[0].id, row.id); assert.equal(JSON.stringify(page).includes('/synthetic/file'), false); assert.equal(JSON.stringify(page).includes('sourceHistory'), false);
  assert.deepEqual(f.broker.listArchives({ offset: 1, limit: 1 }).items, []);
  assert.throws(() => f.broker.respond(approvalResponse(f, row))); assert.throws(() => f.broker.archive(archiveInput(row)));
  const restarted = createCodeInteractions(f.deps); t.after(() => restarted.close()); assert.deepEqual(restarted.get(row.id), cold); assert.equal(restarted.list().length, 0);
});

test('archive requires a synchronous true maintenance authority before and after writing and validates exact batch inputs', async t => {
  for (const authority of [undefined, () => false, () => Promise.resolve(true), () => Promise.reject(Error('PRIVATE'))]) {
    const f = fixture(t, { authorizeMaintenance: authority }); const row = await settledForArchive(f);
    assert.throws(() => f.broker.archive(archiveInput(row)), /CODE_INTERACTION_MAINTENANCE_DENIED/); assert.deepEqual(f.broker.list(), [row]);
  }
  const f = fixture(t, { authorizeMaintenance: () => true }); const row = await settledForArchive(f);
  for (const input of [{ ...archiveInput(row), ids: [] }, { ...archiveInput(row), ids: [...archiveInput(row).ids, ...archiveInput(row).ids] },
    { ...archiveInput(row), ids: Array.from({ length: 33 }, (_, n) => ({ id: 'request-' + n, revision: 1 })) },
    { ...archiveInput(row), reviewer: '' }, { ...archiveInput(row), reason: '' }, { ...archiveInput(row), reason: 'x'.repeat(4001) },
    { ...archiveInput(row), approved: true }, { ...archiveInput(row), ids: [{ id: row.id, revision: row.revision, extra: true }] },
    Object.assign(Object.create({ hidden: true }), archiveInput(row))]) assert.throws(() => f.broker.archive(input));
  for (const options of [{ limit: 101 }, { offset: -1 }, { owner: true }, []]) assert.throws(() => f.broker.listArchives(options));
  let attempts = 0;
  const g = fixture(t, { authorizeMaintenance: () => ++attempts === 1 }); const item = await settledForArchive(g);
  assert.throws(() => g.broker.archive(archiveInput(item))); assert.deepEqual(g.broker.list(), [item]); assert.equal(g.broker.listArchives().total, 0);
});

test('archive rejects pending/live, running tasks, ready or held results, missing or unsettled notices, and stale CAS', async t => {
  const pending = fixture(t, { authorizeMaintenance: () => true }); const wait = pending.start(), row = pending.broker.list()[0];
  pending.outbox.cancel(row.id + ':notice'); pending.code.stop(pending.task.id, 1001);
  assert.throws(() => pending.broker.archive(archiveInput(row))); pending.broker.close(); await assert.rejects(wait);
  for (const scenario of ['running', 'ready', 'held', 'queued', 'sending', 'unknown', 'held-notice', 'missing', 'stale', 'source-change']) {
    const f = fixture(t, { authorizeMaintenance: () => true }); const item = await settledForArchive(f, { stop: !['running', 'ready', 'held'].includes(scenario) });
    if (['ready', 'held'].includes(scenario)) { f.code.finish(f.task.id, 'Retained final result', 1002); if (scenario === 'held') f.code.restart(1003); }
    if (['queued', 'sending', 'unknown', 'held-notice', 'missing'].includes(scenario)) f.store.atomic(tx => {
      const queue = tx.read('outbox:v1'); if (scenario === 'missing') queue.value.items = [];
      else queue.value.items[0].status = scenario === 'held-notice' ? 'held' : scenario;
      tx.write('outbox:v1', queue.revision, queue.value);
    });
    if (scenario === 'source-change') f.store.atomic(tx => {
      const key = JSON.stringify(['code-jobs-v1', 'default']), s = tx.read(key); s.value.tasks[f.task.id].input.eventId = 'Changed-source'; tx.write(key, s.revision, s.value);
    });
    const request = archiveInput(item); if (scenario === 'stale') request.ids[0].revision--;
    assert.throws(() => f.broker.archive(request), scenario); assert.deepEqual(f.broker.list(), [item]); assert.equal(f.broker.listArchives().total, 0);
  }
  const completed = fixture(t, { authorizeMaintenance: () => true }); const item = await settledForArchive(completed, { stop: false });
  completed.code.finish(completed.task.id, 'Delivered result', 1002); completed.code.markResultDelivered(completed.task.id, 1003);
  assert.equal(completed.broker.archive(archiveInput(item)).count, 1);
});

test('whole-batch validation and real SQLite write faults roll back cold copies, hot removals and index writes together', async t => {
  const f = fixture(t, { authorizeMaintenance: () => true }); const first = await settledForArchive(f);
  const other = f.code.admit({ ...f.task.input, eventId: 'second-input' }, 1002).task; f.code.start(other.id, 1003);
  const second = await settledForArchive(f, { task: other, callId: 'second-call' }); const before = f.broker.list(), queue = f.outbox.list();
  assert.throws(() => f.broker.archive({ ...archiveInput(first, second), ids: [{ id: first.id, revision: first.revision }, { id: second.id, revision: 0 }] }));
  assert.deepEqual(f.broker.list(), before); assert.equal(f.broker.listArchives().total, 0);
  f.db.exec('PRAGMA query_only=ON'); assert.throws(() => f.broker.archive(archiveInput(first, second))); f.db.exec('PRAGMA query_only=OFF');
  assert.deepEqual(f.broker.list(), before); assert.equal(f.broker.listArchives().total, 0);
  // Fail late, after both cold writes and the hot-state write, at archive-index insertion.
  const indexKey = JSON.stringify(['code-interactions-archives-v1', 'default']);
  f.db.exec(`CREATE TEMP TRIGGER archive_failure BEFORE INSERT ON agent_state WHEN NEW.key = '${indexKey}' BEGIN SELECT RAISE(ABORT, 'synthetic archive failure'); END`);
  assert.throws(() => f.broker.archive(archiveInput(first, second)));
  assert.deepEqual(f.broker.list(), before); assert.deepEqual(f.outbox.list(), queue); assert.equal(f.broker.listArchives().total, 0);
  for (const item of [first, second]) assert.equal(f.store.read(JSON.stringify(['code-interactions-archive-v1', 'default', item.id])), null);
  f.db.exec('DROP TRIGGER archive_failure'); assert.equal(f.broker.archive(archiveInput(first, second)).count, 2);
  assert.equal(f.broker.listArchives({ offset: 0, limit: 1 }).nextOffset, 1);
});

test('archiving never frees reply-event dedupe and archive index/events have permanent explicit bounds', async t => {
  const f = fixture(t, { authorizeMaintenance: () => true }); const first = await settledForArchive(f); f.broker.archive(archiveInput(first));
  const other = f.code.admit({ ...f.task.input, eventId: 'other-task' }, 1002).task; f.code.start(other.id, 1003);
  const wait = f.start({ ...f.payload, taskId: other.id, callId: 'other-call' }); const pending = f.broker.list()[0];
  assert.throws(() => f.broker.respond(approvalResponse(f, pending, { source: f.source('reply-call-1') })), /CODE_INTERACTION_EVENT_CONFLICT/);
  f.broker.respond(approvalResponse(f, pending, { decision: 'rejected', source: f.source('fresh-event') })); assert.equal(await wait, 'rejected');
  f.outbox.cancel(pending.id + ':notice'); f.code.stop(other.id, 1004);
  const indexKey = JSON.stringify(['code-interactions-archives-v1', 'default']);
  f.store.atomic(tx => { const s = tx.read(indexKey); s.value.items = Array.from({ length: 4096 }, (_, n) => ({ id: 'retained-' + n })); tx.write(indexKey, s.revision, s.value); });
  assert.throws(() => f.broker.archive(archiveInput(f.broker.get(pending.id)))); assert.equal(f.broker.list().length, 1);
  const stateKey = JSON.stringify(['code-interactions-v1', 'default']);
  f.store.atomic(tx => { const s = tx.read(stateKey); s.value.events = Object.fromEntries(Array.from({ length: 4096 }, (_, n) => ['historic-event-' + n, first.id])); tx.write(stateKey, s.revision, s.value); });
  const third = f.code.admit({ ...f.task.input, eventId: 'third-task' }, 1005).task; f.code.start(third.id, 1006);
  assert.throws(() => f.start({ ...f.payload, taskId: third.id, callId: 'third-call' }), /CODE_INTERACTION_CAPACITY/);
});

test('closed broker cannot archive and closure inside either maintenance check leaves no cold copy or hot removal', async t => {
  for (const boundary of ['before', 'first-check', 'final-check']) {
    let f, checks = 0;
    f = fixture(t, { authorizeMaintenance: () => {
      checks++;
      if ((boundary === 'first-check' && checks === 1) || (boundary === 'final-check' && checks === 2)) f.broker.close();
      return true;
    } });
    const row = await settledForArchive(f), before = f.broker.list(), outbox = f.outbox.list();
    if (boundary === 'before') f.broker.close();
    assert.throws(() => f.broker.archive(archiveInput(row)));
    assert.equal(checks, boundary === 'before' ? 0 : boundary === 'first-check' ? 1 : 2);
    assert.deepEqual(f.broker.list(), before); assert.deepEqual(f.broker.get(row.id), row);
    assert.equal(f.broker.listArchives().total, 0); assert.deepEqual(f.outbox.list(), outbox);
    assert.equal(f.store.read(JSON.stringify(['code-interactions-archive-v1', 'default', row.id])), null);
    assert.equal(f.store.read(JSON.stringify(['code-interactions-archives-v1', 'default'])), null);
  }
});

test('archive rejects a clock before any selected record creation without writing archive data', async t => {
  const f = fixture(t, { authorizeMaintenance: () => true }); const row = await settledForArchive(f);
  f.time(row.createdAt - 1); const before = f.broker.list();
  assert.throws(() => f.broker.archive(archiveInput(row)));
  assert.deepEqual(f.broker.list(), before); assert.equal(f.broker.listArchives().total, 0);
  assert.equal(f.store.read(JSON.stringify(['code-interactions-archive-v1', 'default', row.id])), null);
  f.time(row.createdAt); assert.equal(f.broker.archive(archiveInput(row)).receipts[0].archivedAt, row.createdAt);
});

test('maintenance hooks cannot replace reviewed archive input, reviewer, reason, selected IDs or CAS', async t => {
  let request, checks = 0; const seen = [];
  const f = fixture(t, { authorizeMaintenance: reviewer => {
    seen.push(reviewer); checks++;
    if (checks === 1) {
      request.reviewer = 'unreviewed-user'; request.reason = 'Unreviewed replacement reason';
      request.ids[0].id = 'unreviewed-request'; request.ids[0].revision = 999; request.ids.push({ id: 'extra-request', revision: 1 });
    }
    return reviewer === 'human-maintainer';
  } });
  const row = await settledForArchive(f); request = archiveInput(row); const reviewed = structuredClone(request);
  const result = f.broker.archive(request);
  assert.equal(result.count, 1); assert.equal(result.receipts[0].id, row.id); assert.equal(result.receipts[0].revision, row.revision);
  assert.deepEqual(seen, ['human-maintainer', 'human-maintainer']);
  const saved = f.broker.get(row.id);
  assert.equal(saved.archive.reviewer, reviewed.reviewer); assert.equal(saved.archive.reason, reviewed.reason);
  const { archive: _metadata, ...original } = saved; assert.deepEqual(original, row);
  assert.equal(f.broker.listArchives().items[0].reviewer, reviewed.reviewer);
});
