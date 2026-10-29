/** Pure domain contracts. None of these fields proves a real QQ connection or OS permission. */
export type IdentityMode = 'juejue' | 'persona';
export type Conversation = Readonly<{
    kind: 'private' | 'group';
    id: string;
}>;
export type Permissions = Readonly<{
    receive: boolean;
    save: boolean;
    learn: boolean;
    send: boolean;
}>;
export type ChannelRule = Readonly<{
    conversation: Conversation;
    permissions: Permissions;
}>;
export type CorePolicy = Readonly<{
    botId: string;
    connectionId: string;
    channels: readonly ChannelRule[];
}>;
/** Supplied by a future trusted connector, NOT copied from the message body. */
export type TransportContext = Readonly<{
    connectionId: string;
    selfId: string;
}>;
/** Internal normalized input, NOT the unverified SnowLuma wire schema. */
export type InboundMessage = Readonly<{
    eventId: string;
    senderId: string;
    conversation: Conversation;
    text: string;
    form: 'plain' | 'quoted' | 'forwarded' | 'mixed';
}>;
/** Host-only assertions; a future adapter must independently verify and enforce each one. */
export type CodeAuthorization = Readonly<{
    id: string;
    workspace: string;
    sessionId: string;
    modelConfigured: boolean;
    budgetAvailable: boolean;
    sandboxVerified: boolean;
    toolsRestricted: boolean;
}>;
export type Gate = Readonly<{
    allowed: true;
}> | Readonly<{
    allowed: false;
    reason: string;
}>;
export declare const ALLOW: Gate;
export declare function deny(reason: string): Gate;
export declare class CoreError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function requireCondition(value: unknown, code: string): asserts value;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function isId(value: unknown): value is string;
export declare function isQQId(value: unknown): value is string;
export declare function isConversation(value: unknown): value is Conversation;
export declare function sameConversation(a: Conversation, b: Conversation): boolean;
export declare function channelKey(channel: Conversation): string;
export declare function permissionsFor(policy: CorePolicy, channel: Conversation): Permissions | undefined;
/** Defensive snapshot: changes to callers' objects cannot change an admitted task's policy. */
export declare function snapshotPolicy(policy: CorePolicy): CorePolicy;
export declare function normalizeMessage(value: unknown): InboundMessage | undefined;
