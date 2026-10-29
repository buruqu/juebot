import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openApplication } from '../host/application.js';
const modules = await Promise.all([import('../src/store.ts'), import('../../conversation-v1/src/ledger.ts'), import('../src/runtime.ts'), import('../src/creation.ts'),
  import('../src/code-jobs.ts'), import('../src/dispatch.ts'), import('../src/api.ts'), import('../src/creative-workflow.ts'), import('../src/delivery-reconciliation.ts'), import('../src/common.ts')]);
const actor = 'synthetic-owner', bvid = 'BV1xx411c7mD', account = JSON.stringify(['bilibili', 'synthetic', 'one']);
const target = { objectId: bvid, parentId: null, visibility: 'public', category: null };
const participation = { enabled: true, allowedTargets: ['public'], deniedTargets: [], timeZoneOffsetMinutes: 0, windows: [{ startMinute: 0, endMinute: 1440 }], cooldownMs: 0, dailyLimit: 10, unansweredLimit: 10 };
async function fixture(t, extra = {}) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(path.join(parent, 'juebot-app-integration-')); let app, calls = 0, authority = true;
  const ports = { modules, now: () => 1000, authorizeHuman: principal => authority && principal === actor,
    publicationAuthority: work => ({ policyRevision: 1, accountRevision: 1, publishAllowed: true, sources: work.sources.map(source => ({ ...source, publishAllowed: true })) }),
    creative: { policy: () => ({ revision: 1, allowedAccounts: ['public-account'], allowedActions: ['bili.comment'] }),
      plan: async () => ({ brief: 'Synthetic brief', script: null, title: '', description: '', tags: [], text: 'Synthetic final' }) },
    bili: { transport: async url => { calls++; return Response.json({ code: 0, data: url.includes('/view?')
      ? { bvid, aid: 123, cid: 456, title: 'Synthetic title', desc: 'Synthetic description', owner: { mid: '99', name: 'Author' } }
      : { page: { num: 1, size: 20, count: 1 }, replies: [{ oid: 123, rpid: 101, member: { mid: '22', uname: 'Commenter' }, content: { message: 'Approved synthetic material' } }] } }); },
      authorizeRead: () => ({ allowed: true, revision: 1 }), budget: { consume: () => true }, authorizeMaterials: () => ({ allowed: true, revision: 1, expiresAt: 10000 }) }, ...extra };
  t.after(async () => { await app?.close(); assert.equal(path.dirname(root), parent); rmSync(root, { recursive: true }); });
  app = await openApplication({}, { enabled: true, dataRoot: root, initializeEmpty: true, namespace: 'integration' }, { principal: actor }, ports);
  const key = app.runtime.register({ botId: 'juebot', personaId: 'juejue', connector: 'local-test', issuer: 'synthetic', accountId: 'one', kind: 'direct', remoteId: 'human' }, 1, 'Synthetic');
  app.runtime.memory.configure(0, { permissions: { receive: true, save: true, learn: true } });
  return { app, ports, key, root, calls: () => calls, revokeActor: () => { authority = false; } };
}
function source(app, key, id, revision = 1) {
  app.runtime.memory.putSource(app.runtime.memory.readPolicy().revision, { id, revision, conversationKey: key, domain: 'social', status: 'active', purposes: ['read', 'learn', 'draft', 'publish'], audiences: [key], expiresAt: null });
  app.runtime.observe(key, { eventId: id, revision, kind: 'external', topic: 'music', interestDelta: 10, feedback: 'interest' });
}
const intention = (app, key) => app.runtime.self.decide(app.runtime.scope(key), { target: 'public', topic: 'music', action: 'idle-topic', policy: participation }).intention;

