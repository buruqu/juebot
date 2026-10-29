import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { SelfGrowthEngine } from '../src/self-growth.ts';
import { CreationService } from '../src/creation.ts';
import { CreativeWorkflow } from '../src/creative-workflow.ts';
import { DurableOutbox } from '../src/outbox.ts';
import { AgentError } from '../src/common.ts';
import type { CreationDependencies, CreationSource, CreationWork, FinalManifest, TrustedAsset, SubmissionSnapshot } from '../src/creation.ts';
import type { CreativeMaterials, CreativePlan, CreativePolicy, CreativeWorkflowDependencies, CreativeRequest } from '../src/creative-workflow.ts';

const scope = { botId: 'bot', personaId: 'persona', scope: 'synthetic-creative-scope' };
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:', { allowExtension: false }); t.after(() => db.close());
  const store = new SqliteStateStore(db, { namespace: 'creative-test', initialize: true });
  let now = 1000, plans = 0, productions = 0;
  const self = new SelfGrowthEngine(store, { clock: () => now });
  self.initialize({ ...scope, name: '撅撅', mode: 'juejue', roleCore: 'Synthetic role core', modelVersion: 'test-model' });
  self.observe(scope, { eventId: 'external-interest', revision: 1, kind: 'external', topic: 'music', interestDelta: 10, feedback: 'interest' });
  const decision = self.decide(scope, { target: 'public-creation', topic: 'music', action: 'idle-topic', policy: { enabled: true,
    allowedTargets: ['public-creation'], deniedTargets: [], timeZoneOffsetMinutes: 0, windows: [{ startMinute: 0, endMinute: 1440 }], cooldownMs: 0, dailyLimit: 2, unansweredLimit: 2 } });
  assert.ok(decision.intention); const intention = decision.intention;
  const sources: CreationSource[] = [{ id: 'public-source', revision: 1, personLinkRevision: 2 },
    { id: 'external-interest', revision: 1, personLinkRevision: 7 }];
  const materials: CreativeMaterials = { revision: 1, sources, items: [{ id: 'material', text: 'Synthetic material explicitly approved for public creation' }] };
  const policy: CreativePolicy = { revision: 1, allowedAccounts: ['account-1'], allowedActions: ['qqspace', 'bili.comment', 'bili.reply', 'bili.dynamic', 'bili.video'] };
  const context = { revision: 1, personaId: scope.personaId };
  const sourceAuthorization = { intentPublishAllowed: true, intentDraftAllowed: true };
  const registry = new Map<string, TrustedAsset>();
  for (const [ref, kind] of [['video', 'video'], ['audio', 'audio'], ['subtitles', 'subtitles'], ['cover', 'image']] as const)
    registry.set(ref, { ref, kind, previewRef: 'preview_' + ref, sha256: 'a'.repeat(64), ready: true });
  const reference = (ref: string) => { const asset = registry.get(ref)!; return { ref, previewRef: asset.previewRef, sha256: asset.sha256 }; };
  const publication = { title: 'Synthetic final title', description: 'Synthetic description', tags: ['music'], text: 'Synthetic public creation' };
  const creationDeps: CreationDependencies = { now: () => now, authorizeHuman: principal => principal === 'host-human', resolveAsset: ref => registry.get(ref) ?? null,
    currentAuthority: () => ({ policyRevision: 1, accountRevision: 1, contextRevision: context.revision, publishAllowed: true,
      sources: sources.map(source => ({ ...source, publishAllowed: source.id === 'external-interest' ? sourceAuthorization.intentPublishAllowed : true })) }),
    validateWorkflow: work => {
      const journal = work.workflow!; const state = self.get(journal.selfScope).value;
      const currentIntent = state.intents.find(item => item.id === journal.intentId);
      // Trusted current-state check, not an expiry check: preparation consumed the intention already.
      return sourceAuthorization.intentDraftAllowed && journal.selfScope.personaId === context.personaId && state.identityRevision === journal.identityRevision
        && state.growthVersion === journal.growthVersion && state.modelVersion === journal.modelVersion && state.mode === journal.mode
        && (!currentIntent || currentIntent.status === 'attempted') && journal.intentionSources.every(source =>
          Object.hasOwn(state.evidence, source.eventId) && state.evidence[source.eventId]!.revision === source.revision && !state.evidence[source.eventId]!.revoked);
    },
    // Explicit synthetic registry/provider, not a real video renderer or playable media proof.
    productionProvider: { produce: async work => { productions++; const desired = work.workflow!.publication!;
      return { ...desired, accountId: work.accountId, target: work.target, video: reference('video'), audio: [reference('audio')], subtitles: [reference('subtitles')], cover: reference('cover'), attachments: [] }; } } };
  const creation = new CreationService(store, creationDeps);
  const plan: CreativePlan = { brief: 'Synthetic brief', script: 'Synthetic script with production instructions', ...publication };
  const deps: CreativeWorkflowDependencies = { self, creation, scope, now: () => now, policy: () => structuredClone(policy),
    materials: async () => structuredClone(materials), plan: async () => { plans++; return structuredClone(plan); } };
  const request: CreativeRequest = { action: 'bili.comment', accountId: 'account-1', target: { objectId: 'video-target', parentId: null, visibility: 'public', category: null } };
  return { db, store, self, creation, creationDeps, deps, policy, context, sourceAuthorization, materials, plan, request, intention,
    workflow: new CreativeWorkflow(deps), plans: () => plans, productions: () => productions, setNow: (value: number) => { now = value; } };
}
const failure = (code: string) => (error: unknown) => error instanceof Error && error.message === code;

