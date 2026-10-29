import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createAgentApi } from '../src/api.ts';
import type { AgentAccess, AgentApiDependencies } from '../src/api.ts';
import { AgentError } from '../src/common.ts';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { ConversationLedger } from '../../conversation-v1/src/ledger.ts';
import { BotRuntime } from '../src/runtime.ts';

// Precise domain spies, real WHATWG Requests/Responses. Not a Host-auth or SQLite integration test.
function fixture() {
  const calls: { name: string; args: unknown[] }[] = [];
  let principal: string | null = 'trusted-human';
  let access: AgentAccess = { revision: 1, readKeys: ['key-1'], bodyKeys: ['key-1'], manage: true, review: true, bindingRevisions: { 'key-1': 1 } };
  let nextAccess: AgentAccess | null = null, accessCalls = 0, error: unknown;
  const spy = <T>(name: string, value: T) => (...args: unknown[]): T => { calls.push({ name, args }); if (error) throw error; return value; };
  const profile = { botId: 'bot', personaId: 'persona', mode: 'juejue', name: '撅撅', roleCore: 'SECRET-ROLE' };
  const conversation = { key: 'key-1', label: 'Synthetic stream', identity: { botId: 'bot', personaId: 'persona', connector: 'local-test', issuer: 'local', accountId: 'account', kind: 'group', remoteId: 'group' }, bindingRevision: 1 };
  const event = { conversationKey: 'key-1', bindingRevision: 1, sourceEventId: 'event-1', occurredAt: 1000, eventType: 'message.received', reasonCode: 'NONE', actorId: 'actor', runId: null, causedBy: null, sequence: 1, bodyRef: 1 };
  const work = { id: 'work-1', action: 'bili.comment', stage: 'final-review', version: 1, accountId: 'account', target: { objectId: 'video', parentId: null, visibility: 'public', category: null }, sources: [], assets: [], intention: 'Private intention', brief: null, script: null,
    final: { manifest: { accountId: 'account', target: { objectId: 'video', parentId: null, visibility: 'public', category: null }, title: '', description: '', tags: [], text: 'Final text', video: null, audio: [], subtitles: [], cover: null, attachments: [] } }, approval: null, submission: null, review: null };
  const deps = {
    runtime: { profile, modelConfigured: true, conversations: spy('conversations', [conversation]), scope: spy('scope', {}),
      ledger: { getConversation: spy('ledger.getConversation', { key: 'key-1', identity: conversation.identity, bindingRevision: 1, createdAt: 1, updatedAt: 1 }),
        pageEvents: spy('ledger.pageEvents', [event]), readBody: spy('ledger.readBody', 'SECRET-BODY') },
      memory: { readPolicy: spy('memory.readPolicy', { revision: 2, value: { mode: 'isolated', global: { prompt: 'Style', permissions: {}, typing: {}, expressionRules: [], participation: 0.5 }, locals: {}, sources: { private: 'SECRET-SOURCE' }, memories: { private: 'SECRET-MEMORY' } } }),
        configure: spy('memory.configure', {}), effective: spy('memory.effective', { prompt: 'Style' }), card: spy('memory.card', { items: [{ id: 'memory-1', text: 'SECRET-MEMORY', kind: 'private', status: 'active' }] }) },
      self: { get: spy('self.get', { revision: 4, value: { name: '撅撅' } }), propose: spy('self.propose', {}), freezeSuite: spy('self.freezeSuite', {}), evaluate: spy('self.evaluate', {}), review: spy('self.review', {}), activate: spy('self.activate', {}), restore: spy('self.restore', {}) },
      outbox: { state: spy('outbox.state', { revision: 7, paused: true, pausedAccounts: [] }), setPause: spy('outbox.setPause', undefined), list: spy('outbox.list', [{ id: 'delivery', sequence: 1, kind: 'social', conversation: 'key-1', status: 'queued', dueAt: 1000, reason: 'NONE', body: 'SECRET-OUTBOX', payload: { secret: 'SECRET-PAYLOAD' } }]) },
      learning: spy('learning', [{ id: 'learn-1', key: 'key-1', text: 'Candidate', kind: 'knowledge', status: 'pending', sourceId: 's1', context: { secret: 'SECRET-CONTEXT' } }, { id: 'other', key: 'key-2', text: 'SECRET-OTHER', kind: 'knowledge', status: 'pending', sourceId: 's2' }]),
      reviewLearning: spy('reviewLearning', undefined), revokeSource: spy('revokeSource', undefined), receive: async (...args: unknown[]) => spy('receive', { status: 'queued' })(...args) },
    creation: { list: spy('creation.list', [{ id: 'work-1', revision: 1, action: 'bili.comment', stage: 'final-review', version: 1, readyForReview: true }]), read: spy('creation.read', { revision: 1, value: work }), recoveryAudit: spy('creation.recoveryAudit', []), abandonWorkflow: spy('creation.abandonWorkflow', {}), approve: spy('creation.approve', {}), reject: spy('creation.reject', {}), requestChanges: spy('creation.requestChanges', {}) },
    code: { snapshot: spy('code.snapshot', { revision: 1, value: { enabled: false } }), list: spy('code.list', [{ id: 'code-1', state: 'completed', input: { conversationKey: 'key-1', text: 'SECRET-INPUT' }, authorization: { secret: 'SECRET-AUTH' }, result: 'SECRET-RESULT', resultDelivery: 'ready', reason: 'NONE', createdAt: 1, updatedAt: 2 }]), enable: spy('code.enable', {}), disable: spy('code.disable', {}) },
    resolvePrincipal: async () => principal,
    access: async () => { accessCalls++; return structuredClone(accessCalls > 1 && nextAccess ? nextAccess : access); },
    submitCreation: spy('submitCreation', { intentId: 'intent-1' }),
    now: () => 1000,
  } as unknown as AgentApiDependencies;
  return { deps, calls, work, handle: createAgentApi(deps), principal: (value: string | null) => { principal = value; },
    permissions: (value: Partial<AgentAccess>) => { access = { ...access, ...value }; if (value.readKeys) access.bindingRevisions = Object.fromEntries(Object.entries(access.bindingRevisions ?? {}).filter(([key]) => value.readKeys!.includes(key))); }, revokeOnRecheck: (value: Partial<AgentAccess>) => { nextAccess = { ...access, ...value }; },
    fail: (value: unknown) => { error = value; } };
}
const req = (route: string, init?: RequestInit) => new Request('http://offline.invalid/api/juebot/agent/' + route, init);
const post = (route: string, body: unknown) => req(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const envelope = async (response: Response) => await response.json() as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };

