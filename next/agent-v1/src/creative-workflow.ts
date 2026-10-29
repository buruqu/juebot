import { createHash } from 'node:crypto';
import { AgentError, integer, stable, text } from './common.ts';
import type { Snapshot } from './store.ts';
import type { SelfGrowthEngine, SelfScope, Intention } from './self-growth.ts';
import type { CreationService, CreationAction, CreationTarget, CreationSource, CreationWork, WorkflowFailure, CreationWorkflowState, FinalManifest } from './creation.ts';
export interface CreativePolicy { revision: number; allowedAccounts: string[]; allowedActions: CreationAction[] }
export interface CreativeMaterials { revision: number; sources: CreationSource[]; items: { id: string; text: string }[] }
export interface CreativePlan { brief: string; script: string | null; title: string; description: string; tags: string[]; text: string }
export interface CreativeRequest { action: CreationAction; accountId: string; target: CreationTarget }
export interface CreativeWorkflowDependencies {
  self: SelfGrowthEngine; creation: CreationService; scope: SelfScope; now(): number;
  policy(): CreativePolicy;
  /** Trusted projection of materials approved for public creation, never a full memory dump. */
  materials(intention: Intention, target: CreationTarget): Promise<CreativeMaterials>;
  plan(input: { intention: Intention; action: CreationAction; materials: CreativeMaterials }): Promise<CreativePlan>;
}
export interface CreativeResult { status: 'ready' | 'failed' | 'recovery-required'; duplicate: boolean; work: Snapshot<CreationWork>; reasonCode: WorkflowFailure | null }
const actions = ['qqspace', 'bili.comment', 'bili.reply', 'bili.dynamic', 'bili.video'];
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new AgentError(code); }
function shape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_PLAN');
  requireValue(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'INVALID_PLAN');
  requireValue(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)) && keys.every(key => Object.hasOwn(value, key)), 'INVALID_PLAN');
  requireValue(Object.values(Object.getOwnPropertyDescriptors(value)).every(d => !d.get && !d.set), 'INVALID_PLAN');
}
function bounded(value: unknown, maximum: number, empty = false): asserts value is string {
  requireValue(typeof value === 'string' && value.length <= maximum && (empty || value.trim().length > 0) && !/[\u0000\uD800-\uDFFF]/u.test(value), 'INVALID_PLAN');
}
function checkedPlan(value: unknown, video: boolean): CreativePlan {
  shape(value, ['brief', 'script', 'title', 'description', 'tags', 'text']); bounded(value.brief, 8000);
  if (value.script !== null) bounded(value.script, 16000); requireValue(!video || value.script !== null, 'INVALID_PLAN');
  bounded(value.title, 256, !video); bounded(value.description, 8000, true); bounded(value.text, 16000, video);
  requireValue(Array.isArray(value.tags) && value.tags.length <= 32, 'INVALID_PLAN'); value.tags.forEach(tag => bounded(tag, 64));
  return structuredClone(value) as unknown as CreativePlan;
}
function checkedMaterials(value: unknown): CreativeMaterials {
  shape(value, ['revision', 'sources', 'items']); integer(value.revision);
  requireValue(Array.isArray(value.sources) && value.sources.length <= 64 && Array.isArray(value.items) && value.items.length <= 64, 'MATERIALS_CHANGED');
  const ids = new Set<string>();
  for (const source of value.sources) {
    shape(source, ['id', 'revision', 'personLinkRevision']); text(source.id, 128); integer(source.revision);
    if (source.personLinkRevision !== null) integer(source.personLinkRevision);
    requireValue(!ids.has(source.id), 'MATERIALS_CHANGED'); ids.add(source.id);
  }
  let size = 0; const itemIds = new Set<string>();
  for (const item of value.items) {
    shape(item, ['id', 'text']); text(item.id); bounded(item.text, 4000); size += item.text.length;
    requireValue(size <= 64000 && !itemIds.has(item.id), 'MATERIALS_CHANGED'); itemIds.add(item.id);
  }
  return structuredClone(value) as unknown as CreativeMaterials;
}
function checkedPolicy(value: unknown): CreativePolicy {
  shape(value, ['revision', 'allowedAccounts', 'allowedActions']); integer(value.revision);
  requireValue(Array.isArray(value.allowedAccounts) && value.allowedAccounts.length <= 64 && Array.isArray(value.allowedActions) && value.allowedActions.length <= 5, 'POLICY_CHANGED');
  value.allowedAccounts.forEach(account => text(account, 128)); value.allowedActions.forEach(action => requireValue(actions.includes(action as string), 'POLICY_CHANGED'));
  return structuredClone(value) as unknown as CreativePolicy;
}
/** Durable intention -> actual preparation -> final review only. Never approves, uploads or submits. */
export class CreativeWorkflow {
  private readonly deps: CreativeWorkflowDependencies;
  private readonly scope: SelfScope;
  constructor(deps: CreativeWorkflowDependencies) { this.deps = deps; this.scope = structuredClone(deps.scope); }
  private id(intentId: string): string { return 'creative-' + createHash('sha256').update(stable([this.scope, intentId])).digest('hex'); }
  private intention(id: string, expected: 'pending' | 'attempted', captured?: Intention): Intention {
    const now = this.deps.now(); integer(now);
    const state = this.deps.self.get(this.scope).value; const intent = state.intents.find(item => item.id === id);
    requireValue(intent && intent.status === expected && intent.expiresAt > now && intent.createdAt <= now, 'INTENTION_UNAVAILABLE');
    requireValue(intent.sources.length > 0 && intent.sources.every(source => Object.hasOwn(state.evidence, source.eventId)
      && state.evidence[source.eventId]!.revision === source.revision && !state.evidence[source.eventId]!.revoked), 'INTENTION_UNAVAILABLE');
    if (captured) requireValue(stable(intent) === stable({ ...captured, status: expected }), 'INTENTION_UNAVAILABLE');
    return structuredClone(intent);
  }
  async start(intentId: string, request: CreativeRequest, beforeCommit?: () => Promise<void>): Promise<CreativeResult> {
    text(intentId, 128); shape(request, ['action', 'accountId', 'target']); text(request.accountId, 128);
    requireValue(actions.includes(request.action), 'POLICY_CHANGED'); const requested = structuredClone(request);
    const workId = this.id(intentId); const existing = this.deps.creation.read(workId);
    if (existing) {
      requireValue(existing.value.action === requested.action && existing.value.accountId === requested.accountId && stable(existing.value.target) === stable(requested.target), 'CREATIVE_INTENT_ALREADY_BOUND');
      const phase = existing.value.workflow?.phase;
      return { work: existing, duplicate: true, status: phase === 'ready' ? 'ready' : phase === 'failed' ? 'failed' : 'recovery-required', reasonCode: existing.value.workflow?.reasonCode ?? null };
    }
    await beforeCommit?.();
    const intent = this.intention(intentId, 'pending'); const policy = checkedPolicy(this.deps.policy());
    const initialState = this.deps.self.get(this.scope).value;
    requireValue(policy.allowedAccounts.includes(requested.accountId) && policy.allowedActions.includes(requested.action), 'POLICY_CHANGED');
    let work = this.deps.creation.create({ id: workId, action: requested.action, intention: `${intent.topic}: ${intent.reason}`, accountId: requested.accountId, target: requested.target, sources: [] });
    let journal: CreationWorkflowState = { intentId, phase: 'planning', policyRevision: policy.revision, materialsRevision: null, reasonCode: null, publication: null,
      selfScope: structuredClone(this.scope), intentionSources: structuredClone(intent.sources), identityRevision: initialState.identityRevision,
      growthVersion: initialState.growthVersion, modelVersion: initialState.modelVersion, mode: initialState.mode };
    work = this.deps.creation.setWorkflow(workId, work.revision, journal);
    return this.execute(intent, policy, requested, work, false, beforeCommit);
  }
  /** Explicit human restart of local preparation, never an upload retry or an approval. Expired intentions require a new intention. */
  async recover(workId: string, expectedRevision: number, principal: string, reason: string, beforeCommit?: () => Promise<void>): Promise<CreativeResult> {
    const current = this.deps.creation.read(workId); requireValue(current, 'CREATION_NOT_FOUND');
    requireValue(current.revision === expectedRevision, 'CREATION_REVISION_CONFLICT');
    const journal = current.value.workflow; requireValue(journal && stable(journal.selfScope) === stable(this.scope)
      && this.id(journal.intentId) === workId, 'CREATION_RECOVERY_NOT_ALLOWED');
    const intent = this.intention(journal.intentId, 'attempted');
    requireValue(stable(intent.sources) === stable(journal.intentionSources), 'INTENTION_UNAVAILABLE');
    const state = this.deps.self.get(this.scope).value;
    requireValue(stable([state.identityRevision, state.growthVersion, state.modelVersion, state.mode]) ===
      stable([journal.identityRevision, journal.growthVersion, journal.modelVersion, journal.mode]), 'INTENTION_UNAVAILABLE');
    const policy = checkedPolicy(this.deps.policy());
    requireValue(policy.revision === journal.policyRevision && policy.allowedAccounts.includes(current.value.accountId)
      && policy.allowedActions.includes(current.value.action), 'POLICY_CHANGED');
    await beforeCommit?.();
    const claimed = this.deps.creation.recoverWorkflow(workId, expectedRevision, principal, reason);
    return this.execute(intent, policy, { action: claimed.value.action, accountId: claimed.value.accountId, target: claimed.value.target }, claimed, true, beforeCommit);
  }
  private async execute(intent: Intention, policy: CreativePolicy, requested: CreativeRequest, initial: Snapshot<CreationWork>, recovering: boolean, beforeCommit?: () => Promise<void>): Promise<CreativeResult> {
    const intentId = intent.id, workId = initial.value.id; let work = initial; let journal = work.value.workflow!;
    const capturedSelf = stable([journal.identityRevision, journal.growthVersion, journal.modelVersion, journal.mode]);
    const selfContext = () => { const state = this.deps.self.get(this.scope).value;
      return stable([state.identityRevision, state.growthVersion, state.modelVersion, state.mode]); };
    let failure: WorkflowFailure = 'INTENTION_UNAVAILABLE';
    let guardFailed = false;
    const guard = async () => { try { await beforeCommit?.(); } catch (error) { guardFailed = true; throw error; } };
    const assertDependencies = () => {
      requireValue(this.deps.creation.read(workId)?.revision === work.revision, 'CREATION_REVISION_CONFLICT');
      this.intention(intentId, 'attempted', intent);
      requireValue(selfContext() === capturedSelf, 'INTENTION_UNAVAILABLE');
      requireValue(stable(checkedPolicy(this.deps.policy())) === stable(policy), 'POLICY_CHANGED');
    };
    const journalWrite = (phase: CreationWorkflowState['phase'], reasonCode: WorkflowFailure | null = null) => {
      journal = { ...journal, phase, reasonCode }; work = this.deps.creation.setWorkflow(workId, work.revision, journal);
    };
    try {
      if (!recovering) this.deps.self.recordAttempt(this.scope, intentId, { responded: false });
      failure = 'MATERIALS_CHANGED';
      const materials = checkedMaterials(await this.deps.materials(structuredClone(intent), structuredClone(requested.target)));
      await guard();
      assertDependencies();
      // The planner reads intention.topic/reason too. Their complete evidence must be
      // present in the trusted public projection, with PersonLink stamps supplied there.
      requireValue(intent.sources.every(source => materials.sources.some(candidate =>
        candidate.id === source.eventId && candidate.revision === source.revision)), 'MATERIALS_CHANGED');
      if (recovering && journal.materialsRevision !== null) requireValue(materials.revision === journal.materialsRevision
        && stable(materials.sources.slice().sort((a, b) => a.id.localeCompare(b.id))) === stable(work.value.sources.slice().sort((a, b) => a.id.localeCompare(b.id))), 'MATERIALS_CHANGED');
      journal = { ...journal, materialsRevision: materials.revision }; journalWrite('planning');
      work = this.deps.creation.revise(workId, work.revision, { action: requested.action, intention: work.value.intention,
        accountId: requested.accountId, target: requested.target, sources: materials.sources });
      this.deps.creation.validatePreparation(work.value);
      failure = 'PLAN_FAILED';
      const rawPlan = await this.deps.plan({ intention: structuredClone(intent), action: requested.action, materials: structuredClone(materials) });
      await guard();
      assertDependencies(); failure = 'INVALID_PLAN'; const plan = checkedPlan(rawPlan, requested.action === 'bili.video');
      failure = 'MATERIALS_CHANGED'; const refreshed = checkedMaterials(await this.deps.materials(structuredClone(intent), structuredClone(requested.target)));
      await guard();
      assertDependencies(); requireValue(stable(refreshed) === stable(materials), 'MATERIALS_CHANGED');
      journal = { ...journal, publication: { title: plan.title, description: plan.description, tags: plan.tags, text: plan.text } }; journalWrite('planning');
      failure = 'CREATION_FAILED'; work = this.deps.creation.setBrief(workId, work.revision, plan.brief);
      if (plan.script !== null) work = this.deps.creation.setScript(workId, work.revision, plan.script);
      if (requested.action === 'bili.video') {
        this.deps.creation.validatePreparation(work.value);
        journalWrite('producing'); failure = 'PRODUCTION_FAILED'; work = await this.deps.creation.produce(workId, work.revision, guard);
        await guard();
        assertDependencies(); failure = 'MATERIALS_CHANGED';
        const afterProduction = checkedMaterials(await this.deps.materials(structuredClone(intent), structuredClone(requested.target)));
        await guard();
        assertDependencies(); requireValue(stable(afterProduction) === stable(materials), 'MATERIALS_CHANGED');
        const final = work.value.final?.manifest; requireValue(final && stable({ title: final.title, description: final.description, tags: final.tags, text: final.text }) === stable(journal.publication), 'INVALID_PLAN');
      } else {
        assertDependencies();
        const manifest: FinalManifest = { ...journal.publication!, accountId: requested.accountId, target: requested.target, video: null, cover: null, audio: [], subtitles: [], attachments: [] };
        work = this.deps.creation.prepareFinal(workId, work.revision, manifest);
      }
      journalWrite('ready'); return { status: 'ready', duplicate: false, work, reasonCode: null };
    } catch (error) {
      // Revocation/cancellation must not be turned into an authorized failure write.
      if (guardFailed) throw error;
      await guard();
      const controlled = error instanceof AgentError && ['INTENTION_UNAVAILABLE', 'POLICY_CHANGED', 'MATERIALS_CHANGED', 'INVALID_PLAN'].includes(error.code) ? error.code as WorkflowFailure : failure;
      const latest = this.deps.creation.read(workId);
      if (latest) {
        const unchanged = latest.revision === work.revision; work = latest;
        if (unchanged) try { journalWrite('failed', controlled); } catch { /* A concurrent human edit wins; never overwrite its CAS revision. */ }
      }
      return { status: 'failed', duplicate: false, work, reasonCode: controlled };
    }
  }
}
