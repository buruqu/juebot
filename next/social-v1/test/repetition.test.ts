import assert from 'node:assert/strict';
import test from 'node:test';
import { considerRepetition, REPETITION_LIMITS } from '../src/repetition.ts';
import type { RepetitionContext, RepetitionEvent } from '../src/repetition.ts';
const key = { namespace: 'qq:app', opaqueId: 'opaque-group', accountKey: 'bot-account', bindingRevision: 2 };
const context: RepetitionContext = { conversationKey: key, conversationKind: 'group', wantsToRepeat: true,
  enabled: true, outboundAllowed: true, botActorKey: 'self', now: 1000000, lastAttemptAt: null };
function event(n: number, patch: Partial<RepetitionEvent> = {}): RepetitionEvent {
  return { conversationKey: { ...key }, id: `event-${n}`, actorKey: `human-${n % 2}`, actorVerified: true,
    observedAt: context.now - 10000 + n, senderKind: 'human', kind: 'text', text: '合成复读', ...patch };
}
const three = [event(1), event(2), event(3)];
test('continuous multi-person repetition yields a candidate, not a send', () => {
  assert.deepEqual(considerRepetition(three, context), { action: 'candidate', text: '合成复读', sourceEventIds: three.map(item => item.id) });
});
test('intervening messages do not prevent exact repetition detection', () => {
  assert.equal(considerRepetition([event(1), event(2, { text: 'other' }), event(3), event(4, { text: 'filler' }), event(5, { actorKey: 'human-2' })], context).action, 'candidate');
});
test('only line endings and boundary whitespace normalize, similar meaning is not equal', () => {
  assert.equal(considerRepetition([event(1, { text: ' A\r\nB ' }), event(2, { text: 'A\nB' }), event(3, { text: '\tA\nB\n' })], context).action, 'candidate');
  assert.deepEqual(considerRepetition([event(1, { text: 'ａｂ' }), event(2, { text: 'AB' }), event(3, { text: 'ab' })], context), { action: 'skip', reason: 'insufficient-repetition' });
});
test('single-person flooding, unverified actors and bot loops cannot count', () => {
  assert.deepEqual(considerRepetition(three.map(item => ({ ...item, actorKey: 'one-person' })), context), { action: 'skip', reason: 'insufficient-humans' });
  for (const patch of [{ senderKind: 'bot' }, { senderKind: 'unknown' }, { actorKey: 'self' }, { actorVerified: false }, { kind: 'attachment' }] as const) {
    assert.deepEqual(considerRepetition(three.map(item => ({ ...item, ...patch })), context), { action: 'skip', reason: 'ineligible-anchor' });
    assert.equal(considerRepetition([event(1, patch), event(2), event(3)], context).action, 'skip');
  }
});
test('other conversation, namespace, account and binding revision never merge', () => {
  for (const other of [{ ...key, opaqueId: 'other' }, { ...key, namespace: 'other' }, { ...key, accountKey: 'other' }, { ...key, bindingRevision: 3 }]) {
    assert.equal(considerRepetition([event(1, { conversationKey: other }), event(2), event(3)], context).action, 'skip');
    assert.deepEqual(considerRepetition([event(1), event(2), event(3, { conversationKey: other })], context), { action: 'skip', reason: 'wrong-conversation' });
  }
  assert.deepEqual(considerRepetition(three, { ...context, conversationKind: 'direct' }), { action: 'skip', reason: 'not-group' });
});
test('duplicate IDs do not create votes; conflicting duplicates are rejected', () => {
  const first = event(1);
  assert.equal(considerRepetition([first, first, first], context).action, 'skip');
  assert.equal(considerRepetition([first, first, event(2), event(3)], context).action, 'candidate');
  assert.deepEqual(considerRepetition([first, { ...first, actorKey: 'forged' }, event(2), event(3)], context), { action: 'skip', reason: 'invalid-input' });
});
test('will, enabled, outbound and cooldown each independently prevent a candidate', () => {
  for (const [patch, reason] of [[{ wantsToRepeat: false }, 'not-wanted'], [{ enabled: false }, 'disabled'], [{ outboundAllowed: false }, 'outbound-blocked'], [{ lastAttemptAt: context.now - 59999 }, 'cooldown']] as const)
    assert.deepEqual(considerRepetition(three, { ...context, ...patch }), { action: 'skip', reason });
  assert.equal(considerRepetition(three, { ...context, lastAttemptAt: context.now - 60000 }).action, 'candidate');
});
test('time and recent-event windows exclude stale matches', () => {
  assert.deepEqual(considerRepetition(three.map(item => ({ ...item, observedAt: 1 })), context), { action: 'skip', reason: 'expired-anchor' });
  assert.equal(considerRepetition([event(1), event(2), event(3, { text: 'other' }), event(4)], context, { windowEvents: 3 }).action, 'skip');
  assert.equal(considerRepetition([event(1, { observedAt: context.now - 120001 }), event(2), event(3)], context).action, 'skip');
});
test('clock anomalies, unsafe limits, oversized text and arrays fail closed', () => {
  for (const now of [NaN, Infinity, -1, 1.5]) assert.deepEqual(considerRepetition(three, { ...context, now }), { action: 'skip', reason: 'clock-anomaly' });
  assert.deepEqual(considerRepetition(three, { ...context, lastAttemptAt: context.now + 1 }), { action: 'skip', reason: 'clock-anomaly' });
  assert.deepEqual(considerRepetition([event(1, { observedAt: context.now + 1 })], context), { action: 'skip', reason: 'clock-anomaly' });
  assert.deepEqual(considerRepetition([event(2), event(1)], context), { action: 'skip', reason: 'clock-anomaly' });
  assert.deepEqual(considerRepetition([event(1, { text: 'x'.repeat(REPETITION_LIMITS.textCodeUnits + 1) })], context), { action: 'skip', reason: 'invalid-input' });
  assert.deepEqual(considerRepetition(Array(REPETITION_LIMITS.inputEvents + 1).fill(event(1)), context), { action: 'skip', reason: 'invalid-input' });
  for (const config of [{ windowEvents: Infinity }, { windowMs: NaN }, { minOccurrences: 2 }, { minDistinctHumans: 1 }, { cooldownMs: -1 }, { windowEvents: 3.5 }])
    assert.deepEqual(considerRepetition(three, context, config), { action: 'skip', reason: 'invalid-config' });
});
test('pure detection has no timer, network or mutation side effects', t => {
  t.mock.method(globalThis, 'setTimeout', () => { throw Error('unexpected timer'); });
  t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected network'); });
  const snapshot = JSON.stringify(three);
  assert.equal(considerRepetition(three, context).action, 'candidate');
  assert.equal(JSON.stringify(three), snapshot);
});

