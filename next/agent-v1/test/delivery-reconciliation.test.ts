import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentError } from '../src/common.ts';
import { SqliteStateStore } from '../src/store.ts';
import { ConversationLedger } from '../../conversation-v1/src/ledger.ts';
import { BotRuntime } from '../src/runtime.ts';
import { CreationService } from '../src/creation.ts';
import { CodeTasks } from '../src/code-jobs.ts';
import type { CodeState } from '../src/code-jobs.ts';
import { DispatchCoordinator } from '../src/dispatch.ts';
import { DeliveryReconciler, deliveryFingerprint } from '../src/delivery-reconciliation.ts';
import type { DeliveryEvidence, ReconciliationDependencies } from '../src/delivery-reconciliation.ts';
import type { Delivery } from '../src/outbox.ts';

// All domain state is real, isolated SQLite. Only platform IO/identity proof are synthetic.
const budget = { id: 'synthetic-day', limit: 1 };
const codeIs = (code: string) => (error: unknown) => error instanceof AgentError && error.code === code;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, filename = ':memory:', eventsFilename = ':memory:') {
  const db = new DatabaseSync(filename), events = new DatabaseSync(eventsFilename);
  const store = new SqliteStateStore(db, { namespace: 'delivery-reconciliation', initialize: true });
  const ledger = new ConversationLedger(events, { namespace: 'delivery-reconciliation', initialize: true });
  let human = true, sends = 0;
  const runtime = new BotRuntime(store, ledger, {
    profile: { botId: 'bot', personaId: 'juejue', mode: 'juejue', name: 'Synthetic', roleCore: 'Synthetic role' },
    now: () => 1000, model: null, acceptIngress: () => false, authorizeLearning: () => false,
    participation: key => ({ enabled: false, allowedTargets: [key], deniedTargets: [], timeZoneOffsetMinutes: 0, windows: [], cooldownMs: 0, dailyLimit: 0, unansweredLimit: 0 }),
  });
  const key = runtime.register({ botId: 'bot', personaId: 'juejue', connector: 'qq-personal', issuer: 'fixture', accountId: 'one', kind: 'direct', remoteId: 'admin' }, 1, 'Synthetic');
  if (runtime.outbox.state().revision === 0) runtime.outbox.setPause(0, false);
  const account = JSON.stringify(['qq-personal', 'fixture', 'one']);
  const creation = new CreationService(store, { now: () => 1000, authorizeHuman: principal => human && principal === 'human', resolveAsset: () => null,
    currentAuthority: () => ({ policyRevision: 1, accountRevision: 1, publishAllowed: true, sources: [] }) });
  const grant = { revision: 1, adminActor: 'admin', conversationKey: key, account: 'one', workspaceId: 'synthetic', sessionId: 'session', modelConfigured: true,
    budgetAvailable: true, sandboxVerified: true, toolsRestricted: true, allowedTools: ['read'], verified: true };
  let codeAllowed = true;
  const code = new CodeTasks(store, { getAuthorization: () => codeAllowed ? grant : null });
  const dispatcher = new DispatchCoordinator(runtime, creation, code, () => 1000, { resolveAccount: handle => handle === 'one' ? account : null });
  const publication = (id = 'work-1') => {
    const target = { objectId: null, parentId: null, visibility: 'public', category: null };
    let work = creation.create({ id, action: 'qqspace', accountId: 'one', target, intention: 'Synthetic intention', sources: [] });
    work = creation.prepareFinal(id, work.revision, { accountId: 'one', target, title: 'Synthetic title', text: 'PRIVATE-PUBLICATION-BODY', description: '', tags: [],
      video: null, audio: [], subtitles: [], cover: null, attachments: [] });
    work = creation.approve(id, work.revision, 'human', 100000);
    dispatcher.submitCreation(id, work.revision);
    return id;
  };
  const codeResult = () => {
    code.enable(1);
    const task = code.admit({ eventId: 'code-event', actor: 'admin', conversationKey: key, account: 'one', plain: true, text: 'PRIVATE-CODE-INPUT' }, 2).task;
    code.start(task.id, 3); code.finish(task.id, 'PRIVATE-CODE-RESULT', 4);
    dispatcher.enqueueCode(task.id);
    return task.id;
  };
  const uncertain = async () => {
    const item = await dispatcher.dispatch(account, 'synthetic-worker', budget, async () => { sends++; return { status: 'unknown', receipt: null }; });
    assert.equal(item?.status, 'unknown'); return item!;
  };
  const evidence = (item: Delivery): DeliveryEvidence => ({ deliveryId: item.id, account: item.account, fingerprint: deliveryFingerprint(item),
    outcome: 'confirmed', receipt: 'PRIVATE-PLATFORM-RECEIPT', notSubmitted: false });
  const deps: ReconciliationDependencies = { authorizeHuman: principal => human && principal === 'human', query: async item => evidence(item as Delivery), timeoutMs: 1000 };
  let closed = false;
  const close = () => { if (closed) return; closed = true; runtime.close(); store.close(); db.close(); events.close(); };
  t.after(close);
  return { runtime, creation, code, store, dispatcher, account, publication, codeResult, uncertain, evidence, deps,
    reconciler: new DeliveryReconciler(dispatcher, deps), revoke: () => { human = false; }, revokeCode: () => { codeAllowed = false; }, close, sends: () => sends,
    queueSnapshot: () => store.read('outbox:v1') };
}

