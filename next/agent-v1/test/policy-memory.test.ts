import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../src/store.ts';
import type { StateStore } from '../src/store.ts';
import { PolicyMemory } from '../src/policy-memory.ts';
import type { MemoryInput, PolicyPatch, SourceInput } from '../src/policy-memory.ts';
import { conversationKey } from '../../conversation-v1/src/identity.ts';

const ID = { botId: 'bot', personaId: 'juejue', connector: 'local-test' as const, issuer: 'fixture', accountId: 'account', kind: 'group' as const };
const A = conversationKey({ ...ID, remoteId: 'a' });
const B = conversationKey({ ...ID, remoteId: 'b' });
const C = conversationKey({ ...ID, remoteId: 'c' });
const allowed = { receive: true, save: true, learn: true, reply: true, proactive: true };
const purposes = ['read', 'learn', 'draft', 'publish'] as const;
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
function source(patch: Partial<SourceInput> = {}): SourceInput {
  return { id: 'source-a', conversationKey: A, revision: 1, domain: 'social', status: 'active',
    purposes: [...purposes], audiences: [A, B, C], expiresAt: 10000, ...patch };
}
function memory(patch: Partial<MemoryInput> = {}): MemoryInput {
  return { id: 'memory-a', revision: 1, conversationKey: A, kind: 'knowledge', text: '星空 火星知识',
    sourceRefs: [{ sourceId: 'source-a', revision: 1 }], derivedFrom: [],
    sharing: { approved: false, approvedBy: null, ruleRevision: 0, targets: [], purposes: [...purposes], expiresAt: null }, ...patch };
}
function shared(patch: Partial<MemoryInput> = {}): MemoryInput {
  return memory({ sharing: { approved: true, approvedBy: 'host-admin', ruleRevision: 1, targets: [B], purposes: [...purposes], expiresAt: 9000 }, ...patch });
}
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  const store = new SqliteStateStore(db, { namespace: 'test', initialize: true });
  t.after(() => { store.close(); db.close(); });
  const service = new PolicyMemory(store, { botId: ID.botId, personaId: ID.personaId });
  const revision = () => service.readPolicy().revision;
  const configure = (patch: PolicyPatch, key?: string) => service.configure(revision(), patch, key);
  const put = (input = source()) => service.putSource(revision(), input);
  const add = (input = memory()) => service.addMemory(revision(), input);
  const get = (key = A, now = 100, purpose: typeof purposes[number] = 'read', query = '') => service.retrieve({ conversationKey: key, purpose, query, now });
  return { db, store, service, revision, configure, put, add, get };
}

test('safe defaults persist only by explicit CAS and local settings cannot lift hard denial', t => {
  const f = fixture(t);
  assert.equal(f.revision(), 0); assert.equal(f.service.effective(A).memoryMode, 'isolated');
  assert.deepEqual(f.service.effective(A).permissions, { receive: false, save: false, learn: false, reply: false, proactive: false });
  assert.throws(() => f.configure({ permissions: { reply: true } }, A), code('HARD_PERMISSION_DENIED'));
  assert.equal(f.revision(), 0);
  f.configure({ permissions: allowed, prompt: '全局风格', participation: 0.4 });
  f.configure({ permissions: { learn: false }, prompt: '局部规则', typing: { maxDelayMs: 3000 }, participation: 0.2 }, A);
  const effective = f.service.effective(A);
  assert.equal(effective.permissions.learn, false); assert.equal(effective.permissions.reply, true);
  assert.equal(effective.prompt, '全局风格\n局部规则'); assert.equal(effective.typing.maxDelayMs, 3000); assert.equal(effective.participation, 0.2);
  f.configure({ permissions: { reply: false } });
  assert.equal(f.service.effective(A).permissions.reply, false);
  assert.throws(() => f.service.configure(1, { prompt: 'stale' }), code('REVISION_CONFLICT'));
});
test('configuration validation, accessor rejection and returned copies cannot mutate state', t => {
  const f = fixture(t); let accessed = false;
  const accessor = { get mode() { accessed = true; return 'shared'; } };
  assert.throws(() => f.configure(accessor as PolicyPatch)); assert.equal(accessed, false);
  for (const patch of [{ typo: true }, { participation: 2 }, { typing: { charsPerSecond: 0 } }, { mode: 'shared', memoryMode: 'inherit' }]) {
    assert.throws(() => f.configure(patch as PolicyPatch));
  }
  assert.equal(f.revision(), 0);
  const saved = f.configure({ permissions: allowed }); saved.value.global.permissions.reply = false;
  assert.equal(f.service.effective(A).permissions.reply, true);
});
test('global expression rules remain enforced when local rules are empty or different', t => {
  const f = fixture(t);
  f.configure({ expressionRules: [{ ruleId: 'global', match: 'contains', phrase: '人机套话', action: 'blocked' }] });
  f.configure({ expressionRules: [{ ruleId: 'global', match: 'exact', phrase: '其他', action: 'rewrite' }] }, A);
  assert.deepEqual(f.service.checkExpression(A, '这是人机套话', 'repetition'), { action: 'blocked', ruleId: 'g:global' });
  assert.equal(f.service.checkExpression(A, '其他').action, 'rewrite');
  f.configure({ expressionRules: [] }, A);
  assert.equal(f.service.checkExpression(A, '人机套话').action, 'blocked');
  assert.throws(() => f.configure({ expressionRules: [{ ruleId: 'bad', match: 'regex' as 'exact', phrase: '.*', action: 'blocked' }] }));
});
test('expression checks support a long canonical key without weakening shared social validator limits', t => {
  const f = fixture(t);
  const key = conversationKey({ ...ID, botId: 'bot', remoteId: 'r'.repeat(256), accountId: 'a'.repeat(256) });
  assert.ok(key.length > 512);
  f.configure({ expressionRules: [{ ruleId: 'x', match: 'exact', phrase: '禁止', action: 'blocked' }] }, key);
  assert.equal(f.service.checkExpression(key, '禁止').action, 'blocked');
});