function realMemoryFixture(t: { after(fn: () => void): void }) {
  const f = fixture(); const stateDb = new DatabaseSync(':memory:'), ledgerDb = new DatabaseSync(':memory:');
  const store = new SqliteStateStore(stateDb, { namespace: 'api-memory-test', initialize: true });
  const ledger = new ConversationLedger(ledgerDb, { namespace: 'api-memory-test', initialize: true });
  const profile = { botId: 'bot', personaId: 'persona', name: 'Synthetic', mode: 'juejue' as const, roleCore: 'Synthetic role' };
  const runtime = new BotRuntime(store, ledger, { profile, model: null, now: () => 1000, acceptIngress: () => false, authorizeLearning: () => false,
    participation: key => ({ enabled: false, allowedTargets: [key], deniedTargets: [], timeZoneOffsetMinutes: 0, windows: [], cooldownMs: 0, dailyLimit: 0, unansweredLimit: 0 }) });
  const identity = { botId: 'bot', personaId: 'persona', connector: 'local-test' as const, issuer: 'fixture', accountId: 'account', kind: 'group' as const, remoteId: 'one' };
  const key = runtime.register(identity, 1, 'Synthetic one'), otherKey = runtime.register({ ...identity, remoteId: 'two' }, 1, 'Synthetic two');
  runtime.memory.configure(0, { permissions: { receive: true, save: true, learn: true }, prompt: 'PRIVATE GLOBAL', styleContracts: [{ contractId: 'private', policyText: 'PRIVATE STYLE', counterexamples: ['PRIVATE EXAMPLE'] }] });
  runtime.memory.configure(runtime.memory.readPolicy().revision, { prompt: 'PRIVATE LOCAL' }, key);
  for (const [id, conversationKey] of [['own-source', key], ['OTHER-SOURCE', otherKey]]) runtime.memory.putSource(runtime.memory.readPolicy().revision,
    { id: id!, conversationKey: conversationKey!, revision: 1, domain: 'social', status: 'active', purposes: ['read', 'learn', 'draft'], audiences: [conversationKey!], expiresAt: null });
  runtime.memory.addMemory(runtime.memory.readPolicy().revision, { id: 'derived', revision: 1, conversationKey: key, kind: 'knowledge', text: 'Synthetic retained memory',
    sourceRefs: [{ sourceId: 'own-source', revision: 1 }], derivedFrom: [], sharing: { approved: false, approvedBy: null, ruleRevision: 0, targets: [], purposes: ['read'], expiresAt: null } });
  runtime.self.observe({ botId: 'bot', personaId: 'persona', scope: key }, { eventId: 'own-source', revision: 1, kind: 'external', topic: 'music', interestDelta: 10, feedback: 'interest' });
  f.deps.runtime = runtime; f.permissions({ readKeys: [key], bodyKeys: [key], bindingRevisions: { [key]: 1 } });
  t.after(() => { runtime.close(); store.close(); stateDb.close(); ledgerDb.close(); });
  return { ...f, runtime, ledger, store, key, otherKey, identity };
}

test('real SQLite memory source management stays scoped and revokes derived memory plus self evidence', async t => {
  const f = realMemoryFixture(t); const query = 'memory?key=' + encodeURIComponent(f.key);
  const read = await envelope(await f.handle(req(query))); const data = read.data!;
  assert.equal(data.policyRevision, f.runtime.memory.readPolicy().revision); assert.equal(data.canManageSources, true);
  assert.deepEqual(data.sources, [{ id: 'own-source', revision: 1, domain: 'social', status: 'active', purposes: ['read', 'learn', 'draft'], expiresAt: null }]);
  assert.equal(JSON.stringify(data).includes('OTHER-SOURCE'), false);
  const revision = f.runtime.memory.readPolicy().revision;
  assert.equal((await f.handle(post('memory', { key: f.key, action: 'revoke-source', sourceId: 'OTHER-SOURCE', expectedPolicyRevision: revision, nextSourceRevision: 2 }))).status, 403);
  assert.equal(f.runtime.memory.readPolicy().revision, revision);
  assert.equal((await f.handle(post('memory', { key: f.key, action: 'revoke-source', sourceId: 'own-source', expectedPolicyRevision: revision - 1, nextSourceRevision: 2 }))).status, 409);
  const result = await f.handle(post('memory', { key: f.key, action: 'revoke-source', sourceId: 'own-source', expectedPolicyRevision: revision, nextSourceRevision: 2 }));
  assert.equal(result.status, 200); assert.equal(f.runtime.memory.card(f.key, 1000).items.length, 0);
  assert.equal(f.runtime.memory.readPolicy().value.sources['OTHER-SOURCE']!.status, 'active');
  assert.equal(f.runtime.self.get({ botId: 'bot', personaId: 'persona', scope: f.key }).value.evidence['own-source']!.revoked, true);
});

