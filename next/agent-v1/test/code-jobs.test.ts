import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../src/store.ts';
import { CodeTasks } from '../src/code-jobs.ts';
import type { CodeAuthorization, CodeInput } from '../src/code-jobs.ts';
import { conversationKey } from '../../conversation-v1/src/identity.ts';

const key = conversationKey({ botId: 'bot', personaId: 'juejue', connector: 'qq-personal', issuer: 'test-issuer', accountId: 'account', kind: 'direct', remoteId: 'admin' });
const authorization: CodeAuthorization = { revision: 1, adminActor: 'admin', conversationKey: key, account: 'account',
  workspaceId: 'workspace', sessionId: 'session', modelConfigured: true, budgetAvailable: true, sandboxVerified: true,
  toolsRestricted: true, allowedTools: ['read-file', 'edit-file'], verified: true };
const input: CodeInput = { eventId: 'incoming-a', actor: 'admin', conversationKey: key, account: 'account', plain: true, text: 'SYNTHETIC-CODE-REQUEST' };
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  const store = new SqliteStateStore(db, { namespace: 'test', initialize: true });
  t.after(() => { store.close(); db.close(); });
  let grant: CodeAuthorization | null = structuredClone(authorization);
  const jobs = new CodeTasks(store, { getAuthorization: () => grant });
  return { db, store, jobs, setGrant: (value: CodeAuthorization | null) => { grant = value; } };
}