test('style contracts persist by CAS and local contracts cannot erase or replace global contracts', t => {
  const f = fixture(t);
  const global = { contractId: 'natural', policyText: '避免机械总结', counterexamples: ['总而言之，综上所述'] };
  const local = { contractId: 'natural', policyText: '这个群避免过度亲昵称呼', counterexamples: ['亲爱的小宝贝们'] };
  f.configure({ styleContracts: [global] }); f.configure({ styleContracts: [local] }, A);
  const effective = f.service.effective(A);
  assert.deepEqual(effective.styleContracts, [global, local]);
  assert.deepEqual(effective.expressionPolicy.styleContracts.map(contract => [contract.contractId, contract.scope]),
    [['g:style:natural', { kind: 'global' }], ['l:style:natural', { kind: 'global' }]]);
  effective.styleContracts[0]!.counterexamples[0] = 'caller mutation';
  assert.equal(f.service.effective(A).styleContracts[0]!.counterexamples[0], global.counterexamples[0]);
  f.configure({ styleContracts: [] }, A);
  assert.deepEqual(f.service.effective(A).styleContracts, [global]);
  assert.equal(f.service.effective(B).expressionPolicy.styleContracts.length, 1);
  const reloaded = new PolicyMemory(new SqliteStateStore(f.db, { namespace: 'test' }), { botId: ID.botId, personaId: ID.personaId });
  assert.deepEqual(reloaded.effective(A).styleContracts, [global]);
  const revision = f.revision(); assert.throws(() => f.service.configure(revision - 1, { styleContracts: [] }), code('REVISION_CONFLICT'));
  assert.deepEqual(f.service.effective(A).styleContracts, [global]);
  // The pure matcher deliberately makes no semantic judgement: runtime must require its reviewer.
  assert.equal(f.service.checkExpression(A, global.counterexamples[0]!).action, 'allow');
});

test('style contracts reject forged scopes, accessors, duplicate IDs and exceeded merged limits without partial writes', t => {
  const f = fixture(t); const contract = { contractId: 'style', policyText: '自然表达', counterexamples: ['机械示例'] };
  for (const styleContracts of [
    [{ ...contract, scope: { kind: 'conversation', key: B } }],
    [{ ...contract, contractId: 'bad id' }], [{ ...contract, policyText: '' }], [{ ...contract, policyText: 'x'.repeat(4001) }],
    [{ ...contract, counterexamples: [''] }], [{ ...contract, counterexamples: ['x'.repeat(513)] }],
    [{ ...contract, counterexamples: Array(9).fill('example') }], [contract, contract],
    Array.from({ length: 33 }, (_, i) => ({ ...contract, contractId: `c${i}` })),
  ]) assert.throws(() => f.configure({ styleContracts } as PolicyPatch));
  let accessed = false;
  const hostile = { contractId: 'getter', get policyText() { accessed = true; return 'injected'; }, counterexamples: [] };
  assert.throws(() => f.configure({ styleContracts: [hostile] })); assert.equal(accessed, false); assert.equal(f.revision(), 0);
  f.configure({ styleContracts: Array.from({ length: 31 }, (_, i) => ({ ...contract, contractId: `global${i}` })) });
  f.configure({ styleContracts: [contract] }, A); const before = f.service.readPolicy();
  assert.throws(() => f.configure({ styleContracts: Array.from({ length: 32 }, (_, i) => ({ ...contract, contractId: `global${i}` })) }), code('INVALID_EXPRESSION_POLICY'));
  assert.deepEqual(f.service.readPolicy(), before); assert.equal(f.service.effective(A).expressionPolicy.styleContracts.length, 32);
});

test('style contracts resolve canonical keys larger than the expression library scope limit', t => {
  const f = fixture(t); const key = conversationKey({ ...ID, remoteId: 'r'.repeat(256), accountId: 'a'.repeat(256) });
  assert.ok(key.length > 512);
  f.configure({ styleContracts: [{ contractId: 'local', policyText: '避免长篇套话', counterexamples: [] }] }, key);
  assert.deepEqual(f.service.effective(key).expressionPolicy.styleContracts[0]!.scope, { kind: 'global' });
  assert.equal(f.service.effective(A).expressionPolicy.styleContracts.length, 0);
});

