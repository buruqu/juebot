import { createHash } from 'node:crypto';
import { AgentError, ensure, text, integer, clone, stable } from './common.ts';
import type { CreationAction, CreationTarget } from './creation.ts';
import type { Snapshot, StateStore, Transaction } from './store.ts';
import { canonicalIdentity, conversationKey } from '../../conversation-v1/src/identity.ts';
import { DEFAULT_TYPING_CONFIG, validateTypingConfig } from '../../social-v1/src/typing.ts';
import type { TypingConfig } from '../../social-v1/src/typing.ts';
import { checkExpression as checkPolicyExpression, validateExpressionPolicy } from '../../social-v1/src/expression-policy.ts';
import type { ExpressionPolicy, ExpressionDecision, ExpressionRule, StyleContract } from '../../social-v1/src/expression-policy.ts';

export type Permission = 'receive' | 'save' | 'learn' | 'reply' | 'proactive';
export type Purpose = 'read' | 'learn' | 'draft' | 'publish';
export type PlainExpressionRule = Omit<ExpressionRule, 'scope'>;
export interface PlainStyleContract { contractId: string; policyText: string; counterexamples: string[] }
export interface ContactPolicy { timeZoneOffsetMinutes: number; windows: { startMinute: number; endMinute: number }[]; cooldownMs: number; dailyLimit: number; unansweredLimit: number }
export interface Settings {
  permissions: Record<Permission, boolean>; prompt: string; typing: TypingConfig;
  expressionRules: PlainExpressionRule[]; styleContracts: PlainStyleContract[]; participation: number; contactPolicy?: ContactPolicy | null;
}
export interface PolicyPatch {
  mode?: 'isolated' | 'shared'; memoryMode?: 'inherit' | 'isolated';
  permissions?: Partial<Record<Permission, boolean>>; prompt?: string; typing?: Partial<TypingConfig>;
  expressionRules?: PlainExpressionRule[]; styleContracts?: PlainStyleContract[]; participation?: number; contactPolicy?: ContactPolicy | null;
}
export interface LocalSettings extends Omit<PolicyPatch, 'mode'> { memoryMode: 'inherit' | 'isolated' }
export interface SourceInput {
  id: string; conversationKey: string; revision: number; domain: 'social' | 'code'; status: 'active' | 'revoked';
  purposes: Purpose[]; audiences: string[]; expiresAt: number | null;
}
export interface SourceRef { sourceId: string; revision: number }
export interface MemoryRef { memoryId: string; revision: number }
export interface Sharing {
  approved: boolean; approvedBy: string | null; ruleRevision: number;
  targets: string[]; purposes: Purpose[]; expiresAt: number | null;
}
export interface MemoryInput {
  id: string; revision: number; conversationKey: string; kind: 'knowledge' | 'expression' | 'preference' | 'private';
  text: string; sourceRefs: SourceRef[]; derivedFrom: MemoryRef[]; sharing: Sharing;
}
export interface MemoryRecord extends MemoryInput { status: 'active' | 'revoked' }
export interface SummaryMaterialRequest { action: CreationAction; accountId: string; target: CreationTarget }
export interface SummaryMaterialApproval extends SummaryMaterialRequest {
  sourceId: string; revision: 1; topic: string; memoryId: string; memoryRevision: number; key: string;
  principal: string; reason: string; approvedAt: number; expiresAt: number;
}
export interface ApproveSummaryMaterialInput extends SummaryMaterialRequest {
  memoryId: string; expectedMemoryRevision: number; key: string; principal: string; reason: string; expiresAt: number; includePrivate?: boolean;
}
export interface SummaryMaterialRecord extends SummaryMaterialApproval { text: string; sourceRefs: SourceRef[]; includePrivate: boolean }
export interface PolicyState {
  mode: 'isolated' | 'shared'; global: Settings; locals: Record<string, LocalSettings>;
  sources: Record<string, SourceInput>; memories: Record<string, MemoryRecord>;
  /** Human approval of this exact summary, never an authorization to disclose raw source text. */
  summaryApprovals?: Record<string, { memoryRevision: number; sourceRefs: SourceRef[]; principal: string; reason: string; at: number }>;
  memoryReviews?: { id: string; fromRevision: number; toRevision: number; action: string; principal: string; reason: string; at: number }[];
  summaryMaterials?: Record<string, SummaryMaterialRecord>;
}
export interface EffectiveSettings extends Settings { contactPolicies: ContactPolicy[]; memoryMode: 'isolated' | 'shared'; expressionPolicy: ExpressionPolicy; revision: number }
export interface ContextRequest { conversationKey: string; purpose: Purpose; query: string; now: number; maxItems?: number; maxChars?: number }
export interface ContextTicket {
  schemaVersion: 1; botId: string; personaId: string; revision: number; conversationKey: string; purpose: Purpose;
  issuedAt: number; items: MemoryRecord[]; sourceEvidence: SourceRef[]; chars: number; bounded: true; method: 'keyword';
}
const permissions: Permission[] = ['receive', 'save', 'learn', 'reply', 'proactive'];
const purposes: Purpose[] = ['read', 'learn', 'draft', 'publish'];
const MAX_RECORDS = 1024;
function shape(value: unknown, keys: string[]): void {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  for (const name of Reflect.ownKeys(value)) {
    ensure(typeof name === 'string' && keys.includes(name));
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    ensure('value' in descriptor && descriptor.enumerable);
  }
}
function body(value: unknown, max: number): asserts value is string {
  ensure(typeof value === 'string' && value.length <= max && !value.includes('\0'));
}
function expiry(value: unknown): void { if (value !== null) integer(value); }
function live(until: number | null, now: number): boolean { return until === null || until > now; }
function array(value: unknown, max: number): asserts value is unknown[] { ensure(Array.isArray(value) && value.length <= max); }
function safeId(value: unknown): asserts value is string { text(value); ensure(value !== '__proto__' && value !== 'constructor' && value !== 'prototype'); }
function initial(): PolicyState {
  return { mode: 'isolated', global: { permissions: { receive: false, save: false, learn: false, reply: false, proactive: false },
    prompt: '', typing: { ...DEFAULT_TYPING_CONFIG }, expressionRules: [], styleContracts: [], participation: 0.5 }, locals: {}, sources: {}, memories: {} };
}

