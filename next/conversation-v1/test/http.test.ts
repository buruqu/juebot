import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationError } from '../src/contracts.ts';
import type { ConversationRecord, StoredEvent } from '../src/contracts.ts';
import { createConversationHttp } from '../src/http.ts';
import type { ConversationHttpReader } from '../src/http.ts';

// Real WHATWG Request/Response, precise reader/auth doubles. NOT authenticated Host HTTP.
function fixture() {
  const calls: unknown[][] = [];
  let principal: string | null = 'host-resolved-principal';
  let failure: unknown;
  let beforeRead: (() => Promise<void>) | undefined;
  const conversation: ConversationRecord = { key: 'synthetic-key', identity: { botId: 'bot', personaId: 'persona',
    connector: 'local-test', issuer: 'test', accountId: 'account', kind: 'group', remoteId: 'group' },
    bindingRevision: 1, createdAt: 1, updatedAt: 1 };
  const event: StoredEvent = { sequence: 1, conversationKey: 'synthetic-key', bindingRevision: 1,
    sourceEventId: 'source', occurredAt: 1, eventType: 'message.received', reasonCode: 'NONE', actorId: 'actor',
    runId: null, causedBy: null, bodyRef: 1 };
  const read = async (args: unknown[]) => { calls.push(args); await beforeRead?.(); if (failure) throw failure; };
  const reader: ConversationHttpReader = {
    async list(p, options) { await read(['list', p, options]); return { items: [conversation], nextCursor: null }; },
    async events(p, key, options) { await read(['events', p, key, options]); return { items: [event], nextCursor: 'next' }; },
    async body(p, key, sequence) { await read(['body', p, key, sequence]); return { sequence, text: 'synthetic restricted body' }; },
  };
  const handle = createConversationHttp({ reader, resolvePrincipal: async () => principal });
  return { calls, handle, conversation, event,
    principal: (value: string | null) => { principal = value; },
    fail: (value: unknown) => { failure = value; },
    beforeRead: (fn: () => Promise<void>) => { beforeRead = fn; } };
}
const request = (path: string, init?: RequestInit) => new Request('http://offline.invalid' + path, init);

test('three read routes forward only validated parameters and Host principal', async () => {
  const f = fixture();
  const list = await f.handle(request('/juebot/conversations?limit=10&cursor=opaque'));
  assert.deepEqual(await list.json(), { ok: true, data: { items: [f.conversation], nextCursor: null } });
  const events = await f.handle(request('/juebot/conversation-events?key=synthetic-key&limit=2'));
  assert.deepEqual(await events.json(), { ok: true, data: { items: [f.event], nextCursor: 'next' } });
  const body = await f.handle(request('/juebot/conversation-body?key=synthetic-key&sequence=1'));
  assert.deepEqual(await body.json(), { ok: true, data: { sequence: 1, text: 'synthetic restricted body' } });
  assert.deepEqual(f.calls, [ ['list', 'host-resolved-principal', { limit: 10, cursor: 'opaque' }],
    ['events', 'host-resolved-principal', 'synthetic-key', { limit: 2 }], ['body', 'host-resolved-principal', 'synthetic-key', 1] ]);
  for (const response of [list, events, body]) {
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('authentication is injected; client owner claims cannot authorize or alter principal', async () => {
  const f = fixture(); f.principal(null);
  const unauthenticated = await f.handle(request('/juebot/conversations', { headers: { 'x-role': 'owner', authorization: 'Bearer synthetic-forgery' } }));
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { ok: false, error: { code: 'UNAUTHENTICATED' } });
  assert.equal(f.calls.length, 0);
  f.principal('trusted');
  assert.equal((await f.handle(request('/juebot/conversations?principal=owner'))).status, 400);
  assert.equal((await f.handle(request('/juebot/conversations', { headers: { 'x-principal': 'owner' } }))).status, 200);
  assert.deepEqual(f.calls, [['list', 'trusted', {}]]);
});

test('write methods and unknown routes never call the reader', async () => {
  const f = fixture();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    const response = await f.handle(request('/juebot/conversations', { method }));
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  }
  assert.equal((await f.handle(request('/juebot/conversations/'))).status, 404);
  assert.equal(f.calls.length, 0);
});

test('unknown/duplicate query keys, including encoded duplicates, are rejected before reading', async () => {
  const f = fixture();
  for (const path of ['/juebot/conversations?unknown=1', '/juebot/conversations?limit=1&limit=2',
    '/juebot/conversations?limit=1&%6cimit=2', '/juebot/conversations?cursor=a&cursor=a',
    '/juebot/conversation-events?key=a&key=b', '/juebot/conversation-events?key=a&sequence=1',
    '/juebot/conversation-body?key=a&sequence=1&cursor=x']) {
    assert.equal((await f.handle(request(path))).status, 400, path);
  }
  assert.equal(f.calls.length, 0);
});

test('limit and sequence require canonical positive safe integers and bounded page sizes', async () => {
  const f = fixture();
  for (const value of ['', '0', '-1', '01', '+1', '1.0', '1e1', ' 1', 'Infinity', '9007199254740992']) {
    for (const path of ['/juebot/conversations?limit=', '/juebot/conversation-body?key=a&sequence='])
      assert.equal((await f.handle(request(path + encodeURIComponent(value)))).status, 400, path + value);
  }
  assert.equal((await f.handle(request('/juebot/conversations?limit=101'))).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.handle(request('/juebot/conversations?limit=100'))).status, 200);
  assert.equal((await f.handle(request('/juebot/conversation-body?key=a&sequence=9007199254740991'))).status, 200);
});

