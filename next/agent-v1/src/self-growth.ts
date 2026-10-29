import { AgentError, stable } from './common.ts';
import type { Snapshot, StateStore, Transaction } from './store.ts';

/** Trusted Host supplies scope and event provenance. This module never sends or authorizes tools. */
export interface SelfScope { botId: string; personaId: string; scope: string }
export interface SourceRef { eventId: string; revision: number }
export type Action = 'group-participation' | 'idle-topic' | 'direct-contact';
export type Choice = 'reply' | 'silence' | 'decline' | 'defer' | 'leave-topic';
export interface Adaptation { warmth: number; curiosity: number; initiative: number }
export interface SelfState extends SelfScope {
  mode: 'juejue' | 'persona'; name: string; aliases: string[]; roleCore: string;
  identityRevision: number; growthVersion: string; modelVersion: string;
  adaptation: Adaptation; energy: number; energyAt: number;
  affect: { valence: number; intensity: number; at: number; trigger: SourceRef | null };
  interests: Record<string, { score: number; sources: SourceRef[] }>;
  relationships: Record<string, { score: number; sources: SourceRef[] }>;
  evidence: Record<string, { revision: number; fingerprint: string; revoked: boolean }>;
  counters: Partial<Record<Action, { day: number; count: number; unanswered: number; lastAttempt: number | null }>>;
  intents: Intention[];
}
export interface Observation extends SourceRef {
  kind: 'external' | 'self'; topic?: string; interestDelta?: number;
  affect?: { valence: number; intensity: number }; relationshipTarget?: string; relationshipDelta?: number;
  feedback?: 'support' | 'disagreement' | 'recovery' | 'interest' | 'disinterest';
}
export interface ParticipationPolicy {
  enabled: boolean; allowedTargets: string[]; deniedTargets: string[];
  timeZoneOffsetMinutes: number; windows: { startMinute: number; endMinute: number }[];
  cooldownMs: number; dailyLimit: number; unansweredLimit: number;
}
export interface DecisionInput {
  target: string; topic: string; action?: Action; policy: ParticipationPolicy;
  participation?: number; relationshipTarget?: string; sourceFilter?: string[];
  blocked?: boolean; topicClosed?: boolean; available?: boolean;
}
export interface Intention {
  id: string; action: Action; target: string; topic: string; reason: string;
  createdAt: number; expiresAt: number; sources: SourceRef[]; status: 'pending' | 'attempted' | 'invalid';
  limits: { timeZoneOffsetMinutes: number; cooldownMs: number; dailyLimit: number; unansweredLimit: number };
}
export interface Decision { choice: Choice; reason: string; score: number; intention: Intention | null }
export interface EvalSuite { id: string; version: number; checks: { id: string; required: boolean }[] }
export type Outcome = 'pass' | 'fail' | 'untested';
export interface Evaluation {
  suiteId: string; suiteVersion: number; modelVersion: string;
  baselineVersion: string; baseline: Record<string, Outcome>; candidate: Record<string, Outcome>;
}
export interface GrowthCandidate {
  id: string; baseVersion: string; adaptation: Adaptation; sources: SourceRef[];
  status: 'proposed' | 'evaluated' | 'approved' | 'rejected' | 'invalid' | 'active';
  evaluation: Evaluation | null; reviewer: string | null;
}
interface GrowthVersion { id: string; adaptation: Adaptation; sources: SourceRef[]; modelVersion: string }
interface GrowthCatalog { candidates:string[];suites:{id:string;version:number}[];versions:string[] }
const actions: readonly Action[] = ['group-participation', 'idle-topic', 'direct-contact'];
function check(ok: unknown, code = 'INVALID_INPUT'): asserts ok { if (!ok) throw new AgentError(code); }
function label(value: unknown, max = 256): asserts value is string {
  check(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
}
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  check(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max);
}
function shape(value: unknown, fields: readonly string[]): void {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  check(Object.keys(value).every(key => fields.includes(key)));
}
function copy<T>(value: T): T { return structuredClone(value); }
function own<T>(map: Record<string, T>, key: string): T | undefined { return Object.hasOwn(map, key) ? map[key] : undefined; }
function put<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, enumerable: true, configurable: true, writable: true });
}
function scopeKey(scope: SelfScope): string {
  shape(scope, ['botId', 'personaId', 'scope']); label(scope.botId); label(scope.personaId); label(scope.scope, 4096);
  return JSON.stringify(['self-v1', scope.botId, scope.personaId, scope.scope]);
}
function ref(value: SourceRef): void { shape(value, ['eventId', 'revision']); label(value.eventId); number(value.revision, 1); }
function adaptation(value: Adaptation): void {
  shape(value, ['warmth', 'curiosity', 'initiative']);
  for (const key of ['warmth', 'curiosity', 'initiative'] as const) number(value[key], 0, 100);
}
function assertSources(state: SelfState, sources: SourceRef[]): void {
  check(Array.isArray(sources) && sources.length > 0 && sources.length <= 16);
  check(new Set(sources.map(item => item.eventId)).size === sources.length);
  for (const source of sources) {
    ref(source); const known = own(state.evidence, source.eventId);
    check(known && !known.revoked && known.revision === source.revision, 'SOURCE_REVOKED');
  }
}
function effective(state: SelfState, now: number): void {
  const elapsed = Math.max(0, now - state.affect.at);
  const remaining = Math.max(0, 1 - elapsed / 1800000);
  state.affect.valence = Math.round(state.affect.valence * remaining);
  state.affect.intensity = Math.round(state.affect.intensity * remaining);
  state.affect.at = Math.max(now, state.affect.at);
  state.energy = Math.min(100, state.energy + Math.floor(Math.max(0, now - state.energyAt) / 60000));
  state.energyAt = Math.max(now, state.energyAt);
}
function policy(value: ParticipationPolicy): void {
  shape(value, ['enabled', 'allowedTargets', 'deniedTargets', 'timeZoneOffsetMinutes', 'windows', 'cooldownMs', 'dailyLimit', 'unansweredLimit']);
  check(typeof value.enabled === 'boolean');
  for (const list of [value.allowedTargets, value.deniedTargets]) {
    check(Array.isArray(list) && list.length <= 128); for (const target of list) label(target, 4096);
  }
  number(value.timeZoneOffsetMinutes, -840, 840); number(value.cooldownMs, 0, 86400000);
  number(value.dailyLimit, 0, 10000); number(value.unansweredLimit, 0, 10000);
  check(Array.isArray(value.windows) && value.windows.length <= 16);
  for (const window of value.windows) {
    shape(window, ['startMinute', 'endMinute']); number(window.startMinute, 0, 1439); number(window.endMinute, 1, 1440);
    check(window.startMinute !== window.endMinute);
  }
}