test('caller transaction commits or rolls back memory and candidate review together with the same validation', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put();
  f.store.atomic(tx => tx.write('candidate-review', 0, { status: 'pending' })); const revision = f.revision();
  assert.throws(() => f.store.atomic(tx => {
    f.service.addMemoryIn(tx, revision, memory());
    tx.write('candidate-review', 0, { status: 'accepted' }); // Simulate a conflicting second state write.
  }), code('CONFLICT'));
  assert.equal(f.revision(), revision); assert.equal(f.get().items.length, 0);
  assert.equal(f.store.read<{ status: string }>('candidate-review')!.value.status, 'pending');
  f.store.atomic(tx => {
    f.service.addMemoryIn(tx, revision, memory()); tx.write('candidate-review', 1, { status: 'accepted' });
  });
  assert.equal(f.get().items.length, 1); assert.equal(f.store.read<{ status: string }>('candidate-review')!.value.status, 'accepted');
  assert.throws(() => f.store.atomic(tx => f.service.addMemoryIn(tx, f.revision(), memory({ id: 'invalid', sourceRefs: [] }))));
  assert.equal(f.service.readPolicy().value.memories.invalid, undefined);
});
test('isolated memory remains per canonical stream and persona, with no cross-stream cards', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put(); f.add(shared());
  assert.equal(f.get(A).items.length, 1); assert.equal(f.get(B).items.length, 0);
  assert.equal(f.service.card(B, 100).items.length, 0);
  const other = new PolicyMemory(f.store, { botId: ID.botId, personaId: 'other-persona' });
  assert.throws(() => other.effective(A), code('MEMORY_SCOPE_MISMATCH'));
  const otherKey = conversationKey({ ...ID, personaId: 'other-persona', remoteId: 'a' });
  assert.equal(other.card(otherKey, 100).items.length, 0);
  assert.throws(() => f.service.effective(JSON.stringify(['nickname', 'a'])));
});
test('shared mode requires explicit approval and targets, and local isolation can only tighten', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(); f.add();
  assert.equal(f.get(B).items.length, 0);
  f.add(shared({ revision: 2 }));
  assert.equal(f.get(B).items.length, 1); assert.equal(f.get(C).items.length, 0);
  f.configure({ memoryMode: 'isolated' }, B); assert.equal(f.get(B).items.length, 0);
  f.configure({ memoryMode: 'inherit' }, B); assert.equal(f.get(B).items.length, 1);
  f.configure({ memoryMode: 'isolated' }, A); assert.equal(f.get(B).items.length, 0);
  assert.throws(() => f.configure({ mode: 'shared' }, A));
});
test('private facts only cross approved concrete audiences and purposes', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put();
  f.add(shared({ kind: 'private', text: 'PRIVATE-FACT' }));
  assert.equal(f.get(B, 100, 'read').items[0]!.text, 'PRIVATE-FACT');
  assert.equal(f.get(C, 100, 'read').items.length, 0);
  f.add(shared({ revision: 2, kind: 'private', sharing: { approved: true, approvedBy: 'admin', ruleRevision: 2, targets: [B], purposes: ['read'], expiresAt: null } }));
  assert.equal(f.get(B, 100, 'publish').items.length, 0);
  assert.throws(() => f.add(shared({ revision: 3, sharing: { approved: true, approvedBy: null, ruleRevision: 2, targets: [B], purposes: ['read'], expiresAt: null } })));
});
test('Code sources and missing learning permission cannot enter social memory', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put(source({ domain: 'code' }));
  assert.throws(() => f.add(), code('SOURCE_NOT_ALLOWED'));
  const g = fixture(t); g.configure({ permissions: { receive: true, save: true } }); g.put();
  assert.throws(() => g.add(), code('MEMORY_WRITE_DENIED'));
});
test('a foreign source cannot be laundered into a local card even with a target audience', t => {
  const f = fixture(t); f.configure({ permissions: allowed });
  f.put(source({ conversationKey: B, audiences: [A, B] }));
  assert.throws(() => f.add(memory()), code('SOURCE_SCOPE_MISMATCH'));
  assert.equal(f.service.card(A, 100).items.length, 0);
});
test('source current status/revision/purpose/audience is checked independently of sharing approval', t => {
  for (const patch of [{ status: 'revoked' as const }, { revision: 2 }, { purposes: ['read'] as ['read'] }, { audiences: [C] }]) {
    const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(source(patch));
    assert.throws(() => f.add(shared()), code('SOURCE_NOT_ALLOWED'));
  }
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(source({ audiences: [A] })); f.add(shared());
  assert.equal(f.get(B).items.length, 0);
});
test('source revocation cascades through derived memory and cannot silently resurrect', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(); f.add(shared());
  f.add(shared({ id: 'derived', derivedFrom: [{ memoryId: 'memory-a', revision: 1 }] }));
  f.add(shared({ id: 'leaf', derivedFrom: [{ memoryId: 'derived', revision: 1 }] }));
  const ticket = f.get(B); assert.equal(ticket.items.length, 3);
  f.service.revokeSource(f.revision(), 'source-a', 2);
  assert.equal(f.get(A).items.length, 0); assert.equal(f.get(B).items.length, 0);
  assert.ok(Object.values(f.service.readPolicy().value.memories).every(item => item.status === 'revoked'));
  assert.throws(() => f.service.validateTicket(ticket, 100), code('CONTEXT_STALE'));
  assert.throws(() => f.put(source({ revision: 3 })), code('SOURCE_REVOKED'));
  assert.throws(() => f.add(shared({ revision: 2 })), code('MEMORY_CONFLICT'));
});
test('source revision changes invalidate old facts and tickets without a revocation flag', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put(); f.add(); const ticket = f.get();
  f.put(source({ revision: 2, audiences: [A] }));
  assert.equal(f.get().items.length, 0); assert.throws(() => f.service.validateTicket(ticket, 100), code('CONTEXT_STALE'));
});
test('derived memory preserves source evidence, ancestor permissions and cycle protection', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(); f.add();
  f.put(source({ id: 'source-b' }));
  assert.throws(() => f.add(shared({ id: 'laundered', sourceRefs: [{ sourceId: 'source-b', revision: 1 }], derivedFrom: [{ memoryId: 'memory-a', revision: 1 }] })), code('SOURCE_INHERITANCE_REQUIRED'));
  f.add(shared({ id: 'derived', derivedFrom: [{ memoryId: 'memory-a', revision: 1 }] }));
  assert.equal(f.get(B).items.length, 0, 'child approval cannot publish an unapproved parent');
  assert.throws(() => f.add(memory({ revision: 2, derivedFrom: [{ memoryId: 'derived', revision: 1 }] })), code('DERIVATION_CYCLE'));
  assert.throws(() => f.add(memory({ id: 'self', derivedFrom: [{ memoryId: 'self', revision: 1 }] })), code('DERIVATION_CYCLE'));
});
test('valid diamond derivations are supported and inherit all source versions', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put(); f.add();
  f.add(memory({ id: 'left', derivedFrom: [{ memoryId: 'memory-a', revision: 1 }] }));
  f.add(memory({ id: 'right', derivedFrom: [{ memoryId: 'memory-a', revision: 1 }] }));
  f.add(memory({ id: 'diamond', derivedFrom: [{ memoryId: 'left', revision: 1 }, { memoryId: 'right', revision: 1 }] }));
  assert.equal(f.get().items.length, 4);
});
test('mode changes invalidate prior context even when toggled back, without deleting cards', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(); f.add(shared());
  const ticket = f.get(B); f.configure({ mode: 'isolated' });
  assert.throws(() => f.service.validateTicket(ticket, 100), code('CONTEXT_STALE'));
  assert.equal(f.get(B).items.length, 0); assert.equal(f.service.card(A, 100).items.length, 1);
  f.configure({ mode: 'shared' });
  assert.throws(() => f.service.validateTicket(ticket, 100), code('CONTEXT_STALE'));
  assert.equal(f.get(B).items.length, 1);
});
test('expiry after retrieval and target/origin permission revocation stop old context', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(source({ expiresAt: 200 })); f.add(shared());
  const ticket = f.get(B); assert.equal(f.service.validateTicket(ticket, 199), true);
  assert.throws(() => f.service.validateTicket(ticket, 200), code('CONTEXT_STALE'));
  assert.equal(f.get(B, 200).items.length, 0);
  f.configure({ permissions: { save: false } }, A); assert.equal(f.get(B).items.length, 0);
});
test('sharing expiry and draft reply permissions are rechecked', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put();
  f.add(shared({ sharing: { approved: true, approvedBy: 'admin', ruleRevision: 1, targets: [B], purposes: [...purposes], expiresAt: 200 } }));
  assert.equal(f.get(B, 199).items.length, 1); assert.equal(f.get(B, 200).items.length, 0);
  f.configure({ permissions: { reply: false } }, B);
  assert.equal(f.get(B, 100, 'draft').items.length, 0); assert.equal(f.get(B, 100, 'read').items.length, 1);
});
test('bounded keyword relevance and context budget exclude oversized and unrelated items', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put();
  f.add(memory({ id: 'a', text: '星空 火星' })); f.add(memory({ id: 'b', text: '星空' })); f.add(memory({ id: 'c', text: '园艺' }));
  const ticket = f.service.retrieve({ conversationKey: A, purpose: 'read', query: '星空 火星', now: 100, maxItems: 2, maxChars: 30 });
  assert.deepEqual(ticket.items.map(item => item.id), ['a', 'b']); assert.equal(ticket.method, 'keyword'); assert.equal(ticket.bounded, true);
  const small = f.service.retrieve({ conversationKey: A, purpose: 'read', query: '星空', now: 100, maxItems: 2, maxChars: 2 });
  assert.deepEqual(small.items.map(item => item.id), ['b']);
  assert.throws(() => f.service.retrieve({ conversationKey: A, purpose: 'read', query: '', now: 100, maxItems: 33 }));
  assert.throws(() => f.service.retrieve({ conversationKey: A, purpose: 'read', query: '', now: 100, maxChars: 16001 }));
});
test('ticket tampering cannot substitute private text or source version evidence', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put(); f.add(); const ticket = f.get();
  const changedText = structuredClone(ticket); changedText.items[0]!.text = 'invented';
  assert.throws(() => f.service.validateTicket(changedText, 100), code('CONTEXT_STALE'));
  const changedSource = structuredClone(ticket); changedSource.sourceEvidence[0]!.revision++;
  assert.throws(() => f.service.validateTicket(changedSource, 100), code('CONTEXT_INVALID'));
  ticket.items[0]!.text = 'mutated-copy'; assert.equal(f.get().items[0]!.text, '星空 火星知识');
});
test('a real policy change between retrieval snapshot and final check prevents returning context', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put(); f.add(); let armed = true;
  // Only scheduling is injected; reads and the intervening CAS use real SQLite.
  const interleaved: StateStore = {
    atomic: work => f.store.atomic(work),
    read: key => {
      const snapshot = f.store.read(key);
      if (armed) { armed = false; f.configure({ mode: 'shared' }); }
      return snapshot;
    },
  };
  const service = new PolicyMemory(interleaved, { botId: ID.botId, personaId: ID.personaId });
  assert.throws(() => service.retrieve({ conversationKey: A, purpose: 'read', query: '', now: 100 }), code('CONTEXT_STALE'));
});
test('actual SQLite write failure rolls back policy and preserves valid prior tickets', t => {
  const f = fixture(t); f.configure({ permissions: allowed }); f.put(); f.add(); const before = f.service.readPolicy(); const ticket = f.get();
  f.db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON agent_state BEGIN SELECT RAISE(ABORT,'PRIVATE-DRIVER-DETAIL'); END");
  assert.throws(() => f.configure({ mode: 'shared' }), code('STORAGE_FAILURE'));
  assert.deepEqual(f.service.readPolicy(), before); assert.equal(f.service.validateTicket(ticket, 100), true);
  f.db.exec('DROP TRIGGER reject_update');
});
test('synthetic disk reopen retains local policy, approved cards and ticket invalidation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'juebot-policy-memory-'));
  let db = new DatabaseSync(join(directory, 'synthetic.sqlite'), { allowExtension: false });
  let store = new SqliteStateStore(db, { namespace: 'test', initialize: true });
  t.after(() => { store.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  let service = new PolicyMemory(store, { botId: 'bot', personaId: 'juejue' });
  let rev = service.configure(0, { permissions: allowed, mode: 'shared' }).revision;
  rev = service.configure(rev, { prompt: 'persisted-local' }, B).revision;
  rev = service.putSource(rev, source()).revision; service.addMemory(rev, shared());
  const ticket = service.retrieve({ conversationKey: B, purpose: 'read', query: '', now: 100 });
  store.close(); db.close(); db = new DatabaseSync(join(directory, 'synthetic.sqlite'), { allowExtension: false });
  store = new SqliteStateStore(db, { namespace: 'test' }); service = new PolicyMemory(store, { botId: 'bot', personaId: 'juejue' });
  assert.equal(service.effective(B).prompt, 'persisted-local'); assert.equal(service.validateTicket(ticket, 100), true);
  service.configure(service.readPolicy().revision, { mode: 'isolated' });
  assert.throws(() => service.validateTicket(ticket, 100), code('CONTEXT_STALE'));
});
test('canonical namespaces separate equal-looking remote IDs and reject malformed/prototype IDs', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(); f.add(shared());
  for (const patch of [{ issuer: 'other-app' }, { accountId: 'other-account' }, { kind: 'direct' as const }, { connector: 'qq-official' as const }]) {
    const key = conversationKey({ ...ID, remoteId: 'a', ...patch }); assert.equal(f.get(key).items.length, 0);
  }
  assert.throws(() => f.put(source({ id: '__proto__' })));
  assert.throws(() => f.add(memory({ id: 'constructor' })));
});


