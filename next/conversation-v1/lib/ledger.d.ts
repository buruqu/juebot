import type { AppendResult, ConversationIdentity, ConversationRecord, EventInput, LedgerReader, SqliteDatabase, StoredEvent } from './contracts.ts';
export declare const CONVERSATION_APPLICATION_ID = 1247102275;
export declare const CONVERSATION_SCHEMA_VERSION = 1;
/** Injected SQLite only. No filesystem, profile lookup, driver import or caller-owned DB close. */
export declare class ConversationLedger implements LedgerReader {
    private closed;
    private readonly db;
    constructor(db: SqliteDatabase, options: {
        namespace: string;
        initialize?: boolean;
    });
    private verifySchema;
    private assertOpen;
    private transaction;
    private lookup;
    private requireBinding;
    registerConversation(identity: ConversationIdentity, bindingRevision: number, now: number): ConversationRecord;
    changeBinding(key: string, expectedRevision: number, nextRevision: number, now: number): ConversationRecord;
    append(input: EventInput): AppendResult;
    private bodyFor;
    getConversation(key: string): ConversationRecord | null;
    listConversations(keys: readonly string[], afterKey: string | null, limit: number): ConversationRecord[];
    pageEvents(key: string, bindingRevision: number, afterSequence: number, limit: number): StoredEvent[];
    readBody(key: string, bindingRevision: number, sequence: number): string | null;
    close(): void;
}