test('trusted confirmed evidence repairs real creation and Code projections without another send or private response fields', async t => {
  for (const kind of ['creation', 'code']) {
    const f = fixture(t); const domainId = kind === 'creation' ? f.publication() : f.codeResult(); const unknown = await f.uncertain();
    if (kind === 'creation') assert.equal(f.creation.read(domainId)!.value.submission!.state, 'unknown');
    else assert.equal(f.code.get(domainId).resultDelivery, 'ready');
    f.deps.query = async item => ({ ...f.evidence(item as Delivery), visibility: 'published' });
    const result = await f.reconciler.reconcile(unknown.id, f.runtime.outbox.state().revision, 'human');
    assert.deepEqual(Object.keys(result).sort(), ['id', 'reason', 'revision', 'status']); assert.equal(result.status, 'confirmed');
    assert.equal(result.reason, 'RECONCILED'); assert.equal(result.revision, f.runtime.outbox.state().revision);
    for (const secret of ['PRIVATE-PUBLICATION-BODY', 'PRIVATE-CODE-RESULT', 'PRIVATE-PLATFORM-RECEIPT', 'payload', 'receipt']) assert.equal(JSON.stringify(result).includes(secret), false);
    if (kind === 'creation') {
      assert.equal(f.creation.read(domainId)!.value.submission!.state, 'published');
      assert.equal(f.creation.read(domainId)!.value.submission!.platformObjectId, 'PRIVATE-PLATFORM-RECEIPT');
    } else assert.equal(f.code.get(domainId).resultDelivery, 'delivered');
    assert.equal(f.sends(), 1);
    assert.equal(await f.dispatcher.dispatch(f.account, 'another-worker', budget, async () => { assert.fail('reconciliation must not resend'); }), null);
    const before = f.queueSnapshot();
    await assert.rejects(f.reconciler.reconcile(unknown.id, f.runtime.outbox.state().revision, 'human'), codeIs('INVALID_STATE'));
    assert.deepEqual(f.queueSnapshot(), before); assert.equal(f.runtime.outbox.list().length, 1);
  }
});

test('null or unconfigured evidence leaves real SQLite Outbox and domain unknown, with no automatic retry', async t => {
  for (const kind of ['null', 'missing']) {
    const f = fixture(t); const work = f.publication(); const item = await f.uncertain(); const before = f.queueSnapshot(); const workBefore = f.creation.read(work);
    if (kind === 'missing') {
      delete f.deps.query;
      await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), codeIs('NOT_CONFIGURED'));
    } else {
      f.deps.query = async () => null;
      assert.deepEqual(await f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'),
        { id: item.id, status: 'unknown', revision: f.runtime.outbox.state().revision, reason: 'EVIDENCE_UNAVAILABLE' });
    }
    assert.deepEqual(f.queueSnapshot(), before); assert.deepEqual(f.creation.read(work), workBefore); assert.equal(f.sends(), 1);
  }
});

test('mismatched evidence id/account/fingerprint or forged evidence shape cannot change real unknown delivery', async t => {
  for (const patch of [{ deliveryId: 'another-delivery' }, { account: JSON.stringify(['qq-personal', 'fixture', 'other']) },
    { fingerprint: '0'.repeat(64) }, { notSubmitted: true }, { visibility: 'invented' }, { approved: true }]) {
    const f = fixture(t); f.publication(); const item = await f.uncertain(); const before = f.queueSnapshot();
    f.deps.query = async row => ({ ...f.evidence(row as Delivery), ...patch }) as DeliveryEvidence;
    await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), error =>
      error instanceof AgentError && ['EVIDENCE_MISMATCH', 'EVIDENCE_INVALID'].includes(error.code));
    assert.deepEqual(f.queueSnapshot(), before); assert.equal(f.sends(), 1);
  }
});

