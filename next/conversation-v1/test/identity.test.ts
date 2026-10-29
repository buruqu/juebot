import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalIdentity, conversationKey } from '../src/identity.ts';
import { validateEvent } from '../src/contracts.ts';
const base = { botId: 'bot', personaId: 'persona', connector: 'qq-official', issuer: 'app-A', accountId: 'account-A', kind: 'group', remoteId: 'opaque:ABC/123' };
test('platform, app, account, persona and group/direct namespaces cannot collide', () => {
  const variants = [base, { ...base, connector: 'qq-personal' }, { ...base, issuer: 'app-B' }, { ...base, accountId: 'account-B' },
    { ...base, personaId: 'persona-B' }, { ...base, botId: 'bot-B' }, { ...base, kind: 'direct' }, { ...base, remoteId: 'opaque:abc/123' }];
  assert.equal(new Set(variants.map(conversationKey)).size, variants.length);
});
test('tuple encoding preserves delimiters and property order does not change identity', () => {
  assert.equal(conversationKey(base), conversationKey(Object.fromEntries(Object.entries(base).reverse())));
  assert.notEqual(conversationKey({ ...base, issuer: 'a:b', accountId: 'c' }), conversationKey({ ...base, issuer: 'a', accountId: 'b:c' }));
  const copy = canonicalIdentity(base); copy.remoteId = 'changed'; assert.equal(base.remoteId, 'opaque:ABC/123');
});
test('identity is validated without fabricating a nickname or numeric QQ mapping', () => {
  for (const patch of [{ remoteId: 123 }, { issuer: '' }, { accountId: ' a ' }, { remoteId: 'x\u0000y' }, { connector: 'unknown' },
    { kind: 'thread' }, { nickname: 'shared-name' }, { bindingRevision: 1 }]) assert.throws(() => conversationKey({ ...base, ...patch }));
  assert.doesNotThrow(() => conversationKey({ ...base, connector: 'bilibili', kind: 'thread' }));
});
test('structured events reject unknown logging fields, unbounded bodies and copied delivery bodies', () => {
  const event = { conversationKey: conversationKey(base), bindingRevision: 1, sourceEventId: 'event-1', occurredAt: 1,
    eventType: 'message.received', reasonCode: 'NONE', actorId: 'actor', runId: null, causedBy: null, body: 'synthetic private body' };
  assert.doesNotThrow(() => validateEvent(event));
  for (const patch of [{ environment: {} }, { cookie: 'test' }, { rawError: 'path' }, { body: 'x'.repeat(16001) },
    { eventType: 'reply.confirmed' }, { occurredAt: NaN }, { causedBy: -1 }, { reasonCode: 'free text' }]) assert.throws(() => validateEvent({ ...event, ...patch }));
});