test('application wires inert Bili snapshot, one selected pending learning proposal and actual CreativeWorkflow final-review', async t => {
  const f = await fixture(t); assert.equal(f.calls(), 0);
  const saved = await f.app.biliSources.capture({ id: 'bili-proof', expectedRevision: 0, request: { account, bvid } }, actor);
  assert.equal(f.calls(), 2); assert.equal(f.app.biliSources.read('bili-proof', 1, actor).snapshot.contentHash, saved.contentHash);
  const result = f.app.biliSources.learning({ key: f.key, id: 'bili-proof', revision: 1, itemId: saved.items[1].id, proposalId: 'selected-learning' }, actor);
  assert.equal(result.requiresHumanApproval, true); assert.equal(result.proposal.status, 'pending'); assert.equal(f.app.runtime.learning().length, 1);
  assert.equal(f.app.runtime.learning()[0].text, saved.items[1].text); assert.equal(f.app.runtime.memory.readPolicy().value.sources[result.sourceId].purposes.includes('publish'), false);
  f.app.runtime.reviewLearning('selected-learning', true, actor); assert.equal(f.app.runtime.learning()[0].status, 'accepted');
  source(f.app, f.key, 'bili-proof'); const intent = intention(f.app, f.key); assert.ok(intent);
  const ready = await f.app.startCreation(f.key, intent.id, { action: 'bili.comment', accountId: 'public-account', target }, actor);
  assert.equal(ready.status, 'ready'); assert.equal(ready.work.value.stage, 'final-review'); assert.equal(ready.work.value.approval, null); assert.equal(f.app.runtime.outbox.list().length, 0); assert.equal(f.calls(), 2);
  await f.app.biliSources.capture({ id: 'bili-proof', expectedRevision: 1, request: { account, bvid } }, actor);
  assert.equal(f.app.runtime.memory.readPolicy().value.sources[result.sourceId].status, 'revoked');
  assert.throws(() => f.app.creation.approve(ready.work.value.id, ready.work.revision, actor, 5000));
});

test('mixed Bili and external creation sources are all preserved and missing external evidence fails closed', async t => {
  let sources;
  const f = await fixture(t, { creative: { policy: () => ({ revision: 1, allowedAccounts: ['public-account'], allowedActions: ['bili.comment'] }),
    materials: async input => { assert.deepEqual(input.sources.map(row => row.eventId), ['external-proof']); return { revision: 1, sources: [{ id: 'external-proof', revision: 1, personLinkRevision: null }], items: [{ id: 'external-item', text: 'External approved fact' }] }; },
    plan: async input => { sources = input.materials.sources; return { brief: 'Mixed brief', script: null, title: '', description: '', tags: [], text: 'Mixed final' }; } } });
  await f.app.biliSources.capture({ id: 'bili-proof', expectedRevision: 0, request: { account, bvid } }, actor);
  source(f.app, f.key, 'bili-proof'); source(f.app, f.key, 'external-proof'); const intent = intention(f.app, f.key);
  assert.ok(intent.sources.length >= 2); const ready = await f.app.startCreation(f.key, intent.id, { action: 'bili.comment', accountId: 'public-account', target }, actor);
  assert.equal(ready.status, 'ready'); assert.deepEqual(new Set(sources.map(row => row.id)), new Set(['bili-proof', 'external-proof']));
});

test('application commit guards block late Bili snapshots and creative model writes after human permission revocation', async t => {
  const f = await fixture(t); let finish;
  f.ports.bili.transport = async () => new Promise(resolve => { finish = resolve; });
  const pending = f.app.biliSources.capture({ id: 'late-proof', expectedRevision: 0, request: { account, bvid } }, actor, async () => { throw Error('ACCESS_CHANGED'); });
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve(); finish(Response.json({ code: -412 })); await assert.rejects(pending);
  assert.throws(() => f.app.biliSources.read('late-proof', 1, actor));
  const g = await fixture(t, { creative: { policy: () => ({ revision: 1, allowedAccounts: ['public-account'], allowedActions: ['bili.comment'] }),
    materials: async () => ({ revision: 1, sources: [{ id: 'external-proof', revision: 1, personLinkRevision: null }], items: [{ id: 'proof', text: 'Synthetic' }] }),
    plan: async () => new Promise(resolve => { finish = resolve; }) } });
  source(g.app, g.key, 'external-proof'); const intent = intention(g.app, g.key); finish = null;
  const creative = g.app.startCreation(g.key, intent.id, { action: 'bili.comment', accountId: 'public-account', target }, actor);
  for (let i = 0; i < 50 && !finish; i++) await Promise.resolve(); assert.ok(finish);
  const before = g.app.creation.read(g.app.creation.list()[0].id); g.revokeActor();
  finish({ brief: 'Late', script: null, title: '', description: '', tags: [], text: 'Late final' }); await assert.rejects(creative);
  assert.deepEqual(g.app.creation.read(before.value.id), before);
});

