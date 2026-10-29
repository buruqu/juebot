import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ConversationLedger } from '../src/ledger.ts';
import { ConversationReadService } from '../src/read-service.ts';
import { createConversationHttp } from '../src/http.ts';
import type { AccessSnapshot, EventInput } from '../src/contracts.ts';

function setup(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:', { allowExtension: false }); t.after(() => db.close());
  const ledger = new ConversationLedger(db, { namespace: 'integration-fixture', initialize: true });
  const identity = { botId: 'bot', personaId: 'persona', connector: 'qq-official' as const,
    issuer: 'synthetic-app-A', accountId: 'synthetic-account', kind: 'direct' as const, remoteId: 'same-opaque-id' };
  const one = ledger.registerConversation(identity, 1, 1);
  const two = ledger.registerConversation({ ...identity, issuer: 'synthetic-app-B' }, 1, 1);
  const grant = (key: string, bindingRevision = 1) => ({ key, bindingRevision, metadata: true, body: true });
  let access: AccessSnapshot = { revision: 1, grants: [grant(one.key)] };
  const service = new ConversationReadService(ledger, async () => access);
  const authenticated = new WeakSet<Request>();
  // Explicit Host authentication double. No real credentials, socket or platform connector.
  const handle = createConversationHttp({ reader: service, resolvePrincipal: async request => authenticated.has(request) ? 'fixture-owner' : null });
  const request = (path: string, query: Record<string, string> = {}, auth = true, method = 'GET') => {
    const url = new URL(`https://fixture.invalid/juebot/${path}`); for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const value = new Request(url, { method }); if (auth) authenticated.add(value); return value;
  };
  const event = (n: number, conversationKey = one.key): EventInput => ({ conversationKey, bindingRevision: 1, sourceEventId: `incoming-${n}`,
    occurredAt: n, eventType: 'message.received', reasonCode: 'NONE', actorId: 'synthetic-person', runId: null, causedBy: null, body: `PRIVATE-FIXTURE-${n}` });
  return { db, ledger, one, two, grant, handle, request, event, service, setAccess(value: AccessSnapshot) { access = value; } };
}
test('real SQLite -> ACL service -> HTTP exposes scoped metadata and separately authorized bodies', async t => {
  const f = setup(t); const first = f.ledger.append(f.event(1)).event;
  f.ledger.append(f.event(2, f.two.key));
  const list = await f.handle(f.request('conversations')); const listing = await list.json();
  assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal(listing.data.items.length, 1); assert.equal(JSON.stringify(listing).includes('PRIVATE-FIXTURE'), false);
  const events = await f.handle(f.request('conversation-events', { key: f.one.key })); const page = await events.json();
  assert.equal(page.data.items[0].bodyRef, first.sequence); assert.equal(JSON.stringify(page).includes('PRIVATE-FIXTURE'), false);
  const body = await f.handle(f.request('conversation-body', { key: f.one.key, sequence: String(first.sequence) }));
  assert.deepEqual(await body.json(), { ok: true, data: { sequence: first.sequence, text: 'PRIVATE-FIXTURE-1' } });
});
test('same opaque ID in another app cannot be reached through key, body reference or forged owner claim', async t => {
  const f = setup(t); const hidden = f.ledger.append(f.event(1, f.two.key)).event;
  const denied = await f.handle(f.request('conversation-body', { key: f.two.key, sequence: String(hidden.sequence) }));
  assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'ACCESS_DENIED');
  const foreignRef = await f.handle(f.request('conversation-body', { key: f.one.key, sequence: String(hidden.sequence) }));
  assert.equal(foreignRef.status, 404);
  const forged = await f.handle(f.request('conversation-events', { key: f.two.key, role: 'owner' }));
  assert.equal(forged.status, 400);
});
test('pagination and later permission revision keep old cursors from returning data', async t => {
  const f = setup(t); for (let n = 1; n <= 3; n++) f.ledger.append(f.event(n));
  const first = await (await f.handle(f.request('conversation-events', { key: f.one.key, limit: '2' }))).json();
  const last = await (await f.handle(f.request('conversation-events', { key: f.one.key, cursor: first.data.nextCursor }))).json();
  assert.deepEqual([...first.data.items, ...last.data.items].map(item => item.sourceEventId), ['incoming-1', 'incoming-2', 'incoming-3']);
  f.setAccess({ revision: 2, grants: [f.grant(f.one.key)] });
  const stale = await f.handle(f.request('conversation-events', { key: f.one.key, cursor: first.data.nextCursor }));
  assert.equal(stale.status, 400); assert.equal((await stale.json()).error.code, 'INVALID_CURSOR');
});
test('rebind and reauthorization do not expose events from the old binding', async t => {
  const f = setup(t); const old = f.ledger.append(f.event(1)).event;
  f.ledger.changeBinding(f.one.key, 1, 2, 4);
  const stale = await f.handle(f.request('conversation-events', { key: f.one.key })); assert.equal(stale.status, 409);
  f.setAccess({ revision: 2, grants: [f.grant(f.one.key, 2)] });
  const events = await (await f.handle(f.request('conversation-events', { key: f.one.key }))).json(); assert.deepEqual(events.data.items, []);
  assert.equal((await f.handle(f.request('conversation-body', { key: f.one.key, sequence: String(old.sequence) }))).status, 404);
});
test('revocation after a real body read returns no private response payload', async t => {
  const f = setup(t); const entry = f.ledger.append(f.event(1)).event; let reads = 0;
  const service = new ConversationReadService(f.ledger, async () => ({ revision: ++reads, grants: reads === 1 ? [f.grant(f.one.key)] : [] }));
  const handle = createConversationHttp({ reader: service, resolvePrincipal: async () => 'fixture-owner' });
  const response = await handle(f.request('conversation-body', { key: f.one.key, sequence: String(entry.sequence) }));
  assert.equal(response.status, 403); assert.equal(await response.text(), '{"ok":false,"error":{"code":"ACCESS_CHANGED"}}');
});
test('unauthenticated, malformed and write requests leave the real ledger untouched; closed store is safely unavailable', async t => {
  const f = setup(t); f.ledger.append(f.event(1));
  const counts = () => f.db.prepare('SELECT count(*) AS count FROM ledger_events').get(); const before = counts();
  assert.equal((await f.handle(f.request('conversations', {}, false))).status, 401);
  assert.equal((await f.handle(f.request('conversations', {}, true, 'POST'))).status, 405);
  assert.equal((await f.handle(f.request('conversations', { limit: '01' }))).status, 400);
  assert.deepEqual(counts(), before);
  f.ledger.close(); const unavailable = await f.handle(f.request('conversations'));
  assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { ok: false, error: { code: 'STORAGE_FAILURE' } });
});