test('human permission is required before evidence queries and rechecked after an asynchronous query', async t => {
  for (const boundary of ['before', 'during']) {
    const f = fixture(t); f.publication(); const item = await f.uncertain(); const before = f.queueSnapshot(); let queries = 0;
    const waiting = deferred<DeliveryEvidence | null>();
    f.deps.query = async () => { queries++; return waiting.promise; };
    if (boundary === 'before') {
      f.revoke(); await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), codeIs('ACCESS_DENIED'));
      assert.equal(queries, 0);
    } else {
      const pending = f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human');
      assert.equal(queries, 1); f.revoke(); waiting.resolve(f.evidence(item)); await assert.rejects(pending, codeIs('ACCESS_DENIED'));
    }
    assert.deepEqual(f.queueSnapshot(), before);
  }
});

test('stale CAS before or during evidence query and a rejected beforeCommit guard never commit reconciliation', async t => {
  for (const boundary of ['stale-before', 'stale-during', 'guard']) {
    const f = fixture(t); f.publication(); const item = await f.uncertain(); const revision = f.runtime.outbox.state().revision; let queries = 0;
    const waiting = deferred<DeliveryEvidence | null>();
    f.deps.query = async () => { queries++; return waiting.promise; };
    if (boundary === 'stale-before') {
      const before = f.queueSnapshot();
      await assert.rejects(f.reconciler.reconcile(item.id, revision - 1, 'human'), codeIs('CONFLICT'));
      assert.equal(queries, 0); assert.deepEqual(f.queueSnapshot(), before);
    } else {
      const pending = f.reconciler.reconcile(item.id, revision, 'human', boundary === 'guard' ? async () => { throw new AgentError('ACCESS_CHANGED'); } : undefined);
      if (boundary === 'stale-during') f.runtime.outbox.setPause(revision, true);
      const before = f.queueSnapshot(); waiting.resolve(f.evidence(item));
      await assert.rejects(pending, codeIs(boundary === 'guard' ? 'ACCESS_CHANGED' : 'CONFLICT'));
      assert.deepEqual(f.queueSnapshot(), before);
    }
    assert.equal(f.runtime.outbox.list()[0]!.status, 'unknown'); assert.equal(f.sends(), 1);
  }
});

test('evidence query timeout aborts the provider and ignores late success without mutating SQLite', async t => {
  const f = fixture(t); f.publication(); const item = await f.uncertain(); const before = f.queueSnapshot();
  const waiting = deferred<DeliveryEvidence | null>(); let signal!: AbortSignal;
  const reconciler = new DeliveryReconciler(f.dispatcher, { authorizeHuman: () => true, timeoutMs: 15,
    query: async (_item, received) => { signal = received; return waiting.promise; } });
  await assert.rejects(reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), codeIs('EVIDENCE_TIMEOUT'));
  assert.equal(signal.aborted, true); assert.deepEqual(f.queueSnapshot(), before);
  waiting.resolve(f.evidence(item)); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.queueSnapshot(), before); assert.equal(f.sends(), 1);
});

test('trusted notSubmitted evidence marks failure, repairs creation and releases reservation for a different authorized work', async t => {
  const f = fixture(t); const first = f.publication(); const item = await f.uncertain();
  const held = f.store.read<{ budgets: { spent: number; reserved: number }[] }>('outbox:v1')!.value.budgets[0]!;
  assert.equal(held.reserved, 1); assert.equal(held.spent, 0);
  f.deps.query = async row => ({ ...f.evidence(row as Delivery), outcome: 'failed', notSubmitted: true });
  const result = await f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human');
  assert.equal(result.status, 'failed'); assert.equal(f.creation.read(first)!.value.submission!.state, 'failed');
  const released = f.store.read<{ budgets: { spent: number; reserved: number }[] }>('outbox:v1')!.value.budgets[0]!;
  assert.equal(released.reserved, 0); assert.equal(released.spent, 0); assert.equal(f.runtime.outbox.list()[0]!.charged, false);
  f.publication('work-2');
  const sent = await f.dispatcher.dispatch(f.account, 'other-worker', budget, async entry => {
    assert.notEqual(entry.id, item.id); return { status: 'confirmed', receipt: 'synthetic-new-work' };
  });
  assert.equal(sent!.status, 'confirmed'); assert.equal(f.runtime.outbox.list().length, 2);
  assert.equal(f.runtime.outbox.list()[0]!.status, 'failed');
});

