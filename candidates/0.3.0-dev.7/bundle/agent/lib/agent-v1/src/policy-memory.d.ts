import type { CreationAction, CreationTarget } from './creation.ts';
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
export interface ContactPolicy {
    timeZoneOffsetMinutes: number;
    windows: {
        startMinute: number;
        endMinute: number;
    }[];
    cooldownMs: number;
    dailyLimit: number;
    unansweredLimit: number;
}
export interface Settings {
    permissions: Record<Permission, boolean>;
    prompt: string;
    typing: TypingConfig;
    expressionRules: PlainExpressionRule[];
    styleContracts: PlainStyleContract[];
    participation: number;
    contactPolicy?: ContactPolicy | null;
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
    contactPolicy?: ContactPolicy | null;
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
export interface SummaryMaterialRequest {
    action: CreationAction;
    accountId: string;
    target: CreationTarget;
}
export interface SummaryMaterialApproval extends SummaryMaterialRequest {
    sourceId: string;
    revision: 1;
    topic: string;
    memoryId: string;
    memoryRevision: number;
    key: string;
    principal: string;
    reason: string;
    approvedAt: number;
    expiresAt: number;
}
export interface ApproveSummaryMaterialInput extends SummaryMaterialRequest {
    memoryId: string;
    expectedMemoryRevision: number;
    key: string;
    principal: string;
    reason: string;
    expiresAt: number;
    includePrivate?: boolean;
}
export interface SummaryMaterialRecord extends SummaryMaterialApproval {
    text: string;
    sourceRefs: SourceRef[];
    includePrivate: boolean;
}
export interface PolicyState {
    mode: 'isolated' | 'shared';
    global: Settings;
    locals: Record<string, LocalSettings>;
    sources: Record<string, SourceInput>;
    memories: Record<string, MemoryRecord>;
    /** Human approval of this exact summary, never an authorization to disclose raw source text. */
    summaryApprovals?: Record<string, {
        memoryRevision: number;
        sourceRefs: SourceRef[];
        principal: string;
        reason: string;
        at: number;
    }>;
    memoryReviews?: {
        id: string;
        fromRevision: number;
        toRevision: number;
        action: string;
        principal: string;
        reason: string;
        at: number;
    }[];
    summaryMaterials?: Record<string, SummaryMaterialRecord>;
}
export interface EffectiveSettings extends Settings {
    contactPolicies: ContactPolicy[];
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
    /** Reviewed stream limits can narrow, never extend, the current Host capability. */
    restrictParticipation<T extends ContactPolicy>(key: string, host: T): T;
    configure(expectedRevision: number, patch: PolicyPatch, key?: string): Snapshot<PolicyState>;
    checkExpression(key: string, value: string, kind?: 'social' | 'repetition', rewriteCount?: number): ExpressionDecision;
    private purposeList;
    private targets;
    private materialRequest;
    private summaryOrigin;
    /** Trusted reviewed summary grant. This never broadens any original source or authorizes a send. */
    approveSummaryMaterial(expectedPolicyRevision: number, input: ApproveSummaryMaterialInput, now: number): SummaryMaterialApproval;
    isSummaryMaterial(sourceId: string): boolean;
    /** Runtime observation may recognize an approved summary without granting it learning authority. */
    validateSummarySource(sourceId: string, key: string, revision: number, now: number): boolean;
    private summarySourceCurrent;
    resolveSummaryMaterial(sourceId: string, key: string, request: SummaryMaterialRequest, now: number): {
        id: string;
        revision: number;
        text: string;
    } | null;
    putSource(expectedRevision: number, input: SourceInput): Snapshot<PolicyState>;
    revokeSource(expectedRevision: number, sourceId: string, nextSourceRevision: number): Snapshot<PolicyState>;
    private cascade;
    addMemory(expectedRevision: number, input: MemoryInput): Snapshot<PolicyState>;
    reviewMemory(expectedRevision: number, input: {
        id: string;
        expectedMemoryRevision: number;
        principal: string;
        reason: string;
        action: 'share' | 'unshare' | 'correct' | 'revoke';
        targets?: string[];
        purposes?: Purpose[];
        expiresAt?: number | null;
        text?: string;
        includePrivate?: boolean;
    }, now: number): Snapshot<PolicyState>;
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