test('invalid Unicode cannot be silently replaced by SQLite and break source idempotency', t => {
  const f = setup(t);
  for (const patch of [{ sourceEventId: '\ud800' }, { actorId: '\udc00' }, { body: 'broken\ud800text' }])
    assert.throws(() => f.ledger.append({ ...f.event(1), ...patch }), /INVALID_INPUT/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_events').get()!.n, 0);
  const emoji = { ...f.event(2), body: '合成🧑‍💻消息' };
  assert.equal(f.ledger.append(emoji).duplicate, false);
  assert.equal(f.ledger.append(emoji).duplicate, true);
});

test('valid maximum-length multilingual identities can use event cursors over HTTP', async t => {
  const f = setup(t); const wide = '测'.repeat(256);
  const conversation = f.ledger.registerConversation({ botId: wide, personaId: wide, connector: 'qq-official', issuer: wide, accountId: wide, kind: 'direct', remoteId: wide }, 1, 1);
  f.setAccess({ revision: 1, grants: [f.grant(conversation.key)] });
  for (let n = 1; n <= 3; n++) f.ledger.append(f.event(n, conversation.key));
  const initial = await f.handle(f.request('conversation-events', { key: conversation.key, limit: '1' }));
  assert.equal(initial.status, 200); const page = await initial.json();
  const next = await f.handle(f.request('conversation-events', { key: conversation.key, cursor: page.data.nextCursor }));
  assert.equal(next.status, 200); assert.equal((await next.json()).data.items.length, 2);
});
