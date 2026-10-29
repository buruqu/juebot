export const EXPRESSION_LIMITS = Object.freeze({ rules: 128, phraseCodeUnits: 256, textCodeUnits: 32000,
    contracts: 32, policyCodeUnits: 4000, counterexamples: 8, exampleCodeUnits: 512, scopeCodeUnits: 512,
    maxRewrites: 5 });
export const EMPTY_EXPRESSION_POLICY = Object.freeze({ revision: 0,
    rules: Object.freeze([]), styleContracts: Object.freeze([]), maxRewrites: 2 });
function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function bounded(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
// Full-fold expansions beyond lowercase (Unicode data generated offline); not identity normalization.
const CASE_FOLD = { "\u00b5": "\u03bc", "\u00df": "ss", "\u0149": "\u02bcn", "\u017f": "s", "\u01f0": "j\u030c", "\u0345": "\u03b9", "\u0390": "\u03b9\u0308\u0301", "\u03b0": "\u03c5\u0308\u0301", "\u03c2": "\u03c3", "\u03d0": "\u03b2", "\u03d1": "\u03b8", "\u03d5": "\u03c6", "\u03d6": "\u03c0", "\u03f0": "\u03ba", "\u03f1": "\u03c1", "\u03f5": "\u03b5", "\u0587": "\u0565\u0582", "\uab70": "\u13a0", "\uab71": "\u13a1", "\uab72": "\u13a2", "\uab73": "\u13a3", "\uab74": "\u13a4", "\uab75": "\u13a5", "\uab76": "\u13a6", "\uab77": "\u13a7", "\uab78": "\u13a8", "\uab79": "\u13a9", "\uab7a": "\u13aa", "\uab7b": "\u13ab", "\uab7c": "\u13ac", "\uab7d": "\u13ad", "\uab7e": "\u13ae", "\uab7f": "\u13af", "\uab80": "\u13b0", "\uab81": "\u13b1", "\uab82": "\u13b2", "\uab83": "\u13b3", "\uab84": "\u13b4", "\uab85": "\u13b5", "\uab86": "\u13b6", "\uab87": "\u13b7", "\uab88": "\u13b8", "\uab89": "\u13b9", "\uab8a": "\u13ba", "\uab8b": "\u13bb", "\uab8c": "\u13bc", "\uab8d": "\u13bd", "\uab8e": "\u13be", "\uab8f": "\u13bf", "\uab90": "\u13c0", "\uab91": "\u13c1", "\uab92": "\u13c2", "\uab93": "\u13c3", "\uab94": "\u13c4", "\uab95": "\u13c5", "\uab96": "\u13c6", "\uab97": "\u13c7", "\uab98": "\u13c8", "\uab99": "\u13c9", "\uab9a": "\u13ca", "\uab9b": "\u13cb", "\uab9c": "\u13cc", "\uab9d": "\u13cd", "\uab9e": "\u13ce", "\uab9f": "\u13cf", "\uaba0": "\u13d0", "\uaba1": "\u13d1", "\uaba2": "\u13d2", "\uaba3": "\u13d3", "\uaba4": "\u13d4", "\uaba5": "\u13d5", "\uaba6": "\u13d6", "\uaba7": "\u13d7", "\uaba8": "\u13d8", "\uaba9": "\u13d9", "\uabaa": "\u13da", "\uabab": "\u13db", "\uabac": "\u13dc", "\uabad": "\u13dd", "\uabae": "\u13de", "\uabaf": "\u13df", "\uabb0": "\u13e0", "\uabb1": "\u13e1", "\uabb2": "\u13e2", "\uabb3": "\u13e3", "\uabb4": "\u13e4", "\uabb5": "\u13e5", "\uabb6": "\u13e6", "\uabb7": "\u13e7", "\uabb8": "\u13e8", "\uabb9": "\u13e9", "\uabba": "\u13ea", "\uabbb": "\u13eb", "\uabbc": "\u13ec", "\uabbd": "\u13ed", "\uabbe": "\u13ee", "\uabbf": "\u13ef", "\u13f8": "\u13f0", "\u13f9": "\u13f1", "\u13fa": "\u13f2", "\u13fb": "\u13f3", "\u13fc": "\u13f4", "\u13fd": "\u13f5", "\u1c80": "\u0432", "\u1c81": "\u0434", "\u1c82": "\u043e", "\u1c83": "\u0441", "\u1c84": "\u0442", "\u1c85": "\u0442", "\u1c86": "\u044a", "\u1c87": "\u0463", "\u1c88": "\ua64b", "\u1e96": "h\u0331", "\u1e97": "t\u0308", "\u1e98": "w\u030a", "\u1e99": "y\u030a", "\u1e9a": "a\u02be", "\u1e9b": "\u1e61", "\u1f50": "\u03c5\u0313", "\u1f52": "\u03c5\u0313\u0300", "\u1f54": "\u03c5\u0313\u0301", "\u1f56": "\u03c5\u0313\u0342", "\u1f80": "\u1f00\u03b9", "\u1f81": "\u1f01\u03b9", "\u1f82": "\u1f02\u03b9", "\u1f83": "\u1f03\u03b9", "\u1f84": "\u1f04\u03b9", "\u1f85": "\u1f05\u03b9", "\u1f86": "\u1f06\u03b9", "\u1f87": "\u1f07\u03b9", "\u1f90": "\u1f20\u03b9", "\u1f91": "\u1f21\u03b9", "\u1f92": "\u1f22\u03b9", "\u1f93": "\u1f23\u03b9", "\u1f94": "\u1f24\u03b9", "\u1f95": "\u1f25\u03b9", "\u1f96": "\u1f26\u03b9", "\u1f97": "\u1f27\u03b9", "\u1fa0": "\u1f60\u03b9", "\u1fa1": "\u1f61\u03b9", "\u1fa2": "\u1f62\u03b9", "\u1fa3": "\u1f63\u03b9", "\u1fa4": "\u1f64\u03b9", "\u1fa5": "\u1f65\u03b9", "\u1fa6": "\u1f66\u03b9", "\u1fa7": "\u1f67\u03b9", "\u1fb2": "\u1f70\u03b9", "\u1fb3": "\u03b1\u03b9", "\u1fb4": "\u03ac\u03b9", "\u1fb6": "\u03b1\u0342", "\u1fb7": "\u03b1\u0342\u03b9", "\u1fbe": "\u03b9", "\u1fc2": "\u1f74\u03b9", "\u1fc3": "\u03b7\u03b9", "\u1fc4": "\u03ae\u03b9", "\u1fc6": "\u03b7\u0342", "\u1fc7": "\u03b7\u0342\u03b9", "\u1fd2": "\u03b9\u0308\u0300", "\u1fd3": "\u03b9\u0308\u0301", "\u1fd6": "\u03b9\u0342", "\u1fd7": "\u03b9\u0308\u0342", "\u1fe2": "\u03c5\u0308\u0300", "\u1fe3": "\u03c5\u0308\u0301", "\u1fe4": "\u03c1\u0313", "\u1fe6": "\u03c5\u0342", "\u1fe7": "\u03c5\u0308\u0342", "\u1ff2": "\u1f7c\u03b9", "\u1ff3": "\u03c9\u03b9", "\u1ff4": "\u03ce\u03b9", "\u1ff6": "\u03c9\u0342", "\u1ff7": "\u03c9\u0342\u03b9", "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st", "\ufb13": "\u0574\u0576", "\ufb14": "\u0574\u0565", "\ufb15": "\u0574\u056b", "\ufb16": "\u057e\u0576", "\ufb17": "\u0574\u056d" };
export function normalizeExpression(value) {
    return Array.from(value.normalize('NFKC').toLowerCase().replace(/[\u200B-\u200D\u2060\uFEFF]/gu, ''), char => CASE_FOLD[char] ?? char).join('');
}
function scopeValid(scope) {
    return !!scope && (scope.kind === 'global' || (scope.kind === 'conversation' && bounded(scope.key, EXPRESSION_LIMITS.scopeCodeUnits))
        || (scope.kind === 'persona' && bounded(scope.id, EXPRESSION_LIMITS.scopeCodeUnits)));
}
function applies(scope, input) {
    return scope.kind === 'global' || (scope.kind === 'conversation' ? scope.key === input.conversationKey : scope.id === input.personaId);
}
export function validateExpressionPolicy(policy) {
    if (!policy || !revision(policy.revision) || !Number.isSafeInteger(policy.maxRewrites) || policy.maxRewrites < 0
        || policy.maxRewrites > EXPRESSION_LIMITS.maxRewrites || !Array.isArray(policy.rules)
        || policy.rules.length > EXPRESSION_LIMITS.rules || !Array.isArray(policy.styleContracts)
        || policy.styleContracts.length > EXPRESSION_LIMITS.contracts)
        throw new Error('INVALID_EXPRESSION_POLICY');
    const ids = new Set();
    for (const rule of policy.rules) {
        if (!rule || !/^[a-zA-Z0-9_.:-]{1,96}$/.test(rule.ruleId) || ids.has(rule.ruleId) || !scopeValid(rule.scope)
            || !['exact', 'contains'].includes(rule.match) || !bounded(rule.phrase, EXPRESSION_LIMITS.phraseCodeUnits)
            || !normalizeExpression(rule.phrase).length || !['rewrite', 'blocked'].includes(rule.action) || 'hard' in rule)
            throw new Error('INVALID_EXPRESSION_RULE');
        ids.add(rule.ruleId);
    }
    for (const contract of policy.styleContracts) {
        if (!contract || !/^[a-zA-Z0-9_.:-]{1,96}$/.test(contract.contractId) || ids.has(contract.contractId)
            || !scopeValid(contract.scope) || !bounded(contract.policyText, EXPRESSION_LIMITS.policyCodeUnits)
            || !Array.isArray(contract.counterexamples) || contract.counterexamples.length > EXPRESSION_LIMITS.counterexamples
            || !contract.counterexamples.every((value) => bounded(value, EXPRESSION_LIMITS.exampleCodeUnits)))
            throw new Error('INVALID_STYLE_CONTRACT');
        ids.add(contract.contractId);
    }
}
/** Decisions contain identifiers only, never source text or replacement text. Style contracts are descriptive only. */
export function checkExpression(policy, input) {
    validateExpressionPolicy(policy);
    if (!input || !['social', 'repetition', 'code-result', 'control-ack'].includes(input.kind) || !revision(input.policyRevision)
        || !revision(input.rewriteCount) || typeof input.text !== 'string')
        throw new Error('INVALID_EXPRESSION_INPUT');
    // Code materials and management confirmations do not enter social style checks.
    if (input.kind !== 'social' && input.kind !== 'repetition')
        return { action: 'allow' };
    if (!bounded(input.conversationKey, EXPRESSION_LIMITS.scopeCodeUnits) || !bounded(input.personaId, EXPRESSION_LIMITS.scopeCodeUnits)
        || input.text.length > EXPRESSION_LIMITS.textCodeUnits)
        throw new Error('INVALID_EXPRESSION_INPUT');
    if (input.policyRevision !== policy.revision)
        return { action: 'recheck' };
    const text = normalizeExpression(input.text);
    const matches = policy.rules.filter(rule => applies(rule.scope, input) && (rule.match === 'exact'
        ? text === normalizeExpression(rule.phrase) : text.includes(normalizeExpression(rule.phrase))));
    // Every matching rule applies; no narrower scope can waive a global rule.
    const chosen = matches.find(rule => rule.action === 'blocked') ?? matches[0];
    if (!chosen)
        return { action: 'allow' };
    return { action: chosen.action === 'blocked' || input.rewriteCount >= policy.maxRewrites ? 'blocked' : 'rewrite', ruleId: chosen.ruleId };
}
