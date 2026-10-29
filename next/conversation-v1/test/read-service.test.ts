import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ConversationLedger } from '../src/ledger.ts';
import { ConversationReadService } from '../src/read-service.ts';
import { ConversationError } from '../src/contracts.ts';
import type { AccessSnapshot, EventInput, LedgerReader } from '../src/contracts.ts';
const identity = { botId: 'bot', personaId: 'persona', connector: 'local-test' as const, issuer: 'test', accountId: 'account', kind: 'direct' as const, remoteId: 'one' };
const error = (code: string) => (value: unknown) => value instanceof ConversationError && value.code === code;
function setup(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const ledger = new ConversationLedger(db, { namespace: 'synthetic-profile', initialize: true });
  const first = ledger.registerConversation(identity, 1, 0);
  const second = ledger.registerConversation({ ...identity, remoteId: 'two' }, 1, 0);
  const grant = (key: string, body = true) => ({ key, bindingRevision: 1, metadata: true, body });
  let current: AccessSnapshot = { revision: 1, grants: [grant(first.key)] };
  const service = new ConversationReadService(ledger, async () => current);
  const input = (n: number, key = first.key): EventInput => ({ conversationKey: key, bindingRevision: 1, sourceEventId: `source-${n}`,
    occurredAt: n, eventType: 'message.received', reasonCode: 'NONE', actorId: 'synthetic-actor', runId: null, causedBy: null, body: `private fixture ${n}` });
  return { db, ledger, first, second, grant, service, input, setAccess(value: AccessSnapshot) { current = value; } };
}
test('list exposes only granted current bindings, no message previews or global counts', async t => {
  const f = setup(t); f.ledger.append(f.input(1)); f.ledger.append(f.input(2, f.second.key));
  const page = await f.service.list('owner');
  assert.deepEqual(page.items.map(item => item.key), [f.first.key]);
  assert.equal(JSON.stringify(page).includes('private fixture'), false);
  assert.equal(JSON.stringify(page).includes(f.second.key), false);
  f.ledger.changeBinding(f.first.key, 1, 2, 3);
  assert.deepEqual((await f.service.list('owner')).items, []);
});
test('metadata-only permission never calls the private body reader; denied stream never calls the ledger', async t => {
  const f = setup(t); const event = f.ledger.append(f.input(1)).event;
  let calls = 0;
  const monitored = new Proxy(f.ledger, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { calls++; return value.apply(target, args); };
  } }) as LedgerReader;
  const service = new ConversationReadService(monitored, async () => ({ revision: 1, grants: [f.grant(f.first.key, false)] }));
  await assert.rejects(service.body('owner', f.first.key, event.sequence), error('ACCESS_DENIED'));
  await assert.rejects(service.events('owner', f.second.key), error('ACCESS_DENIED'));
  assert.equal(calls, 0);
  assert.equal((await service.events('owner', f.first.key)).items[0]?.bodyRef, event.sequence);
});
test('events page stably without duplicates and body is retrieved only through its scoped reference', async t => {
  const f = setup(t);
  for (let n = 1; n <= 5; n++) f.ledger.append(f.input(n));
  const one = await f.service.events('owner', f.first.key, { limit: 2 });
  const two = await f.service.events('owner', f.first.key, { limit: 2, cursor: one.nextCursor! });
  const three = await f.service.events('owner', f.first.key, { limit: 2, cursor: two.nextCursor! });
  assert.deepEqual([...one.items, ...two.items, ...three.items].map(item => item.sourceEventId), ['source-1','source-2','source-3','source-4','source-5']);
  assert.equal(three.nextCursor, null); assert.equal(JSON.stringify(one).includes('private fixture'), false);
  assert.deepEqual(await f.service.body('owner', f.first.key, one.items[0]!.sequence), { sequence: one.items[0]!.sequence, text: 'private fixture 1' });
  const other = f.ledger.append(f.input(6, f.second.key)).event;
  await assert.rejects(f.service.body('owner', f.first.key, other.sequence), error('SOURCE_NOT_FOUND'));
});
test('cursors cannot move a request across a conversation, purpose or permission revision', async t => {
  const f = setup(t); for (let n = 1; n <= 3; n++) f.ledger.append(f.input(n));
  const page = await f.service.events('owner', f.first.key, { limit: 1 });
  f.setAccess({ revision: 1, grants: [f.grant(f.first.key), f.grant(f.second.key)] });
  await assert.rejects(f.service.events('owner', f.second.key, { cursor: page.nextCursor! }), error('INVALID_CURSOR'));
  await assert.rejects(f.service.list('owner', { cursor: page.nextCursor! }), error('INVALID_CURSOR'));
  f.setAccess({ revision: 2, grants: [f.grant(f.first.key)] });
  await assert.rejects(f.service.events('owner', f.first.key, { cursor: page.nextCursor! }), error('INVALID_CURSOR'));
  f.setAccess({ revision: 3, grants: [] });
  await assert.rejects(f.service.events('owner', f.first.key, { cursor: page.nextCursor! }), error('ACCESS_DENIED'));
});
test('permissions are checked again after collecting data, even if a buggy provider reuses its revision', async t => {
  const f = setup(t); const event = f.ledger.append(f.input(1)).event;
  for (const operation of ['list', 'events', 'body'] as const) {
    let reads = 0;
    const service = new ConversationReadService(f.ledger, async () => ({ revision: 1, grants: ++reads === 1 ? [f.grant(f.first.key)] : [] }));
    const pending = operation === 'list' ? service.list('owner') : operation === 'events' ? service.events('owner', f.first.key) : service.body('owner', f.first.key, event.sequence);
    await assert.rejects(pending, error('ACCESS_CHANGED'));
  }
});
test('rebind during asynchronous authorization prevents returning the collected page or body', async t => {
  for (const operation of ['list', 'events', 'body'] as const) {
    const f = setup(t); const event = f.ledger.append(f.input(1)).event; let reads = 0;
    const service = new ConversationReadService(f.ledger, async () => {
      if (++reads === 2) f.ledger.changeBinding(f.first.key, 1, 2, 2);
      return { revision: 1, grants: [f.grant(f.first.key)] };
    });
    const pending = operation === 'list' ? service.list('owner') : operation === 'events' ? service.events('owner', f.first.key) : service.body('owner', f.first.key, event.sequence);
    await assert.rejects(pending, error('BINDING_CONFLICT'));
  }
});
test('list pagination obeys scoped grants, and invalid cursors/options fail closed', async t => {
  const f = setup(t); f.setAccess({ revision: 1, grants: [f.grant(f.second.key), f.grant(f.first.key)] });
  const one = await f.service.list('owner', { limit: 1 }); const two = await f.service.list('owner', { limit: 1, cursor: one.nextCursor! });
  assert.equal(new Set([...one.items,...two.items].map(item => item.key)).size, 2); assert.equal(two.nextCursor, null);
  for (const input of [{ limit: 0 }, { limit: Infinity }, { limit: 101 }, { cursor: '' }, { cursor: '{}' }, { cursor: '{"v":1,"role":"owner"}' }, { approved: true }])
    await assert.rejects(f.service.list('owner', input));
});
test('malformed or duplicate grants are rejected without body access', async t => {
  const f = setup(t);
  for (const grants of [[f.grant(f.first.key), f.grant(f.first.key)], [{ ...f.grant(f.first.key), metadata: false }],
    [{ ...f.grant(f.first.key), approved: true }]]) {
    const service = new ConversationReadService(f.ledger, async () => ({ revision: 1, grants }));
    await assert.rejects(service.list('owner'), error('INVALID_INPUT'));
  }
});

test('bounded list scanning skips stale bindings without losing later authorized rows', async t => {
  const f = setup(t); const registered = Array.from({ length: 128 }, (_, n) => f.ledger.registerConversation({ ...identity, remoteId: `scope-${String(n).padStart(3, '0')}` }, 1, 1));
  for (const item of registered.slice(0, 110)) f.ledger.changeBinding(item.key, 1, 2, 2);
  f.setAccess({ revision: 1, grants: registered.map(item => f.grant(item.key)) });
  const one = await f.service.list('owner', { limit: 10 });
  const two = await f.service.list('owner', { limit: 10, cursor: one.nextCursor! });
  assert.deepEqual([...one.items, ...two.items].map(item => item.key), registered.slice(110).map(item => item.key));
  assert.equal(one.items.length, 10); assert.equal(two.items.length, 8); assert.equal(two.nextCursor, null);
});