test('memory management rejects missing rights, sharing fields and permission revocation before source reads', async () => {
  const body = { key: 'key-1', action: 'revoke-source', sourceId: 'own-source', expectedPolicyRevision: 1, nextSourceRevision: 2 };
  for (const permissions of [{ manage: false }, { bodyKeys: [] }, { bindingRevisions: {} }]) {
    const f = fixture(); f.permissions(permissions); assert.equal((await f.handle(post('memory', body))).status, 403); assert.equal(f.calls.length, 0);
  }
  const revoked = fixture(); revoked.revokeOnRecheck({ manage: false });
  assert.equal((await revoked.handle(post('memory', body))).status, 403); assert.equal(revoked.calls.length, 0);
  for (const extra of [{ sharing: { approved: true } }, { audiences: ['key-2'] }, { purposes: ['publish'] }, { principal: 'owner' }]) {
    const f = fixture(); assert.equal((await f.handle(post('memory', { ...body, ...extra }))).status, 400); assert.equal(f.calls.length, 0);
  }
});

test('metadata-only rights cannot read private settings and old binding grants cannot read new bindings', async t => {
  const f = realMemoryFixture(t); f.permissions({ manage: false, review: false, bodyKeys: [] });
  const hidden = await f.handle(req('settings?key=' + encodeURIComponent(f.key))); assert.equal(hidden.status, 403); assert.equal((await hidden.text()).includes('PRIVATE'), false);
  f.permissions({ manage: true, review: true, bodyKeys: [f.key] });
  f.ledger.changeBinding(f.key, 1, 2, 1001);
  f.store.atomic(tx => { const current = tx.read<{ items: { key: string; bindingRevision: number }[] }>('runtime:catalog')!;
    current.value.items.find(item => item.key === f.key)!.bindingRevision = 2; tx.write('runtime:catalog', current.revision, current.value); });
  for (const route of ['events', 'settings', 'memory', 'self', 'growth']) {
    const result = await f.handle(req(route + '?key=' + encodeURIComponent(f.key))); assert.equal(result.status, 409, route);
    assert.equal((await result.text()).includes('PRIVATE'), false);
  }
  assert.equal((await f.handle(post('memory', { key: f.key, action: 'revoke-source', sourceId: 'own-source', expectedPolicyRevision: f.runtime.memory.readPolicy().revision, nextSourceRevision: 2 }))).status, 409);
  assert.equal(f.runtime.memory.readPolicy().value.sources['own-source']!.status, 'active');
  f.permissions({ bindingRevisions: { [f.key]: 2 } }); assert.equal((await f.handle(req('memory?key=' + encodeURIComponent(f.key)))).status, 200);
});

test('binding grants are mandatory and full binding snapshot changes revoke a pending read', async () => {
  const f = fixture(); f.permissions({ bindingRevisions: undefined }); assert.equal((await f.handle(req('memory?key=key-1'))).status, 403); assert.equal(f.calls.length, 0);
  const g = fixture(); g.revokeOnRecheck({ bindingRevisions: { 'key-1': 2 } }); assert.equal((await g.handle(req('memory?key=key-1'))).status, 403);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) { const h = fixture(); h.permissions({ bindingRevisions: { 'key-1': value } }); assert.equal((await h.handle(req('status'))).status, 400); assert.equal(h.calls.length, 0); }
});

test('manager sees only creation Outbox metadata tied to an actual saved submission', async () => {
  const f = fixture(); f.permissions({ readKeys: [], bodyKeys: [] });
  (f.work as unknown as { submission: unknown }).submission = { intentId: 'creation-intent' };
  f.deps.runtime.outbox.list = () => [{ id: 'creation-intent', kind: 'creation', conversation: 'publication:account', sequence: 1, status: 'unknown', dueAt: 1, reason: 'UNKNOWN', payload: { workId: 'work-1', text: 'PRIVATE BODY' }, body: 'PRIVATE BODY' },
    { id: 'forged', kind: 'creation', conversation: 'publication:account', payload: { workId: 'work-1' }, body: 'PRIVATE BODY' }] as never;
  const result = await envelope(await f.handle(req('outbox'))); const value = result.data!.items as { id: string }[];
  assert.equal(value.length, 1); assert.equal(value[0]!.id, 'creation-intent'); assert.equal(JSON.stringify(result).includes('PRIVATE BODY'), false);
});

test('unauthenticated and denied reads never call domain/storage despite forged owner claims', async () => {
  const f = fixture(); f.principal(null);
  assert.equal((await f.handle(req('outbox', { headers: { 'x-role': 'owner' } }))).status, 401); assert.equal(f.calls.length, 0);
  for (const route of ['body?key=key-1&sequence=1', 'memory?key=key-1', 'self?key=key-1', 'events?key=key-1', 'creation?id=work-1', 'outbox', 'code', 'identity', 'learning', 'growth']) {
    const f = fixture(); f.permissions({ readKeys: [], bodyKeys: [], manage: false, review: false });
    assert.equal((await f.handle(req(route))).status, 403, route); assert.equal(f.calls.length, 0, route);
  }
});

test('metadata and body rights are independent; denied body does not call body SQL', async () => {
  const f = fixture(); f.permissions({ bodyKeys: [] });
  assert.equal((await f.handle(req('events?key=key-1'))).status, 200);
  assert.equal(f.calls.some(call => call.name === 'ledger.readBody'), false);
  const result = await f.handle(req('body?key=key-1&sequence=1')); assert.equal(result.status, 403);
  assert.equal(f.calls.some(call => call.name === 'ledger.readBody'), false);
});

test('full access snapshot is rechecked after reads and after async JSON before management writes', async () => {
  const f = fixture(); f.revokeOnRecheck({ revision: 2, bodyKeys: [] });
  const response = await f.handle(req('body?key=key-1&sequence=1'));
  assert.equal(response.status, 403); assert.equal((await response.text()).includes('SECRET-BODY'), false);
  const g = fixture(); g.revokeOnRecheck({ manage: false });
  assert.equal((await g.handle(post('code', { enabled: false }))).status, 403);
  assert.equal(g.calls.length, 0);
});