export class SelfGrowthEngine {
  private indexGrowth(tx:Transaction,scope:SelfScope,kind:'candidates'|'versions',id:string):void;
  private indexGrowth(tx:Transaction,scope:SelfScope,kind:'suites',id:{id:string;version:number}):void;
  private indexGrowth(tx:Transaction,scope:SelfScope,kind:keyof GrowthCatalog,id:string|{id:string;version:number}):void {
    const key=scopeKey(scope)+'/catalog';const saved=tx.read<GrowthCatalog>(key);const catalog=saved?.value??{candidates:[],suites:[],versions:[]};
    const list=catalog[kind] as (string|{id:string;version:number})[];if(list.some(item=>stable(item)===stable(id)))return;
    check(list.length<512,'CAPACITY');list.push(copy(id));tx.write(key,saved?.revision??0,catalog);
  }
  listGrowth(scope:SelfScope){
    this.state(this.store,scope);const key=scopeKey(scope);const catalog=this.store.read<GrowthCatalog>(key+'/catalog')?.value??{candidates:[],suites:[],versions:[]};
    return {candidates:catalog.candidates.map(id=>this.store.read<GrowthCandidate>(key+'/candidate/'+JSON.stringify(id))).filter((s):s is Snapshot<GrowthCandidate>=>!!s),
      suites:catalog.suites.map(id=>this.store.read<EvalSuite>(key+'/suite/'+JSON.stringify([id.id,id.version]))).filter((s):s is Snapshot<EvalSuite>=>!!s),
      versions:['initial',...catalog.versions.filter(id=>id!=='initial')].map(id=>this.store.read<GrowthVersion>(key+'/version/'+(id==='initial'?'initial':JSON.stringify(id))))
        .filter((s):s is Snapshot<GrowthVersion>=>!!s).map(s=>({id:s.value.id,adaptation:copy(s.value.adaptation),modelVersion:s.value.modelVersion}))};
  }
  private readonly store: StateStore;
  private readonly clock: () => number;
  constructor(store: StateStore, options: { clock?: () => number } = {}) { this.store = store; this.clock = options.clock ?? Date.now; }
  private now(): number { const now = this.clock(); number(now); return now; }
  private state(tx: Pick<Transaction, 'read'>, scope: SelfScope): Snapshot<SelfState> {
    const found = tx.read<SelfState>(scopeKey(scope)); check(found, 'NOT_FOUND'); return found;
  }
  initialize(input: SelfScope & { mode: 'juejue' | 'persona'; name: string; roleCore: string; modelVersion: string }): Snapshot<SelfState> {
    shape(input, ['botId', 'personaId', 'scope', 'mode', 'name', 'roleCore', 'modelVersion']);
    const scope = { botId: input.botId, personaId: input.personaId, scope: input.scope };
    const key = scopeKey(scope); label(input.name); label(input.modelVersion);
    check(typeof input.roleCore === 'string' && input.roleCore.length > 0 && input.roleCore.length <= 8000 && !input.roleCore.includes('\u0000'));
    check(input.mode === 'juejue' || input.mode === 'persona'); const now = this.now();
    return this.store.atomic(tx => {
      const existing = tx.read<SelfState>(key);
      if (existing) {
        check(existing.value.mode === input.mode && existing.value.roleCore === input.roleCore && existing.value.modelVersion === input.modelVersion, 'CONFLICT');
        return existing;
      }
      const state: SelfState = { ...scope, mode: input.mode, name: input.name, aliases: [], roleCore: input.roleCore,
        identityRevision: 1, growthVersion: 'initial', modelVersion: input.modelVersion,
        adaptation: { warmth: 50, curiosity: 50, initiative: 50 }, energy: 80, energyAt: now,
        affect: { valence: 0, intensity: 0, at: now, trigger: null }, interests: {}, relationships: {}, evidence: {}, counters: {}, intents: [] };
      tx.write<GrowthVersion>(key + '/version/initial', 0, { id: 'initial', adaptation: state.adaptation, sources: [], modelVersion: input.modelVersion });
      return tx.write(key, 0, state);
    });
  }
  get(scope: SelfScope): Snapshot<SelfState> { return copy(this.state(this.store, scope)); }
  /** Trusted management changes the fixed identity, never a learning/model patch. */
  configureIdentity(scope: SelfScope, expectedRevision: number, name: string, roleCore: string): Snapshot<SelfState> {
    return this.store.atomic(tx => this.configureIdentityIn(tx,scope,expectedRevision,name,roleCore));
  }
  configureIdentityIn(tx: Transaction, scope: SelfScope, expectedRevision: number, name: string, roleCore: string): Snapshot<SelfState> {
    label(name); check(typeof roleCore === 'string' && roleCore.length > 0 && roleCore.length <= 8000 && !roleCore.includes('\0'));
      const current=this.state(tx,scope);check(current.revision===expectedRevision,'CONFLICT');
      const state=current.value;
      if(state.name!==name){check(state.aliases.length<64,'CAPACITY');state.aliases.push(state.name);state.name=name;}
      state.roleCore=roleCore;state.identityRevision++;for(const intent of state.intents)if(intent.status==='pending')intent.status='invalid';
      return tx.write(scopeKey(scope),current.revision,state);
  }
  rename(scope: SelfScope, name: string, expectedRevision: number): Snapshot<SelfState> {
    label(name); number(expectedRevision, 1);
    return this.store.atomic(tx => {
      const current = this.state(tx, scope); check(current.revision === expectedRevision, 'CONFLICT'); const state = current.value;
      if (state.name === name) return current;
      check(state.aliases.length < 64, 'CAPACITY'); state.aliases.push(state.name); state.name = name; state.identityRevision++;
      for (const intent of state.intents) if (intent.status === 'pending') intent.status = 'invalid';
      return tx.write(scopeKey(scope), expectedRevision, state);
    });
  }
  setModelVersion(scope: SelfScope, modelVersion: string, expectedRevision: number): Snapshot<SelfState> {
    label(modelVersion); number(expectedRevision, 1);
    return this.store.atomic(tx => {
      const current = this.state(tx, scope); check(current.revision === expectedRevision, 'CONFLICT');
      current.value.modelVersion = modelVersion; current.value.identityRevision++;
      for (const intent of current.value.intents) if (intent.status === 'pending') intent.status = 'invalid';
      return tx.write(scopeKey(scope), expectedRevision, current.value);
    });
  }
  observe(scope: SelfScope, input: Observation): { state: Snapshot<SelfState>; duplicate: boolean; ignored: boolean } {
    return this.store.atomic(tx=>this.observeIn(tx,scope,input));
  }
  observeIn(tx:Transaction,scope: SelfScope,input:Observation):{state:Snapshot<SelfState>;duplicate:boolean;ignored:boolean}{
    shape(input, ['eventId', 'revision', 'kind', 'topic', 'interestDelta', 'affect', 'relationshipTarget', 'relationshipDelta', 'feedback']);
    label(input.eventId); number(input.revision, 1); check(input.kind === 'external' || input.kind === 'self');
    if (input.topic !== undefined) label(input.topic); if (input.relationshipTarget !== undefined) label(input.relationshipTarget, 4096);
    if (input.interestDelta !== undefined) { number(input.interestDelta, -10, 10); check(input.topic && ['interest', 'disinterest'].includes(input.feedback ?? '')); }
    if (input.relationshipDelta !== undefined) { number(input.relationshipDelta, -10, 10); check(input.relationshipTarget); }
    if (input.feedback !== undefined) check(['support', 'disagreement', 'recovery', 'interest', 'disinterest'].includes(input.feedback));
    if (input.affect !== undefined) { shape(input.affect, ['valence', 'intensity']); number(input.affect.valence, -100, 100); number(input.affect.intensity, 0, 100); }
    const event = copy(input); const now = this.now(); const source = { eventId: event.eventId, revision: event.revision };
    const fingerprint = stable([event.topic ?? null, event.interestDelta ?? null, event.affect ?? null, event.relationshipTarget ?? null, event.relationshipDelta ?? null, event.feedback ?? null]);
      const current = this.state(tx, scope); const state = current.value;
      if (event.kind === 'self') return { state: current, duplicate: false, ignored: true };
      const previous = own(state.evidence, event.eventId);
      if (previous) {
        check(!previous.revoked && previous.revision === event.revision && previous.fingerprint === fingerprint, 'EVENT_CONFLICT');
        return { state: current, duplicate: true, ignored: false };
      }
      check(Object.keys(state.evidence).length < 512, 'CAPACITY'); effective(state, now);
      put(state.evidence, event.eventId, { revision: event.revision, fingerprint, revoked: false });
      if (event.feedback !== 'disagreement') {
        if (event.affect) state.affect = { ...event.affect, at: now, trigger: source };
        if (event.feedback === 'recovery') state.affect = { valence: 0, intensity: 0, at: now, trigger: source };
        if (event.relationshipTarget && event.relationshipDelta !== undefined) {
          check(Object.hasOwn(state.relationships, event.relationshipTarget) || Object.keys(state.relationships).length < 128, 'CAPACITY');
          const old = Object.hasOwn(state.relationships, event.relationshipTarget) ? state.relationships[event.relationshipTarget]! : { score: 50, sources: [] };
          put(state.relationships, event.relationshipTarget, { score: Math.max(0, Math.min(100, old.score + event.relationshipDelta)), sources: [...old.sources, source] });
        }
      }
      if (event.topic && event.interestDelta !== undefined) {
        check(Object.hasOwn(state.interests, event.topic) || Object.keys(state.interests).length < 128, 'CAPACITY');
        const old = Object.hasOwn(state.interests, event.topic) ? state.interests[event.topic]! : { score: 50, sources: [] };
        put(state.interests, event.topic, { score: Math.max(0, Math.min(100, old.score + event.interestDelta)), sources: [...old.sources, source] });
      }
      return { state: tx.write(scopeKey(scope), current.revision, state), duplicate: false, ignored: false };
  }
  decide(scope: SelfScope, input: DecisionInput): Decision {
    shape(input, ['target', 'topic', 'action', 'policy', 'blocked', 'topicClosed', 'available', 'participation','relationshipTarget','sourceFilter']);
    if(input.sourceFilter!==undefined){check(Array.isArray(input.sourceFilter)&&input.sourceFilter.length<=512);for(const id of input.sourceFilter)label(id);}
    if(input.relationshipTarget!==undefined)label(input.relationshipTarget,4096);
    check(input.participation===undefined||(Number.isFinite(input.participation)&&input.participation>=0&&input.participation<=1));
    label(input.target, 4096); label(input.topic); policy(input.policy);
    check(input.action === undefined || actions.includes(input.action));
    for (const flag of [input.blocked, input.topicClosed, input.available]) check(flag === undefined || typeof flag === 'boolean');
    const query = copy(input); const now = this.now();
    return this.store.atomic(tx => {
      const current = this.state(tx, scope); const state = current.value; effective(state, now);
      state.intents = state.intents.filter(intent => intent.expiresAt > now);
      const finish = (choice: Choice, reason: string, score = 0, intention: Intention | null = null): Decision => {
        tx.write(scopeKey(scope), current.revision, state); return { choice, reason, score, intention: copy(intention) };
      };
      if (query.blocked || query.policy.deniedTargets.includes(query.target)) return finish('decline', 'CONTACT_REFUSED');
      if (!query.policy.enabled || !query.policy.allowedTargets.includes(query.target)) return finish('silence', 'NOT_AUTHORIZED');
      if(query.participation===0)return finish('silence','PARTICIPATION_DISABLED');
      if (query.topicClosed) return finish('leave-topic', 'TOPIC_CLOSED');
      if (query.available === false) return finish('defer', 'UNAVAILABLE');
      const local = now + query.policy.timeZoneOffsetMinutes * 60000;
      const minute = Math.floor((local % 86400000 + 86400000) % 86400000 / 60000);
      if (!query.policy.windows.some(window => window.startMinute < window.endMinute ? minute >= window.startMinute && minute < window.endMinute : minute >= window.startMinute || minute < window.endMinute)) return finish('defer', 'QUIET_HOURS');
      const interest = Object.hasOwn(state.interests, query.topic) ? state.interests[query.topic]!.score : 50;
      const relationshipTarget=query.relationshipTarget??query.target;
      const relationship = Object.hasOwn(state.relationships, relationshipTarget) ? state.relationships[relationshipTarget]!.score : 50;
      const score = Math.round(interest * 0.5 + relationship * 0.15 + state.energy * 0.2 + state.adaptation.initiative * 0.15 + state.affect.valence * 0.05);
      if (state.energy < 20) return finish('defer', 'LOW_ENERGY', score);
      if (score < 30) return finish('decline', 'NOT_INTERESTED', score);
      if (score < 45+(0.5-(query.participation??0.5))*60) return finish('silence', 'LOW_PARTICIPATION', score);
      if (!query.action) return finish('reply', 'WILLING', score);
      const count = state.counters[query.action]; const day = Math.floor(local / 86400000);
      if (count && count.unanswered >= query.policy.unansweredLimit || query.policy.unansweredLimit === 0) return finish('silence', 'UNANSWERED_LIMIT', score);
      if ((count?.day === day ? count.count : 0) >= query.policy.dailyLimit) return finish('defer', 'DAILY_LIMIT', score);
      if (count?.lastAttempt !== null && count?.lastAttempt !== undefined && now - count.lastAttempt < query.policy.cooldownMs) return finish('defer', 'COOLDOWN', score);
      const sources = [...(Object.hasOwn(state.interests, query.topic) ? state.interests[query.topic]!.sources : []), ...(Object.hasOwn(state.relationships, relationshipTarget) ? state.relationships[relationshipTarget]!.sources : [])]
        .filter(source=>query.sourceFilter===undefined||query.sourceFilter.includes(source.eventId))
        .filter(source => own(state.evidence, source.eventId) && !own(state.evidence, source.eventId)!.revoked && own(state.evidence, source.eventId)!.revision === source.revision)
        .filter((source, index, all) => all.findIndex(item => item.eventId === source.eventId) === index).slice(-16);
      if (!sources.length) return finish('silence', 'NO_EVIDENCE', score);
      const existing = state.intents.find(intent => intent.status === 'pending' && intent.action === query.action && intent.target === query.target && intent.topic === query.topic
        &&intent.sources.every(source=>query.sourceFilter===undefined||query.sourceFilter.includes(source.eventId)));
      if (existing) return finish('reply', 'INTENTION_PENDING', score, existing);
      check(state.intents.length < 64, 'CAPACITY');
      const intention: Intention = { id: `intent-${current.revision + 1}`, action: query.action, target: query.target, topic: query.topic,
        reason: 'INTEREST_AND_STATE', createdAt: now, expiresAt: now + 600000, sources, status: 'pending',
        limits: { timeZoneOffsetMinutes: query.policy.timeZoneOffsetMinutes, cooldownMs: query.policy.cooldownMs,
          dailyLimit: query.policy.dailyLimit, unansweredLimit: query.policy.unansweredLimit } };
      state.intents.push(intention); return finish('reply', 'INTENTION_CANDIDATE', score, intention);
    });
  }
  /** Record an externally gated attempt; this is accounting, never a send permission. */
  recordAttempt(scope: SelfScope, intentId: string, input: { responded: boolean; timeZoneOffsetMinutes?: number }): Snapshot<SelfState> {
    label(intentId); shape(input, ['responded', 'timeZoneOffsetMinutes']); check(typeof input.responded === 'boolean');
    if (input.timeZoneOffsetMinutes !== undefined) number(input.timeZoneOffsetMinutes, -840, 840); const now = this.now();
    return this.store.atomic(tx => {
      const current = this.state(tx, scope); const state = current.value; const intent = state.intents.find(item => item.id === intentId);
      check(intent && intent.status === 'pending' && intent.expiresAt > now, 'CONFLICT'); assertSources(state, intent.sources);
      check(input.timeZoneOffsetMinutes === undefined || input.timeZoneOffsetMinutes === intent.limits.timeZoneOffsetMinutes, 'CONFLICT');
      const day = Math.floor((now + intent.limits.timeZoneOffsetMinutes * 60000) / 86400000); const old = state.counters[intent.action];
      check((old?.day === day ? old.count : 0) < intent.limits.dailyLimit, 'DAILY_LIMIT');
      check((old?.unanswered ?? 0) < intent.limits.unansweredLimit, 'UNANSWERED_LIMIT');
      check(old?.lastAttempt === undefined || old.lastAttempt === null || now - old.lastAttempt >= intent.limits.cooldownMs, 'COOLDOWN');
      state.counters[intent.action] = { day, count: (old?.day === day ? old.count : 0) + 1,
        unanswered: input.responded ? 0 : (old?.unanswered ?? 0) + 1, lastAttempt: now };
      state.energy = Math.max(0, state.energy - 5); intent.status = 'attempted';
      return tx.write(scopeKey(scope), current.revision, state);
    });
  }
  acknowledgeResponse(scope: SelfScope, action: Action): Snapshot<SelfState> {
    return this.store.atomic(tx=>this.acknowledgeResponseIn(tx,scope,action));
  }
  acknowledgeResponseIn(tx:Transaction,scope:SelfScope,action:Action):Snapshot<SelfState>{
    check(actions.includes(action));
      const current = this.state(tx, scope); if (current.value.counters[action]) current.value.counters[action]!.unanswered = Math.max(0,current.value.counters[action]!.unanswered-1);
      return tx.write(scopeKey(scope), current.revision, current.value);
  }
  revokeSource(scope: SelfScope, eventId: string, revision: number): Snapshot<SelfState> {
    label(eventId); number(revision, 1); return this.store.atomic(tx => {
      const current = this.state(tx, scope); const source = own(current.value.evidence, eventId);
      check(source && source.revision === revision, 'CONFLICT'); source.revoked = true;
      const affectedTopics = new Set<string>(); const affectedTargets = new Set<string>();
      for (const [map, affected] of [[current.value.interests, affectedTopics], [current.value.relationships, affectedTargets]] as const) {
        for (const [key, value] of Object.entries(map)) if (value.sources.some(item => item.eventId === eventId)) { affected.add(key); delete map[key]; }
      }
      if (current.value.affect.trigger?.eventId === eventId) current.value.affect = { valence: 0, intensity: 0, at: this.now(), trigger: null };
      for (const intent of current.value.intents) if (intent.sources.some(item => item.eventId === eventId) || affectedTopics.has(intent.topic) || affectedTargets.has(intent.target)) intent.status = 'invalid';
      if (current.value.growthVersion !== 'initial') {
        const version = tx.read<GrowthVersion>(scopeKey(scope) + '/version/' + JSON.stringify(current.value.growthVersion));
        if (version?.value.sources.some(item => item.eventId === eventId)) {
          current.value.adaptation = { warmth: 50, curiosity: 50, initiative: 50 };
          current.value.growthVersion = 'initial';
          for (const intent of current.value.intents) if (intent.status === 'pending') intent.status = 'invalid';
        }
      }
      // Candidate checks are repeated at each operation; no unbounded scan is needed.
      return tx.write(scopeKey(scope), current.revision, current.value);
    });
  }
  propose(scope: SelfScope, input: { id: string; adaptation: Adaptation; sources: SourceRef[] }): Snapshot<GrowthCandidate> {
    shape(input, ['id', 'adaptation', 'sources']); label(input.id); adaptation(input.adaptation);
    return this.store.atomic(tx => {
      const current = this.state(tx, scope); assertSources(current.value, input.sources);
      for (const key of ['warmth', 'curiosity', 'initiative'] as const) check(Math.abs(input.adaptation[key] - current.value.adaptation[key]) <= 10);
      const candidate: GrowthCandidate = { id: input.id, baseVersion: current.value.growthVersion, adaptation: copy(input.adaptation), sources: copy(input.sources), status: 'proposed', evaluation: null, reviewer: null };
      this.indexGrowth(tx,scope,'candidates',input.id);
      return tx.write(scopeKey(scope) + '/candidate/' + JSON.stringify(input.id), 0, candidate);
    });
  }
  freezeSuite(scope: SelfScope, suite: EvalSuite): Snapshot<EvalSuite> {
    shape(suite, ['id', 'version', 'checks']); label(suite.id); number(suite.version, 1);
    check(Array.isArray(suite.checks) && suite.checks.length > 0 && suite.checks.length <= 128);
    check(new Set(suite.checks.map(item => item.id)).size === suite.checks.length && suite.checks.some(item => item.required));
    for (const item of suite.checks) { shape(item, ['id', 'required']); label(item.id); check(typeof item.required === 'boolean'); }
    return this.store.atomic(tx => { this.state(tx, scope);this.indexGrowth(tx,scope,'suites',{id:suite.id,version:suite.version}); return tx.write(scopeKey(scope) + '/suite/' + JSON.stringify([suite.id, suite.version]), 0, copy(suite)); });
  }
  private candidate(tx: Pick<Transaction, 'read'>, scope: SelfScope, id: string): Snapshot<GrowthCandidate> {
    label(id); const candidate = tx.read<GrowthCandidate>(scopeKey(scope) + '/candidate/' + JSON.stringify(id)); check(candidate, 'NOT_FOUND');
    const state = this.state(tx, scope).value; assertSources(state, candidate.value.sources); return candidate;
  }
  getCandidate(scope: SelfScope, id: string): Snapshot<GrowthCandidate> { return copy(this.candidate(this.store, scope, id)); }
  evaluate(scope: SelfScope, id: string, expectedRevision: number, evaluation: Evaluation): Snapshot<GrowthCandidate> {
    shape(evaluation, ['suiteId', 'suiteVersion', 'modelVersion', 'baselineVersion', 'baseline', 'candidate']);
    label(evaluation.suiteId); number(evaluation.suiteVersion, 1); label(evaluation.modelVersion); label(evaluation.baselineVersion); number(expectedRevision, 1);
    return this.store.atomic(tx => {
      const current = this.candidate(tx, scope, id); check(current.revision === expectedRevision && ['proposed', 'evaluated'].includes(current.value.status), 'CONFLICT');
      const state = this.state(tx, scope).value;
      check(evaluation.modelVersion === state.modelVersion && evaluation.baselineVersion === state.growthVersion && current.value.baseVersion === state.growthVersion, 'STALE_EVALUATION');
      const suite = tx.read<EvalSuite>(scopeKey(scope) + '/suite/' + JSON.stringify([evaluation.suiteId, evaluation.suiteVersion])); check(suite, 'NOT_FOUND');
      for (const results of [evaluation.baseline, evaluation.candidate]) {
        shape(results, suite.value.checks.map(item => item.id)); check(Object.keys(results).length === suite.value.checks.length);
        for (const item of suite.value.checks) check(['pass', 'fail', 'untested'].includes(results[item.id]!));
      }
      current.value.evaluation = copy(evaluation); current.value.status = 'evaluated'; current.value.reviewer = null;
      return tx.write(scopeKey(scope) + '/candidate/' + JSON.stringify(id), expectedRevision, current.value);
    });
  }
  private eligible(state: SelfState, candidate: GrowthCandidate, suite: EvalSuite): void {
    const evaluation = candidate.evaluation; check(evaluation && evaluation.modelVersion === state.modelVersion && evaluation.baselineVersion === state.growthVersion && candidate.baseVersion === state.growthVersion, 'STALE_EVALUATION');
    for (const item of suite.checks) {
      // Untested coverage is never silently excluded, even for optional quality checks.
      check(evaluation.baseline[item.id] !== 'untested' && evaluation.candidate[item.id] !== 'untested', 'STALE_EVALUATION');
      if (item.required) check(evaluation.candidate[item.id] === 'pass', 'ACCESS_DENIED');
      if (evaluation.baseline[item.id] === 'pass') check(evaluation.candidate[item.id] === 'pass', 'ACCESS_DENIED');
    }
  }
  review(scope: SelfScope, id: string, expectedRevision: number, input: { reviewer: string; human: true; approve: boolean }): Snapshot<GrowthCandidate> {
    shape(input, ['reviewer', 'human', 'approve']); label(input.reviewer); check(input.human === true && typeof input.approve === 'boolean'); number(expectedRevision, 1);
    return this.store.atomic(tx => {
      const current = this.candidate(tx, scope, id); check(current.revision === expectedRevision && current.value.status === 'evaluated', 'CONFLICT');
      if (input.approve) {
        const evaluation = current.value.evaluation!;
        const suite = tx.read<EvalSuite>(scopeKey(scope) + '/suite/' + JSON.stringify([evaluation.suiteId, evaluation.suiteVersion])); check(suite, 'NOT_FOUND');
        this.eligible(this.state(tx, scope).value, current.value, suite.value);
      }
      current.value.status = input.approve ? 'approved' : 'rejected'; current.value.reviewer = input.reviewer;
      return tx.write(scopeKey(scope) + '/candidate/' + JSON.stringify(id), expectedRevision, current.value);
    });
  }
  activate(scope: SelfScope, id: string, expectedCandidateRevision: number, expectedStateRevision: number): Snapshot<SelfState> {
    number(expectedCandidateRevision, 1); number(expectedStateRevision, 1);
    return this.store.atomic(tx => {
      const candidate = this.candidate(tx, scope, id); const current = this.state(tx, scope);
      check(candidate.revision === expectedCandidateRevision && current.revision === expectedStateRevision, 'CONFLICT');
      check(candidate.value.status === 'approved' && candidate.value.reviewer, 'ACCESS_DENIED'); const evaluation = candidate.value.evaluation!;
      const suite = tx.read<EvalSuite>(scopeKey(scope) + '/suite/' + JSON.stringify([evaluation.suiteId, evaluation.suiteVersion])); check(suite, 'NOT_FOUND');
      this.eligible(current.value, candidate.value, suite.value);
      const version = `growth-${current.revision + 1}-${id}`;
      this.indexGrowth(tx,scope,'versions',version);
      tx.write<GrowthVersion>(scopeKey(scope) + '/version/' + JSON.stringify(version), 0, { id: version, adaptation: candidate.value.adaptation, sources: candidate.value.sources, modelVersion: current.value.modelVersion });
      current.value.adaptation = copy(candidate.value.adaptation); current.value.growthVersion = version;
      for (const intent of current.value.intents) if (intent.status === 'pending') intent.status = 'invalid';
      candidate.value.status = 'active'; tx.write(scopeKey(scope) + '/candidate/' + JSON.stringify(id), candidate.revision, candidate.value);
      return tx.write(scopeKey(scope), current.revision, current.value);
    });
  }
  restore(scope: SelfScope, version: string, expectedStateRevision: number, input: { reviewer: string; human: true }): Snapshot<SelfState> {
    label(version, 512); number(expectedStateRevision, 1); shape(input, ['reviewer', 'human']); label(input.reviewer); check(input.human === true);
    return this.store.atomic(tx => {
      const current = this.state(tx, scope); check(current.revision === expectedStateRevision, 'CONFLICT');
      const old = tx.read<GrowthVersion>(scopeKey(scope) + '/version/' + (version === 'initial' ? 'initial' : JSON.stringify(version))); check(old, 'NOT_FOUND');
      check(old.value.modelVersion === current.value.modelVersion, 'STALE_EVALUATION'); if (old.value.sources.length) assertSources(current.value, old.value.sources);
      current.value.adaptation = copy(old.value.adaptation); current.value.growthVersion = old.value.id;
      for (const intent of current.value.intents) if (intent.status === 'pending') intent.status = 'invalid';
      // Original evidence remains; active adaptation is restored explicitly by a human.
      tx.write(scopeKey(scope) + '/restore/' + String(current.revision + 1), 0, { version, reviewer: input.reviewer, at: this.now() });
      return tx.write(scopeKey(scope), current.revision, current.value);
    });
  }
}
