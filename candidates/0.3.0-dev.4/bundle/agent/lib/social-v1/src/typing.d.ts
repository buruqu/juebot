/** Offline timing assumptions, not measurements of human typing. No timers or I/O. */
export interface TypingConfig {
    enabled: boolean;
    charsPerSecond: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitterFraction: number;
    maxGraphemes: number;
    maxCodeUnits: number;
}
export type MessageKind = 'social' | 'code-result' | 'control-ack';
export declare const DEFAULT_TYPING_CONFIG: Readonly<TypingConfig>;
export declare function validateTypingConfig(config: TypingConfig): void;
export interface TypingPlan {
    graphemes: number;
    delayMs: number;
}
export declare function planTyping(text: string, kind: MessageKind | 'repetition', config?: TypingConfig, sample?: () => number): TypingPlan;
export interface ConversationKey {
    namespace: string;
    opaqueId: string;
    accountKey: string;
    bindingRevision: number;
}
export interface QueuedMessage {
    conversation: ConversationKey;
    text: string;
    kind: MessageKind;
    policyRevision: number;
}
export interface ClaimChecks {
    bindingRevision: number;
    policyRevision: number;
    outboundAllowed: boolean;
    /** Stops new Code work only. It does not revoke an existing code-result. */
    codeEnabled?: boolean;
}
export interface LocalClaim {
    id: number;
    message: QueuedMessage;
    dueAt: number;
}
export type ClaimResult = {
    status: 'empty' | 'waiting' | 'in-flight';
} | {
    status: 'recheck';
    id: number;
    policyRevision: number;
} | {
    status: 'cancelled';
    id: number;
    reason: 'cancelled' | 'binding-changed' | 'policy-changed' | 'outbound-blocked';
} | {
    status: 'blocked';
    id: number;
    reason: 'binding-changed' | 'policy-changed' | 'outbound-blocked';
} | {
    status: 'claimed';
    claim: LocalClaim;
};
/** All kinds preserve conversation FIFO; UI control acknowledgements should bypass this queue.
 * In-memory FIFO. A claim is local and single-use; no external delivery guarantee. */
export declare class TypingQueue {
    private readonly queues;
    private readonly config;
    private nextId;
    private count;
    private readonly capacity;
    constructor(capacity?: number, config?: TypingConfig);
    get size(): number;
    enqueue(message: QueuedMessage, now: number, sample?: () => number): LocalClaim;
    cancel(key: ConversationKey, id: number): boolean;
    claim(key: ConversationKey, now: number, checks: ClaimChecks): ClaimResult;
    /** Trusted Host only: invoke after the exact original text passes the latest expression policy.
     * Rewrites must cancel the social draft and enqueue the checked replacement as a new item.
     * This does not itself perform expression checks or authorize outbound delivery.
     */
    revalidateSocial(key: ConversationKey, id: number, checked: {
        policyRevision: number;
        checkedText: string;
    }): boolean;
    /** Call after the consumer resolves its own delivery outcome. No retry is automatic. */
    complete(key: ConversationKey, id: number): boolean;
    private remove;
    private copy;
}