test('provider failures stay bounded and preserve the unknown delivery and reserved budget', async t => {
  const f = fixture(t); f.publication(); const item = await f.uncertain(); const before = f.queueSnapshot();
  f.deps.query = async () => { throw Error('PRIVATE cookie, raw receipt and /database/path'); };
  await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), error =>
    error instanceof AgentError && error.code === 'EVIDENCE_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  assert.deepEqual(f.queueSnapshot(), before);
});

test('domain writes followed by a projection exception roll back Outbox, reservation and both domain snapshots', async t => {
  for (const kind of ['creation', 'code']) {
    const f = fixture(t); const domainId = kind === 'creation' ? f.publication() : f.codeResult(); const item = await f.uncertain();
    const queue = f.queueSnapshot(), domain = kind === 'creation' ? f.creation.read(domainId) : f.code.snapshot();
    if (kind === 'creation') {
      const original = f.creation.recordOutcomeIn.bind(f.creation);
      f.creation.recordOutcomeIn = (...args) => { original(...args); throw new AgentError('PROJECTION_TEST_FAILURE'); };
    } else {
      const original = f.code.markResultDeliveredIn.bind(f.code);
      f.code.markResultDeliveredIn = (...args) => { original(...args); throw new AgentError('PROJECTION_TEST_FAILURE'); };
    }
    await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), codeIs('PROJECTION_TEST_FAILURE'));
    assert.deepEqual(f.queueSnapshot(), queue);
    assert.deepEqual(kind === 'creation' ? f.creation.read(domainId) : f.code.snapshot(), domain);
    assert.equal(f.runtime.outbox.list()[0]!.status, 'unknown'); assert.equal(f.sends(), 1);
  }
});

test('a failed projection remains retryable after actual SQLite close/reopen without a second platform send', async t => {
  const parent = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(path.join(parent, 'juebot-atomic-reconcile-')));
  const filename = path.join(directory, 'synthetic.sqlite'), eventsFilename = path.join(directory, 'events.sqlite');
  const f = fixture(t, filename, eventsFilename); let reopened: ReturnType<typeof fixture> | undefined;
  t.after(() => { f.close(); reopened?.close(); assert.equal(path.dirname(realpathSync(directory)), parent); rmSync(directory, { recursive: true }); });
  const work = f.publication(); const item = await f.uncertain(); const queue = f.queueSnapshot(); const domain = f.creation.read(work);
  const original = f.creation.recordOutcomeIn.bind(f.creation);
  f.creation.recordOutcomeIn = (...args) => { original(...args); throw new AgentError('PROJECTION_TEST_FAILURE'); };
  await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), codeIs('PROJECTION_TEST_FAILURE'));
  f.close(); reopened = fixture(t, filename, eventsFilename);
  assert.deepEqual(reopened.queueSnapshot(), queue); assert.deepEqual(reopened.creation.read(work), domain);
  const result = await reopened.reconciler.reconcile(item.id, reopened.runtime.outbox.state().revision, 'human');
  assert.equal(result.status, 'confirmed'); assert.equal(reopened.creation.read(work)!.value.submission!.state, 'accepted');
  assert.equal(reopened.sends(), 0);
  assert.equal(await reopened.dispatcher.dispatch(reopened.account, 'worker', budget, async () => { assert.fail('never resend old work'); }), null);
});

test('trusted sent Code fact resolves a held result after real SQLite reopen and current grant revocation', async t => {
  const parent = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(path.join(parent, 'juebot-code-reconcile-')));
  const filename = path.join(directory, 'synthetic.sqlite'), eventsFilename = path.join(directory, 'events.sqlite');
  const f = fixture(t, filename, eventsFilename); let reopened: ReturnType<typeof fixture> | undefined;
  t.after(() => { f.close(); reopened?.close(); assert.equal(path.dirname(realpathSync(directory)), parent); rmSync(directory, { recursive: true }); });
  const task = f.codeResult(); const item = await f.uncertain(); f.close(); reopened = fixture(t, filename, eventsFilename);
  reopened.code.restart(1100); reopened.revokeCode();
  assert.equal(reopened.code.get(task).resultDelivery, 'held');
  assert.throws(() => reopened!.code.takeResult(task), codeIs('CODE_NOT_AUTHORIZED'));
  const result = await reopened.reconciler.reconcile(item.id, reopened.runtime.outbox.state().revision, 'human');
  assert.equal(result.status, 'confirmed'); assert.equal(reopened.code.get(task).resultDelivery, 'delivered');
  assert.equal(reopened.code.snapshot().value.enabled, false); assert.equal(reopened.sends(), 0);
  assert.throws(() => reopened!.dispatcher.enqueueCode(task), codeIs('CODE_NOT_AUTHORIZED'));
});

