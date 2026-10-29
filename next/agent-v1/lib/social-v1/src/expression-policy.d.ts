/** Trusted Host pure policy logic. No CRUD, storage, model, network or semantic classifier. */
export type ExpressionScope = {
    kind: 'global';
} | {
    kind: 'conversation';
    key: string;
} | {
    kind: 'persona';
    id: string;
};
export interface ExpressionRule {
    ruleId: string;
    scope: ExpressionScope;
    match: 'exact' | 'contains';
    phrase: string;
    action: 'rewrite' | 'blocked';
}
export interface StyleContract {
    contractId: string;
    scope: ExpressionScope;
    policyText: string;
    counterexamples: readonly string[];
}
export interface ExpressionPolicy {
    revision: number;
    rules: readonly ExpressionRule[];
    styleContracts: readonly StyleContract[];
    maxRewrites: number;
}
export interface ExpressionInput {
    kind: 'social' | 'repetition' | 'code-result' | 'control-ack';
    text: string;
    conversationKey: string;
    personaId: string;
    policyRevision: number;
    rewriteCount: number;
}
export type ExpressionDecision = {
    action: 'allow' | 'recheck';
} | {
    action: 'rewrite' | 'blocked';
    ruleId: string;
};
export declare const EXPRESSION_LIMITS: Readonly<{
    rules: 128;
    phraseCodeUnits: 256;
    textCodeUnits: 32000;
    contracts: 32;
    policyCodeUnits: 4000;
    counterexamples: 8;
    exampleCodeUnits: 512;
    scopeCodeUnits: 512;
    maxRewrites: 5;
}>;
export declare const EMPTY_EXPRESSION_POLICY: Readonly<ExpressionPolicy>;
export declare function normalizeExpression(value: string): string;
export declare function validateExpressionPolicy(policy: ExpressionPolicy): void;
/** Decisions contain identifiers only, never source text or replacement text. Style contracts are descriptive only. */
export declare function checkExpression(policy: ExpressionPolicy, input: ExpressionInput): ExpressionDecision;