test('reviewed local contact windows intersect Host authority across midnight/timezones and never increase budgets', t => {
  const f = fixture(t), host = { enabled: true, allowedTargets: [A], deniedTargets: [], timeZoneOffsetMinutes: 0,
    windows: [{ startMinute: 60, endMinute: 240 }], cooldownMs: 1000, dailyLimit: 3, unansweredLimit: 2 };
  f.configure({ contactPolicy: { timeZoneOffsetMinutes: 480, windows: [{ startMinute: 600, endMinute: 660 }], cooldownMs: 2000, dailyLimit: 8, unansweredLimit: 1 } }, A);
  assert.deepEqual(f.service.restrictParticipation(A, host), { ...host, windows: [{ startMinute: 120, endMinute: 180 }], cooldownMs: 2000, unansweredLimit: 1 });
  f.configure({ contactPolicy: { timeZoneOffsetMinutes: 0, windows: [{ startMinute: 150, endMinute: 160 }], cooldownMs: 0, dailyLimit: 1, unansweredLimit: 9 } });
  const limited = f.service.restrictParticipation(A, host); assert.deepEqual(limited.windows, [{ startMinute: 150, endMinute: 160 }]); assert.equal(limited.dailyLimit, 1);
  f.configure({ contactPolicy: null }, A); assert.deepEqual(f.service.restrictParticipation(A, host).windows, [{ startMinute: 150, endMinute: 160 }]);
  f.configure({ contactPolicy: { timeZoneOffsetMinutes: 0, windows: [{ startMinute: 1380, endMinute: 60 }], cooldownMs: 0, dailyLimit: 1, unansweredLimit: 1 } }, A);
  assert.deepEqual(f.service.restrictParticipation(A, host).windows, []);
  assert.equal(f.service.restrictParticipation(A, { ...host, enabled: false }).enabled, false);
  assert.throws(() => f.configure({ contactPolicy: { ...host, enabled: undefined } } as never));
});