test('maintenance defaults closed and requires exact current channel binding, Code OFF, paused Outbox and terminal dependency facts', async t => {
  let application, binding, permit = true;
  const f = await fixture(t, { maintenance: { binding: () => binding, authorize: () => permit } }); application = f.app;
  assert.throws(() => application.maintenance.list({ domain: 'outbox', reviewer: actor }));
  const interactions = { list: () => [], get: () => { throw Error('No interaction'); } };
  binding = { verified: true, code: application.code, profile: application.runtime.profile, bridgeIdle: true, interactions };
  const queue = application.runtime.outbox;
  queue.enqueue({ id: 'delivery', account: JSON.stringify(['local-test', 'synthetic', 'one']), conversation: f.key, kind: 'social', body: 'Retained body', payload: {},
    revisions: { binding: 1, policy: 0, memory: 0, identity: 0, expression: 0 }, sourceRefs: [], createdAt: 1000, dueAt: 1000, expiresAt: 5000, costUnits: 1 }); queue.cancel('delivery');
  const plan = application.maintenance.inspect({ domain: 'outbox', ids: ['delivery'], reviewer: actor });
  const receipt = application.maintenance.archive({ domain: 'outbox', ids: ['delivery'], expectedRevision: plan.revision, reviewer: actor, reason: 'Explicit local review' });
  assert.equal(receipt.length, 1); assert.equal(queue.list().length, 0); assert.equal(application.maintenance.read({ domain: 'outbox', id: 'delivery', reviewer: actor }).delivery.body, 'Retained body');
  permit = false; assert.throws(() => application.maintenance.list({ domain: 'outbox', reviewer: actor })); permit = true;
  queue.setPause(queue.state().revision, false); assert.throws(() => application.maintenance.list({ domain: 'outbox', reviewer: actor })); queue.setPause(queue.state().revision, true);
  binding = { ...binding, code: {}, verified: true }; assert.throws(() => application.maintenance.list({ domain: 'outbox', reviewer: actor }));
});

test('application close cancels in-flight Bili and drains before releasing its actual SQLite owner lock', async t => {
  const f = await fixture(t); let signal;
  f.ports.bili.transport = async (_url, options) => { signal = options.signal; return new Promise(() => {}); };
  const pending = f.app.biliSources.capture({ id: 'pending', expectedRevision: 0, request: { account, bvid } }, actor); const rejected = assert.rejects(pending);
  for (let i = 0; i < 10 && !signal; i++) await Promise.resolve(); await f.app.close(); await rejected;
  assert.equal(signal.aborted, true); assert.equal(existsSync(path.join(f.root, '.juebot-agent-owner')), false);
});

