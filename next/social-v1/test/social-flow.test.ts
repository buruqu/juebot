import assert from 'node:assert/strict';
import test from 'node:test';
import { planTyping, TypingQueue } from '../src/typing.ts';
import type { ConversationKey } from '../src/typing.ts';
import { checkExpression } from '../src/expression-policy.ts';
import type { ExpressionPolicy } from '../src/expression-policy.ts';
import { considerRepetition } from '../src/repetition.ts';

const key: ConversationKey = { namespace: 'synthetic:app:group', accountKey: 'test-account', opaqueId: 'one', bindingRevision: 1 };
const context = { kind: 'social' as const, conversationKey: 'synthetic:app:group:one', personaId: 'test-persona', rewriteCount: 0 };
const checks = (policyRevision: number, outboundAllowed = true) => ({ bindingRevision: 1, policyRevision, outboundAllowed });
const empty = (revision: number): ExpressionPolicy => ({ revision, rules: [], styleContracts: [], maxRewrites: 2 });

test('new expression ban keeps a waiting draft unclaimable; no blocked result is revalidated', () => {
  const queue = new TypingQueue();
  queue.enqueue({ conversation: key, kind: 'social', text: 'synthetic forbidden phrase', policyRevision: 1 }, 0);
  assert.equal(queue.claim(key, 10000, checks(2)).status, 'recheck');
  const policy: ExpressionPolicy = { ...empty(2), rules: [{ ruleId: 'block.1', scope: { kind: 'global' }, match: 'contains', phrase: 'forbidden', action: 'blocked' }] };
  assert.equal(checkExpression(policy, { ...context, text: 'synthetic forbidden phrase', policyRevision: 1 }).action, 'recheck');
  const decision = checkExpression(policy, { ...context, text: 'synthetic forbidden phrase', policyRevision: 2 });
  assert.equal(decision.action, 'blocked');
  assert.equal(queue.claim(key, 10000, checks(1)).status, 'recheck');
  assert.equal(queue.claim(key, 10000, checks(2)).status, 'recheck');
  assert.equal(queue.size, 1);
});

test('a second policy update invalidates an older recheck; latest allow still respects pause', () => {
  const queue = new TypingQueue();
  const text = 'synthetic permitted response';
  const entry = queue.enqueue({ conversation: key, kind: 'social', text, policyRevision: 5 }, 0);
  assert.equal(queue.claim(key, 10000, checks(6)).status, 'recheck');
  assert.equal(checkExpression(empty(6), { ...context, text, policyRevision: 6 }).action, 'allow');
  assert.equal(queue.claim(key, 10000, checks(7)).status, 'recheck');
  assert.equal(queue.revalidateSocial(key, entry.id, { policyRevision: 6, checkedText: text }), false);
  assert.equal(queue.claim(key, 10000, checks(6)).status, 'recheck');
  assert.equal(checkExpression(empty(7), { ...context, text, policyRevision: 7 }).action, 'allow');
  assert.equal(queue.revalidateSocial(key, entry.id, { policyRevision: 7, checkedText: text }), true);
  assert.equal(queue.claim(key, 10000, checks(7, false)).status, 'blocked');
  assert.equal(queue.claim(key, 10000, checks(7)).status, 'claimed');
  assert.equal(queue.claim(key, 10000, checks(7)).status, 'in-flight');
  assert.equal(queue.complete(key, entry.id), true);
  assert.equal(queue.size, 0);
});

test('bounded rewrite exhaustion blocks a social draft while Code OFF preserves an existing result', () => {
  const queue = new TypingQueue();
  const text = 'synthetic unwanted style';
  const policy: ExpressionPolicy = { ...empty(1), rules: [{ ruleId: 'rewrite.1', scope: { kind: 'global' }, match: 'contains', phrase: 'unwanted', action: 'rewrite' }] };
  assert.equal(checkExpression(policy, { ...context, text, policyRevision: 1, rewriteCount: 2 }).action, 'blocked');
  assert.equal(checkExpression(policy, { ...context, kind: 'code-result', text, policyRevision: 1, rewriteCount: 2 }).action, 'allow');
  const result = queue.enqueue({ conversation: key, kind: 'code-result', text, policyRevision: 1 }, 0);
  assert.equal(queue.cancel(key, result.id), false);
  assert.equal(queue.claim(key, 0, { ...checks(1), codeEnabled: false }).status, 'claimed');
});

test('split messages must be checked as a complete logical reply, not one chunk at a time', () => {
  const chunks = ['synthetic for', 'bidden phrase'];
  const policy: ExpressionPolicy = { ...empty(1), rules: [{ ruleId: 'block.chunk', scope: { kind: 'global' }, match: 'contains', phrase: 'forbidden', action: 'blocked' }] };
  assert.equal(checkExpression(policy, { ...context, text: chunks.join(''), policyRevision: 1 }).action, 'blocked');
});

const repeatedEvents = [1, 2, 3].map(n => ({ conversationKey: key, id: `repeat-${n}`, actorKey: `human-${n % 2}`,
  actorVerified: true, observedAt: n, senderKind: 'human' as const, kind: 'text' as const, text: 'synthetic repeated wording' }));
const repeatContext = { conversationKey: key, conversationKind: 'group' as const, wantsToRepeat: true,
  enabled: true, outboundAllowed: true, botActorKey: 'test-bot', now: 10, lastAttemptAt: null };

test('a repetition candidate is still blocked by a banned expression', () => {
  const candidate = considerRepetition(repeatedEvents, repeatContext);
  assert.equal(candidate.action, 'candidate');
  if (candidate.action !== 'candidate') throw new Error('expected candidate');
  const policy: ExpressionPolicy = { ...empty(1), rules: [{ ruleId: 'repeat.banned', scope: { kind: 'global' }, match: 'contains', phrase: 'repeated wording', action: 'blocked' }] };
  assert.equal(checkExpression(policy, { ...context, kind: 'repetition', text: candidate.text, policyRevision: 1 }).action, 'blocked');
  assert.equal(checkExpression(policy, { ...context, kind: 'repetition', text: candidate.text, policyRevision: 0 }).action, 'recheck');
});

test('a willing permitted repetition adds no typing wait, while unwillingness or pause prevents a candidate', () => {
  assert.equal(considerRepetition(repeatedEvents, { ...repeatContext, wantsToRepeat: false }).action, 'skip');
  assert.equal(considerRepetition(repeatedEvents, { ...repeatContext, outboundAllowed: false }).action, 'skip');
  const candidate = considerRepetition(repeatedEvents, repeatContext);
  if (candidate.action !== 'candidate') throw new Error('expected candidate');
  assert.equal(checkExpression(empty(1), { ...context, kind: 'repetition', text: candidate.text, policyRevision: 1 }).action, 'allow');
  assert.equal(planTyping(candidate.text, 'repetition').delayMs, 0);
});
