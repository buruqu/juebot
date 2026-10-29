/** Offline conversation ledger contracts. Host supplies identities and permissions. */
export declare const LIMITS: Readonly<{
    id: 256;
    body: 16000;
    grants: 128;
    page: 100;
}>;
export type ErrorCode = 'INVALID_INPUT' | 'STORE_NOT_INITIALIZED' | 'STORE_MISMATCH' | 'STORE_CLOSED' | 'CONVERSATION_NOT_FOUND' | 'BINDING_CONFLICT' | 'EVENT_CONFLICT' | 'SOURCE_NOT_FOUND' | 'ACCESS_DENIED' | 'ACCESS_CHANGED' | 'INVALID_CURSOR' | 'STORAGE_FAILURE';
export declare class ConversationError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode);
}
export declare function demand(ok: unknown, code?: ErrorCode): asserts ok;
export declare function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown>;
export declare function id(value: unknown, max?: number): asserts value is string;
export declare function integer(value: unknown, min?: number, max?: number): asserts value is number;
export interface ConversationIdentity {
    botId: string;
    personaId: string;
    connector: 'qq-personal' | 'qq-official' | 'bilibili' | 'local-test';
    issuer: string;
    accountId: string;
    kind: 'group' | 'direct' | 'thread';
    remoteId: string;
}
export interface ConversationRecord {
    key: string;
    identity: ConversationIdentity;
    bindingRevision: number;
    createdAt: number;
    updatedAt: number;
}
export declare const EVENT_TYPES: readonly ["message.received", "reply.draft", "decision.recorded", "reply.submitted", "reply.confirmed", "reply.failed", "reply.unknown", "policy.changed"];
export declare const REASONS: readonly ["NONE", "NOT_INTERESTED", "EXPRESSION_BLOCKED", "OUTBOUND_PAUSED", "POLICY_CHANGED", "MODEL_ERROR", "TOOL_ERROR", "DELIVERY_UNCERTAIN"];
export interface EventInput {
    conversationKey: string;
    bindingRevision: number;
    sourceEventId: string;
    occurredAt: number;
    eventType: typeof EVENT_TYPES[number];
    reasonCode: typeof REASONS[number];
    actorId: string | null;
    runId: string | null;
    causedBy: number | null;
    body: string | null;
}
export interface StoredEvent extends Omit<EventInput, 'body'> {
    sequence: number;
    bodyRef: number | null;
}
export interface AppendResult {
    event: StoredEvent;
    duplicate: boolean;
}
export declare function validateEvent(value: unknown): asserts value is EventInput;
export interface Statement {
    run(...args: (string | number | null)[]): unknown;
    get(...args: (string | number | null)[]): unknown;
    all(...args: (string | number | null)[]): unknown[];
}
export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): Statement;
}
export interface LedgerReader {
    getConversation(key: string): ConversationRecord | null;
    listConversations(keys: readonly string[], afterKey: string | null, limit: number): ConversationRecord[];
    pageEvents(key: string, bindingRevision: number, afterSequence: number, limit: number): StoredEvent[];
    readBody(key: string, bindingRevision: number, sequence: number): string | null;
}
export interface ConversationGrant {
    key: string;
    bindingRevision: number;
    metadata: boolean;
    body: boolean;
}
export interface AccessSnapshot {
    revision: number;
    grants: readonly ConversationGrant[];
}
export type AccessProvider = (principal: string) => Promise<AccessSnapshot>;
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}