test('missing verification, model, budget, sandbox or restricted tools cannot enable', t => {
  for (const prerequisite of ['verified', 'modelConfigured', 'budgetAvailable', 'sandboxVerified', 'toolsRestricted'] as const) {
    const f = fixture(t); f.setGrant({ ...authorization, [prerequisite]: false });
    assert.throws(() => f.jobs.enable(1), code(prerequisite === 'verified' ? 'CODE_NOT_AUTHORIZED' : 'CODE_PREREQUISITES_MISSING'));
    assert.equal(f.jobs.snapshot().value.enabled, false);
  }
  const f = fixture(t); f.setGrant(null); assert.throws(() => f.jobs.enable(1), code('CODE_NOT_AUTHORIZED'));
});
test('only trusted verified administrator plain private route is admitted', t => {
  const f = fixture(t); f.jobs.enable(1);
  for (const patch of [{ actor: 'impostor' }, { account: 'other' }, { conversationKey: 'fake' }]) {
    assert.throws(() => f.jobs.admit({ ...input, ...patch }, 2), code('CODE_ADMIN_ROUTE_REQUIRED'));
  }
  assert.throws(() => f.jobs.admit({ ...input, plain: false } as unknown as CodeInput, 2), code('CODE_PLAIN_INPUT_REQUIRED'));
  assert.throws(() => f.jobs.admit({ ...input, forwarded: true } as CodeInput, 2));
  assert.equal(f.jobs.list().length, 0);
  const group = conversationKey({ botId: 'bot', personaId: 'juejue', connector: 'qq-personal', issuer: 'test-issuer', accountId: 'account', kind: 'group', remoteId: 'admin' });
  f.setGrant({ ...authorization, conversationKey: group });
  assert.throws(() => f.jobs.enable(3), code('CODE_PRIVATE_ROUTE_REQUIRED'));
});
test('admission is persistent-idempotent and changed content conflicts, including OFF replays', t => {
  const f = fixture(t); f.jobs.enable(1);
  const first = f.jobs.admit(input, 2); const duplicate = f.jobs.admit(input, 3);
  assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true); assert.deepEqual(first.task, duplicate.task);
  assert.throws(() => f.jobs.admit({ ...input, text: 'changed' }, 3), code('CODE_EVENT_CONFLICT'));
  f.jobs.disable(4);
  assert.equal(f.jobs.admit(input, 5).duplicate, true);
  assert.throws(() => f.jobs.admit({ ...input, eventId: 'new' }, 5), code('CODE_DISABLED'));
});
test('OFF holds queued work while a running task continues and returns its result', t => {
  const f = fixture(t); f.jobs.enable(1);
  const running = f.jobs.admit(input, 2).task;
  const queued = f.jobs.admit({ ...input, eventId: 'incoming-b' }, 2).task;
  f.jobs.start(running.id, 3); f.jobs.disable(4);
  assert.equal(f.jobs.get(running.id).state, 'running'); assert.equal(f.jobs.get(queued.id).state, 'held');
  assert.throws(() => f.jobs.start(queued.id, 5), code('CODE_DISABLED'));
  const finished = f.jobs.finish(running.id, 'CODE-RESULT', 5);
  assert.equal(finished.state, 'completed'); assert.equal(finished.resultDelivery, 'ready');
  const result = f.jobs.takeResult(running.id); assert.equal(result.id, `${running.id}:result`); assert.equal(result.result, 'CODE-RESULT');
  assert.equal(f.jobs.takeResult(running.id).id, result.id, 'repeated handoff uses the same Outbox id');
  f.jobs.markResultDelivered(running.id, 6); assert.equal(f.jobs.get(running.id).resultDelivery, 'delivered');
  assert.throws(() => f.jobs.takeResult(running.id), code('CODE_RESULT_HELD'));
  f.jobs.enable(7); assert.equal(f.jobs.get(queued.id).state, 'held');
});
test('finish is idempotent, stores empty results, and never overwrites a completed result', t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task; f.jobs.start(task.id, 3);
  const first = f.jobs.finish(task.id, '', 4); assert.equal(first.result, '');
  assert.deepEqual(f.jobs.finish(task.id, '', 5), first);
  assert.throws(() => f.jobs.finish(task.id, 'different', 6), code('CODE_RESULT_CONFLICT'));
});
test('grant changes block queued execution and automatic results while retaining completed output', t => {
  for (const patch of [{ revision: 2 }, { adminActor: 'new-admin' }, { account: 'new-account' }, { verified: false }, { workspaceId: 'other-workspace' }, { allowedTools: [] }]) {
    const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task; f.jobs.start(task.id, 3);
    f.setGrant({ ...authorization, ...patch });
    const finished = f.jobs.finish(task.id, 'KEEP-PRIVATE-CODE-RESULT', 4);
    assert.equal(finished.result, 'KEEP-PRIVATE-CODE-RESULT'); assert.equal(finished.resultDelivery, 'held');
    assert.throws(() => f.jobs.takeResult(task.id));
  }
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  f.setGrant({ ...authorization, revision: 2 });
  assert.throws(() => f.jobs.start(task.id, 3), code('CODE_AUTH_CHANGED'));
  f.jobs.enable(4); assert.equal(f.jobs.get(task.id).state, 'held');
});
test('executor is injected; tools and model calls recheck current grant and whitelist', async t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  await assert.rejects(f.jobs.execute(task.id), code('NOT_CONFIGURED')); assert.equal(f.jobs.get(task.id).state, 'queued');
  const done = await f.jobs.execute(task.id, async context => {
    context.gateModel(); context.gateTool('read-file');
    assert.throws(() => context.gateTool('shell'), code('CODE_TOOL_NOT_ALLOWED'));
    return 'synthetic-executor-result';
  }, { now: () => 3 });
  assert.equal(done.state, 'completed'); assert.equal(done.resultDelivery, 'ready');
});
test('OFF never aborts an executing task or blocks its allowed tools', async t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  const started = deferred<void>(); const release = deferred<void>();
  const executing = f.jobs.execute(task.id, async context => {
    started.resolve(); await release.promise; assert.equal(context.signal.aborted, false); context.gateTool('edit-file'); return 'finished-after-off';
  }, { now: () => 3 });
  await started.promise; f.jobs.disable(4); release.resolve(); const result = await executing;
  assert.equal(result.result, 'finished-after-off'); assert.equal(result.resultDelivery, 'ready');
});
test('authorization revision is checked before every tool, not only executor entry', async t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  await assert.rejects(f.jobs.execute(task.id, async context => {
    context.gateTool('read-file'); f.setGrant({ ...authorization, revision: 2 }); context.gateTool('edit-file'); return 'must-not-occur';
  }, { now: () => 3 }), code('CODE_AUTH_CHANGED'));
  assert.equal(f.jobs.get(task.id).state, 'needs-review'); assert.equal(f.jobs.get(task.id).result, null);
});
test('budget depletion is checked for later model and tool operations', async t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  await assert.rejects(f.jobs.execute(task.id, async context => {
    f.setGrant({ ...authorization, budgetAvailable: false }); context.gateModel(); return 'not-executed';
  }, { now: () => 3 }), code('CODE_PREREQUISITES_MISSING'));
  assert.equal(f.jobs.get(task.id).state, 'needs-review');
});
test('explicit stop differs from OFF: signals executor and holds any late result', async t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  const started = deferred<void>(); const release = deferred<void>();
  const executing = f.jobs.execute(task.id, async context => {
    started.resolve(); await release.promise; assert.equal(context.signal.aborted, true); return 'late-output-retained';
  }, { now: () => 3 });
  await started.promise; f.jobs.stop(task.id, 4); release.resolve();
  const completed = await executing;
  assert.equal(completed.state, 'stopped'); assert.equal(completed.result, 'late-output-retained'); assert.equal(completed.resultDelivery, 'held');
  assert.throws(() => f.jobs.takeResult(task.id), code('CODE_RESULT_HELD'));
});
test('executor failure and abort require review rather than automatic restart', async t => {
  const f = fixture(t); f.jobs.enable(1); const first = f.jobs.admit(input, 2).task;
  await assert.rejects(f.jobs.execute(first.id, async () => { throw new Error('PRIVATE-SHELL-PATH'); }, { now: () => 3 }), code('CODE_EXECUTION_FAILED'));
  assert.equal(f.jobs.get(first.id).state, 'needs-review');
  assert.throws(() => f.jobs.start(first.id, 4), code('CODE_TASK_NOT_QUEUED'));
  const second = f.jobs.admit({ ...input, eventId: 'second' }, 4).task;
  const abort = new AbortController();
  await assert.rejects(f.jobs.execute(second.id, async context => { abort.abort(); context.gateTool('read-file'); return 'never'; }, { now: () => 5, signal: abort.signal }), code('CODE_ABORTED'));
  assert.equal(f.jobs.get(second.id).state, 'needs-review');
});
test('restart goes OFF and requires explicit strategies for queued and running work', t => {
  const f = fixture(t); f.jobs.enable(1); const a = f.jobs.admit(input, 2).task;
  const b = f.jobs.admit({ ...input, eventId: 'b' }, 2).task; f.jobs.start(a.id, 3);
  const restarted = new CodeTasks(f.store, { getAuthorization: () => authorization });
  assert.throws(() => restarted.enable(4), code('CODE_RECOVERY_REQUIRED'));
  const after = restarted.restart(4); assert.equal(after.value.enabled, false);
  assert.equal(restarted.get(a.id).state, 'needs-review'); assert.equal(restarted.get(b.id).state, 'held');
  assert.throws(() => restarted.resume(a.id, undefined as unknown as 'requeue', 5), code('CODE_RECOVERY_STRATEGY_REQUIRED'));
  assert.throws(() => restarted.resume(a.id, 'requeue', 5), code('CODE_DISABLED'));
  restarted.enable(6); restarted.resume(a.id, 'keep-held', 6); assert.equal(restarted.get(a.id).state, 'held');
  restarted.resume(b.id, 'requeue', 7); assert.equal(restarted.get(b.id).state, 'queued');
  assert.equal(restarted.start(b.id, 8).state, 'running');
});
test('new process disk reopen preserves Code requests and results without any social record', t => {
  const directory = mkdtempSync(join(tmpdir(), 'juebot-code-jobs-'));
  let db = new DatabaseSync(join(directory, 'synthetic.sqlite'), { allowExtension: false });
  let store = new SqliteStateStore(db, { namespace: 'test', initialize: true });
  t.after(() => { store.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  let jobs = new CodeTasks(store, { getAuthorization: () => authorization }); jobs.enable(1);
  const task = jobs.admit(input, 2).task; jobs.start(task.id, 3); jobs.disable(4); jobs.finish(task.id, 'DISK-CODE-RESULT', 5);
  const rows = db.prepare('SELECT key FROM agent_state').all(); assert.equal(rows.length, 1); assert.ok(String(rows[0]!.key).includes('code-jobs-v1'));
  store.close(); db.close(); db = new DatabaseSync(join(directory, 'synthetic.sqlite'), { allowExtension: false });
  store = new SqliteStateStore(db, { namespace: 'test' }); jobs = new CodeTasks(store, { getAuthorization: () => authorization });
  assert.equal(jobs.get(task.id).result, 'DISK-CODE-RESULT'); assert.throws(() => jobs.takeResult(task.id), code('CODE_RECOVERY_REQUIRED'));
  jobs.restart(6); assert.equal(jobs.get(task.id).result, 'DISK-CODE-RESULT'); assert.equal(jobs.get(task.id).resultDelivery, 'held');
  jobs.releaseResult(task.id, 7); assert.equal(jobs.takeResult(task.id).result, 'DISK-CODE-RESULT');
});
test('explicit result release cannot disclose old Code material to a new admin or workspace', t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task; f.jobs.start(task.id, 3);
  f.setGrant({ ...authorization, revision: 2 }); f.jobs.finish(task.id, 'private-result', 4);
  f.setGrant({ ...authorization, revision: 3, adminActor: 'new-admin' });
  assert.throws(() => f.jobs.releaseResult(task.id, 5), code('CODE_ADMIN_ROUTE_REQUIRED'));
  f.setGrant({ ...authorization, revision: 4, workspaceId: 'new-workspace' });
  assert.throws(() => f.jobs.releaseResult(task.id, 6), code('CODE_ADMIN_ROUTE_REQUIRED'));
  f.setGrant({ ...authorization, revision: 5 }); f.jobs.releaseResult(task.id, 7);
  assert.equal(f.jobs.takeResult(task.id).result, 'private-result');
});
test('real SQLite failure cannot admit a partial ticket or publish a lost revision', t => {
  const f = fixture(t); f.jobs.enable(1); const before = f.jobs.snapshot();
  f.db.exec("CREATE TRIGGER fail_code_write BEFORE UPDATE ON agent_state BEGIN SELECT RAISE(ABORT,'PRIVATE-DB-ERROR'); END");
  assert.throws(() => f.jobs.admit(input, 2), code('STORAGE_FAILURE'));
  assert.deepEqual(f.jobs.snapshot(), before); assert.equal(f.jobs.list().length, 0);
  f.db.exec('DROP TRIGGER fail_code_write'); assert.equal(f.jobs.admit(input, 2).task.id, 'code-1');
});
test('readonly returned copies cannot alter persisted authorization or results', t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  task.authorization.allowedTools.push('shell'); task.input.actor = 'other';
  assert.deepEqual(f.jobs.get(task.id).authorization.allowedTools, ['read-file', 'edit-file']);
  assert.equal(f.jobs.get(task.id).input.actor, 'admin');
  assert.throws(() => f.jobs.get('__proto__'), code('CODE_TASK_NOT_FOUND'));
});