test('summary approval expires, unshare clears access, malformed review rolls back and disk reopen preserves exact grant', t => {
  const f = fixture(t); f.configure({ permissions: allowed, mode: 'shared' }); f.put(source({ audiences: [A] })); f.add();
  const share = () => ({ id: 'memory-a', expectedMemoryRevision: f.service.readPolicy().value.memories['memory-a']!.revision, principal: 'human', reason: 'Generic summary', action: 'share' as const, targets: [B], purposes: ['read' as const], expiresAt: 200 });
  const revision = f.revision(); assert.throws(() => f.service.reviewMemory(revision, { ...share(), targets: [A] }, 100)); assert.equal(f.revision(), revision);
  f.service.reviewMemory(f.revision(), share(), 100); assert.equal(f.get(B, 100).items.length, 1); assert.equal(f.get(B, 200).items.length, 0);
  const reopened = new PolicyMemory(new SqliteStateStore(f.db, { namespace: 'test' }), { botId: ID.botId, personaId: ID.personaId });
  assert.equal(reopened.retrieve({ conversationKey: B, purpose: 'read', query: '', now: 100 }).items.length, 1);
  f.service.reviewMemory(f.revision(), { id: 'memory-a', expectedMemoryRevision: 2, principal: 'human', reason: 'Withdraw summary', action: 'unshare' }, 150);
  assert.equal(f.get(B, 150).items.length, 0); assert.deepEqual(f.service.readPolicy().value.sources['source-a']!.audiences, [A]);
  assert.equal(f.service.readPolicy().value.memoryReviews!.length, 2);
});