test('read routes expose the UI projections and strip sources/private payload from configuration/logs', async () => {
  for (const route of ['status', 'conversations', 'events?key=key-1&limit=1', 'body?key=key-1&sequence=1', 'settings?key=key-1', 'memory?key=key-1', 'self?key=key-1', 'creations', 'creation?id=work-1', 'outbox', 'code', 'learning', 'growth?key=key-1']) {
    const f = fixture(); const response = await f.handle(req(route)); assert.equal(response.status, 200, route);
    const text = await response.text(); assert.equal(JSON.parse(text).ok, true);
    for (const secret of ['SECRET-SOURCE', 'SECRET-PAYLOAD', 'SECRET-OUTBOX', 'SECRET-AUTH', 'SECRET-INPUT', 'SECRET-RESULT', 'SECRET-OTHER', 'SECRET-CONTEXT']) assert.equal(text.includes(secret), false, route + secret);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('strict query rejects unknown/duplicate/oversize and noncanonical numeric arguments', async () => {
  for (const route of ['events?key=key-1&key=key-1', 'events?key=key-1&%6bey=key-1', 'events?key=key-1&owner=true', 'events?key=key-1&limit=01', 'events?key=key-1&limit=101',
    'body?key=key-1&sequence=1e1', 'body?key=key-1&sequence=9007199254740992', 'body?key=key-1&sequence=0', 'conversations?cursor=x', 'events?key=%0a',
    'events?key=' + 'x'.repeat(4097), 'events?key=key-1&cursor=' + 'x'.repeat(8193), 'events?key=key-1&cursor=' + '%78'.repeat(12000)]) {
    const f = fixture(); assert.equal((await f.handle(req(route))).status, 400, route.slice(0, 100)); assert.equal(f.calls.length, 0);
  }
});

test('bounded streaming JSON rejects bad UTF8, inflated lengths, encodings and forged actor fields', async () => {
  const bodies: Request[] = [req('code', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } }),
    req('code', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
    req('code', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'content-length': '99999' } }),
    req('code', { method: 'POST', body: new Uint8Array([0xff]), headers: { 'content-type': 'application/json' } }),
    post('review', { id: 'work-1', expectedRevision: 1, action: 'approve', expiresAt: 2000, human: true }), post('code', { enabled: true, principal: 'owner' })];
  for (const request of bodies) { const f = fixture(); assert.equal((await f.handle(request)).status, 400); assert.equal(f.calls.length, 0); }
  let cancelled = false; const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(40000)); c.enqueue(new Uint8Array(40000)); }, cancel() { cancelled = true; } });
  const f = fixture(); assert.equal((await f.handle(req('code', { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json', 'content-length': '2' } } as RequestInit))).status, 400);
  assert.equal(cancelled, true); assert.equal(body.locked, false); assert.equal(f.calls.length, 0);
});

test('management/review calls use the resolver principal, and reviewer ACL alone cannot become manage', async () => {
  const f = fixture();
  assert.equal((await f.handle(post('review', { id: 'work-1', expectedRevision: 1, action: 'approve', expiresAt: 2000 }))).status, 200);
  assert.deepEqual(f.calls.find(call => call.name === 'creation.approve')!.args, ['work-1', 1, 'trusted-human', 2000]);
  const g = fixture(); g.permissions({ review: false });
  assert.equal((await g.handle(post('review', { id: 'work-1', expectedRevision: 1, action: 'approve', expiresAt: 2000 }))).status, 403); assert.equal(g.calls.length, 0);
  const h = fixture(); h.permissions({ manage: false, review: true });
  assert.equal((await h.handle(post('submit', { id: 'work-1', expectedRevision: 1 }))).status, 403); assert.equal(h.calls.length, 0);
});

test('human recovery and abandon use only authenticated principal, exact CAS and a required bounded reason', async () => {
  const f = fixture(); let recovered: unknown[] = [];
  f.deps.recoverCreation = async (...args) => { recovered = args; return { status: 'ready' }; };
  assert.equal((await f.handle(post('creation-recovery', { id: 'work-1', expectedRevision: 1, action: 'recover', reason: 'Resume local work' }))).status, 200);
  assert.deepEqual(recovered.slice(0, 4), ['work-1', 1, 'trusted-human', 'Resume local work']); assert.equal(typeof recovered[4], 'function');
  const g = fixture();
  assert.equal((await g.handle(post('creation-recovery', { id: 'work-1', expectedRevision: 1, action: 'abandon', reason: 'Discard attempt' }))).status, 200);
  assert.deepEqual(g.calls.find(call => call.name === 'creation.abandonWorkflow')!.args, ['work-1', 1, 'trusted-human', 'Discard attempt']);
  for (const body of [{ reason: '' }, { reason: 'x'.repeat(4001) }, { principal: 'forged' }, { approved: true }, { action: 'submit' }]) {
    const h = fixture();
    assert.equal((await h.handle(post('creation-recovery', { id: 'work-1', expectedRevision: 1, action: 'recover', reason: 'Resume', ...body }))).status, 400);
    assert.equal(h.calls.length, 0);
  }
  const missing = fixture();
  assert.deepEqual(await envelope(await missing.handle(post('creation-recovery', { id: 'work-1', expectedRevision: 1, action: 'recover', reason: 'Resume' }))), { ok: false, error: { code: 'NOT_CONFIGURED' } });
});

test('recovery/reconciliation require manage and review, recheck after JSON, and withhold late revoked results', async () => {
  for (const route of ['creation-recovery', 'reconcile']) {
    const body = route === 'reconcile' ? { id: 'delivery', expectedRevision: 7 } : { id: 'work-1', expectedRevision: 1, action: 'recover', reason: 'Resume' };
    for (const permission of [{ manage: false }, { review: false }]) {
      const f = fixture(); f.permissions(permission);
      assert.equal((await f.handle(post(route, body))).status, 403); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); f.revokeOnRecheck({ review: false });
    assert.equal((await f.handle(post(route, body))).status, 403); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); let finish!: () => void;
  f.deps.recoverCreation = async () => new Promise(resolve => { finish = () => resolve({ private: 'LATE_PRIVATE_RESULT' }); });
  const pending = f.handle(post('creation-recovery', { id: 'work-1', expectedRevision: 1, action: 'recover', reason: 'Resume' }));
  for (let i = 0; i < 30 && !finish; i++) await Promise.resolve();
  assert.ok(finish); f.permissions({ review: false, revision: 2 }); finish();
  const response = await pending; assert.equal(response.status, 403); assert.equal((await response.text()).includes('LATE_PRIVATE_RESULT'), false);
});

test('reconcile accepts only an unknown visible delivery id/CAS and never a client conclusion or proof', async () => {
  const f = fixture(); const item = { ...f.deps.runtime.outbox.list()[0]!, status: 'unknown' as const };
  f.deps.runtime.outbox.list = () => [item]; let called: unknown[] = [];
  f.deps.reconcileDelivery = async (...args) => { called = args; return { status: 'unknown' }; };
  assert.equal((await f.handle(post('reconcile', { id: 'delivery', expectedRevision: 7 }))).status, 200);
  assert.deepEqual(called.slice(0, 3), ['delivery', 7, 'trusted-human']); assert.equal(typeof called[3], 'function');
  for (const forged of [{ outcome: 'confirmed' }, { status: 'failed' }, { proof: 'operator-says-so' }, { account: 'other' }]) {
    called = []; assert.equal((await f.handle(post('reconcile', { id: 'delivery', expectedRevision: 7, ...forged }))).status, 400); assert.deepEqual(called, []);
  }
  f.deps.runtime.outbox.list = () => [{ ...item, status: 'queued' }];
  assert.equal((await f.handle(post('reconcile', { id: 'delivery', expectedRevision: 7 }))).status, 409);
  f.deps.runtime.outbox.list = () => [item]; item.conversation = 'unreadable-stream';
  assert.equal((await f.handle(post('reconcile', { id: 'delivery', expectedRevision: 7 }))).status, 403);
  const missing = fixture();
  assert.deepEqual(await envelope(await missing.handle(post('reconcile', { id: 'delivery', expectedRevision: 7 }))), { ok: false, error: { code: 'NOT_CONFIGURED' } });
});

test('creation recovery audit is manager-only and outbox CAS projection strips provider/private payload', async () => {
  const f = fixture(); f.deps.creation.recoveryAudit = () => [{ decision: 'recover', principal: 'trusted-human', reason: 'Resume', at: 1, fromRevision: 1, phase: 'planning' }];
  const result = await envelope(await f.handle(req('creation?id=work-1')));
  assert.equal((result.data!.recoveryAudit as unknown[]).length, 1);
  const log = await envelope(await f.handle(req('outbox'))); assert.equal(log.data!.revision, 7);
  assert.equal(JSON.stringify(log).includes('SECRET'), false);
  const denied = fixture(); denied.permissions({ manage: false });
  assert.equal((await denied.handle(req('creation?id=work-1'))).status, 403); assert.equal(denied.calls.length, 0);
});

test('async recovery and reconcile receive a commit guard that blocks effects after permission revocation', async () => {
  for (const route of ['creation-recovery', 'reconcile']) {
    const f = fixture(); let finish!: () => void, commits = 0;
    const operation = async (guard?: () => Promise<void>) => {
      await new Promise<void>(resolve => { finish = resolve; }); await guard!(); commits++; return {};
    };
    f.deps.recoverCreation = async (_id, _revision, _principal, _reason, guard) => operation(guard);
    f.deps.reconcileDelivery = async (_id, _revision, _principal, guard) => operation(guard);
    const item = { ...f.deps.runtime.outbox.list()[0]!, status: 'unknown' as const }; f.deps.runtime.outbox.list = () => [item];
    const body = route === 'reconcile' ? { id: 'delivery', expectedRevision: 7 } : { id: 'work-1', expectedRevision: 1, action: 'recover', reason: 'Resume' };
    const pending = f.handle(post(route, body));
    for (let i = 0; i < 30 && !finish; i++) await Promise.resolve();
    assert.ok(finish); f.permissions({ revision: 2, review: false }); finish();
    assert.equal((await pending).status, 403); assert.equal(commits, 0);
  }
});

test('settings, pause, Code and learning writes have strict fields and no network/executor', async () => {
  for (const [route, body, method] of [['settings', { key: 'key-1', expectedRevision: 2, patch: { prompt: 'Updated' } }, 'memory.configure'],
    ['pause', { expectedRevision: 7, paused: true }, 'outbox.setPause'], ['code', { enabled: false }, 'code.disable'],
    ['learning', { id: 'learn-1', accepted: false }, 'reviewLearning']] as const) {
    const f = fixture(); assert.equal((await f.handle(post(route, body))).status, 200); assert.ok(f.calls.some(call => call.name === method));
  }
  const missing = fixture(); assert.equal((await missing.handle(req('identity'))).status, 503);
});

test('local messages only enter a configured local-test stream, with generated event identity and actual principal', async () => {
  const f = fixture(); const result = await f.handle(post('local-message', { key: 'key-1', text: 'Synthetic local input' })); assert.equal(result.status, 200);
  const input = f.calls.find(call => call.name === 'receive')!.args[0] as { actor: string; eventId: string };
  assert.equal(input.actor, 'trusted-human'); assert.match(input.eventId, /^local-1000-1$/);
  const g = fixture(); (g.deps.runtime as unknown as { conversations(): unknown[] }).conversations = () => [{ key: 'key-1', identity: { connector: 'qq-personal' }, bindingRevision: 1 }];
  assert.equal((await g.handle(post('local-message', { key: 'key-1', text: 'No external message' }))).status, 403);
  assert.equal(g.calls.some(call => call.name === 'receive'), false);
});

test('growth exposes a fixed command union; client cannot forge reviewer identity', async () => {
  const f = fixture();
  assert.equal((await f.handle(post('growth', { key: 'key-1', command: 'review', id: 'candidate', expectedRevision: 1, accepted: true }))).status, 200);
  const args = f.calls.find(call => call.name === 'self.review')!.args;
  assert.deepEqual(args[3], { reviewer: 'trusted-human', human: true, approve: true });
  const g = fixture(); assert.equal((await g.handle(post('growth', { key: 'key-1', command: 'execute', source: 'model' }))).status, 400);
  assert.equal(g.calls.some(call => call.name.startsWith('self.')), false);
});

test('controlled media verifies frozen-work membership, current hash, MIME and full permission snapshot', async () => {
  const f = fixture(); const bytes = new TextEncoder().encode('WEBVTT\n\nSynthetic subtitles'); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset = { ref: 'asset_ref', previewRef: 'preview_ref', sha256, kind: 'subtitles' as const, ready: true };
  f.work.final.manifest.subtitles.push(asset as never);
  f.deps.assets = { read: preview => { assert.equal(preview, 'preview_ref'); return { asset, bytes, mime: 'text/vtt' }; }, resolve: () => asset };
  const result = await f.handle(req('media?ref=preview_ref')); assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'text/vtt'); assert.equal(await result.text(), new TextDecoder().decode(bytes));
  assert.equal((await f.handle(req('media?ref=unknown'))).status, 403);
  assert.equal((await f.handle(req('media?ref=C%3A%5Cprivate'))).status, 400);
  f.deps.assets.read = () => ({ asset, bytes: new TextEncoder().encode('tampered'), mime: 'text/vtt' });
  const tampered = await f.handle(req('media?ref=preview_ref')); assert.equal(tampered.status, 503); assert.equal((await tampered.text()).includes('tampered'), false);
});

test('media permission revocation during the digest blocks bytes and stalled POST cancellation releases the stream', async () => {
  const f = fixture(); const bytes = new TextEncoder().encode('WEBVTT\n');
  const asset = { ref: 'asset_ref', previewRef: 'preview_ref', sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'subtitles' as const, ready: true };
  f.work.final.manifest.subtitles.push(asset as never);
  f.deps.assets = { resolve: () => asset, read: () => ({ bytes, mime: 'text/vtt', asset }) };
  f.revokeOnRecheck({ review: false });
  const result = await f.handle(req('media?ref=preview_ref')); assert.equal(result.status, 403); assert.equal((await result.text()).includes('WEBVTT'), false);
  const g = fixture(); let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } }); const controller = new AbortController();
  const pending = g.handle(req('code', { method: 'POST', body, signal: controller.signal, duplex: 'half', headers: { 'content-type': 'application/json' } } as RequestInit));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
  assert.equal(cancelled, true); assert.equal(body.locked, false); assert.equal(g.calls.length, 0);
});