test('explicit recovery abandonment is atomic, OFF only, and never replays an old event', t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  f.jobs.start(task.id, 3); f.jobs.restart(4);
  const options = { expectedRevision: f.jobs.snapshot().revision, reviewer: 'owner', reason: 'Inspected interrupted work', now: 5 };
  assert.throws(() => f.store.atomic(tx => { f.jobs.abandonIn(tx, task.id, options); throw new Error('rollback'); }), code('STORAGE_FAILURE'));
  assert.equal(f.jobs.get(task.id).state, 'needs-review');
  const recovered = f.store.atomic(tx => f.jobs.abandonIn(tx, task.id, options));
  assert.equal(recovered.state, 'stopped'); assert.deepEqual(recovered.input, input);
  assert.equal(recovered.recovery?.reviewer, 'owner'); assert.equal(f.jobs.snapshot().value.enabled, false);
  f.jobs.enable(6); assert.equal(f.jobs.admit(input, 7).duplicate, true);
  assert.throws(() => f.jobs.resume(task.id, 'requeue', 8), code('CODE_TASK_NOT_HELD'));
  assert.equal(f.jobs.admit({ ...input, eventId: 'new-explicit-request' }, 9).task.id, 'code-2');
});

test('recovery rejects stale review, current execution, changed authority and saved results', async t => {
  const f = fixture(t); f.jobs.enable(1); const task = f.jobs.admit(input, 2).task;
  const pending = deferred<string>(); const run = f.jobs.execute(task.id, () => pending.promise, { now: () => 3 });
  f.jobs.stop(task.id, 4); f.jobs.disable(5);
  const options = () => ({ expectedRevision: f.jobs.snapshot().revision, reviewer: 'owner', reason: 'reviewed', now: 10 });
  assert.throws(() => f.store.atomic(tx => f.jobs.abandonIn(tx, task.id, options())), code('CODE_EXECUTION_ACTIVE'));
  pending.resolve('preserve-output'); await run;
  assert.throws(() => f.store.atomic(tx => f.jobs.abandonIn(tx, task.id, options())), code('CODE_RECOVERY_NOT_ALLOWED'));
  const g = fixture(t); g.jobs.enable(1); const old = g.jobs.admit(input, 2).task; g.jobs.start(old.id, 3); g.jobs.restart(4);
  const review = { expectedRevision: g.jobs.snapshot().revision, reviewer: 'owner', reason: 'reviewed', now: 5 };
  assert.throws(() => g.store.atomic(tx => g.jobs.abandonIn(tx, old.id, { ...review, expectedRevision: 1 })), code('CONFLICT'));
  g.setGrant({ ...authorization, revision: 2 });
  assert.throws(() => g.store.atomic(tx => g.jobs.abandonIn(tx, old.id, review)), code('CODE_AUTH_CHANGED'));
  g.setGrant(authorization); g.jobs.enable(6);
  assert.throws(() => g.store.atomic(tx => g.jobs.abandonIn(tx, old.id, { ...review, expectedRevision: g.jobs.snapshot().revision, now: 7 })), code('CODE_RECOVERY_REQUIRES_OFF'));
  assert.equal(g.jobs.get(old.id).state, 'needs-review');
});