async function interrupted(t: { after(fn: () => void): void }, phase: 'planning' | 'producing' = 'planning') {
  const f = fixture(t); let finish!: () => void;
  if (phase === 'planning') f.deps.plan = async () => new Promise<CreativePlan>(resolve => { finish = () => resolve(structuredClone(f.plan)); });
  else {
    const producer = f.creationDeps.productionProvider!;
    f.creationDeps.productionProvider = { produce: work => new Promise<FinalManifest>(resolve => { finish = () => { void producer.produce(work).then(resolve); }; }) };
  }
  const request = phase === 'producing' ? { ...f.request, action: 'bili.video' as const, target: { ...f.request.target, category: 'music' } } : f.request;
  const pending = f.workflow.start(f.intention.id, request);
  for (let i = 0; i < 30 && !finish; i++) await Promise.resolve();
  assert.ok(finish); const work = f.creation.read(f.creation.list()[0]!.id)!;
  assert.equal(work.value.workflow!.phase, phase);
  return { ...f, request, pending, work, finish };
}

test('human recovery fences an old planner, preserves work/attempt identity and requires a new final approval', async t => {
  const f = await interrupted(t);
  await assert.rejects(f.workflow.recover(f.work.value.id, f.work.revision, 'model', 'recover'), failure('CREATION_HUMAN_REQUIRED'));
  assert.equal(f.creation.recoveryAudit(f.work.value.id).length, 0);
  f.deps.plan = async () => ({ ...f.plan, text: 'Recovered final requires human review' });
  const recovered = await new CreativeWorkflow(f.deps).recover(f.work.value.id, f.work.revision, 'host-human', 'Explicitly restart local planning');
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.work.value.id, f.work.value.id);
  assert.equal(recovered.work.value.approval, null); assert.equal(recovered.work.value.submission, null);
  assert.equal(f.self.get(scope).value.counters['idle-topic']!.count, 1);
  assert.throws(() => f.creation.submit(recovered.work.value.id, recovered.work.revision, () => 'unreviewed'), failure('CREATION_APPROVAL_REQUIRED'));
  await assert.rejects(f.workflow.recover(f.work.value.id, f.work.revision, 'host-human', 'stale double click'), failure('CREATION_REVISION_CONFLICT'));
  f.finish(); assert.equal((await f.pending).status, 'failed');
  const current = f.creation.read(f.work.value.id)!;
  assert.equal(current.revision, recovered.work.revision); assert.equal(current.value.final!.manifest.text, 'Recovered final requires human review');
  assert.deepEqual(f.creation.recoveryAudit(current.value.id), [{ decision: 'recover', principal: 'host-human', reason: 'Explicitly restart local planning', at: 1000, fromRevision: f.work.revision, phase: 'planning' }]);
  const approved = f.creation.approve(current.value.id, current.revision, 'host-human', 5000);
  const submitted = f.creation.submit(current.value.id, approved.revision, () => 'once-only');
  assert.equal(f.creation.submit(current.value.id, current.revision, () => { throw Error('duplicate'); }).intentId, submitted.intentId);
  await assert.rejects(f.workflow.recover(current.value.id, submitted.work.revision, 'host-human', 'already sent'), failure('CREATION_ALREADY_SUBMITTED'));
});