test('identity provider and six growth commands receive exact validated management arguments', async () => {
  const f = fixture(); let profile = f.deps.runtime.profile;
  f.deps.identity = { read: () => ({ revision: 2, profile }), write: (revision, input) => { assert.equal(revision, 1); profile = input; } };
  const update = { ...profile, name: 'New identity' };
  assert.equal((await f.handle(post('identity', { expectedRevision: 1, profile: update }))).status, 200);
  assert.equal(profile.name, 'New identity');
  for (const [body, method] of [
    [{ key: 'key-1', command: 'propose', id: 'candidate', adaptation: { warmth: 50, curiosity: 50, initiative: 50 }, sources: [{ eventId: 'event', revision: 1 }] }, 'self.propose'],
    [{ key: 'key-1', command: 'freeze', suite: { id: 'suite', version: 1, checks: [{ id: 'check', required: true }] } }, 'self.freezeSuite'],
    [{ key: 'key-1', command: 'activate', id: 'candidate', expectedCandidateRevision: 2, expectedStateRevision: 1 }, 'self.activate'],
    [{ key: 'key-1', command: 'restore', version: 'baseline', expectedStateRevision: 1 }, 'self.restore'],
  ] as const) {
    const g = fixture(); assert.equal((await g.handle(post('growth', body))).status, 200); assert.ok(g.calls.some(call => call.name === method));
  }
  const g = fixture();
  assert.equal((await g.handle(post('growth', { key: 'key-1', command: 'review', id: 'candidate', expectedRevision: 1, accepted: true, human: true, reviewer: 'forged' }))).status, 400);
  assert.equal(g.calls.some(call => call.name === 'self.review'), false);
});