function delivered(f, eventId = input.eventId) {
  f.jobs.enable(1); const item = f.jobs.admit({ ...input, eventId }, 2).task;
  f.jobs.start(item.id, 3); f.jobs.finish(item.id, 'PRIVATE RESULT', 4); f.jobs.markResultDelivered(item.id, 5); f.jobs.disable(6);
  return f.jobs.get(item.id);
}
const archiveOptions = (jobs, patch = {}) => ({ expectedRevision: jobs.snapshot().revision, reviewer: 'trusted-host', reason: 'Reviewed completed dependencies', now: 10, authorize: () => true, ...patch });

test('Code manual archive releases hot capacity while preserving original result, audit and permanent event deduplication', t => {
  const f = fixture(t); const original = delivered(f);
  const info = f.jobs.inspectArchive([original.id]); assert.equal(info.revision, f.jobs.snapshot().revision);
  const metadata = f.jobs.archive([original.id], archiveOptions(f.jobs));
  assert.equal(f.jobs.list().length, 0); assert.deepEqual(f.jobs.get(original.id), original);
  const record = f.jobs.readArchive(original.id); assert.deepEqual(record.task, original);
  assert.equal(record.audit.reviewer, 'trusted-host'); assert.equal(metadata[0].hash.length, 64); assert.equal(metadata[0].recordHash.length, 64);
  assert.deepEqual(f.jobs.listArchives(), metadata); assert.equal(f.jobs.listArchives({ offset: 1 }).length, 0);
  record.task.input.text = 'mutated copy'; assert.equal(f.jobs.get(original.id).input.text, input.text);
  assert.equal(f.jobs.admit(input, 11).duplicate, true); assert.deepEqual(f.jobs.admit(input, 12).task, original);
  assert.throws(() => f.jobs.admit({ ...input, text: 'conflicting' }, 12), /CODE_EVENT_CONFLICT/);
  for (const write of [() => f.jobs.stop(original.id, 12), () => f.jobs.finish(original.id, 'new', 12),
    () => f.jobs.resume(original.id, 'requeue', 12), () => f.jobs.releaseResult(original.id, 12)]) assert.throws(write, /CODE_TASK_NOT_FOUND/);
  f.jobs.enable(13); assert.notEqual(f.jobs.admit({ ...input, eventId: 'new-event' }, 14).task.id, original.id);
});