test('key/cursor/query bounds and required parameters fail closed', async () => {
  const f = fixture();
  const invalid = ['/juebot/conversation-events', '/juebot/conversation-body?key=a', '/juebot/conversation-body?sequence=1',
    '/juebot/conversation-events?key=', '/juebot/conversation-events?key=%00', '/juebot/conversation-events?key=%20a',
    '/juebot/conversation-events?key=' + 'x'.repeat(4097), '/juebot/conversations?cursor=',
    '/juebot/conversations?cursor=' + 'x'.repeat(8193), '/juebot/conversations?cursor=%00',
    '/juebot/conversation-events?key=' + '%61'.repeat(4096) + '&cursor=' + '%78'.repeat(8192)];
  for (const path of invalid) assert.equal((await f.handle(request(path))).status, 400, path.slice(0, 90));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.handle(request('/juebot/conversation-events?key=' + 'x'.repeat(4096)))).status, 200);
  assert.equal((await f.handle(request('/juebot/conversations?cursor=' + 'x'.repeat(8192)))).status, 200);
});

test('access revocation/conflicts/not-found and invalid cursor retain safe status codes', async () => {
  const f = fixture();
  for (const [code, status] of [['INVALID_INPUT', 400], ['INVALID_CURSOR', 400], ['ACCESS_DENIED', 403],
    ['ACCESS_CHANGED', 403], ['BINDING_CONFLICT', 409], ['EVENT_CONFLICT', 409],
    ['CONVERSATION_NOT_FOUND', 404], ['SOURCE_NOT_FOUND', 404]] as const) {
    f.fail(new ConversationError(code));
    const response = await f.handle(request('/juebot/conversation-body?key=a&sequence=1'));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, error: { code } });
  }
});

test('unknown reader/auth errors and unmapped storage errors never echo private details', async () => {
  const f = fixture();
  for (const error of [new Error('synthetic-private-body /private/path token=synthetic'),
    { code: 'ACCESS_DENIED', message: 'synthetic-private-body' }, new ConversationError('STORE_MISMATCH')]) {
    f.fail(error);
    const response = await f.handle(request('/juebot/conversations'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'STORAGE_FAILURE' } });
  }
  const handler = createConversationHttp({ reader: {} as ConversationHttpReader,
    resolvePrincipal: async () => { throw new Error('synthetic private auth configuration'); } });
  assert.deepEqual(await (await handler(request('/juebot/conversations'))).json(), { ok: false, error: { code: 'STORAGE_FAILURE' } });
});

test('cancellation before auth, during auth and during reading cannot report success', async () => {
  const before = new AbortController(); before.abort();
  const f = fixture();
  await assert.rejects(f.handle(request('/juebot/conversations', { signal: before.signal })), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  const duringRead = new AbortController();
  f.beforeRead(async () => { duringRead.abort(); });
  await assert.rejects(f.handle(request('/juebot/conversations', { signal: duringRead.signal })), { name: 'AbortError' });
  const duringAuth = new AbortController(); let reads = 0;
  const handler = createConversationHttp({ reader: { list: async () => { reads++; return { items: [], nextCursor: null }; } } as unknown as ConversationHttpReader,
    resolvePrincipal: async () => { duringAuth.abort(); return 'trusted'; } });
  await assert.rejects(handler(request('/juebot/conversations', { signal: duringAuth.signal })), { name: 'AbortError' });
  assert.equal(reads, 0);
});