test('a failed planner remains failed on repeated start and resumes only after explicit human recovery', async t => {
  const f = fixture(t); f.deps.plan = async () => { throw Error('private model failure'); };
  const failed = await f.workflow.start(f.intention.id, f.request);
  assert.equal(failed.reasonCode, 'PLAN_FAILED');
  f.deps.plan = async () => structuredClone(f.plan);
  assert.equal((await f.workflow.start(f.intention.id, f.request)).status, 'failed');
  const recovered = await f.workflow.recover(failed.work.value.id, failed.work.revision, 'host-human', 'Retry local preparation after resolving model fault');
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.work.value.id, failed.work.value.id);
  assert.equal(recovered.work.value.approval, null); assert.equal(recovered.work.value.submission, null);
  assert.equal(f.self.get(scope).value.counters['idle-topic']!.count, 1);
});

test('recovery commit guard rejects late model/producer success or failure without any post-revocation write', async t => {
  for (const boundary of ['plan', 'producer', 'plan-error']) {
    const f = await interrupted(t, boundary === 'producer' ? 'producing' : 'planning'); let release!: () => void, revoked = false;
    const guard = async () => { if (revoked) throw new AgentError('ACCESS_CHANGED'); };
    f.deps.plan = boundary === 'producer' ? async () => structuredClone(f.plan) : async () => new Promise<CreativePlan>((resolve, reject) => {
      release = () => boundary === 'plan-error' ? reject(Error('private model failure')) : resolve(structuredClone(f.plan));
    });
    if (boundary === 'producer') {
      const ref = (name: string) => ({ ref: name, previewRef: 'preview_' + name, sha256: 'a'.repeat(64) });
      f.creationDeps.productionProvider = { produce: async work => new Promise<FinalManifest>(resolve => {
        release = () => resolve({ ...work.workflow!.publication!, accountId: work.accountId, target: work.target,
          video: ref('video'), cover: ref('cover'), audio: [ref('audio')], subtitles: [ref('subtitles')], attachments: [] });
      }) };
    }
    const pending = f.workflow.recover(f.work.value.id, f.work.revision, 'host-human', 'Human recovery', guard);
    for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
    assert.ok(release); const before = f.creation.read(f.work.value.id)!; const audit = f.creation.recoveryAudit(before.value.id);
    revoked = true; release(); await assert.rejects(pending, failure('ACCESS_CHANGED'));
    assert.deepEqual(f.creation.read(before.value.id), before); assert.deepEqual(f.creation.recoveryAudit(before.value.id), audit);
    f.finish(); await f.pending;
  }
});

test('explicit recovery of interrupted video rebuilds local media and fences the late old producer', async t => {
  const f = await interrupted(t, 'producing');
  f.creationDeps.productionProvider = { produce: async work => ({ ...work.workflow!.publication!, accountId: work.accountId, target: work.target,
    video: { ref: 'video', previewRef: 'preview_video', sha256: 'a'.repeat(64) }, cover: { ref: 'cover', previewRef: 'preview_cover', sha256: 'a'.repeat(64) },
    audio: [{ ref: 'audio', previewRef: 'preview_audio', sha256: 'a'.repeat(64) }], subtitles: [{ ref: 'subtitles', previewRef: 'preview_subtitles', sha256: 'a'.repeat(64) }], attachments: [] }) };
  const recovered = await f.workflow.recover(f.work.value.id, f.work.revision, 'host-human', 'Rebuild interrupted video');
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.work.value.stage, 'final-review');
  f.finish(); assert.equal((await f.pending).status, 'failed');
  assert.equal(f.creation.read(f.work.value.id)!.revision, recovered.work.revision);
  assert.equal(f.creation.read(f.work.value.id)!.value.approval, null);
});

