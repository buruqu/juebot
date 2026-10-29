import type { AccessProvider, ConversationRecord, LedgerReader, Page, StoredEvent } from './contracts.ts';
export interface ReadOptions {
    limit?: number;
    cursor?: string;
}
/** No write, model or network methods. Cursors are untrusted positions, never authorization. */
export declare class ConversationReadService {
    private readonly ledger;
    private readonly access;
    constructor(ledger: LedgerReader, access: AccessProvider);
    private before;
    private after;
    list(principal: string, input?: ReadOptions): Promise<Page<ConversationRecord>>;
    events(principal: string, key: string, input?: ReadOptions): Promise<Page<StoredEvent>>;
    body(principal: string, key: string, sequence: number): Promise<{
        sequence: number;
        text: string;
    }>;
}