test('Code archive validates complete batch and requires OFF, terminal disposition, CAS and current Host authority', t => {
  const f = fixture(t); const original = delivered(f); f.jobs.enable(7);
  const queued = f.jobs.admit({ ...input, eventId: 'not-terminal' }, 8).task;
  assert.throws(() => f.jobs.archive([original.id], archiveOptions(f.jobs)), /CODE_ARCHIVE_REQUIRES_OFF/); f.jobs.disable(9);
  const before = f.jobs.snapshot();
  for (const ids of [[original.id, queued.id], [original.id, 'missing'], [original.id, original.id]]) assert.throws(() => f.jobs.archive(ids, archiveOptions(f.jobs)));
  assert.deepEqual(f.jobs.snapshot(), before); assert.equal(f.jobs.listArchives().length, 0);
  assert.throws(() => f.jobs.archive([original.id], archiveOptions(f.jobs, { expectedRevision: before.revision - 1 })), /CONFLICT/);
  for (const patch of [{ authorize: undefined }, { authorize: () => false }, { authorize: () => Promise.resolve(true) },
    { reviewer: '' }, { reason: ' ' }, { now: 0 }]) assert.throws(() => f.jobs.archive([original.id], archiveOptions(f.jobs, patch)));
  let calls = 0;
  assert.throws(() => f.jobs.archive([original.id], archiveOptions(f.jobs, { authorize: () => ++calls === 1 })), /ARCHIVE_NOT_AUTHORIZED/);
  assert.throws(() => f.jobs.archive([original.id], archiveOptions(f.jobs, { authorize: () => { f.setGrant(null); return true; } })), /CODE_NOT_AUTHORIZED/);
  assert.equal(f.jobs.listArchives().length, 0); assert.deepEqual(f.jobs.snapshot(), before);
});