test('human abandon is terminal, preserves draft artifacts, and prevents late async completion and automatic restart', async t => {
  for (const phase of ['planning', 'producing'] as const) {
    const f = await interrupted(t, phase);
    assert.throws(() => f.creation.abandonWorkflow(f.work.value.id, f.work.revision, 'model', 'stop'), failure('CREATION_HUMAN_REQUIRED'));
    const abandoned = f.creation.abandonWorkflow(f.work.value.id, f.work.revision, 'host-human', 'Discard interrupted attempt');
    assert.equal(abandoned.value.script, f.work.value.script); assert.equal(abandoned.value.workflow!.reasonCode, 'HUMAN_ABANDONED');
    assert.equal(f.creation.recoveryAudit(abandoned.value.id)[0]!.decision, 'abandon');
    f.finish(); await f.pending;
    const duplicate = await f.workflow.start(f.intention.id, f.request);
    assert.equal(duplicate.status, 'failed'); assert.equal(duplicate.reasonCode, 'HUMAN_ABANDONED');
    assert.equal(duplicate.work.revision, abandoned.revision);
    await assert.rejects(f.workflow.recover(abandoned.value.id, abandoned.revision, 'host-human', 'restore'), failure('CREATION_RECOVERY_NOT_ALLOWED'));
    assert.throws(() => f.creation.approve(abandoned.value.id, abandoned.revision, 'host-human', 5000));
  }
});

test('recovery refuses expired intentions, revoked sources, changed identity/policy/materials and missing trusted validation', async t => {
  for (const fault of ['expired', 'source', 'identity', 'policy', 'materials', 'publish', 'validator']) {
    const f = await interrupted(t);
    if (fault === 'expired') f.setNow(f.intention.expiresAt);
    if (fault === 'source') f.self.revokeSource(scope, 'external-interest', 1);
    if (fault === 'identity') f.self.rename(scope, 'New identity', f.self.get(scope).revision);
    if (fault === 'policy') f.policy.revision++;
    if (fault === 'materials') f.materials.revision++;
    if (fault === 'publish') f.sourceAuthorization.intentPublishAllowed = false;
    if (fault === 'validator') delete f.creationDeps.validateWorkflow;
    f.deps.plan = async () => { assert.fail('changed dependencies must never reach a new planner'); };
    if (fault === 'materials') {
      const result = await f.workflow.recover(f.work.value.id, f.work.revision, 'host-human', 'Attempt recovery');
      assert.equal(result.status, 'failed'); assert.equal(result.reasonCode, 'MATERIALS_CHANGED');
    } else await assert.rejects(f.workflow.recover(f.work.value.id, f.work.revision, 'host-human', 'Attempt recovery'), failure(
      ['expired', 'source', 'identity'].includes(fault) ? 'INTENTION_UNAVAILABLE' : fault === 'policy' ? 'POLICY_CHANGED' : fault === 'publish' ? 'CREATION_SOURCE_REVOKED' : 'CREATION_WORKFLOW_INVALID'));
    f.finish(); await f.pending;
    assert.equal(f.creation.read(f.work.value.id)!.value.approval, null);
    assert.equal(f.creation.read(f.work.value.id)!.value.submission, null);
  }
});

test('real SQLite interest -> intention -> creation stops at final-review; only a human can create the Outbox intent', async t => {
  const f = fixture(t); const prepared = await f.workflow.start(f.intention.id, f.request);
  assert.equal(prepared.status, 'ready'); assert.equal(prepared.work.value.stage, 'final-review'); assert.equal(prepared.work.value.workflow!.phase, 'ready');
  assert.equal(prepared.work.value.approval, null); assert.equal(prepared.work.value.submission, null);
  assert.ok(prepared.work.value.final!.sources.some(source => source.id === 'external-interest' && source.revision === 1 && source.personLinkRevision === 7));
  assert.equal(f.self.get(scope).value.intents.find(item => item.id === f.intention.id)!.status, 'attempted');
  assert.equal(f.self.get(scope).value.counters['idle-topic']!.count, 1);
  assert.equal(f.plans(), 1); const outbox = new DurableOutbox(f.store); assert.equal(outbox.list().length, 0);
  assert.throws(() => f.creation.approve(prepared.work.value.id, prepared.work.revision, 'model', 5000), failure('CREATION_HUMAN_REQUIRED'));
  const approved = f.creation.approve(prepared.work.value.id, prepared.work.revision, 'host-human', 5000);
  let submitted!: SubmissionSnapshot;
  const result = f.creation.submit(approved.value.id, approved.revision, (tx, snapshot) => {
    submitted = snapshot;
    return outbox.enqueueIn(tx, { id: 'publish-' + snapshot.workId, account: snapshot.manifest.accountId, conversation: 'public-creation', kind: 'creation', body: snapshot.manifest.text,
      payload: snapshot, revisions: { binding: 1, policy: 1, memory: 1, identity: 1, expression: 1 }, sourceRefs: snapshot.sources.map(source => ({ id: source.id, revision: source.revision })),
      createdAt: 1000, dueAt: 1000, expiresAt: 5000, costUnits: 1 });
  });
  assert.equal(outbox.list().length, 1); f.creation.validateSubmission(submitted, result.intentId);
  assert.equal(f.creation.submit(approved.value.id, approved.revision, () => { assert.fail('no duplicate Outbox intent'); }).intentId, result.intentId);
});

