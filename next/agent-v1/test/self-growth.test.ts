import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { SelfGrowthEngine } from '../src/self-growth.ts';
import type { DecisionInput, Evaluation, Observation, ParticipationPolicy, SelfScope } from '../src/self-growth.ts';

const scope: SelfScope = { botId: 'bot', personaId: 'juejue', scope: 'qq/group/a' };
const config = { ...scope, mode: 'juejue' as const, name: '撅撅', roleCore: '保持连续身份\n不改权限', modelVersion: 'model-a' };
const policy: ParticipationPolicy = { enabled: true, allowedTargets: ['group-a', 'person-a'], deniedTargets: [], timeZoneOffsetMinutes: 0,
  windows: [{ startMinute: 0, endMinute: 1440 }], cooldownMs: 60000, dailyLimit: 2, unansweredLimit: 2 };
const observation: Observation = { eventId: 'real-external-fixture', revision: 1, kind: 'external', topic: 'music', interestDelta: 10, feedback: 'interest' };
const decision = (patch: Partial<DecisionInput> = {}): DecisionInput => ({ target: 'group-a', topic: 'music', action: 'group-participation', policy, ...patch });
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new SqliteStateStore(db, { namespace: 'self-test', initialize: true });
  let now = 1000; const engine = new SelfGrowthEngine(store, { clock: () => now }); engine.initialize(config);
  return { db, store, engine, advance(ms: number) { now += ms; } };
}
function candidate(engine: SelfGrowthEngine, id = 'candidate') {
  engine.observe(scope, observation);
  return engine.propose(scope, { id, adaptation: { warmth: 55, curiosity: 60, initiative: 55 }, sources: [{ eventId: observation.eventId, revision: 1 }] });
}
function evaluated(engine: SelfGrowthEngine, outcomes: Partial<Evaluation> = {}, id = 'candidate') {
  const proposed = candidate(engine, id);
  engine.freezeSuite(scope, { id: 'independent-heldout', version: 1, checks: [{ id: 'privacy', required: true }, { id: 'style', required: false }] });
  return engine.evaluate(scope, id, proposed.revision, { suiteId: 'independent-heldout', suiteVersion: 1, modelVersion: 'model-a', baselineVersion: 'initial',
    baseline: { privacy: 'pass', style: 'pass' }, candidate: { privacy: 'pass', style: 'pass' }, ...outcomes });
}

test('self identity and scoped evidence survive a new engine, rename preserves aliases and mode separation', t => {
  const f = fixture(t); f.engine.observe(scope, observation);
  const before = f.engine.get(scope); const renamed = f.engine.rename(scope, '新名字', before.revision);
  const reloaded = new SelfGrowthEngine(new SqliteStateStore(f.db, { namespace: 'self-test' }));
  assert.equal(reloaded.get(scope).value.name, '新名字'); assert.deepEqual(renamed.value.aliases, ['撅撅']);
  assert.equal(reloaded.get(scope).value.interests.music!.score, 60);
  const other = { ...scope, scope: 'qq/group/b' }; f.engine.initialize({ ...config, ...other });
  assert.deepEqual(f.engine.get(other).value.interests, {});
  const persona = { ...scope, personaId: 'role-one' }; f.engine.initialize({ ...config, ...persona, mode: 'persona', roleCore: '独立角色核心' });
  assert.equal(f.engine.get(persona).value.roleCore, '独立角色核心');
  assert.throws(() => f.engine.rename(scope, '过期更名', before.revision));
});

test('external evidence is exact-idempotent, self output ignored, disagreement gives no relationship or affect penalty', t => {
  const f = fixture(t); const first = f.engine.observe(scope, observation);
  assert.equal(f.engine.observe(scope, observation).duplicate, true); assert.equal(f.engine.get(scope).revision, first.state.revision);
  assert.throws(() => f.engine.observe(scope, { ...observation, interestDelta: 9 }), { message: 'EVENT_CONFLICT' });
  assert.equal(f.engine.observe(scope, { ...observation, eventId: 'self', kind: 'self' }).ignored, true);
  f.engine.observe(scope, { eventId: 'disagree', revision: 1, kind: 'external', feedback: 'disagreement', relationshipTarget: 'person-a', relationshipDelta: -10, affect: { valence: -90, intensity: 90 } });
  const state = f.engine.get(scope).value;
  assert.deepEqual(state.relationships, {}); assert.equal(state.affect.intensity, 0); assert.equal(Object.hasOwn(state.evidence, 'self'), false);
  f.engine.observe(scope, { eventId: 'mentioned', revision: 1, kind: 'external', topic: 'weather' });
  assert.equal(Object.hasOwn(f.engine.get(scope).value.interests, 'weather'), false);
});