test('Code archive freezes proof, captures caller input, and rolls back caller/SQLite failure atomically', t => {
  const f = fixture(t); const item = delivered(f); const ids = [item.id]; const options = archiveOptions(f.jobs);
  let proofSeen;
  options.authorize = proof => { proofSeen = proof; assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.items[0].input));
    assert.throws(() => { proof.items[0].input.text = 'rewrite'; }, TypeError); ids[0] = 'wrong'; options.reviewer = 'mutated'; return true; };
  const before = f.db.prepare('SELECT * FROM agent_state ORDER BY key').all();
  assert.throws(() => f.store.atomic(tx => { f.jobs.archiveIn(tx, ids, options); tx.write('cross-domain', 0, { archived: true }); throw Error('rollback'); }));
  assert.deepEqual(f.db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before); assert.equal(proofSeen.hashes[0].length, 64);
  f.db.exec(`CREATE TEMP TRIGGER reject_archive BEFORE INSERT ON agent_state WHEN NEW.key LIKE '%code-task-archive-v1%' BEGIN SELECT RAISE(FAIL, 'fault'); END`);
  assert.throws(() => f.jobs.archive([item.id], archiveOptions(f.jobs)));
  assert.deepEqual(f.db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before); f.db.exec('DROP TRIGGER reject_archive');
  f.jobs.archive([item.id], archiveOptions(f.jobs));
});

test('Code abandoned recovery may archive but an explicit stop and undelivered results may not', t => {
  const f = fixture(t); f.jobs.enable(1); const item = f.jobs.admit(input, 2).task; f.jobs.stop(item.id, 3); f.jobs.disable(4);
  assert.throws(() => f.jobs.archive([item.id], archiveOptions(f.jobs)), /CODE_ARCHIVE_NOT_TERMINAL/);
  f.store.atomic(tx => f.jobs.abandonIn(tx, item.id, { expectedRevision: f.jobs.snapshot().revision, reviewer: 'host', reason: 'stopped session verified', now: 5 }));
  f.jobs.archive([item.id], archiveOptions(f.jobs)); assert.equal(f.jobs.get(item.id).reason, 'RECOVERY_ABANDONED');
  assert.equal(f.jobs.admit(input, 11).duplicate, true);
  const g = fixture(t); g.jobs.enable(1); const pending = g.jobs.admit(input, 2).task; g.jobs.start(pending.id, 3); g.jobs.finish(pending.id, '', 4); g.jobs.disable(5);
  assert.throws(() => g.jobs.archive([pending.id], archiveOptions(g.jobs)), /CODE_ARCHIVE_NOT_TERMINAL/);
});

test('Code archive survives reopen without construction cleanup and detects corrupt cold content or audit', t => {
  const f = fixture(t); const item = delivered(f); f.jobs.archive([item.id], archiveOptions(f.jobs));
  const reopened = new CodeTasks(f.store, { getAuthorization: () => authorization });
  assert.deepEqual(reopened.get(item.id), item); assert.equal(reopened.list().length, 0); assert.equal(reopened.listArchives().length, 1);
  const row = f.db.prepare("SELECT key,value FROM agent_state WHERE key LIKE '%code-task-archive-v1%'").get();
  const saved = JSON.parse(row.value); saved.audit.reason = 'tampered'; f.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(saved), row.key);
  assert.throws(() => f.jobs.get(item.id), /ARCHIVE_CORRUPT/); assert.throws(() => f.jobs.admit(input, 12), /ARCHIVE_CORRUPT/);
});