const summaryRequest = { action: 'bili.dynamic' as const, accountId: 'public-account', target: { objectId: null, parentId: null, visibility: 'public', category: null } };
function summaryFixture(t, kind: 'knowledge' | 'private' = 'knowledge') {
  const f = fixture(t); f.configure({ permissions: allowed });
  f.put(source({ purposes: ['read', 'learn'], audiences: [A], expiresAt: 5000 }));
  f.add(memory({ kind, text: '人工批准的摘要，不是原始私聊全文' }));
  return f;
}
const summaryApproval = (patch = {}) => ({ memoryId: 'memory-a', expectedMemoryRevision: 1, key: B, ...structuredClone(summaryRequest),
  principal: 'trusted-human', reason: '逐字审阅该摘要及公开目标', expiresAt: 4000, ...patch });

test('summary material binds an exact approved summary while keeping all raw purposes and audiences unchanged', t => {
  const f = summaryFixture(t); const rawBefore = f.service.readPolicy().value.sources['source-a'];
  const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 100);
  assert.equal(approved.topic, '创作摘要 memory-a ' + approved.sourceId.slice(-16)); assert.equal(approved.revision, 1); assert.match(approved.sourceId, /^summary-material-[a-f0-9]{64}$/);
  const state = f.service.readPolicy().value; assert.deepEqual(state.sources['source-a'], rawBefore);
  assert.deepEqual(state.sources[approved.sourceId].purposes, ['draft', 'publish']); assert.deepEqual(state.sources[approved.sourceId].audiences, [B]);
  assert.equal(f.service.isSummaryMaterial(approved.sourceId), true); assert.equal(f.service.isSummaryMaterial('source-a'), false);
  assert.deepEqual(f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 101), { id: approved.sourceId, revision: 1, text: state.memories['memory-a'].text });
  assert.equal(f.service.resolveSummaryMaterial('source-a', B, summaryRequest, 101), null);
  assert.equal(f.get(B, 101, 'publish').items.length, 0, 'the original memory/raw provenance is not broadly shared');
  approved.target.visibility = 'changed-copy'; assert.equal(f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 101).text, state.memories['memory-a'].text);
});