test('trusted growth evidence port evaluates a frozen suite without auto-approval; missing, fabricated or revoked evidence cannot write candidate', async t => {
  const evaluation = { suiteId: 'held-out', suiteVersion: 1, modelVersion: 'unconfigured', baselineVersion: 'initial', baseline: { privacy: 'pass' }, candidate: { privacy: 'pass' } };
  const f = await fixture(t, { growthEvaluation: { evaluate: async request => { assert.equal(request.principal, actor); return { kind: 'host-evidence', evidenceId: 'synthetic-test-run-1', evaluation }; } } });
  source(f.app, f.key, 'growth-proof'); const scope = f.app.runtime.scope(f.key);
  f.app.runtime.self.freezeSuite(scope, { id: 'held-out', version: 1, checks: [{ id: 'privacy', required: true }] });
  f.app.runtime.self.propose(scope, { id: 'candidate', adaptation: { warmth: 55, curiosity: 50, initiative: 50 }, sources: [{ eventId: 'growth-proof', revision: 1 }] });
  const result = await f.app.evaluateGrowth({ key: f.key, id: 'candidate', expectedRevision: 1 }, actor);
  assert.equal(result.kind, 'host-evidence'); assert.equal(result.result.value.status, 'evaluated'); assert.equal(result.result.value.reviewer, null);
  assert.equal(f.app.runtime.self.get(scope).value.growthVersion, 'initial');
  f.ports.growthEvaluation.evaluate = async () => ({ kind: 'human-reported', evidenceId: 'self-claimed', evaluation });
  await assert.rejects(f.app.evaluateGrowth({ key: f.key, id: 'candidate', expectedRevision: result.result.revision }, actor));
  assert.deepEqual(f.app.runtime.self.getCandidate(scope, 'candidate'), result.result);
  let finish; f.ports.growthEvaluation.evaluate = async () => new Promise(resolve => { finish = resolve; });
  const pending = f.app.evaluateGrowth({ key: f.key, id: 'candidate', expectedRevision: result.result.revision }, actor);
  for (let i = 0; i < 30 && !finish; i++) await Promise.resolve(); f.revokeActor(); finish({ kind: 'host-evidence', evidenceId: 'late-evidence', evaluation });
  await assert.rejects(pending); assert.deepEqual(f.app.runtime.self.getCandidate(scope, 'candidate'), result.result);
  const missing = await fixture(t); assert.throws(() => missing.app.evaluateGrowth({ key: missing.key, id: 'none', expectedRevision: 1 }, actor), /NOT_CONFIGURED/);
});

test('Code archive application maintenance resolves both domains and refuses hot interaction evidence or unresolved result deliveries', async t => {
  let binding, grant, rows = [];
  const f = await fixture(t, { codeAuthorization: () => grant, maintenance: { binding: () => binding, authorize: () => true } });
  binding = { verified: true, code: f.app.code, profile: f.app.runtime.profile, bridgeIdle: true, interactions: { list: () => rows, get: () => { throw Error('No cold record'); } } };
  grant = { revision: 1, adminActor: 'human', conversationKey: f.key, account: 'one', workspaceId: 'workspace', sessionId: 'session', modelConfigured: true, budgetAvailable: true, sandboxVerified: true, toolsRestricted: true, allowedTools: ['read'], verified: true };
  f.app.code.enable(1000); const task = f.app.code.admit({ eventId: 'code-event', actor: 'human', conversationKey: f.key, account: 'one', plain: true, text: 'Retained Code input' }, 1000).task;
  f.app.code.start(task.id, 1000); f.app.code.finish(task.id, 'Retained Code output', 1000); f.app.code.markResultDelivered(task.id, 1000); f.app.code.disable(1000);
  rows = [{ taskId: task.id, status: 'answered' }]; assert.throws(() => f.app.maintenance.inspect({ domain: 'code', ids: [task.id], reviewer: actor }), /INTERACTIONS_NOT_ARCHIVED/); rows = [];
  const queue = f.app.runtime.outbox;
  queue.enqueue({ id: task.id + ':result', account: JSON.stringify(['local-test', 'synthetic', 'one']), conversation: f.key, kind: 'code-result', body: 'Retained Code output', payload: { taskId: task.id },
    revisions: { binding: 1, policy: 0, memory: 0, identity: 0, expression: 0 }, sourceRefs: [], createdAt: 1000, dueAt: 1000, expiresAt: 5000, costUnits: 1 });
  assert.throws(() => f.app.maintenance.inspect({ domain: 'code', ids: [task.id], reviewer: actor }), /DELIVERY_UNSETTLED/);
  queue.setPause(queue.state().revision, false); const claimed = queue.claim(JSON.stringify(['local-test', 'synthetic', 'one']), 'synthetic', 1000, 30000, { id: 'day', limit: 1 }, () => ({ allowed: true, reason: 'NONE' }));
  queue.finish(claimed.id, claimed.claim, 1000, 'confirmed', 'synthetic-receipt'); queue.setPause(queue.state().revision, true);
  const inspected = f.app.maintenance.inspect({ domain: 'code', ids: [task.id], reviewer: actor });
  f.app.maintenance.archive({ domain: 'code', ids: [task.id], expectedRevision: inspected.revision, reviewer: actor, reason: 'Explicit terminal Code review' });
  assert.equal(f.app.code.list().length, 0); assert.equal(f.app.maintenance.read({ domain: 'code', id: task.id, reviewer: actor }).task.result, 'Retained Code output');
  const outboxPlan = f.app.maintenance.inspect({ domain: 'outbox', ids: [claimed.id], reviewer: actor });
  f.app.maintenance.archive({ domain: 'outbox', ids: [claimed.id], expectedRevision: outboxPlan.revision, reviewer: actor, reason: 'Reviewed delivery fact' });
  assert.equal(queue.list().length, 0); assert.equal(f.app.maintenance.list({ domain: 'outbox', reviewer: actor }).length, 1);
});