test('affect has an external trigger, decays with injected clock and can explicitly recover without locking administration', t => {
  const f = fixture(t);
  f.engine.observe(scope, { eventId: 'bad-day', revision: 1, kind: 'external', affect: { valence: -60, intensity: 80 } });
  assert.equal(f.engine.get(scope).value.affect.trigger!.eventId, 'bad-day');
  f.advance(900000); f.engine.decide(scope, decision({ action: undefined }));
  assert.equal(f.engine.get(scope).value.affect.intensity, 40);
  f.engine.rename(scope, '仍可管理', f.engine.get(scope).revision);
  f.engine.observe(scope, { eventId: 'restored', revision: 1, kind: 'external', feedback: 'recovery' });
  assert.equal(f.engine.get(scope).value.affect.intensity, 0);
});

test('participation produces bounded evidence-backed intentions, refuses contact and honors independent action quotas', t => {
  const f = fixture(t);
  assert.equal(f.engine.decide(scope, decision()).reason, 'NO_EVIDENCE'); f.engine.observe(scope, observation);
  assert.equal(f.engine.decide(scope, decision({ policy: { ...policy, deniedTargets: ['group-a'] } })).choice, 'decline');
  assert.equal(f.engine.decide(scope, decision({ policy: { ...policy, enabled: false } })).reason, 'NOT_AUTHORIZED');
  assert.equal(f.engine.decide(scope, decision({ topicClosed: true })).choice, 'leave-topic');
  assert.equal(f.engine.decide(scope, decision({ available: false })).choice, 'defer');
  assert.equal(f.engine.decide(scope, decision({ policy: { ...policy, windows: [{ startMinute: 100, endMinute: 200 }] } })).reason, 'QUIET_HOURS');
  const first = f.engine.decide(scope, decision()); assert.ok(first.intention);
  assert.equal(f.engine.decide(scope, decision()).intention!.id, first.intention.id);
  f.engine.recordAttempt(scope, first.intention.id, { responded: false });
  assert.throws(() => f.engine.recordAttempt(scope, first.intention!.id, { responded: false }));
  assert.equal(f.engine.decide(scope, decision()).reason, 'COOLDOWN');
  assert.ok(f.engine.decide(scope, decision({ action: 'idle-topic' })).intention);
  f.advance(60000); const next = f.engine.decide(scope, decision()).intention!;
  f.engine.recordAttempt(scope, next.id, { responded: false }); f.advance(60000);
  assert.equal(f.engine.decide(scope, decision()).reason, 'UNANSWERED_LIMIT');
  f.engine.acknowledgeResponse(scope, 'group-participation');
  assert.equal(f.engine.decide(scope, decision()).reason, 'DAILY_LIMIT');
});

test('growth needs complete frozen baseline/candidate coverage, passing safety and human review', t => {
  for (const outcomes of [ { privacy: 'fail', style: 'pass' }, { privacy: 'pass', style: 'untested' }, { privacy: 'pass', style: 'fail' } ] as const) {
    const f = fixture(t); const result = evaluated(f.engine, { candidate: outcomes });
    assert.throws(() => f.engine.review(scope, 'candidate', result.revision, { reviewer: 'admin', human: true, approve: true }));
    assert.throws(() => f.engine.activate(scope, 'candidate', result.revision, f.engine.get(scope).revision));
    assert.equal(f.engine.get(scope).value.growthVersion, 'initial');
  }
  const f = fixture(t); candidate(f.engine);
  f.engine.freezeSuite(scope, { id: 'frozen', version: 1, checks: [{ id: 'privacy', required: true }] });
  assert.throws(() => f.engine.freezeSuite(scope, { id: 'frozen', version: 1, checks: [{ id: 'different', required: true }] }));
  assert.throws(() => f.engine.evaluate(scope, 'candidate', 1, { suiteId: 'frozen', suiteVersion: 1, modelVersion: 'model-a', baselineVersion: 'initial', baseline: {}, candidate: {} }));
});