test('private summary creation requires explicit true and repeated approvals have independent irreversible alias IDs', t => {
  const f = summaryFixture(t, 'private'); const before = f.service.readPolicy();
  for (const includePrivate of [undefined, false, 'true']) assert.throws(() => f.service.approveSummaryMaterial(f.revision(), summaryApproval({ includePrivate }) as never, 100));
  assert.deepEqual(f.service.readPolicy(), before);
  const first = f.service.approveSummaryMaterial(f.revision(), summaryApproval({ includePrivate: true }), 100);
  f.service.revokeSource(f.revision(), first.sourceId, 2);
  assert.throws(() => f.service.resolveSummaryMaterial(first.sourceId, B, summaryRequest, 101), /SUMMARY_MATERIAL_STALE/);
  const second = f.service.approveSummaryMaterial(f.revision(), summaryApproval({ includePrivate: true }), 101);
  assert.notEqual(second.sourceId, first.sourceId); assert.notEqual(second.topic, first.topic); assert.ok(second.topic.length <= 128); assert.equal(second.revision, 1);
  assert.throws(() => f.service.putSource(f.revision(), { ...f.service.readPolicy().value.sources[first.sourceId], status: 'active', revision: 3 }), /SUMMARY_SOURCE_RESERVED/);
  assert.equal(f.service.resolveSummaryMaterial(second.sourceId, B, summaryRequest, 102).text, before.value.memories['memory-a'].text);
});

test('summary material rejects changed target, account, action and key without permitting broader raw publication', t => {
  const f = summaryFixture(t); const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 100);
  for (const patch of [{ action: 'qqspace' }, { accountId: 'other-account' }, { target: { ...summaryRequest.target, visibility: 'private' } },
    { target: { ...summaryRequest.target, objectId: 'another-post' } }]) assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, B, { ...summaryRequest, ...patch } as never, 101), /SUMMARY_MATERIAL_SCOPE_MISMATCH/);
  assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, A, summaryRequest, 101), /SUMMARY_MATERIAL_SCOPE_MISMATCH/);
  f.configure({ permissions: { reply: false } }, B); assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 102), /SUMMARY_MATERIAL_STALE/);
});

test('summary expiry is finite and no longer than every active original source, and expiry is rechecked without cascade', t => {
  const f = summaryFixture(t); const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval({ expiresAt: 6000 }), 100);
  assert.equal(approved.expiresAt, 5000); assert.equal(f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 4999).revision, 1);
  assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 5000), /SUMMARY_MATERIAL_STALE/);
  for (const expiresAt of [100, null, Number.MAX_SAFE_INTEGER, 100 + 31 * 86400000]) assert.throws(() => f.service.approveSummaryMaterial(f.revision(), summaryApproval({ expiresAt }) as never, 100));
  assert.throws(() => f.service.approveSummaryMaterial(f.revision(), summaryApproval({ expiresAt: 6000 }), 5000), /SOURCE_NOT_ALLOWED/);
});

test('source updates and memory correction immediately revoke aliases and old approvals cannot publish corrected text', t => {
  for (const mode of ['source-revoke', 'source-revision', 'correct', 'memory-revoke']) {
    const f = summaryFixture(t); const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 100);
    if (mode === 'source-revoke') f.service.revokeSource(f.revision(), 'source-a', 2);
    if (mode === 'source-revision') f.put(source({ revision: 2, purposes: ['read', 'learn'], audiences: [A] }));
    if (mode === 'correct' || mode === 'memory-revoke') f.service.reviewMemory(f.revision(), { id: 'memory-a', expectedMemoryRevision: 1,
      principal: 'human', reason: 'review update', action: mode === 'correct' ? 'correct' : 'revoke', ...(mode === 'correct' ? { text: 'NEW SUMMARY' } : {}) }, 101);
    assert.equal(f.service.readPolicy().value.sources[approved.sourceId].status, 'revoked');
    assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 102), /SUMMARY_MATERIAL_STALE/);
  }
});

test('summary resolver checks current raw Code/source facts even if no propagation has run', t => {
  const f = summaryFixture(t); const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 100);
  const row = f.db.prepare('SELECT key,value FROM agent_state').get(); const state = JSON.parse(row.value); state.sources['source-a'].domain = 'code';
  f.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(state), row.key);
  assert.equal(f.service.readPolicy().value.sources[approved.sourceId].status, 'active');
  assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 101), /SUMMARY_MATERIAL_STALE/);
  assert.throws(() => f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 101), /SOURCE_NOT_ALLOWED/);
});

test('summary aliases revoke through corrected ancestors and never acquire learning authority', t => {
  const f = summaryFixture(t); f.add(memory({ id: 'child', text: 'derived reviewed summary', derivedFrom: [{ memoryId: 'memory-a', revision: 1 }] }));
  const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval({ memoryId: 'child' }), 100);
  assert.throws(() => f.service.addMemory(f.revision(), memory({ id: 'laundered', conversationKey: B, sourceRefs: [{ sourceId: approved.sourceId, revision: 1 }] })), /SOURCE_NOT_ALLOWED/);
  f.service.reviewMemory(f.revision(), { id: 'memory-a', expectedMemoryRevision: 1, principal: 'human', reason: 'correct root', action: 'correct', text: 'updated parent' }, 101);
  assert.equal(f.service.readPolicy().value.memories.child.status, 'revoked'); assert.equal(f.service.readPolicy().value.sources[approved.sourceId].status, 'revoked');
  assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 102), /SUMMARY_MATERIAL_STALE/);
});

