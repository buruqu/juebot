import type { Snapshot, StateStore, Transaction } from './store.ts';
import type { TypingConfig } from '../../social-v1/src/typing.ts';
import type { ExpressionPolicy, ExpressionDecision, ExpressionRule } from '../../social-v1/src/expression-policy.ts';
export type Permission = 'receive' | 'save' | 'learn' | 'reply' | 'proactive';
export type Purpose = 'read' | 'learn' | 'draft' | 'publish';
export type PlainExpressionRule = Omit<ExpressionRule, 'scope'>;
export interface PlainStyleContract {
    contractId: string;
    policyText: string;
    counterexamples: string[];
}
export interface Settings {
    permissions: Record<Permission, boolean>;
    prompt: string;
    typing: TypingConfig;
    expressionRules: PlainExpressionRule[];
    styleContracts: PlainStyleContract[];
    participation: number;
}
export interface PolicyPatch {
    mode?: 'isolated' | 'shared';
    memoryMode?: 'inherit' | 'isolated';
    permissions?: Partial<Record<Permission, boolean>>;
    prompt?: string;
    typing?: Partial<TypingConfig>;
    expressionRules?: PlainExpressionRule[];
    styleContracts?: PlainStyleContract[];
    participation?: number;
}
export interface LocalSettings extends Omit<PolicyPatch, 'mode'> {
    memoryMode: 'inherit' | 'isolated';
}
export interface SourceInput {
    id: string;
    conversationKey: string;
    revision: number;
    domain: 'social' | 'code';
    status: 'active' | 'revoked';
    purposes: Purpose[];
    audiences: string[];
    expiresAt: number | null;
}
export interface SourceRef {
    sourceId: string;
    revision: number;
}
export interface MemoryRef {
    memoryId: string;
    revision: number;
}
export interface Sharing {
    approved: boolean;
    approvedBy: string | null;
    ruleRevision: number;
    targets: string[];
    purposes: Purpose[];
    expiresAt: number | null;
}
export interface MemoryInput {
    id: string;
    revision: number;
    conversationKey: string;
    kind: 'knowledge' | 'expression' | 'preference' | 'private';
    text: string;
    sourceRefs: SourceRef[];
    derivedFrom: MemoryRef[];
    sharing: Sharing;
}
export interface MemoryRecord extends MemoryInput {
    status: 'active' | 'revoked';
}
export interface PolicyState {
    mode: 'isolated' | 'shared';
    global: Settings;
    locals: Record<string, LocalSettings>;
    sources: Record<string, SourceInput>;
    memories: Record<string, MemoryRecord>;
}
export interface EffectiveSettings extends Settings {
    memoryMode: 'isolated' | 'shared';
    expressionPolicy: ExpressionPolicy;
    revision: number;
}
export interface ContextRequest {
    conversationKey: string;
    purpose: Purpose;
    query: string;
    now: number;
    maxItems?: number;
    maxChars?: number;
}
export interface ContextTicket {
    schemaVersion: 1;
    botId: string;
    personaId: string;
    revision: number;
    conversationKey: string;
    purpose: Purpose;
    issuedAt: number;
    items: MemoryRecord[];
    sourceEvidence: SourceRef[];
    chars: number;
    bounded: true;
    method: 'keyword';
}
/** Trusted Host service: no model/HTTP/file/driver or account authority is exposed. */
export declare class PolicyMemory {
    private readonly store;
    private readonly stateKey;
    private readonly botId;
    private readonly personaId;
    constructor(store: StateStore, options: {
        botId: string;
        personaId: string;
    });
    private key;
    private read;
    readPolicy(): Snapshot<PolicyState>;
    private change;
    private changeIn;
    private expression;
    private styles;
    private effectiveFrom;
    effective(key: string): EffectiveSettings;
    configure(expectedRevision: number, patch: PolicyPatch, key?: string): Snapshot<PolicyState>;
    checkExpression(key: string, value: string, kind?: 'social' | 'repetition', rewriteCount?: number): ExpressionDecision;
    private purposeList;
    private targets;
    putSource(expectedRevision: number, input: SourceInput): Snapshot<PolicyState>;
    revokeSource(expectedRevision: number, sourceId: string, nextSourceRevision: number): Snapshot<PolicyState>;
    private cascade;
    addMemory(expectedRevision: number, input: MemoryInput): Snapshot<PolicyState>;
    /** Trusted Host only: join a caller-owned transaction without weakening candidate validation. */
    addMemoryIn(tx: Transaction, expectedRevision: number, input: MemoryInput): Snapshot<PolicyState>;
    private readable;
    retrieve(request: ContextRequest): ContextTicket;
    validateTicket(ticket: ContextTicket, now: number): boolean;
    card(key: string, now: number): {
        conversationKey: string;
        personaId: string;
        revision: number;
        mode: 'isolated' | 'shared';
        items: MemoryRecord[];
    };
}