test('video carries publication metadata to the configured producer and still requires final-media human review', async t => {
  const f = fixture(t); const request = { ...f.request, action: 'bili.video' as const, target: { ...f.request.target, objectId: null, category: 'music' } };
  const result = await f.workflow.start(f.intention.id, request);
  assert.equal(result.status, 'ready'); assert.equal(f.productions(), 1);
  assert.equal(result.work.value.final!.manifest.video!.previewRef, 'preview_video');
  assert.equal(result.work.value.final!.manifest.title, f.plan.title); assert.equal(result.work.value.script, f.plan.script);
  assert.equal(result.work.value.approval, null); assert.equal(result.work.value.submission, null);
});

test('unconfigured production and model failures keep bounded failed drafts without raw errors or automatic retry', async t => {
  for (const fault of ['plan', 'production']) {
    const f = fixture(t);
    if (fault === 'plan') f.deps.plan = async () => { throw Error('SECRET model prompt /private/path'); };
    else delete f.creationDeps.productionProvider;
    const request = fault === 'production' ? { ...f.request, action: 'bili.video' as const, target: { ...f.request.target, category: 'music' } } : f.request;
    const result = await f.workflow.start(f.intention.id, request);
    assert.equal(result.status, 'failed'); assert.equal(result.work.value.workflow!.phase, 'failed');
    assert.equal(result.reasonCode, fault === 'plan' ? 'PLAN_FAILED' : 'PRODUCTION_FAILED');
    assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.equal(result.work.value.submission, null);
    if (fault === 'production') { assert.equal(result.work.value.script, f.plan.script); assert.equal(result.work.value.brief, f.plan.brief); }
    const again = await new CreativeWorkflow(f.deps).start(f.intention.id, request);
    assert.equal(again.duplicate, true); assert.equal(again.status, 'failed');
    assert.equal(again.work.revision, result.work.revision);
  }
});

test('stable work identity prevents duplicate planning, account swapping or publication on repeated starts', async t => {
  const f = fixture(t); const first = await f.workflow.start(f.intention.id, f.request);
  const second = await new CreativeWorkflow(f.deps).start(f.intention.id, f.request);
  assert.equal(second.duplicate, true); assert.equal(second.work.value.id, first.work.value.id); assert.equal(f.plans(), 1);
  await assert.rejects(f.workflow.start(f.intention.id, { ...f.request, accountId: 'other' }), failure('CREATIVE_INTENT_ALREADY_BOUND'));
  assert.equal(f.creation.list().length, 1);
});

test('pending/producing reentry returns recovery-required instead of starting another planner', async t => {
  const f = fixture(t); let finish!: (value: CreativePlan) => void;
  f.deps.plan = async () => new Promise<CreativePlan>(resolve => { finish = resolve; });
  const pending = f.workflow.start(f.intention.id, f.request);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const existing = await new CreativeWorkflow(f.deps).start(f.intention.id, f.request);
  assert.equal(existing.status, 'recovery-required'); assert.equal(existing.work.value.workflow!.phase, 'planning');
  assert.equal(f.creation.list().length, 1); finish(f.plan); assert.equal((await pending).status, 'ready');
});

test('expired, revoked, nonpending and disallowed intentions never reach the planner or create a work', async t => {
  for (const fault of ['expired', 'revoked', 'attempted', 'policy']) {
    const f = fixture(t);
    if (fault === 'expired') f.setNow(f.intention.expiresAt);
    if (fault === 'revoked') f.self.revokeSource(scope, 'external-interest', 1);
    if (fault === 'attempted') f.self.recordAttempt(scope, f.intention.id, { responded: false });
    if (fault === 'policy') f.policy.allowedAccounts = [];
    await assert.rejects(f.workflow.start(f.intention.id, f.request)); assert.equal(f.plans(), 0); assert.equal(f.creation.list().length, 0);
  }
});