test('summary approval strict shapes, both CAS revisions, source read purpose and real SQLite faults are atomic', t => {
  const f = summaryFixture(t); const before = f.service.readPolicy();
  assert.throws(() => f.service.approveSummaryMaterial(f.revision() - 1, summaryApproval(), 100), /REVISION_CONFLICT/);
  assert.throws(() => f.service.approveSummaryMaterial(f.revision(), summaryApproval({ expectedMemoryRevision: 2 }), 100), /MEMORY_CONFLICT/);
  for (const patch of [{ extra: true }, { action: 'send' }, { principal: ' ' }, { reason: '' }, { accountId: '../escape' },
    { target: { objectId: null, parentId: null, visibility: 'public', category: null, extra: true } }, { action: 'bili.reply' }]) assert.throws(() => f.service.approveSummaryMaterial(f.revision(), summaryApproval(patch) as never, 100));
  let getterCalls = 0; const accessor = summaryApproval(); Object.defineProperty(accessor, 'reason', { enumerable: true, get() { getterCalls++; return 'never'; } });
  assert.throws(() => f.service.approveSummaryMaterial(f.revision(), accessor, 100)); assert.equal(getterCalls, 0);
  assert.throws(() => f.service.approveSummaryMaterial(f.revision(), { ...summaryApproval(), [Symbol('hidden')]: true }, 100));
  assert.deepEqual(f.service.readPolicy(), before);
  f.db.exec(`CREATE TEMP TRIGGER reject_summary BEFORE UPDATE ON agent_state BEGIN SELECT RAISE(FAIL,'fault'); END`);
  assert.throws(() => f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 100), /STORAGE_FAILURE/); assert.deepEqual(f.service.readPolicy(), before);
  f.db.exec('DROP TRIGGER reject_summary'); const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 100);
  assert.equal(f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 101).revision, 1);
});

test('summary materials persist across real database reopen and remain exact, bounded, and inert at construction', t => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-material-')); const path = join(dir, 'state.db');
  let db = new DatabaseSync(path), store = new SqliteStateStore(db, { namespace: 'summary', initialize: true });
  let service = new PolicyMemory(store, { botId: ID.botId, personaId: ID.personaId }); const rev = () => service.readPolicy().revision;
  service.configure(rev(), { permissions: allowed }); service.putSource(rev(), source({ purposes: ['read', 'learn'], audiences: [A] })); service.addMemory(rev(), memory());
  const approved = service.approveSummaryMaterial(rev(), summaryApproval(), 100); store.close(); db.close();
  db = new DatabaseSync(path); store = new SqliteStateStore(db, { namespace: 'summary' }); service = new PolicyMemory(store, { botId: ID.botId, personaId: ID.personaId });
  t.after(() => { store.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 101).text, memory().text);
  const row = db.prepare('SELECT key,value FROM agent_state').get(); const state = JSON.parse(row.value); const original = state.summaryMaterials[approved.sourceId];
  state.summaryMaterials = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`old-${i}`, original]));
  db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(state), row.key);
  assert.throws(() => service.approveSummaryMaterial(rev(), summaryApproval(), 102), /CAPACITY_EXCEEDED/);
});

test('runtime summary observation validator is strict, read-only and independent of alias purpose or stale propagation', t => {
  const f = summaryFixture(t); const approved = f.service.approveSummaryMaterial(f.revision(), summaryApproval(), 100);
  const before = f.service.readPolicy(); assert.equal(f.service.validateSummarySource(approved.sourceId, B, 1, 101), true);
  assert.equal(f.service.validateSummarySource('source-a', B, 1, 101), false);
  assert.equal(f.service.validateSummarySource(approved.sourceId, B, 2, 101), false);
  assert.equal(f.service.validateSummarySource(approved.sourceId, A, 1, 101), false);
  assert.equal(f.service.validateSummarySource(approved.sourceId, B, 1, 99), false);
  assert.equal(f.service.validateSummarySource(approved.sourceId, B, 1, approved.expiresAt), false);
  assert.deepEqual(f.service.readPolicy(), before);
  const row = f.db.prepare('SELECT key,value FROM agent_state').get();
  for (const patch of [{ status: 'revoked' }, { revision: 2 }, { expiresAt: 101 }, { audiences: [B] }, { purposes: ['learn'] }, { conversationKey: B }]) {
    const state = JSON.parse(row.value); Object.assign(state.sources['source-a'], patch);
    f.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(state), row.key);
    assert.equal(f.service.validateSummarySource(approved.sourceId, B, 1, 101), false);
    assert.throws(() => f.service.resolveSummaryMaterial(approved.sourceId, B, summaryRequest, 101), /SUMMARY_MATERIAL_STALE/);
  }
  f.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(row.value, row.key);
  assert.equal(f.service.validateSummarySource(approved.sourceId, B, 1, 101), true);
});