test('identity POST commits to real SQLite and returns 200 when its own switch changes stream grants, exposing only identity fields', async t => {
  const f = realMemoryFixture(t);
  const initial = f.store.atomic(tx => tx.write('api-test:identity', 0, f.runtime.profile));
  let writes = 0;
  f.deps.identity = {
    read: () => {
      const saved = f.store.read<typeof initial.value>('api-test:identity')!;
      return { revision: saved.revision, profile: { ...saved.value, body: 'PRIVATE-CONVERSATION-BODY' },
        profiles: { persona: { ...saved.value, body: 'PRIVATE-PROFILE-EXTRA' } }, bodies: ['PRIVATE-CONVERSATION-BODY'], bindingRevisions: { secret: 99 } };
    },
    write: (revision, profile) => {
      writes++; f.store.atomic(tx => tx.write('api-test:identity', revision, profile));
      f.permissions({ revision: 2, readKeys: [f.otherKey], bodyKeys: [f.otherKey], bindingRevisions: { [f.otherKey]: 1 } });
    },
  };
  const updated = { ...initial.value, mode: 'persona' as const, name: 'Alternate identity', roleCore: 'Saved alternate core' };
  const response = await f.handle(post('identity', { expectedRevision: initial.revision, profile: updated }));
  assert.equal(response.status, 200); const result = await envelope(response);
  assert.deepEqual(result.data, { revision: 2, profile: updated, profiles: { persona: updated } });
  assert.deepEqual(f.store.read('api-test:identity')!.value, updated); assert.equal(writes, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(f.calls.some(call => call.name === 'ledger.readBody'), false);
});

test('identity POST retains strict prewrite recheck and rejects postwrite management revocation without returning the identity', async () => {
  for (const boundary of ['before', 'after']) {
    const f = fixture(); let writes = 0;
    const profile = { ...f.deps.runtime.profile, roleCore: 'PRIVATE-UPDATED-CORE' };
    f.deps.identity = { read: () => ({ revision: 2, profile }), write: () => {
      writes++; if (boundary === 'after') f.permissions({ revision: 2, manage: false });
    } };
    if (boundary === 'before') f.revokeOnRecheck({ revision: 2, manage: false });
    const result = await f.handle(post('identity', { expectedRevision: 1, profile }));
    assert.equal(result.status, 403); assert.equal(writes, boundary === 'before' ? 0 : 1);
    assert.deepEqual(await envelope(result), { ok: false, error: { code: 'ACCESS_CHANGED' } });
  }
  const f = fixture(); let writes = 0;
  f.deps.identity = { read: () => ({ revision: 2, profile: f.deps.runtime.profile }), write: () => { writes++; } };
  f.revokeOnRecheck({ revision: 2, readKeys: [], bodyKeys: [], bindingRevisions: {} });
  assert.equal((await f.handle(post('identity', { expectedRevision: 1, profile: f.deps.runtime.profile }))).status, 403);
  assert.equal(writes, 0, 'even grant-only changes before writing must still fail the full access check');
});

test('the identity POST grant exception does not weaken identity GET or other management POST rechecks', async () => {
  const f = fixture();
  f.deps.identity = { read: () => {
    f.permissions({ revision: 2, readKeys: [], bodyKeys: [], bindingRevisions: {} });
    return { revision: 1, profile: { ...f.deps.runtime.profile, roleCore: 'PRIVATE-IDENTITY-READ' } };
  }, write: () => assert.fail('GET cannot write') };
  const read = await f.handle(req('identity')); assert.equal(read.status, 403); assert.equal((await read.text()).includes('PRIVATE-IDENTITY-READ'), false);
  const g = fixture(); let writes = 0;
  g.deps.code.disable = () => { writes++; g.permissions({ revision: 2, readKeys: [], bodyKeys: [], bindingRevisions: {} }); return g.deps.code.snapshot(); };
  const other = await g.handle(post('code', { enabled: false }));
  assert.equal(other.status, 403); assert.equal(writes, 1);
  assert.deepEqual(await envelope(other), { ok: false, error: { code: 'ACCESS_CHANGED' } });
});

test('errors never leak raw SQL/paths/body and cancellation cannot return a success response', async () => {
  for (const error of [new Error('SECRET SQL /private/path'), { code: 'ACCESS_DENIED', secret: 'SECRET' }, new AgentError('SECRET_PRIVATE_CONTENT')]) {
    const f = fixture(); f.fail(error); const result = await f.handle(req('conversations')); assert.equal(result.status, 503);
    assert.deepEqual(await envelope(result), { ok: false, error: { code: 'AGENT_OPERATION_FAILED' } });
  }
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.handle(req('status', { signal: controller.signal })), { name: 'AbortError' }); assert.equal(f.calls.length, 0);
  const g = fixture(); const abort = new AbortController(); g.deps.access = async () => { abort.abort(); return { revision: 1, readKeys: [], bodyKeys: [], manage: false, review: false }; };
  await assert.rejects(g.handle(req('status', { signal: abort.signal })), { name: 'AbortError' }); assert.equal(g.calls.length, 0);
  const h = fixture(); const pendingAuth = new AbortController();
  h.deps.resolvePrincipal = async () => new Promise(() => {});
  const pending = h.handle(req('status', { signal: pendingAuth.signal }));
  const rejected = assert.rejects(pending, { name: 'AbortError' }); pendingAuth.abort(); await rejected;
  assert.equal(h.calls.length, 0);
});