test('application source aliases keep one-item learning pending and snapshot revoke invalidates its review', async t => {
  const f = await fixture(t); const snapshot = await f.app.biliSources.capture({ id: 'proof', expectedRevision: 0, request: { account, bvid } }, actor);
  const input = { key: f.key, id: 'proof', revision: 1, itemId: snapshot.items[0].id, proposalId: 'single-item' };
  const first = f.app.biliSources.learning(input, actor); const again = f.app.biliSources.learning(input, actor);
  assert.equal(first.proposal.id, again.proposal.id); assert.equal(f.app.runtime.learning().length, 1);
  f.app.biliSources.revoke({ id: 'proof', expectedRevision: 1 }, actor);
  assert.throws(() => f.app.runtime.reviewLearning('single-item', true, actor));
  assert.equal(f.app.runtime.memory.readPolicy().value.sources[first.sourceId].status, 'revoked');
  assert.equal(f.app.biliSources.read('proof', 1, actor).snapshot.contentHash, snapshot.contentHash);
});

test('application prepares an existing-evidence pending creation intention without manual self.decide or sending', async t => {
  const f = await fixture(t, { participation: key => ({ ...participation, allowedTargets: [key] }) });
  await f.app.biliSources.capture({ id: 'pending-proof', expectedRevision: 0, request: { account, bvid } }, actor);
  source(f.app, f.key, 'pending-proof');
  const decision = await f.app.prepareCreationIntention(f.key, 'music', actor);
  assert.ok(decision.intention); assert.equal(decision.intention.status, 'pending'); assert.deepEqual(decision.intention.sources, [{ eventId: 'pending-proof', revision: 1 }]);
  assert.equal(f.app.runtime.outbox.list().length, 0); assert.equal(f.app.creation.list().length, 0);
  const result = await f.app.startCreation(f.key, decision.intention.id, { action: 'bili.comment', accountId: 'public-account', target }, actor);
  assert.equal(result.status, 'ready'); assert.equal(result.work.value.approval, null); assert.equal(f.app.runtime.outbox.list().length, 0);
});

test('explicit bounded runner creation plans prepare autonomous work only after start and never approve or submit', async t => {
  let plans = [], requested = 0; const diagnostics = [];
  const f = await fixture(t, { participation: key => ({ ...participation, allowedTargets: [key] }), runner: {
    accounts: [], intervalMs: 100, setTimer: () => 1, clearTimer: () => {}, creationPlans: () => { requested++; return plans; }, onDiagnostic: entry => diagnostics.push(entry),
  } });
  assert.equal(requested, 0); assert.equal(f.app.runner.status().started, false);
  await f.app.biliSources.capture({ id: 'runner-proof', expectedRevision: 0, request: { account, bvid } }, actor); source(f.app, f.key, 'runner-proof');
  plans = [{ key: f.key, topic: 'music', request: { action: 'bili.comment', accountId: 'public-account', target } }];
  await f.app.runner.start(); await f.app.runner.runOnce();
  assert.equal(f.app.creation.list().length, 1); const work = f.app.creation.read(f.app.creation.list()[0].id).value;
  assert.equal(work.stage, 'final-review'); assert.equal(work.approval, null); assert.equal(work.submission, null); assert.equal(f.app.runtime.outbox.list().length, 0);
  assert.ok(diagnostics.some(entry => entry.code === 'CREATION_READY_FOR_REVIEW'));
  plans = Array.from({ length: 9 }, (_, n) => ({ ...plans[0], topic: 'different-' + n })); await f.app.runner.runOnce();
  assert.equal(f.app.creation.list().length, 1); assert.ok(diagnostics.some(entry => entry.code === 'CREATION_PLAN_FAILED'));
  await f.app.runner.stop(); await assert.rejects(f.app.runner.runOnce()); assert.equal(f.app.creation.list().length, 1);
});