test('Code archive never invokes authorization after store close and rejects accessor/symbol maintenance fields', t => {
  const f = fixture(t); const item = delivered(f); let called = 0; const options = archiveOptions(f.jobs, { authorize: () => { called++; return true; } });
  const accessor = { ...options }; Object.defineProperty(accessor, 'reviewer', { enumerable: true, get() { throw Error('must not evaluate'); } });
  assert.throws(() => f.jobs.archive([item.id], accessor), /INVALID_INPUT/);
  assert.throws(() => f.jobs.archive([item.id], { ...options, [Symbol('hidden')]: 1 }), /INVALID_INPUT/);
  f.store.close(); assert.throws(() => f.jobs.archive([item.id], options), /STORE_CLOSED/); assert.equal(called, 0);
});

test('Code full hot capacity becomes available only through explicit archive; cold events stay duplicates after restart', t => {
  const f = fixture(t); const completed = [];
  for (let i = 0; i < 64; i++) completed.push(delivered(f, `capacity-${i}`));
  f.jobs.enable(7); assert.throws(() => f.jobs.admit({ ...input, eventId: 'over-capacity' }, 8), /CODE_CAPACITY/); f.jobs.disable(9);
  f.jobs.archive(completed.map(item => item.id), archiveOptions(f.jobs)); assert.equal(f.jobs.list().length, 0);
  const reopened = new CodeTasks(f.store, { getAuthorization: () => authorization }); reopened.restart(11); reopened.enable(12);
  const old = reopened.admit({ ...input, eventId: 'capacity-0' }, 13); assert.equal(old.duplicate, true); assert.deepEqual(old.task, completed[0]);
  assert.equal(reopened.admit({ ...input, eventId: 'over-capacity' }, 14).task.id, 'code-65');
});

test('Code archive rejects live executions and detects Host callback state mutation before removing any task', async t => {
  const f = fixture(t); const done = delivered(f); f.jobs.enable(7); const active = f.jobs.admit({ ...input, eventId: 'active' }, 8).task;
  const entered = deferred<void>(), release = deferred<string>();
  const running = f.jobs.execute(active.id, async () => { entered.resolve(); return release.promise; }, { now: () => 9 });
  await entered.promise; f.jobs.disable(9);
  assert.throws(() => f.jobs.archive([done.id], archiveOptions(f.jobs)), /CODE_EXECUTION_ACTIVE/);
  release.resolve('done'); await running;
  const before = f.jobs.snapshot();
  assert.throws(() => f.store.atomic(tx => f.jobs.archiveIn(tx, [done.id], archiveOptions(f.jobs, { authorize: () => {
    const row = tx.read(JSON.stringify(['code-jobs-v1', 'default'])); row.value.enabled = true; tx.write(JSON.stringify(['code-jobs-v1', 'default']), row.revision, row.value); return true;
  } }))), /CONFLICT/);
  assert.deepEqual(f.jobs.snapshot(), before); assert.equal(f.jobs.listArchives().length, 0);
});

test('Code missing archive index cannot turn an archived event into a new admission', t => {
  const f = fixture(t); const done = delivered(f); f.jobs.archive([done.id], archiveOptions(f.jobs));
  f.db.prepare("DELETE FROM agent_state WHERE key LIKE '%:archives:v1'").run();
  assert.throws(() => f.jobs.admit(input, 11), /ARCHIVE_CORRUPT/); assert.throws(() => f.jobs.get(done.id), /ARCHIVE_CORRUPT/);
});

test('Code archive cold index has a fixed bound and payload hashes detect alteration independently of audit', t => {
  const f = fixture(t); const done = delivered(f);
  const indexKey = `${JSON.stringify(['code-jobs-v1', 'default'])}:archives:v1`;
  f.store.atomic(tx => tx.write(indexKey, 0, Array.from({ length: 4096 }, (_, i) => ({ id: `old-${i}`, hash: 'synthetic', eventHash: `event-${i}`, state: 'completed', at: 1 }))));
  assert.throws(() => f.jobs.archive([done.id], archiveOptions(f.jobs)), /ARCHIVE_CAPACITY/); assert.deepEqual(f.jobs.get(done.id), done);
  const g = fixture(t); const other = delivered(g); g.jobs.archive([other.id], archiveOptions(g.jobs));
  const row = g.db.prepare("SELECT key,value FROM agent_state WHERE key LIKE '%code-task-archive-v1%'").get();
  const record = JSON.parse(row.value); record.task.result = 'altered result'; g.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(record), row.key);
  assert.throws(() => g.jobs.get(other.id), /ARCHIVE_CORRUPT/);
});