test('growth evaluation comes only from the configured trusted evaluator and rechecks its commit', async () => {
  const f = fixture(), body = { key: 'key-1', command: 'evaluate', id: 'candidate', expectedRevision: 1 };
  assert.equal((await f.handle(post('growth', body))).status, 503);
  let calls = 0;
  f.deps.evaluateGrowth = async (input, principal, guard) => { assert.deepEqual(input, { key: 'key-1', id: 'candidate', expectedRevision: 1 }); assert.equal(principal, 'trusted-human'); await guard!(); calls++; return {}; };
  assert.equal((await f.handle(post('growth', { ...body, evaluation: { candidate: { safety: 'pass' } } }))).status, 400);
  assert.equal((await f.handle(post('growth', body))).status, 200); assert.equal(calls, 1);
});

test('real API approves exact memory summary across streams without changing raw-source audiences; CAS, correction and revocation invalidate use', async t => {
  const f = realMemoryFixture(t), m = f.runtime.memory, revision = () => m.readPolicy().revision;
  f.permissions({ readKeys: [f.key, f.otherKey], bindingRevisions: { [f.key]: 1, [f.otherKey]: 1 } });
  m.configure(revision(), { mode: 'shared', permissions: { reply: true } });
  const get = () => m.retrieve({ conversationKey: f.otherKey, purpose: 'draft', query: '', now: 1000 });
  assert.equal(get().items.length, 0);
  const share = { key: f.key, action: 'share', id: 'derived', expectedPolicyRevision: revision(), expectedMemoryRevision: 1, reason: 'Approved generic summary only', targets: [f.otherKey], purposes: ['read', 'draft'], expiresAt: 2000 };
  assert.equal((await f.handle(post('memory', { ...share, principal: 'forged' }))).status, 400);
  assert.equal((await f.handle(post('memory', share))).status, 200);
  const ticket = get(); assert.equal(ticket.items[0]!.text, 'Synthetic retained memory');
  assert.deepEqual(m.readPolicy().value.sources['own-source']!.audiences, [f.key]);
  assert.equal(m.readPolicy().value.summaryApprovals!.derived!.principal, 'trusted-human');
  assert.equal((await f.handle(post('memory', share))).status, 409);
  const correct = { key: f.key, action: 'correct', id: 'derived', expectedPolicyRevision: revision(), expectedMemoryRevision: 2, reason: 'Correction requires another review', text: 'Corrected summary' };
  assert.equal((await f.handle(post('memory', correct))).status, 200); assert.equal(get().items.length, 0);
  assert.throws(() => m.validateTicket(ticket, 1000));
  assert.equal((await f.handle(post('memory', { ...share, expectedPolicyRevision: revision(), expectedMemoryRevision: 3 }))).status, 200);
  f.runtime.revokeSource('own-source', revision(), 2); assert.equal(get().items.length, 0);
  assert.equal(m.readPolicy().value.memoryReviews!.length, 3);
});

