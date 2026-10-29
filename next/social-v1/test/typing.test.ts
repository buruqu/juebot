import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TYPING_CONFIG, planTyping, TypingQueue } from '../src/typing.ts';
import type { ClaimChecks, ConversationKey, MessageKind, QueuedMessage } from '../src/typing.ts';
const config = { ...DEFAULT_TYPING_CONFIG, charsPerSecond: 10, minDelayMs: 0, maxDelayMs: 10000, jitterFraction: 0 };
const key: ConversationKey = { namespace: 'qq:app:a', opaqueId: 'conversation:opaque', accountKey: 'account:a', bindingRevision: 2 };
const checks: ClaimChecks = { bindingRevision: 2, policyRevision: 5, outboundAllowed: true };
function message(text = '你好', kind: MessageKind = 'social', conversation = key) {
  return { text, kind, conversation, policyRevision: 5 };
}
test('Chinese, combining marks and family emoji count as graphemes', () => {
  assert.deepEqual(planTyping('中👨‍👩‍👧‍👦e\u0301', 'social', config), { graphemes: 3, delayMs: 300 });
  assert.ok(planTyping('长'.repeat(30), 'social', config).delayMs > planTyping('短', 'social', config).delayMs);
});

test('copy-paste repetitions have zero typing delay and cannot enter the artificial typing FIFO', () => {
  for (const text of ['短', '长'.repeat(4000)])
    assert.equal(planTyping(text, 'repetition', { ...config, minDelayMs: 5000 }, () => { throw Error('must not sample'); }).delayMs, 0);
  const queue = new TypingQueue();
  queue.enqueue(message('长'.repeat(100)), 0);
  assert.throws(() => queue.enqueue({ ...message(), kind: 'repetition' } as unknown as QueuedMessage, 0), /MESSAGE_KIND_NOT_ALLOWED_IN_TYPING_QUEUE/);
  assert.equal(queue.size, 1);
});
test('jitter is replayable, bounded, with configurable switch and nonsocial bypass', () => {
  const jitter = { ...config, jitterFraction: 0.1 };
  assert.equal(planTyping('十'.repeat(10), 'social', jitter, () => 0).delayMs, 900);
  assert.equal(planTyping('十'.repeat(10), 'social', jitter, () => 1).delayMs, 1100);
  assert.equal(planTyping('字', 'social', { ...config, enabled: false }).delayMs, 0);
  for (const kind of ['code-result', 'control-ack'] as const)
    assert.equal(planTyping('字'.repeat(100), kind, config, () => { throw Error('random not used'); }).delayMs, 0);
  assert.equal(planTyping('字', 'social', { ...config, minDelayMs: 500 }).delayMs, 500);
  assert.equal(planTyping('字'.repeat(1000), 'social', config).delayMs, 10000);
});
test('invalid finite configuration, samples and oversized text are rejected', () => {
  for (const field of ['charsPerSecond', 'minDelayMs', 'maxDelayMs', 'jitterFraction', 'maxGraphemes', 'maxCodeUnits'] as const)
    for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => planTyping('x', 'social', { ...config, [field]: value }));
  for (const value of [NaN, Infinity, -0.1, 1.1]) assert.throws(() => planTyping('x', 'social', config, () => value));
  assert.throws(() => planTyping('abc', 'social', { ...config, maxGraphemes: 2 }));
  assert.throws(() => planTyping('👨‍👩‍👧‍👦', 'social', { ...config, maxCodeUnits: 2 }));
  assert.throws(() => new TypingQueue(0));
});
test('fake clock FIFO holds the short message behind a long message, with one local claim', () => {
  const queue = new TypingQueue(3, config);
  let now = 1000;
  const first = queue.enqueue(message('长'.repeat(20)), now);
  const second = queue.enqueue(message('短'), now);
  assert.equal(first.dueAt, 3000); assert.equal(second.dueAt, 3100);
  assert.equal(queue.claim(key, now, checks).status, 'waiting');
  now = 5000;
  const claimed = queue.claim(key, now, checks);
  assert.equal(claimed.status, 'claimed');
  if (claimed.status === 'claimed') assert.equal(claimed.claim.id, first.id);
  assert.equal(queue.claim(key, now, checks).status, 'in-flight');
  assert.equal(queue.complete(key, second.id), false);
  assert.equal(queue.complete(key, first.id), true);
  assert.equal(queue.complete(key, first.id), false);
  const next = queue.claim(key, now, checks);
  assert.equal(next.status, 'claimed');
  if (next.status === 'claimed') assert.equal(next.claim.id, second.id);
});
test('capacity is bounded globally and independent namespaces/accounts/revisions do not block one another', () => {
  const queue = new TypingQueue(4, config);
  queue.enqueue(message('长'.repeat(20)), 0);
  for (const other of [{ ...key, namespace: 'bili:app:b' }, { ...key, accountKey: 'account:b' }, { ...key, bindingRevision: 3 }]) {
    queue.enqueue(message('ack', 'control-ack', other), 0);
    assert.equal(queue.claim(other, 0, { ...checks, bindingRevision: other.bindingRevision }).status, 'claimed');
  }
  assert.throws(() => queue.enqueue(message(), 0), /QUEUE_FULL/);
  assert.equal(queue.size, 4);
});
test('cancel and latest policy/account/outbound checks happen before claim, no automatic retry', () => {
  for (const [override, reason] of [[{ bindingRevision: 3 }, 'binding-changed']] as const) {
    const queue = new TypingQueue(1, config);
    queue.enqueue(message(), 0);
    assert.deepEqual(queue.claim(key, 9999, { ...checks, ...override }), { status: 'cancelled', id: 1, reason });
    assert.equal(queue.size, 0);
    assert.equal(queue.claim(key, 9999, checks).status, 'empty');
  }
  const queue = new TypingQueue(1, config);
  const entry = queue.enqueue(message(), 0);
  assert.equal(queue.cancel(key, entry.id), true);
  assert.equal(queue.claim(key, 0, checks).status, 'cancelled');
});
test('ordinary Code OFF preserves existing Code results without humanized delay', () => {
  const queue = new TypingQueue(1, config);
  const entry = queue.enqueue(message('result', 'code-result'), 0);
  assert.equal(entry.dueAt, 0);
  assert.equal(queue.claim(key, 0, { ...checks, codeEnabled: false }).status, 'claimed');
  assert.equal(queue.cancel(key, entry.id), false);
});
test('caller mutation cannot redirect queued messages or alter their revisions', () => {
  const queue = new TypingQueue(1, config);
  const input = message('ack', 'control-ack', { ...key });
  const entry = queue.enqueue(input, 0);
  input.conversation.namespace = 'changed'; entry.message.policyRevision = 999;
  entry.message.conversation.bindingRevision = 999;
  assert.equal(queue.claim(key, 0, checks).status, 'claimed');
});
test('fractional bounds remain bounds and invalid key/clock/check inputs reject', () => {
  assert.equal(planTyping('', 'social', { ...config, minDelayMs: 0.2 }).delayMs, 0.2);
  assert.equal(planTyping('long', 'social', { ...config, maxDelayMs: 0.2 }).delayMs, 0.2);
  const queue = new TypingQueue(2, config);
  assert.throws(() => queue.enqueue(message('x', 'social', { ...key, namespace: '' }), 0));
  assert.throws(() => queue.enqueue(message('x', 'social', { ...key, bindingRevision: NaN }), 0));
  assert.throws(() => queue.enqueue(message(), Infinity));
  assert.throws(() => queue.claim(key, 0, { ...checks, policyRevision: NaN }));
});