test('replayed final anchor is rejected even with sufficient unique human votes and equal timestamps', () => {
  const events = [event(1), event(2), event(3)].map(item => ({ ...item, observedAt: 1000 }));
  const atTime = { ...context, now: 1000 };
  assert.equal(considerRepetition(events, atTime).action, 'candidate');
  assert.deepEqual(considerRepetition([...events, events[2]!], atTime), { action: 'skip', reason: 'duplicate-anchor' });
  assert.deepEqual(considerRepetition([...events, { ...events[2]!, text: 'changed' }], atTime), { action: 'skip', reason: 'invalid-input' });
});
test('duplicate comparison uses contract fields, independent of object insertion order and unused extras', () => {
  const first = event(1);
  const reordered = Object.fromEntries(Object.entries(first).reverse()) as unknown as RepetitionEvent;
  reordered.conversationKey = Object.fromEntries(Object.entries(first.conversationKey).reverse()) as unknown as RepetitionEvent['conversationKey'];
  const withExtra = { ...reordered, unused: 'does not prove content' };
  assert.equal(considerRepetition([first, withExtra, event(2), event(3)], context).action, 'candidate');
  for (const changed of [{ actorKey: 'changed' }, { text: 'changed' }, { observedAt: first.observedAt + 1 }])
    assert.deepEqual(considerRepetition([first, { ...first, ...changed }, event(2), event(3)], context), { action: 'skip', reason: 'invalid-input' });
});