test('memory review requires human review and both origin body plus target stream grants; private summary needs explicit inclusion', async t => {
  const f = realMemoryFixture(t), m = f.runtime.memory, rev = () => m.readPolicy().revision;
  const { status, ...original } = m.readPolicy().value.memories.derived!;
  m.addMemory(rev(), { ...original, id: 'private', kind: 'private' });
  const share = () => ({ key: f.key, action: 'share', id: 'private', expectedPolicyRevision: rev(), expectedMemoryRevision: 1, reason: 'One approved fact', targets: [f.otherKey], purposes: ['read'], expiresAt: 2000 });
  assert.equal((await f.handle(post('memory', share()))).status, 403);
  f.permissions({ readKeys: [f.key, f.otherKey], bindingRevisions: { [f.key]: 1, [f.otherKey]: 1 }, review: false });
  assert.equal((await f.handle(post('memory', share()))).status, 403);
  f.permissions({ review: true });
  assert.equal((await f.handle(post('memory', share()))).status, 403);
  assert.equal((await f.handle(post('memory', { ...share(), includePrivate: true }))).status, 200);
  const saved = rev(); f.permissions({ bodyKeys: [] });
  assert.equal((await f.handle(post('memory', { key: f.key, action: 'revoke', id: 'private', expectedPolicyRevision: saved, expectedMemoryRevision: 2, reason: 'Withdraw' }))).status, 403);
  assert.equal(rev(), saved);
});


test('catalog search pages only authorized metadata and trace requires current body grant', async t => {
  const f = realMemoryFixture(t);
  let result = await envelope(await f.handle(req('conversations?q=one&offset=0&limit=1')));
  assert.equal(result.data!.total, 1); assert.equal((result.data!.items as { key: string }[])[0]!.key, f.key);
  result = await envelope(await f.handle(req('conversations?q=two'))); assert.equal(result.data!.total, 0);
  assert.equal((await f.handle(req('conversations?offset=01'))).status, 400);
  f.permissions({ bodyKeys: [] }); assert.equal((await f.handle(req('trace?key=' + encodeURIComponent(f.key)))).status, 403);
  f.permissions({ bodyKeys: [f.key] }); assert.equal((await f.handle(req('trace?key=' + encodeURIComponent(f.key)))).status, 200);
});

test('creation start receives authenticated principal, exact target and late commit guard; it cannot self-approve', async () => {
  const f = fixture(), body = { key: 'key-1', intentionId: 'intent', action: 'bili.comment', accountId: 'account', target: { objectId: 'BV', parentId: null, visibility: 'public', category: null } };
  let called = 0; f.deps.startCreation = async (key, id, request, principal, guard) => { assert.equal(key, 'key-1'); assert.equal(id, 'intent'); assert.equal(principal, 'trusted-human'); assert.equal(request.target.objectId, 'BV'); await guard!(); called++; return { stage: 'final-review' }; };
  assert.equal((await f.handle(post('creation-start', { ...body, approved: true }))).status, 400);
  assert.equal((await f.handle(post('creation-start', body))).status, 200); assert.equal(called, 1);
  f.permissions({ bodyKeys: [] }); assert.equal((await f.handle(post('creation-start', body))).status, 403); assert.equal(called, 1);
});


test('summary creation requires current human review/body rights and injects principal without opening raw sources', async t => {
  const f = realMemoryFixture(t), body = { key: f.key, memoryId: 'derived', expectedMemoryRevision: 1, expectedPolicyRevision: f.runtime.memory.readPolicy().revision,
    reason: 'Only this summary for one public target', expiresAt: 2000, request: { action: 'bili.comment', accountId: 'account', target: { objectId: 'video', parentId: null, visibility: 'public', category: null } } };
  let calls = 0;
  f.deps.prepareSummaryCreation = async (key, input, principal, guard) => { assert.equal(key, f.key); assert.equal(principal, 'trusted-human'); assert.equal(input.memoryId, 'derived'); await guard!(); calls++; return { decision: { choice: 'reply' } }; };
  assert.equal((await f.handle(post('summary-creation', { ...body, principal: 'forged' }))).status, 400);
  assert.equal((await f.handle(post('summary-creation', body))).status, 200); assert.equal(calls, 1);
  assert.deepEqual(f.runtime.memory.readPolicy().value.sources['own-source']!.purposes, ['read', 'learn', 'draft']);
  f.permissions({ review: false }); assert.equal((await f.handle(post('summary-creation', body))).status, 403);
  f.permissions({ review: true, bodyKeys: [] }); assert.equal((await f.handle(post('summary-creation', body))).status, 403); assert.equal(calls, 1);
});