test('after-await source, material and policy changes retain the failed work and block human approval', async t => {
  for (const fault of ['source', 'materials', 'policy', 'expiry', 'identity']) {
    const f = fixture(t);
    f.deps.plan = async () => {
      if (fault === 'source') f.self.revokeSource(scope, 'external-interest', 1);
      if (fault === 'materials') { f.materials.revision++; f.materials.items[0]!.text = 'Changed approved projection'; }
      if (fault === 'policy') f.policy.revision++;
      if (fault === 'expiry') f.setNow(f.intention.expiresAt);
      if (fault === 'identity') f.self.rename(scope, 'New Host name', f.self.get(scope).revision);
      return structuredClone(f.plan);
    };
    const result = await f.workflow.start(f.intention.id, f.request);
    assert.equal(result.status, 'failed', fault); assert.equal(result.work.value.workflow!.phase, 'failed');
    assert.equal(result.reasonCode, fault === 'materials' ? 'MATERIALS_CHANGED' : fault === 'policy' ? 'POLICY_CHANGED' : 'INTENTION_UNAVAILABLE');
    assert.throws(() => f.creation.approve(result.work.value.id, result.work.revision, 'host-human', 9999999));
    assert.equal(result.work.value.submission, null);
  }
});

test('planner cannot self-approve/share or omit a video script; strict bounded plan validation retains failure reason', async t => {
  for (const plan of [{ approved: true }, { sharing: { approved: true } }, { brief: 'x'.repeat(8001) }, { script: null }]) {
    const f = fixture(t); f.deps.plan = async () => ({ ...f.plan, ...plan }) as CreativePlan;
    const result = await f.workflow.start(f.intention.id, { ...f.request, action: 'bili.video', target: { ...f.request.target, category: 'music' } });
    assert.equal(result.status, 'failed'); assert.equal(result.reasonCode, 'INVALID_PLAN'); assert.equal(f.productions(), 0);
  }
});

test('workflow journal cannot bypass final requirements or change the approval/manifest snapshot', async t => {
  const f = fixture(t); const ready = await f.workflow.start(f.intention.id, f.request); const beforeHash = ready.work.value.final!.manifestHash;
  const failed = f.creation.setWorkflow(ready.work.value.id, ready.work.revision, { ...ready.work.value.workflow!, phase: 'failed', reasonCode: 'MATERIALS_CHANGED' });
  assert.equal(failed.value.final!.manifestHash, beforeHash); assert.equal(failed.value.stage, 'final-review');
  assert.equal(f.creation.list()[0]!.readyForReview, false);
  assert.throws(() => f.creation.approve(failed.value.id, failed.revision, 'host-human', 5000), failure('CREATION_WORKFLOW_NOT_READY'));
  assert.throws(() => f.creation.setWorkflow(failed.value.id, failed.revision, { ...failed.value.workflow!, phase: 'ready', reasonCode: null }), failure('CREATION_WORKFLOW_CONFLICT'));
});

test('a human revision during planning wins and is never overwritten by a failed planner', async t => {
  const f = fixture(t);
  f.deps.plan = async () => {
    const current = f.creation.read(f.creation.list()[0]!.id)!;
    f.creation.setBrief(current.value.id, current.revision, 'Human edited brief');
    throw Error('private model failure');
  };
  const result = await f.workflow.start(f.intention.id, f.request);
  assert.equal(result.status, 'failed'); assert.equal(result.reasonCode, 'PLAN_FAILED');
  assert.equal(result.work.value.brief, 'Human edited brief'); assert.equal(result.work.value.workflow!.phase, 'planning');
  assert.equal((await new CreativeWorkflow(f.deps).start(f.intention.id, f.request)).status, 'recovery-required');
});