test('outbound pause retains Code result and capacity until resumed; changed policy or binding blocks for management', () => {
  const queue = new TypingQueue(1, config);
  queue.enqueue(message('existing result', 'code-result'), 0);
  for (const [override, reason] of [[{ outboundAllowed: false }, 'outbound-blocked'], [{ policyRevision: 6 }, 'policy-changed'], [{ bindingRevision: 3 }, 'binding-changed']] as const) {
    assert.deepEqual(queue.claim(key, 0, { ...checks, ...override }), { status: 'blocked', id: 1, reason });
    assert.equal(queue.size, 1);
    assert.throws(() => queue.enqueue(message(), 0), /QUEUE_FULL/);
  }
  assert.equal(queue.claim(key, 0, { ...checks, codeEnabled: false }).status, 'claimed');
  assert.equal(queue.complete(key, 1), true);
});
test('planning and cancellation use caller clock without timers, fetch or platform I/O', t => {
  t.mock.method(globalThis, 'setTimeout', () => { throw Error('unexpected timer'); });
  t.mock.method(globalThis, 'setInterval', () => { throw Error('unexpected timer'); });
  t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected fetch'); });
  const queue = new TypingQueue(1, config);
  const entry = queue.enqueue(message(), 123);
  assert.equal(queue.cancel(key, entry.id), true);
  assert.equal(queue.claim(key, 123, checks).status, 'cancelled');
  assert.equal(queue.size, 0);
});

test('unclaimed Code results and control confirmations cannot be cancelled by social cancellation', () => {
  for (const kind of ['code-result', 'control-ack'] as const) {
    const queue = new TypingQueue(1, config);
    const entry = queue.enqueue(message('existing', kind), 0);
    assert.equal(queue.cancel(key, entry.id), false);
    assert.equal(queue.size, 1);
    assert.equal(queue.claim(key, 0, checks).status, 'claimed');
  }
});
test('social policy changes retain draft and capacity until exact text is rechecked against latest revision', () => {
  const queue = new TypingQueue(1, config);
  const entry = queue.enqueue(message(), 0);
  assert.deepEqual(queue.claim(key, 999, { ...checks, policyRevision: 6 }), { status: 'recheck', id: entry.id, policyRevision: 6 });
  assert.equal(queue.size, 1);
  assert.throws(() => queue.enqueue(message(), 0), /QUEUE_FULL/);
  assert.deepEqual(queue.claim(key, 999, checks), { status: 'recheck', id: entry.id, policyRevision: 6 });
  assert.equal(queue.revalidateSocial(key, entry.id, { policyRevision: 6, checkedText: 'changed text' }), false);
  assert.equal(queue.revalidateSocial(key, entry.id, { policyRevision: 7, checkedText: entry.message.text }), false);
  assert.equal(queue.revalidateSocial(key, entry.id, { policyRevision: 6, checkedText: entry.message.text }), true);
  assert.equal(queue.claim(key, 999, { ...checks, policyRevision: 6 }).status, 'claimed');
  assert.equal(queue.revalidateSocial(key, entry.id, { policyRevision: 6, checkedText: entry.message.text }), false);
});