/** Trusted Host service: no model/HTTP/file/driver or account authority is exposed. */
export class PolicyMemory {
  private readonly store: StateStore;
  private readonly stateKey: string;
  private readonly botId: string;
  private readonly personaId: string;
  constructor(store: StateStore, options: { botId: string; personaId: string }) {
    shape(options, ['botId', 'personaId']); text(options.botId); text(options.personaId);
    this.store = store; this.botId = options.botId; this.personaId = options.personaId;
    this.stateKey = JSON.stringify(['policy-memory-v1', options.botId, options.personaId]);
  }
  private key(value: unknown): asserts value is string {
    text(value, 4096);
    try {
      const tuple: unknown = JSON.parse(value);
      ensure(Array.isArray(tuple) && tuple.length === 8 && tuple[0] === 'juebot-conversation-v1');
      const identity = canonicalIdentity({ botId: tuple[1], personaId: tuple[2], connector: tuple[3], issuer: tuple[4], accountId: tuple[5], kind: tuple[6], remoteId: tuple[7] });
      ensure(identity.botId === this.botId && identity.personaId === this.personaId && conversationKey(identity) === value, 'MEMORY_SCOPE_MISMATCH');
    } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError('INVALID_CONVERSATION_KEY'); }
  }
  private read(tx?: Transaction): Snapshot<PolicyState> {
    return clone((tx ?? this.store).read<PolicyState>(this.stateKey) ?? { revision: 0, value: initial() });
  }
  readPolicy(): Snapshot<PolicyState> { return this.read(); }
  private change(expectedRevision: number, fn: (state: PolicyState) => void): Snapshot<PolicyState> {
    return this.store.atomic(tx => this.changeIn(tx, expectedRevision, fn));
  }
  private changeIn(tx: Transaction, expectedRevision: number, fn: (state: PolicyState) => void): Snapshot<PolicyState> {
    integer(expectedRevision);
    const current = this.read(tx); ensure(current.revision === expectedRevision, 'REVISION_CONFLICT');
    fn(current.value);
    return tx.write(this.stateKey, expectedRevision, current.value);
  }
  private expression(rules: PlainExpressionRule[], prefix: string): ExpressionRule[] {
    return rules.map(rule => ({ ...rule, ruleId: `${prefix}:${rule.ruleId}`, scope: { kind: 'global' } }));
  }
  private styles(contracts: PlainStyleContract[], prefix: string): StyleContract[] {
    // The canonical stream was resolved before this projection; no raw key enters the
    // expression library's narrower physical scope field. Rules use the same projection.
    return contracts.map(contract => ({ ...contract, contractId: `${prefix}:style:${contract.contractId}`, scope: { kind: 'global' } }));
  }
  private effectiveFrom(state: PolicyState, revision: number, key: string): EffectiveSettings {
    const local = state.locals[key];
    const global = state.global;
    const effectivePermissions = { ...global.permissions };
    for (const permission of permissions) effectivePermissions[permission] = global.permissions[permission] && local?.permissions?.[permission] !== false;
    const styleContracts = [...(global.styleContracts ?? []), ...(local?.styleContracts ?? [])];
    const expressionPolicy: ExpressionPolicy = { revision, rules: [...this.expression(global.expressionRules, 'g'), ...this.expression(local?.expressionRules ?? [], 'l')],
      styleContracts: [...this.styles(global.styleContracts ?? [], 'g'), ...this.styles(local?.styleContracts ?? [], 'l')], maxRewrites: 2 };
    return { permissions: effectivePermissions, prompt: [global.prompt, local?.prompt ?? ''].filter(Boolean).join('\n'),
      typing: { ...global.typing, ...local?.typing }, expressionRules: [...global.expressionRules, ...(local?.expressionRules ?? [])], styleContracts,
      participation: local?.participation ?? global.participation, contactPolicies: [global.contactPolicy, local?.contactPolicy].filter((v): v is ContactPolicy => v != null),
      memoryMode: state.mode === 'isolated' || local?.memoryMode === 'isolated' ? 'isolated' : 'shared', expressionPolicy, revision };
  }
  effective(key: string): EffectiveSettings {
    this.key(key); const current = this.read(); return clone(this.effectiveFrom(current.value, current.revision, key));
  }
  /** Reviewed stream limits can narrow, never extend, the current Host capability. */
  restrictParticipation<T extends ContactPolicy>(key: string, host: T): T {
    const restrictions = this.effective(key).contactPolicies; if (!restrictions.length) return clone(host);
    const permits = (minute: number, windows: ContactPolicy['windows']) => windows.some(w => w.startMinute < w.endMinute ? minute >= w.startMinute && minute < w.endMinute : minute >= w.startMinute || minute < w.endMinute);
    const windows: ContactPolicy['windows'] = []; let start: number | null = null;
    for (let minute = 0; minute <= 1440; minute++) {
      const allowed = minute < 1440 && permits(minute, host.windows) && restrictions.every(rule => permits(((minute + rule.timeZoneOffsetMinutes - host.timeZoneOffsetMinutes) % 1440 + 1440) % 1440, rule.windows));
      if (allowed && start === null) start = minute;
      if (!allowed && start !== null) { windows.push({ startMinute: start, endMinute: minute }); start = null; }
    }
    ensure(windows.length <= 16, 'CONTACT_WINDOWS_TOO_COMPLEX');
    return { ...clone(host), windows, cooldownMs: Math.max(host.cooldownMs, ...restrictions.map(r => r.cooldownMs)),
      dailyLimit: Math.min(host.dailyLimit, ...restrictions.map(r => r.dailyLimit)), unansweredLimit: Math.min(host.unansweredLimit, ...restrictions.map(r => r.unansweredLimit)) };
  }
  configure(expectedRevision: number, patch: PolicyPatch, key?: string): Snapshot<PolicyState> {
    shape(patch, ['mode', 'memoryMode', 'permissions', 'prompt', 'typing', 'expressionRules', 'styleContracts', 'participation', 'contactPolicy']);
    ensure(Object.keys(patch).length > 0);
    if (key !== undefined) this.key(key);
    ensure(key === undefined ? patch.memoryMode === undefined : patch.mode === undefined);
    if (patch.mode !== undefined) ensure(patch.mode === 'isolated' || patch.mode === 'shared');
    if (patch.memoryMode !== undefined) ensure(patch.memoryMode === 'inherit' || patch.memoryMode === 'isolated');
    if (patch.permissions !== undefined) { shape(patch.permissions, permissions); for (const value of Object.values(patch.permissions)) ensure(typeof value === 'boolean'); }
    if (patch.prompt !== undefined) body(patch.prompt, 4000);
    if (patch.participation !== undefined) ensure(Number.isFinite(patch.participation) && patch.participation >= 0 && patch.participation <= 1);
    if (patch.contactPolicy != null) {
      const value = patch.contactPolicy; shape(value, ['timeZoneOffsetMinutes', 'windows', 'cooldownMs', 'dailyLimit', 'unansweredLimit']);
      integer(value.timeZoneOffsetMinutes, -840, 840); integer(value.cooldownMs, 0, 86400000); integer(value.dailyLimit, 0, 10000); integer(value.unansweredLimit, 0, 100);
      array(value.windows, 16); for (const window of value.windows) { shape(window, ['startMinute', 'endMinute']); integer(window.startMinute, 0, 1439); integer(window.endMinute, 0, 1440); ensure(window.startMinute !== window.endMinute); }
    }
    if (patch.typing !== undefined) shape(patch.typing, Object.keys(DEFAULT_TYPING_CONFIG));
    if (patch.expressionRules !== undefined) {
      array(patch.expressionRules, 64);
      for (const rule of patch.expressionRules) {
        shape(rule, ['ruleId', 'match', 'phrase', 'action']); text(rule.ruleId, 80);
      }
      try { validateExpressionPolicy({ revision: 0, rules: this.expression(patch.expressionRules, 'v'), styleContracts: [], maxRewrites: 2 }); }
      catch { throw new AgentError('INVALID_EXPRESSION_POLICY'); }
    }
    if (patch.styleContracts !== undefined) {
      array(patch.styleContracts, 32);
      for (const contract of patch.styleContracts) {
        shape(contract, ['contractId', 'policyText', 'counterexamples']); text(contract.contractId, 80);
        body(contract.policyText, 4000); array(contract.counterexamples, 8);
        for (const example of contract.counterexamples) body(example, 512);
      }
      try { validateExpressionPolicy({ revision: 0, rules: [], styleContracts: this.styles(patch.styleContracts, 'v'), maxRewrites: 2 }); }
      catch { throw new AgentError('INVALID_EXPRESSION_POLICY'); }
    }
    return this.change(expectedRevision, state => {
      if (key === undefined) {
        if (patch.mode !== undefined) state.mode = patch.mode;
        const { mode: ignored, ...settings } = patch; void ignored;
        state.global = { ...state.global, ...settings, permissions: { ...state.global.permissions, ...patch.permissions }, typing: { ...state.global.typing, ...patch.typing } };
      } else {
        ensure(Object.hasOwn(state.locals, key) || Object.keys(state.locals).length < 128, 'CAPACITY_EXCEEDED');
        for (const permission of permissions) if (patch.permissions?.[permission] === true) ensure(state.global.permissions[permission], 'HARD_PERMISSION_DENIED');
        state.locals[key] = { ...state.locals[key], memoryMode: state.locals[key]?.memoryMode ?? 'inherit', ...patch,
          permissions: { ...state.locals[key]?.permissions, ...patch.permissions }, typing: { ...state.locals[key]?.typing, ...patch.typing } };
      }
      try { validateTypingConfig(key === undefined ? state.global.typing : this.effectiveFrom(state, 0, key).typing); }
      catch { throw new AgentError('INVALID_TYPING_CONFIG'); }
      try {
        // A global edit must also preserve the combined limit for every existing local.
        validateExpressionPolicy({ revision: 0, rules: this.expression(state.global.expressionRules, 'g'),
          styleContracts: this.styles(state.global.styleContracts ?? [], 'g'), maxRewrites: 2 });
        for (const localKey of key === undefined ? Object.keys(state.locals) : [key])
          validateExpressionPolicy(this.effectiveFrom(state, 0, localKey).expressionPolicy);
      } catch { throw new AgentError('INVALID_EXPRESSION_POLICY'); }
    });
  }
  checkExpression(key: string, value: string, kind: 'social' | 'repetition' = 'social', rewriteCount = 0): ExpressionDecision {
    this.key(key); body(value, 32000); integer(rewriteCount);
    const config = this.effective(key);
    return checkPolicyExpression(config.expressionPolicy, { kind, text: value, conversationKey: 'resolved-scope', personaId: this.personaId, policyRevision: config.revision, rewriteCount });
  }
  private purposeList(value: unknown): asserts value is Purpose[] {
    array(value, 4); ensure(value.length > 0 && new Set(value).size === value.length && value.every(item => purposes.includes(item as Purpose)));
  }
  private targets(value: unknown): asserts value is string[] {
    array(value, 128); for (const item of value) this.key(item); ensure(new Set(value).size === value.length);
  }
  private materialRequest(request: SummaryMaterialRequest): void {
    shape(request, ['action', 'accountId', 'target']);
    ensure(['qqspace', 'bili.comment', 'bili.reply', 'bili.dynamic', 'bili.video'].includes(request.action));
    ensure(typeof request.accountId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(request.accountId));
    shape(request.target, ['objectId', 'parentId', 'visibility', 'category']);
    for (const key of ['objectId', 'parentId', 'category'] as const) if (request.target[key] !== null) { text(request.target[key]); ensure(request.target[key]!.trim()); }
    text(request.target.visibility); ensure(request.target.visibility.trim());
    if (request.action === 'bili.comment' || request.action === 'bili.reply') ensure(request.target.objectId !== null);
    if (request.action === 'bili.reply') ensure(request.target.parentId !== null);
    if (request.action === 'bili.video') ensure(request.target.category !== null);
  }
  private summaryOrigin(state: PolicyState, material: Pick<SummaryMaterialRecord, 'memoryId' | 'memoryRevision' | 'sourceRefs' | 'text' | 'includePrivate'>, now: number): boolean {
    const memory = state.memories[material.memoryId];
    if (!memory || memory.status !== 'active' || memory.revision !== material.memoryRevision || memory.text !== material.text
      || stable(memory.sourceRefs) !== stable(material.sourceRefs) || (memory.kind === 'private' && !material.includePrivate)
      || !this.readable(state, memory, memory.conversationKey, 'read', now)) return false;
    return memory.sourceRefs.every(ref => {
      const source = state.sources[ref.sourceId];
      return source?.domain === 'social' && source.status === 'active' && source.revision === ref.revision
        && source.conversationKey === memory.conversationKey
        && source.purposes.includes('read') && source.purposes.includes('learn')
        && source.audiences.includes(memory.conversationKey) && live(source.expiresAt, now);
    });
  }
  /** Trusted reviewed summary grant. This never broadens any original source or authorizes a send. */
  approveSummaryMaterial(expectedPolicyRevision: number, input: ApproveSummaryMaterialInput, now: number): SummaryMaterialApproval {
    shape(input, ['memoryId', 'expectedMemoryRevision', 'key', 'action', 'accountId', 'target', 'principal', 'reason', 'expiresAt', 'includePrivate']);
    shape(input.target, ['objectId', 'parentId', 'visibility', 'category']);
    input = clone(input); integer(now); integer(input.expectedMemoryRevision, 1); safeId(input.memoryId); this.key(input.key);
    text(input.principal); text(input.reason, 1000); ensure(input.principal.trim() && input.reason.trim());
    this.materialRequest({ action: input.action, accountId: input.accountId, target: input.target });
    integer(input.expiresAt, now + 1); ensure(input.expiresAt - now <= 30 * 86400000, 'SUMMARY_MATERIAL_EXPIRY');
    ensure(input.includePrivate === undefined || typeof input.includePrivate === 'boolean');
    let approved!: SummaryMaterialApproval;
    this.change(expectedPolicyRevision, state => {
      const memory = state.memories[input.memoryId];
      ensure(memory?.status === 'active' && memory.revision === input.expectedMemoryRevision, 'MEMORY_CONFLICT');
      ensure(memory.kind !== 'private' || input.includePrivate === true, 'PRIVATE_SHARING_REQUIRES_CONFIRMATION');
      const target = this.effectiveFrom(state, 0, input.key).permissions;
      ensure(target.receive && target.save && target.reply, 'SUMMARY_MATERIAL_SCOPE_MISMATCH');
      const origin = { memoryId: memory.id, memoryRevision: memory.revision, sourceRefs: clone(memory.sourceRefs), text: memory.text, includePrivate: input.includePrivate === true };
      ensure(this.summaryOrigin(state, origin, now), 'SOURCE_NOT_ALLOWED');
      state.summaryMaterials ??= {};
      ensure(Object.keys(state.summaryMaterials).length < 512 && Object.keys(state.sources).length < MAX_RECORDS, 'CAPACITY_EXCEEDED');
      const sourceId = 'summary-material-' + createHash('sha256').update(stable([this.stateKey, expectedPolicyRevision, Object.keys(state.summaryMaterials).length, input, now])).digest('hex');
      ensure(!Object.hasOwn(state.sources, sourceId) && !Object.hasOwn(state.summaryMaterials, sourceId), 'SOURCE_CONFLICT');
      const expiresAt = Math.min(input.expiresAt, ...memory.sourceRefs.map(ref => state.sources[ref.sourceId]!.expiresAt ?? Number.MAX_SAFE_INTEGER));
      approved = { sourceId, revision: 1, topic: '创作摘要 ' + memory.id.slice(0, 60) + ' ' + sourceId.slice(-16), memoryId: memory.id, memoryRevision: memory.revision,
        key: input.key, action: input.action, accountId: input.accountId, target: clone(input.target), principal: input.principal,
        reason: input.reason, approvedAt: now, expiresAt };
      state.summaryMaterials[sourceId] = { ...clone(approved), ...origin };
      state.sources[sourceId] = { id: sourceId, conversationKey: input.key, revision: 1, domain: 'social', status: 'active',
        purposes: ['draft', 'publish'], audiences: [input.key], expiresAt };
    });
    return clone(approved);
  }
  isSummaryMaterial(sourceId: string): boolean { safeId(sourceId); return Object.hasOwn(this.read().value.summaryMaterials ?? {}, sourceId); }
  /** Runtime observation may recognize an approved summary without granting it learning authority. */
  validateSummarySource(sourceId: string, key: string, revision: number, now: number): boolean {
    safeId(sourceId); this.key(key); integer(revision, 1); integer(now);
    return this.summarySourceCurrent(this.read().value, sourceId, key, revision, now);
  }
  private summarySourceCurrent(state: PolicyState, sourceId: string, key: string, revision: number, now: number): boolean {
    const material = state.summaryMaterials?.[sourceId], source = state.sources[sourceId];
    if (!material || material.key !== key || revision !== 1 || material.revision !== 1 || material.approvedAt > now) return false;
    const permissions = this.effectiveFrom(state, 0, key).permissions;
    return source?.status === 'active' && source.revision === 1 && source.domain === 'social' && source.conversationKey === key
      && stable(source.purposes) === stable(['draft', 'publish']) && stable(source.audiences) === stable([key])
      && source.expiresAt === material.expiresAt && live(material.expiresAt, now)
      && permissions.receive && permissions.save && permissions.reply && this.summaryOrigin(state, material, now);
  }
  resolveSummaryMaterial(sourceId: string, key: string, request: SummaryMaterialRequest, now: number): { id: string; revision: number; text: string } | null {
    safeId(sourceId); this.key(key); this.materialRequest(request); integer(now);
    const state = this.read().value; const material = state.summaryMaterials?.[sourceId]; if (!material) return null;
    ensure(material.key === key && material.action === request.action && material.accountId === request.accountId
      && stable(material.target) === stable(request.target), 'SUMMARY_MATERIAL_SCOPE_MISMATCH');
    ensure(this.summarySourceCurrent(state, sourceId, key, 1, now), 'SUMMARY_MATERIAL_STALE');
    return { id: sourceId, revision: 1, text: material.text };
  }
  putSource(expectedRevision: number, input: SourceInput): Snapshot<PolicyState> {
    shape(input, ['id', 'conversationKey', 'revision', 'domain', 'status', 'purposes', 'audiences', 'expiresAt']);
    safeId(input.id); this.key(input.conversationKey); integer(input.revision, 1); expiry(input.expiresAt);
    ensure(input.domain === 'social' || input.domain === 'code'); ensure(input.status === 'active' || input.status === 'revoked');
    this.purposeList(input.purposes); this.targets(input.audiences);
    const source = clone(input);
    return this.change(expectedRevision, state => {
      ensure(!Object.hasOwn(state.summaryMaterials ?? {}, source.id), 'SUMMARY_SOURCE_RESERVED');
      const prior = state.sources[source.id];
      ensure(!prior || (prior.conversationKey === source.conversationKey && prior.domain === source.domain && source.revision > prior.revision), 'SOURCE_CONFLICT');
      ensure(!prior || prior.status !== 'revoked' || source.status === 'revoked', 'SOURCE_REVOKED');
      ensure(prior || Object.keys(state.sources).length < MAX_RECORDS, 'CAPACITY_EXCEEDED');
      state.sources[source.id] = source;
      this.cascade(state);
    });
  }
  revokeSource(expectedRevision: number, sourceId: string, nextSourceRevision: number): Snapshot<PolicyState> {
    safeId(sourceId); integer(nextSourceRevision, 1);
    return this.change(expectedRevision, state => {
      const source = state.sources[sourceId]; ensure(source, 'SOURCE_NOT_FOUND');
      ensure(nextSourceRevision > source.revision, 'SOURCE_CONFLICT');
      state.sources[sourceId] = { ...source, revision: nextSourceRevision, status: 'revoked' };
      this.cascade(state);
    });
  }
  private cascade(state: PolicyState): void {
    for (let pass = 0; pass <= MAX_RECORDS; pass++) {
      let changed = false;
      for (const material of Object.values(state.summaryMaterials ?? {})) {
        const alias = state.sources[material.sourceId], memory = state.memories[material.memoryId];
        if (alias?.status === 'active' && (!memory || memory.status !== 'active' || memory.revision !== material.memoryRevision
          || memory.text !== material.text || stable(memory.sourceRefs) !== stable(material.sourceRefs)
          || material.sourceRefs.some(ref => state.sources[ref.sourceId]?.status !== 'active' || state.sources[ref.sourceId]?.revision !== ref.revision))) {
          alias.status = 'revoked'; changed = true;
        }
      }
      for (const memory of Object.values(state.memories)) {
        if (memory.status === 'revoked') continue;
        if (memory.sourceRefs.some(ref => !state.sources[ref.sourceId] || state.sources[ref.sourceId]!.status !== 'active' || state.sources[ref.sourceId]!.revision !== ref.revision)
          || memory.derivedFrom.some(ref => !state.memories[ref.memoryId] || state.memories[ref.memoryId]!.status !== 'active' || state.memories[ref.memoryId]!.revision !== ref.revision)) {
          memory.status = 'revoked'; changed = true;
        }
      }
      if (!changed) return;
    }
    throw new AgentError('DERIVATION_LIMIT');
  }
  addMemory(expectedRevision: number, input: MemoryInput): Snapshot<PolicyState> {
    return this.store.atomic(tx => this.addMemoryIn(tx, expectedRevision, input));
  }
  reviewMemory(expectedRevision: number, input: { id: string; expectedMemoryRevision: number; principal: string; reason: string;
    action: 'share' | 'unshare' | 'correct' | 'revoke'; targets?: string[]; purposes?: Purpose[]; expiresAt?: number | null; text?: string; includePrivate?: boolean }, now: number): Snapshot<PolicyState> {
    shape(input, ['id', 'expectedMemoryRevision', 'principal', 'reason', 'action', 'targets', 'purposes', 'expiresAt', 'text', 'includePrivate']);
    const request = clone(input); safeId(request.id); integer(request.expectedMemoryRevision, 1); text(request.principal); text(request.reason, 1000); integer(now);
    ensure(['share', 'unshare', 'correct', 'revoke'].includes(request.action));
    if (request.action === 'share') {
      this.targets(request.targets!); this.purposeList(request.purposes!); expiry(request.expiresAt);
      ensure(request.targets!.length > 0 && request.purposes!.length > 0 && (request.expiresAt === null || request.expiresAt! > now));
      ensure(request.text === undefined && (request.includePrivate === undefined || typeof request.includePrivate === 'boolean'));
    } else {
      ensure(request.targets === undefined && request.purposes === undefined && request.expiresAt === undefined && request.includePrivate === undefined);
      if (request.action === 'correct') { body(request.text, 16000); ensure(request.text!.trim().length > 0); }
      else ensure(request.text === undefined);
    }
    return this.change(expectedRevision, state => {
      const memory = state.memories[request.id]; ensure(memory && memory.status === 'active' && memory.revision === request.expectedMemoryRevision, 'MEMORY_CONFLICT');
      ensure(memory.revision < Number.MAX_SAFE_INTEGER, 'CAPACITY_EXCEEDED');
      state.memoryReviews ??= [];
      ensure(state.memoryReviews.length < 4096, 'CAPACITY_EXCEEDED');
      for (const ref of request.action === 'share' || request.action === 'correct' ? memory.sourceRefs : []) {
        const source = state.sources[ref.sourceId];
        ensure(source && source.domain === 'social' && source.status === 'active' && source.revision === ref.revision
          && live(source.expiresAt, now) && source.purposes.includes('learn') && source.audiences.includes(memory.conversationKey), 'SOURCE_NOT_ALLOWED');
      }
      state.memoryReviews.push({ id: memory.id, fromRevision: memory.revision, toRevision: memory.revision + 1,
        action: request.action, principal: request.principal, reason: request.reason, at: now });
      memory.revision++;
      state.summaryApprovals ??= {};
      delete state.summaryApprovals[memory.id];
      if (request.action === 'share') {
        ensure(memory.kind !== 'private' || request.includePrivate === true, 'PRIVATE_SHARING_REQUIRES_CONFIRMATION');
        ensure(!request.targets!.includes(memory.conversationKey), 'INVALID_INPUT');
        memory.sharing = { approved: true, approvedBy: request.principal, ruleRevision: expectedRevision + 1,
          targets: [...request.targets!], purposes: [...request.purposes!], expiresAt: request.expiresAt! };
        state.summaryApprovals[memory.id] = { memoryRevision: memory.revision, sourceRefs: clone(memory.sourceRefs), principal: request.principal, reason: request.reason, at: now };
      } else {
        memory.sharing = { approved: false, approvedBy: null, ruleRevision: expectedRevision + 1, targets: [], purposes: ['read', 'learn', 'draft'], expiresAt: null };
        if (request.action === 'correct') memory.text = request.text!;
        if (request.action === 'revoke') memory.status = 'revoked';
      }
      this.cascade(state);
    });
  }
  /** Trusted Host only: join a caller-owned transaction without weakening candidate validation. */
  addMemoryIn(tx: Transaction, expectedRevision: number, input: MemoryInput): Snapshot<PolicyState> {
    shape(input, ['id', 'revision', 'conversationKey', 'kind', 'text', 'sourceRefs', 'derivedFrom', 'sharing']);
    safeId(input.id); integer(input.revision, 1); this.key(input.conversationKey); body(input.text, 16000); ensure(input.text.trim().length > 0);
    ensure(['knowledge', 'expression', 'preference', 'private'].includes(input.kind));
    array(input.sourceRefs, 32); array(input.derivedFrom, 16); ensure(input.sourceRefs.length > 0);
    for (const ref of input.sourceRefs) { shape(ref, ['sourceId', 'revision']); safeId(ref.sourceId); integer(ref.revision, 1); }
    for (const ref of input.derivedFrom) { shape(ref, ['memoryId', 'revision']); safeId(ref.memoryId); integer(ref.revision, 1); ensure(ref.memoryId !== input.id, 'DERIVATION_CYCLE'); }
    ensure(new Set(input.sourceRefs.map(ref => ref.sourceId)).size === input.sourceRefs.length);
    ensure(new Set(input.derivedFrom.map(ref => ref.memoryId)).size === input.derivedFrom.length);
    shape(input.sharing, ['approved', 'approvedBy', 'ruleRevision', 'targets', 'purposes', 'expiresAt']);
    ensure(typeof input.sharing.approved === 'boolean'); integer(input.sharing.ruleRevision); expiry(input.sharing.expiresAt);
    this.targets(input.sharing.targets); this.purposeList(input.sharing.purposes);
    if (input.sharing.approved) text(input.sharing.approvedBy); else ensure(input.sharing.approvedBy === null && input.sharing.targets.length === 0);
    const memory = clone(input);
    return this.changeIn(tx, expectedRevision, state => {
      const permissions = this.effectiveFrom(state, 0, memory.conversationKey).permissions;
      ensure(permissions.receive && permissions.save && permissions.learn, 'MEMORY_WRITE_DENIED');
      const prior = state.memories[memory.id];
      ensure(!prior || (prior.conversationKey === memory.conversationKey && prior.status !== 'revoked' && memory.revision > prior.revision), 'MEMORY_CONFLICT');
      ensure(prior || Object.keys(state.memories).length < MAX_RECORDS, 'CAPACITY_EXCEEDED');
      for (const ref of memory.sourceRefs) {
        const source = state.sources[ref.sourceId];
        ensure(source && source.status === 'active' && source.revision === ref.revision && source.domain === 'social', 'SOURCE_NOT_ALLOWED');
        // Keep facts on their source card. Cross-stream use happens through
        // approved retrieval, never by silently copying a foreign fact locally.
        ensure(source.conversationKey === memory.conversationKey, 'SOURCE_SCOPE_MISMATCH');
        ensure(source.purposes.includes('learn') && source.audiences.includes(memory.conversationKey), 'SOURCE_NOT_ALLOWED');
      }
      for (const ref of memory.derivedFrom) {
        const parent = state.memories[ref.memoryId]; ensure(parent && parent.status === 'active' && parent.revision === ref.revision, 'DERIVATION_INVALID');
        // No provenance laundering: every ancestor source must remain explicitly inherited.
        ensure(parent.sourceRefs.every(source => memory.sourceRefs.some(candidate => candidate.sourceId === source.sourceId && candidate.revision === source.revision)), 'SOURCE_INHERITANCE_REQUIRED');
        let visits = 0;
        const inspect = (id: string, path: Set<string>): void => {
          ensure(!path.has(id), 'DERIVATION_CYCLE'); ensure(++visits <= 128, 'DERIVATION_LIMIT');
          const next = new Set(path).add(id);
          for (const ancestor of state.memories[id]!.derivedFrom) inspect(ancestor.memoryId, next);
        };
        inspect(parent.id, new Set([memory.id]));
      }
      state.memories[memory.id] = { ...memory, status: 'active' }; this.cascade(state);
    });
  }
  private readable(state: PolicyState, memory: MemoryRecord, key: string, purpose: Purpose, now: number, visited = new Set<string>()): boolean {
    if (visited.has(memory.id) || visited.size >= 128 || memory.status !== 'active') return false;
    const next = new Set(visited).add(memory.id);
    const target = this.effectiveFrom(state, 0, key);
    const origin = this.effectiveFrom(state, 0, memory.conversationKey);
    const summaryApproval = state.summaryApprovals?.[memory.id];
    const summaryShared = memory.conversationKey !== key && summaryApproval?.memoryRevision === memory.revision
      && summaryApproval.principal === memory.sharing.approvedBy && stable(summaryApproval.sourceRefs) === stable(memory.sourceRefs);
    if (!target.permissions.receive || !target.permissions.save || !origin.permissions.receive || !origin.permissions.save) return false;
    if (purpose === 'learn' && !target.permissions.learn) return false;
    if ((purpose === 'draft' || purpose === 'publish') && !target.permissions.reply) return false;
    if (memory.conversationKey !== key) {
      if (target.memoryMode !== 'shared' || origin.memoryMode !== 'shared' || !memory.sharing.approved
        || !memory.sharing.targets.includes(key) || !memory.sharing.purposes.includes(purpose) || !live(memory.sharing.expiresAt, now)) return false;
    }
    for (const ref of memory.sourceRefs) {
      const source = state.sources[ref.sourceId];
      if (!source || source.domain !== 'social' || source.status !== 'active' || source.revision !== ref.revision
        || !live(source.expiresAt, now)) return false;
      if (summaryShared) {
        if (!source.purposes.includes('learn') || !source.audiences.includes(memory.conversationKey)) return false;
      } else if (!source.purposes.includes(purpose) || !source.audiences.includes(key)) return false;
    }
    return memory.derivedFrom.every(ref => {
      const parent = state.memories[ref.memoryId];
      return parent !== undefined && parent.revision === ref.revision && this.readable(state, parent, key, purpose, now, next);
    });
  }
  retrieve(request: ContextRequest): ContextTicket {
    shape(request, ['conversationKey', 'purpose', 'query', 'now', 'maxItems', 'maxChars']); this.key(request.conversationKey);
    ensure(purposes.includes(request.purpose)); body(request.query, 2048); integer(request.now);
    const maxItems = request.maxItems ?? 8; const maxChars = request.maxChars ?? 8000;
    integer(maxItems, 1, 32); integer(maxChars, 1, 16000);
    const snapshot = this.read();
    const terms = [...new Set(request.query.normalize('NFKC').toLocaleLowerCase('en').split(/\s+/u).filter(Boolean))].slice(0, 32);
    const candidates = Object.values(snapshot.value.memories).filter(memory => this.readable(snapshot.value, memory, request.conversationKey, request.purpose, request.now))
      .map(memory => ({ memory, score: terms.reduce((score, term) => score + (memory.text.normalize('NFKC').toLocaleLowerCase('en').includes(term) ? 1 : 0), 0) }))
      .filter(item => terms.length === 0 || item.score > 0).sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id, 'en'));
    const items: MemoryRecord[] = []; let chars = 0;
    for (const item of candidates) {
      if (items.length >= maxItems) break;
      if (chars + item.memory.text.length > maxChars) continue;
      items.push(clone(item.memory)); chars += item.memory.text.length;
    }
    const sourceEvidence = [...new Map(items.flatMap(item => item.sourceRefs).map(ref => [ref.sourceId, ref])).values()].map(clone);
    const ticket: ContextTicket = { schemaVersion: 1, botId: this.botId, personaId: this.personaId, revision: snapshot.revision,
      conversationKey: request.conversationKey, purpose: request.purpose, issuedAt: request.now, items, sourceEvidence, chars, bounded: true, method: 'keyword' };
    this.validateTicket(ticket, request.now); // Recheck after building, not merely before ranking.
    return ticket;
  }
  validateTicket(ticket: ContextTicket, now: number): boolean {
    integer(now); ensure(ticket && ticket.schemaVersion === 1 && ticket.botId === this.botId && ticket.personaId === this.personaId, 'CONTEXT_INVALID');
    this.key(ticket.conversationKey); ensure(purposes.includes(ticket.purpose), 'CONTEXT_INVALID');
    const snapshot = this.read(); ensure(snapshot.revision === ticket.revision, 'CONTEXT_STALE');
    ensure(Array.isArray(ticket.items) && ticket.items.length <= 32, 'CONTEXT_INVALID');
    for (const item of ticket.items) {
      const memory = snapshot.value.memories[item.id];
      ensure(memory && JSON.stringify(memory) === JSON.stringify(item)
        && this.readable(snapshot.value, memory, ticket.conversationKey, ticket.purpose, now), 'CONTEXT_STALE');
    }
    const evidence = [...new Map(ticket.items.flatMap(item => item.sourceRefs).map(ref => [ref.sourceId, ref])).values()];
    ensure(JSON.stringify(evidence) === JSON.stringify(ticket.sourceEvidence), 'CONTEXT_INVALID');
    ensure(ticket.chars === ticket.items.reduce((sum, item) => sum + item.text.length, 0), 'CONTEXT_INVALID');
    return true;
  }
  card(key: string, now: number): { conversationKey: string; personaId: string; revision: number; mode: 'isolated' | 'shared'; items: MemoryRecord[] } {
    this.key(key); integer(now); const current = this.read();
    return { conversationKey: key, personaId: this.personaId, revision: current.revision,
      mode: this.effectiveFrom(current.value, current.revision, key).memoryMode,
      items: Object.values(current.value.memories).filter(memory => memory.conversationKey === key && this.readable(current.value, memory, key, 'read', now)).map(clone) };
  }
}