test('257 and 1024 character receipts persist consistently in direct send and reconciliation; 1025 is rejected before commit', async t => {
  for (const length of [257, 1024]) for (const boundary of ['send', 'reconcile']) {
    const f = fixture(t); const work = f.publication(); const receipt = 'r'.repeat(length);
    if (boundary === 'send') {
      const result = await f.dispatcher.dispatch(f.account, 'worker', budget, async () => ({ status: 'confirmed', receipt }));
      assert.equal(result!.status, 'confirmed');
    } else {
      const item = await f.uncertain(); f.deps.query = async row => ({ ...f.evidence(row as Delivery), receipt });
      assert.equal((await f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human')).status, 'confirmed');
    }
    assert.equal(f.runtime.outbox.list()[0]!.receipt, receipt); assert.equal(f.creation.read(work)!.value.submission!.platformObjectId, receipt);
  }
  const f = fixture(t); f.publication(); const item = await f.uncertain(); const before = f.queueSnapshot();
  f.deps.query = async row => ({ ...f.evidence(row as Delivery), receipt: 'r'.repeat(1025) });
  await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), codeIs('INVALID_INPUT'));
  assert.deepEqual(f.queueSnapshot(), before);
});

test('normal-send projection failure rolls back finish and stays sending until explicit restart recovery to unknown', async t => {
  const f = fixture(t); const work = f.publication(); const before = f.creation.read(work);
  const original = f.creation.recordOutcomeIn.bind(f.creation);
  f.creation.recordOutcomeIn = (...args) => { original(...args); throw new AgentError('PROJECTION_TEST_FAILURE'); };
  let sends = 0;
  await assert.rejects(f.dispatcher.dispatch(f.account, 'worker', budget, async () => { sends++; return { status: 'confirmed', receipt: 'trusted-receipt' }; }), codeIs('PROJECTION_TEST_FAILURE'));
  assert.equal(f.runtime.outbox.list()[0]!.status, 'sending'); assert.deepEqual(f.creation.read(work), before);
  assert.equal(await f.dispatcher.dispatch(f.account, 'worker-2', budget, async () => { assert.fail('do not replay after projection failure'); }), null);
  f.runtime.outbox.recover(); assert.equal(f.runtime.outbox.list()[0]!.status, 'unknown');
  f.creation.recordOutcomeIn = original; const item = f.runtime.outbox.list()[0]!;
  assert.equal((await f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human')).status, 'confirmed');
  assert.equal(f.creation.read(work)!.value.submission!.state, 'accepted'); assert.equal(sends, 1);
});

test('Code fact projection validates the retained result and original recipient even when evidence matches Outbox', async t => {
  for (const change of ['result', 'recipient']) {
    const f = fixture(t); const task = f.codeResult(); const item = await f.uncertain();
    const stateKey = JSON.stringify(['code-jobs-v1', 'default']);
    f.store.atomic(tx => {
      const state = tx.read<CodeState>(stateKey)!;
      if (change === 'result') state.value.tasks[task]!.result = 'Different retained result';
      else state.value.tasks[task]!.authorization.conversationKey = 'Different recipient';
      tx.write(stateKey, state.revision, state.value);
    });
    const before = f.queueSnapshot();
    await assert.rejects(f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human'), codeIs('CODE_RESULT_CHANGED'));
    assert.deepEqual(f.queueSnapshot(), before); assert.equal(f.code.get(task).resultDelivery, 'ready');
  }
});

test('postcommit audit sees committed Outbox/domain facts and cannot roll them back or trigger resend if it fails', async t => {
  const f = fixture(t); const work = f.publication(); const item = await f.uncertain(); let audits = 0;
  f.runtime.recordDelivery = delivery => {
    audits++; assert.equal(delivery.status, 'confirmed');
    assert.equal(f.runtime.outbox.list()[0]!.status, 'confirmed');
    assert.equal(f.creation.read(work)!.value.submission!.state, 'accepted');
    // A separate transaction proves this callback runs after the main transaction closed.
    f.store.atomic(tx => tx.write('synthetic-audit-attempt', 0, { observed: delivery.status }));
    throw new AgentError('SYNTHETIC_AUDIT_FAILURE');
  };
  const result = await f.reconciler.reconcile(item.id, f.runtime.outbox.state().revision, 'human');
  assert.equal(result.status, 'confirmed'); assert.equal(audits, 1);
  assert.equal(f.runtime.outbox.list()[0]!.status, 'confirmed');
  assert.equal(await f.dispatcher.dispatch(f.account, 'worker-2', budget, async () => { assert.fail('audit failure cannot resend'); }), null);
});