test('persisted self dependencies fail closed after readiness and again for queued submission', async t => {
  for (const boundary of ['review', 'queued']) for (const fault of ['source', 'persona', 'identity', 'missing-validator', 'validator-error']) {
    const f = fixture(t); const ready = await f.workflow.start(f.intention.id, f.request);
    const journal = ready.work.value.workflow!;
    assert.deepEqual(journal.selfScope, scope); assert.deepEqual(journal.intentionSources, f.intention.sources);
    assert.equal(journal.identityRevision, f.self.get(scope).value.identityRevision);
    let submitted!: SubmissionSnapshot;
    if (boundary === 'queued') {
      const approved = f.creation.approve(ready.work.value.id, ready.work.revision, 'host-human', 9999999);
      f.creation.submit(approved.value.id, approved.revision, (_tx, snapshot) => { submitted = snapshot; return 'synthetic-intent'; });
    }
    if (fault === 'source') f.self.revokeSource(scope, 'external-interest', 1);
    if (fault === 'persona') f.context.personaId = 'another-persona';
    if (fault === 'identity') f.self.rename(scope, 'Renamed identity', f.self.get(scope).revision);
    if (fault === 'missing-validator') delete f.creationDeps.validateWorkflow;
    if (fault === 'validator-error') f.creationDeps.validateWorkflow = () => { throw Error('/private/database'); };
    if (boundary === 'review') assert.throws(() => f.creation.approve(ready.work.value.id, ready.work.revision, 'host-human', 9999999), failure('CREATION_WORKFLOW_INVALID'));
    else assert.throws(() => f.creation.validateSubmission(submitted, 'synthetic-intent'), failure('CREATION_WORKFLOW_INVALID'));
  }
});

test('launch expiry does not expire prepared work and workflow provenance cannot be replaced', async t => {
  const f = fixture(t); const ready = await f.workflow.start(f.intention.id, f.request);
  assert.throws(() => f.creation.setWorkflow(ready.work.value.id, ready.work.revision,
    { ...ready.work.value.workflow!, phase: 'failed', reasonCode: 'CREATION_FAILED', selfScope: { ...scope, personaId: 'replacement' } }), failure('CREATION_WORKFLOW_CONFLICT'));
  f.setNow(f.intention.expiresAt + 1);
  const approved = f.creation.approve(ready.work.value.id, ready.work.revision, 'host-human', f.intention.expiresAt + 10000);
  let submitted!: SubmissionSnapshot;
  f.creation.submit(approved.value.id, approved.revision, (_tx, snapshot) => { submitted = snapshot; return 'intent-after-preparation'; });
  f.creation.validateSubmission(submitted, 'intent-after-preparation');
});

test('private intention evidence absent from the public projection or at the wrong revision never reaches the planner', async t => {
  for (const fault of ['missing', 'revision']) {
    const f = fixture(t);
    if (fault === 'missing') f.materials.sources = f.materials.sources.filter(source => source.id !== 'external-interest');
    else f.materials.sources.find(source => source.id === 'external-interest')!.revision++;
    const result = await f.workflow.start(f.intention.id, f.request);
    assert.equal(result.status, 'failed'); assert.equal(result.reasonCode, 'MATERIALS_CHANGED'); assert.equal(f.plans(), 0);
    assert.equal(result.work.value.final, null); assert.equal(result.work.value.approval, null); assert.equal(f.productions(), 0);
    assert.throws(() => f.creation.approve(result.work.value.id, result.work.revision, 'host-human', 9999999));
  }
});

test('intention evidence publication revocation blocks ready approval and queued sends even while draft permission stays valid', async t => {
  for (const boundary of ['ready', 'queued']) {
    const f = fixture(t); const ready = await f.workflow.start(f.intention.id, f.request);
    assert.equal(ready.status, 'ready'); let snapshot!: SubmissionSnapshot;
    if (boundary === 'queued') {
      const approved = f.creation.approve(ready.work.value.id, ready.work.revision, 'host-human', 9999999);
      f.creation.submit(approved.value.id, approved.revision, (_tx, input) => { snapshot = input; return 'publication-with-intent'; });
    }
    f.sourceAuthorization.intentPublishAllowed = false;
    assert.equal(f.sourceAuthorization.intentDraftAllowed, true); assert.equal(f.creationDeps.validateWorkflow!(ready.work.value), true);
    if (boundary === 'ready') assert.throws(() => f.creation.approve(ready.work.value.id, ready.work.revision, 'host-human', 9999999), failure('CREATION_SOURCE_REVOKED'));
    else assert.throws(() => f.creation.validateSubmission(snapshot, 'publication-with-intent'), failure('CREATION_SOURCE_REVOKED'));
  }
});