test('Bili current head and publish permission independently block an already approved old work before submit and dispatch', async t => {
  let allowed = true;
  const f = await fixture(t, { resolveAccount: () => account });
  const original = f.ports.bili.authorizeMaterials; f.ports.bili.authorizeMaterials = request => ({ ...original(request), allowed: request.operation !== 'publish' || allowed });
  await f.app.biliSources.capture({ id: 'proof', expectedRevision: 0, request: { account, bvid } }, actor); source(f.app, f.key, 'proof');
  const intent = intention(f.app, f.key); const ready = await f.app.startCreation(f.key, intent.id, { action: 'bili.comment', accountId: 'public-account', target }, actor);
  allowed = false; assert.throws(() => f.app.creation.approve(ready.work.value.id, ready.work.revision, actor, 5000)); allowed = true;
  const approved = f.app.creation.approve(ready.work.value.id, ready.work.revision, actor, 5000); allowed = false;
  assert.throws(() => f.app.dispatcher.submitCreation(approved.value.id, approved.revision)); allowed = true;
  f.app.dispatcher.submitCreation(approved.value.id, approved.revision); f.app.runtime.outbox.setPause(f.app.runtime.outbox.state().revision, false); allowed = false;
  const sent = await f.app.dispatcher.dispatch(account, 'worker', { id: 'day', limit: 1 }, async () => { assert.fail('withdrawn publication rights must block send'); });
  assert.equal(sent, null); assert.equal(f.app.runtime.outbox.list()[0].status, 'cancelled');
});

test('failed PolicyMemory propagation cannot leave an approved Bili work sendable after explicit revoke intent', async t => {
  const f = await fixture(t, { resolveAccount: () => account });
  await f.app.biliSources.capture({ id: 'proof', expectedRevision: 0, request: { account, bvid } }, actor); source(f.app, f.key, 'proof');
  const prepare = async () => {
    const intent = intention(f.app, f.key); assert.ok(intent);
    const ready = await f.app.startCreation(f.key, intent.id, { action: 'bili.comment', accountId: 'public-account', target }, actor);
    assert.equal(ready.status, 'ready'); return f.app.creation.approve(ready.work.value.id, ready.work.revision, actor, 5000);
  };
  const approved = await prepare(), queued = await prepare(); f.app.dispatcher.submitCreation(queued.value.id, queued.revision);
  const db = new DatabaseSync(path.join(f.root, 'agent.sqlite')); try {
  db.exec(`CREATE TRIGGER deny_policy_update BEFORE UPDATE ON agent_state WHEN NEW.key = '["policy-memory-v1","juebot","juejue"]' BEGIN SELECT RAISE(ABORT, 'synthetic policy failure'); END`);
  assert.throws(() => f.app.biliSources.revoke({ id: 'proof', expectedRevision: 1 }, actor));
  assert.equal(f.app.runtime.memory.readPolicy().value.sources.proof.status, 'active', 'simulated propagation really failed');
  const snapshot = f.app.biliSources.read('proof', 1, actor); assert.equal(snapshot.source.status, 'active'); assert.equal(snapshot.applicationHold.minimumRevision, 2);
  assert.throws(() => f.app.dispatcher.submitCreation(approved.value.id, approved.revision));
  f.app.runtime.outbox.setPause(f.app.runtime.outbox.state().revision, false);
  assert.equal(await f.app.dispatcher.dispatch(account, 'worker', { id: 'day', limit: 1 }, async () => { assert.fail('failed propagation must not permit stale publication'); }), null);
  assert.equal(f.app.runtime.outbox.list()[0].status, 'cancelled');
  db.exec('DROP TRIGGER deny_policy_update');
  const refreshed = await f.app.biliSources.capture({ id: 'proof', expectedRevision: 1, request: { account, bvid } }, actor);
  const proposal = f.app.biliSources.learning({ key: f.key, id: 'proof', revision: 2, itemId: refreshed.items[0].id, proposalId: 'new-explicit-review' }, actor);
  assert.equal(proposal.proposal.status, 'pending'); assert.equal(f.app.runtime.outbox.list().length, 1);
  } finally { db.close(); }
});