test('approved growth atomically activates adaptation, preserves role core and evidence, and can restore an audited version', t => {
  const f = fixture(t); const result = evaluated(f.engine);
  const approved = f.engine.review(scope, 'candidate', result.revision, { reviewer: 'admin', human: true, approve: true });
  const state = f.engine.get(scope); const active = f.engine.activate(scope, 'candidate', approved.revision, state.revision);
  assert.equal(active.value.adaptation.curiosity, 60); assert.equal(active.value.roleCore, config.roleCore);
  assert.equal(f.engine.getCandidate(scope, 'candidate').value.status, 'active');
  assert.throws(() => f.engine.activate(scope, 'candidate', approved.revision, state.revision));
  const restored = f.engine.restore(scope, 'initial', active.revision, { reviewer: 'admin', human: true });
  assert.equal(restored.value.adaptation.curiosity, 50); assert.ok(restored.value.evidence[observation.eventId]);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_state WHERE key LIKE '%/restore/%'").get()!.n, 1);
  assert.throws(() => f.engine.propose(scope, { id: 'overwrite-core', adaptation: { warmth: 55, curiosity: 55, initiative: 55 }, sources: [{ eventId: observation.eventId, revision: 1 }], roleCore: 'bad' } as never));
  assert.throws(() => f.engine.propose(scope, { id: 'jump', adaptation: { warmth: 99, curiosity: 55, initiative: 55 }, sources: [{ eventId: observation.eventId, revision: 1 }] }));
});

test('source revocation invalidates intents and reviewed candidates; new model requires a fresh evaluation', t => {
  const f = fixture(t); const result = evaluated(f.engine); const intention = f.engine.decide(scope, decision()).intention!;
  const reviewed = f.engine.review(scope, 'candidate', result.revision, { reviewer: 'admin', human: true, approve: true });
  f.engine.revokeSource(scope, observation.eventId, 1);
  assert.throws(() => f.engine.activate(scope, 'candidate', reviewed.revision, f.engine.get(scope).revision), { message: 'SOURCE_REVOKED' });
  assert.throws(() => f.engine.recordAttempt(scope, intention.id, { responded: false }));
  assert.equal(f.engine.decide(scope, decision()).reason, 'NO_EVIDENCE');
  assert.throws(() => f.engine.observe(scope, observation));
  const g = fixture(t); const evaluatedCandidate = evaluated(g.engine);
  g.engine.setModelVersion(scope, 'model-b', g.engine.get(scope).revision);
  assert.throws(() => g.engine.review(scope, 'candidate', evaluatedCandidate.revision, { reviewer: 'admin', human: true, approve: true }), { message: 'STALE_EVALUATION' });
  const reevaluated = g.engine.evaluate(scope, 'candidate', evaluatedCandidate.revision, { ...evaluatedCandidate.value.evaluation!, modelVersion: 'model-b' });
  assert.equal(g.engine.review(scope, 'candidate', reevaluated.revision, { reviewer: 'admin', human: true, approve: true }).value.status, 'approved');
});

test('revoking active growth evidence removes derived adaptation and cannot restore the revoked growth version', t => {
  const f = fixture(t); const result = evaluated(f.engine); const approved = f.engine.review(scope, 'candidate', result.revision, { reviewer: 'admin', human: true, approve: true });
  const active = f.engine.activate(scope, 'candidate', approved.revision, f.engine.get(scope).revision);
  f.engine.revokeSource(scope, observation.eventId, 1); const reset = f.engine.get(scope);
  assert.equal(reset.value.adaptation.curiosity, 50); assert.equal(reset.value.growthVersion, 'initial');
  assert.throws(() => f.engine.restore(scope, active.value.growthVersion, reset.revision, { reviewer: 'admin', human: true }), { message: 'SOURCE_REVOKED' });
});

test('SQL commit failure preserves the stable self and candidate versions together', t => {
  const f = fixture(t); const result = evaluated(f.engine); const reviewed = f.engine.review(scope, 'candidate', result.revision, { reviewer: 'admin', human: true, approve: true });
  const before = f.engine.get(scope);
  const port = { exec(sql: string) { if (sql === 'COMMIT') throw new Error('private sqlite detail'); f.db.exec(sql); }, prepare(sql: string) { return f.db.prepare(sql); } };
  const engine = new SelfGrowthEngine(new SqliteStateStore(port, { namespace: 'self-test' }));
  assert.throws(() => engine.activate(scope, 'candidate', reviewed.revision, before.revision), { message: 'STORAGE_FAILURE' });
  assert.deepEqual(f.engine.get(scope), before); assert.equal(f.engine.getCandidate(scope, 'candidate').value.status, 'approved');
});

