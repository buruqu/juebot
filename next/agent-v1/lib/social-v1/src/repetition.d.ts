/** Offline +1 candidate detection only. No sends, QQ +1 API, attachments, models or storage.
 * Host snapshots are not send authorization: candidates must still pass source/privacy,
 * expression and outbound checks before any separately implemented delivery.
 * Copy-paste repetition adds no typing delay and bypasses the artificial typing queue.
 */
export interface RepetitionConversationKey {
    namespace: string;
    opaqueId: string;
    accountKey: string;
    bindingRevision: number;
}
export interface RepetitionEvent {
    conversationKey: RepetitionConversationKey;
    id: string;
    actorKey: string;
    actorVerified: boolean;
    observedAt: number;
    senderKind: 'human' | 'bot' | 'unknown';
    kind: 'text' | 'image' | 'attachment' | 'other';
    text: string;
}
export interface RepetitionContext {
    conversationKey: RepetitionConversationKey;
    conversationKind: 'group' | 'direct';
    wantsToRepeat: boolean;
    enabled: boolean;
    outboundAllowed: boolean;
    botActorKey: string;
    now: number;
    lastAttemptAt: number | null;
}
export interface RepetitionConfig {
    windowEvents: number;
    windowMs: number;
    minOccurrences: number;
    minDistinctHumans: number;
    cooldownMs: number;
}
/** Tunable product assumptions, not a claim about natural group behavior. */
export declare const DEFAULT_REPETITION_CONFIG: Readonly<RepetitionConfig>;
export declare const REPETITION_LIMITS: Readonly<{
    inputEvents: 1000;
    textCodeUnits: 4000;
    keyCodeUnits: 512;
    idCodeUnits: 256;
}>;
export type RepetitionSkipReason = 'invalid-input' | 'invalid-config' | 'clock-anomaly' | 'disabled' | 'not-group' | 'not-wanted' | 'outbound-blocked' | 'cooldown' | 'no-events' | 'wrong-conversation' | 'ineligible-anchor' | 'duplicate-anchor' | 'expired-anchor' | 'insufficient-repetition' | 'insufficient-humans';
export type RepetitionDecision = {
    action: 'candidate';
    text: string;
    sourceEventIds: string[];
} | {
    action: 'skip';
    reason: RepetitionSkipReason;
};
export declare function considerRepetition(events: readonly RepetitionEvent[], context: RepetitionContext, options?: Partial<RepetitionConfig>): RepetitionDecision;
