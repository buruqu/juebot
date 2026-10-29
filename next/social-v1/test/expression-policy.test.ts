import assert from 'node:assert/strict';
import test from 'node:test';
import { checkExpression, EMPTY_EXPRESSION_POLICY, EXPRESSION_LIMITS, normalizeExpression } from '../src/expression-policy.ts';
import type { ExpressionInput, ExpressionPolicy, ExpressionRule } from '../src/expression-policy.ts';
const input: ExpressionInput = { kind: 'social', text: 'synthetic phrase', conversationKey: 'qq:app:conversation', personaId: 'persona:a', policyRevision: 3, rewriteCount: 0 };
const rule: ExpressionRule = { ruleId: 'synthetic.rule', scope: { kind: 'global' }, match: 'contains', phrase: 'synthetic', action: 'rewrite' };
function policy(rules: readonly ExpressionRule[] = [rule]): ExpressionPolicy {
  return { revision: 3, rules, styleContracts: [], maxRewrites: 2 };
}
test('default empty rules add no user blacklist', () => {
  assert.deepEqual(checkExpression(EMPTY_EXPRESSION_POLICY, { ...input, policyRevision: 0 }), { action: 'allow' });
});
test('NFKC, full fold expansions and zero-width cleanup detect literal variants', () => {
  assert.equal(normalizeExpression('ＳＹＮ\u200bＴＨＥＴＩＣ'), 'synthetic');
  assert.equal(normalizeExpression('Straße'), normalizeExpression('STRASSE'));
  assert.equal(normalizeExpression('ΟΣ'), normalizeExpression('οσ'));
  assert.deepEqual(checkExpression(policy(), { ...input, text: 'ＳＹＮ\u200bＴＨＥＴＩＣ phrase' }), { action: 'rewrite', ruleId: rule.ruleId });
});
test('exact matching is not contains and regex characters remain literal', () => {
  assert.deepEqual(checkExpression(policy([{ ...rule, match: 'exact' }]), input), { action: 'allow' });
  assert.deepEqual(checkExpression(policy([{ ...rule, phrase: '.*' }]), input), { action: 'allow' });
  assert.deepEqual(checkExpression(policy([{ ...rule, phrase: '.*' }]), { ...input, text: 'literal .* here' }), { action: 'rewrite', ruleId: rule.ruleId });
});
test('global, conversation and persona scope apply only to matching opaque context', () => {
  for (const scope of [{ kind: 'conversation', key: input.conversationKey }, { kind: 'persona', id: input.personaId }] as const) {
    assert.equal(checkExpression(policy([{ ...rule, scope }]), input).action, 'rewrite');
    assert.equal(checkExpression(policy([{ ...rule, scope }]), { ...input, conversationKey: 'other', personaId: 'other' }).action, 'allow');
  }
});
test('all matching scopes accumulate and global blocking cannot be waived locally', () => {
  const local = { ...rule, ruleId: 'local.rewrite', scope: { kind: 'conversation', key: input.conversationKey } } as const;
  const blocked = { ...rule, ruleId: 'global.block', action: 'blocked' } as const;
  for (const rules of [[local, blocked], [blocked, local]])
    assert.deepEqual(checkExpression(policy(rules), input), { action: 'blocked', ruleId: 'global.block' });
});
test('rewrite budget is bounded, output contains identifiers only and input text is untouched', () => {
  const snapshot = JSON.stringify(input);
  assert.deepEqual(checkExpression(policy(), { ...input, rewriteCount: 1 }), { action: 'rewrite', ruleId: rule.ruleId });
  assert.deepEqual(checkExpression(policy(), { ...input, rewriteCount: 2 }), { action: 'blocked', ruleId: rule.ruleId });
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(Object.keys(checkExpression(policy(), input)).sort(), ['action', 'ruleId']);
});
test('updated policies force waiting social messages to recheck even when rules are empty', () => {
  assert.deepEqual(checkExpression({ ...policy([]), revision: 4 }, input), { action: 'recheck' });
});
test('Code materials and independent management confirmations bypass social matching', () => {
  for (const kind of ['code-result', 'control-ack'] as const)
    assert.deepEqual(checkExpression(policy([{ ...rule, action: 'blocked' }]), { ...input, kind, policyRevision: 0 }), { action: 'allow' });
});
test('style policies and counterexamples record contracts without claiming semantic detection', () => {
  const result = checkExpression({ ...policy([]), styleContracts: [{ contractId: 'style.1', scope: { kind: 'global' }, policyText: 'Synthetic style constraint', counterexamples: ['synthetic phrase'] }] }, input);
  assert.deepEqual(result, { action: 'allow' });
});
test('reject regex modes, invalid revisions, unbounded sizes, duplicate IDs and unsupported allows and legacy hard fields', () => {
  for (const invalid of [
    { ...policy(), revision: NaN }, { ...policy(), maxRewrites: Infinity }, { ...policy(), maxRewrites: EXPRESSION_LIMITS.maxRewrites + 1 },
    policy(Array.from({ length: EXPRESSION_LIMITS.rules + 1 }, (_, i) => ({ ...rule, ruleId: `rule.${i}` }))),
    policy([rule, rule]), policy([{ ...rule, phrase: 'x'.repeat(EXPRESSION_LIMITS.phraseCodeUnits + 1) }]),
    policy([{ ...rule, phrase: '\u200b' }]), policy([{ ...rule, action: 'allow' as 'rewrite' }]), policy([{ ...rule, hard: true } as ExpressionRule]),
    policy([{ ...rule, match: 'regex' as 'exact' }]),
  ]) assert.throws(() => checkExpression(invalid, input));
  assert.throws(() => checkExpression(policy(), { ...input, text: 'x'.repeat(EXPRESSION_LIMITS.textCodeUnits + 1) }));
  assert.throws(() => checkExpression(policy(), { ...input, rewriteCount: -1 }));
});