test('reserved property names remain ordinary evidence and topic data without prototype confusion', t => {
  const f = fixture(t);
  f.engine.observe(scope, { ...observation, eventId: '__proto__', topic: '__proto__' });
  assert.equal(f.engine.get(scope).value.interests['__proto__']!.score, 60);
  assert.ok(f.engine.decide(scope, decision({ topic: '__proto__' })).intention);
  f.engine.revokeSource(scope, '__proto__', 1);
  assert.equal(Object.hasOwn(f.engine.get(scope).value.interests, '__proto__'), false);
});

test('canonical long conversation keys fit scopes and targets; parallel pending intentions cannot bypass attempt quotas', t => {
  const f = fixture(t); const canonical = JSON.stringify(['conversation-v1', 'bot', 'persona', 'qq-official', 'issuer', 'account', 'group', 'a'.repeat(3000)]);
  const longScope = { ...scope, scope: canonical }; f.engine.initialize({ ...config, ...longScope }); f.engine.observe(longScope, observation);
  const longDecision = f.engine.decide(longScope, decision({ target: canonical, policy: { ...policy, allowedTargets: [canonical] } }));
  assert.ok(longDecision.intention);
  f.engine.recordAttempt(longScope, longDecision.intention.id, { responded: false });
  f.engine.observe(scope, observation);
  const onePerDay = { ...policy, cooldownMs: 0, dailyLimit: 1 };
  const a = f.engine.decide(scope, decision({ policy: onePerDay })).intention!;
  const b = f.engine.decide(scope, decision({ target: 'person-a', policy: onePerDay })).intention!;
  f.engine.recordAttempt(scope, a.id, { responded: false });
  assert.throws(() => f.engine.recordAttempt(scope, b.id, { responded: false }), { message: 'DAILY_LIMIT' });
  assert.equal(f.engine.get(scope).value.intents.find(intent => intent.id === b.id)!.status, 'pending');
  // A different action has a separate allowance, while identity changes invalidate its old candidate.
  const separate = f.engine.decide(scope, decision({ action: 'direct-contact', policy: onePerDay })).intention!;
  f.engine.rename(scope, '更名', f.engine.get(scope).revision);
  assert.throws(() => f.engine.recordAttempt(scope, separate.id, { responded: false }));
});

test('old source revocation still invalidates aggregates and pending intentions after many later observations', t => {
  const f = fixture(t);
  for (let index = 0; index < 20; index++) f.engine.observe(scope, { ...observation, eventId: `evidence-${index}` });
  const intention = f.engine.decide(scope, decision()).intention!;
  assert.equal(intention.sources.some(source => source.eventId === 'evidence-0'), false);
  f.engine.revokeSource(scope, 'evidence-0', 1);
  assert.equal(Object.hasOwn(f.engine.get(scope).value.interests, 'music'), false);
  assert.throws(() => f.engine.recordAttempt(scope, intention.id, { responded: false }));
});

test('growth catalog survives reopening and preserves candidate, frozen suite and active version without scanning storage',t=>{
  const f=fixture(t);const evaluatedCandidate=evaluated(f.engine);
  const approved=f.engine.review(scope,'candidate',evaluatedCandidate.revision,{reviewer:'human',human:true,approve:true});
  const active=f.engine.activate(scope,'candidate',approved.revision,f.engine.get(scope).revision);
  const reloaded=new SelfGrowthEngine(new SqliteStateStore(f.db,{namespace:'self-test'}));const catalog=reloaded.listGrowth(scope);
  assert.equal(catalog.candidates[0]!.value.status,'active');assert.equal(catalog.suites[0]!.value.id,'independent-heldout');
  assert.ok(catalog.versions.some(version=>version.id===active.value.growthVersion));assert.ok(catalog.versions.some(version=>version.id==='initial'));
  const other={...scope,scope:'another'};reloaded.initialize({...config,...other});assert.deepEqual(reloaded.listGrowth(other).candidates,[]);
});