test('actual API Bili read -> selected learning -> human review -> exact summary intention -> final review -> one synthetic publication, then revoke/reopen fail closed', async t => {
  let key, plannerCalls = 0;
  const f = await fixture(t, { participation: scope => ({ ...participation, allowedTargets: [scope] }), resolveAccount: () => account,
    access: async () => ({ revision: 1, readKeys: key ? [key] : [], bodyKeys: key ? [key] : [], manage: true, review: true, bindingRevisions: key ? { [key]: 1 } : {} }),
    creative: { policy: () => ({ revision: 1, allowedAccounts: ['public-account', 'other-account'], allowedActions: ['bili.comment', 'bili.dynamic'] }),
      materials: async () => { assert.fail('approved exact summary must not enter raw/external materials provider'); },
      plan: async input => {
        plannerCalls++; assert.ok(input.materials.items.length >= 1);
        assert.ok(input.materials.items.every(item => item.text.includes('Approved synthetic material') && !item.text.includes('Synthetic title')));
        return { brief: 'Approved summary only', script: null, title: '', description: '', tags: [], text: 'Synthetic reviewed final from exact summary' };
      } } });
  key = f.key;
  f.ports.bili.authorizeMaterials = request => ({ allowed: !['draft', 'publish'].includes(request.operation), revision: 1, expiresAt: 10000 });
  f.app.runtime.memory.configure(f.app.runtime.memory.readPolicy().revision, { permissions: { reply: true } });
  const invoke = async (app, route, input) => {
    const response = await app.fetch(new Request('http://localhost/api/juebot/agent/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    const result = await response.json(); assert.equal(response.status, 200, route + ' ' + JSON.stringify(result)); assert.equal(result.ok, true); return result.data;
  };
  const snapshot = await invoke(f.app, 'bili-source', { action: 'capture', id: 'read-only-proof', expectedRevision: 0, request: { account, bvid } });
  const learning = await invoke(f.app, 'bili-source', { action: 'learning', key, id: 'read-only-proof', revision: 1, itemId: snapshot.items[1].id, proposalId: 'approved-summary' });
  assert.equal(learning.proposal.status, 'pending'); await invoke(f.app, 'learning', { id: 'approved-summary', accepted: true });
  const raw = f.app.runtime.memory.readPolicy().value.sources[learning.sourceId]; assert.deepEqual(raw.purposes, ['read', 'learn']);
  const request = { action: 'bili.comment', accountId: 'public-account', target };
  const prepare = async () => {
    const result = await invoke(f.app, 'summary-creation', { key, memoryId: 'approved-summary', expectedMemoryRevision: 1,
      expectedPolicyRevision: f.app.runtime.memory.readPolicy().revision, reason: 'Human approves only this exact summary and destination', expiresAt: 5000, request });
    assert.equal(result.decision.intention.status, 'pending');
    const alias = f.app.runtime.memory.readPolicy().value.sources[result.material.sourceId]; assert.deepEqual(alias.purposes, ['draft', 'publish']);
    assert.deepEqual(f.app.runtime.memory.readPolicy().value.sources[learning.sourceId].purposes, ['read', 'learn']);
    return result;
  };
  const prepared = await prepare();
  const otherRequest = { ...request, target: { ...target, objectId: 'BV1xx411c7mE' } };
  const otherGrant = await invoke(f.app, 'summary-creation', { key, memoryId: 'approved-summary', expectedMemoryRevision: 1,
    expectedPolicyRevision: f.app.runtime.memory.readPolicy().revision, reason: 'Human separately approves another exact destination', expiresAt: 5000, request: otherRequest });
  assert.notEqual(otherGrant.material.topic, prepared.material.topic); assert.notEqual(otherGrant.decision.intention.id, prepared.decision.intention.id);
  await assert.rejects(f.app.startCreation(key, prepared.decision.intention.id, { ...request, accountId: 'other-account' }, actor));
  await assert.rejects(f.app.startCreation(key, prepared.decision.intention.id, { ...request, action: 'bili.dynamic' }, actor));
  await assert.rejects(f.app.startCreation(key, prepared.decision.intention.id, otherRequest, actor));
  await assert.rejects(f.app.startCreation(key, otherGrant.decision.intention.id, request, actor));
  assert.equal(f.app.creation.list().length, 0);
  const otherReady = await invoke(f.app, 'creation-start', { key, intentionId: otherGrant.decision.intention.id, ...otherRequest });
  assert.equal(otherReady.status, 'ready'); assert.deepEqual(otherReady.work.value.target, otherRequest.target);
  const ready = await invoke(f.app, 'creation-start', { key, intentionId: prepared.decision.intention.id, ...request });
  assert.equal(ready.status, 'ready'); assert.equal(ready.work.value.stage, 'final-review'); assert.equal(ready.work.value.approval, null); assert.equal(f.app.runtime.outbox.list().length, 0);
  const approved = await invoke(f.app, 'review', { id: ready.work.value.id, expectedRevision: ready.work.revision, action: 'approve', expiresAt: 5000 });
  await invoke(f.app, 'submit', { id: approved.value.id, expectedRevision: approved.revision });
  f.app.runtime.outbox.setPause(f.app.runtime.outbox.state().revision, false); let sent = 0;
  const delivery = await f.app.dispatcher.dispatch(account, 'synthetic', { id: 'day', limit: 2 }, async () => { sent++; return { status: 'confirmed', receipt: 'synthetic-bili-object', visibility: 'accepted' }; });
  assert.equal(delivery.status, 'confirmed'); assert.equal(sent, 1);
  const pending = await prepare();
  const second = await invoke(f.app, 'creation-start', { key, intentionId: pending.decision.intention.id, ...request });
  const oldApproved = await invoke(f.app, 'review', { id: second.work.value.id, expectedRevision: second.work.revision, action: 'approve', expiresAt: 5000 });
  assert.equal(plannerCalls, 3); assert.equal(f.calls(), 2);
  await f.app.close(); let reopened;
  try {
    reopened = await openApplication({}, { enabled: true, dataRoot: f.root, initializeEmpty: false, namespace: 'integration' }, { principal: actor }, { ...f.ports, bili: undefined });
    assert.throws(() => reopened.dispatcher.submitCreation(oldApproved.value.id, oldApproved.revision), 'missing Bili port cannot turn saved evidence into an external fallback');
    await reopened.close();
    reopened = await openApplication({}, { enabled: true, dataRoot: f.root, initializeEmpty: false, namespace: 'integration' }, { principal: actor }, f.ports);
    await invoke(reopened, 'bili-source', { action: 'revoke', id: 'read-only-proof', expectedRevision: 1 });
    assert.throws(() => reopened.dispatcher.submitCreation(oldApproved.value.id, oldApproved.revision));
    assert.equal(await reopened.dispatcher.dispatch(account, 'no-replay', { id: 'day', limit: 2 }, async () => { assert.fail('never replay a confirmed or revoked work'); }), null);
    await reopened.close();
    reopened = await openApplication({}, { enabled: true, dataRoot: f.root, initializeEmpty: false, namespace: 'integration' }, { principal: actor }, f.ports);
    assert.throws(() => reopened.dispatcher.submitCreation(oldApproved.value.id, oldApproved.revision)); assert.equal(reopened.runtime.outbox.list().length, 1);
    assert.equal(reopened.runtime.memory.readPolicy().value.sources[pending.material.sourceId].status, 'revoked');
  } finally { await reopened?.close(); }
});
