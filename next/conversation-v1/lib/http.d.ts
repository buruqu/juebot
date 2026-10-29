import type { ConversationRecord, Page, StoredEvent } from './contracts.ts';
/** Injectable application boundary. Authentication must come from the Host, never request claims. */
export interface ConversationHttpReader {
    list(principal: string, options: {
        limit?: number;
        cursor?: string;
    }): Promise<Page<ConversationRecord>>;
    events(principal: string, key: string, options: {
        limit?: number;
        cursor?: string;
    }): Promise<Page<StoredEvent>>;
    body(principal: string, key: string, sequence: number): Promise<{
        sequence: number;
        text: string;
    }>;
}
export interface ConversationHttpDependencies {
    reader: ConversationHttpReader;
    resolvePrincipal(request: Request): Promise<string | null>;
}
/** Offline read-only WHATWG handler. Does not listen, register a Host route, or authorize a platform action. */
export declare function createConversationHttp({ reader, resolvePrincipal }: ConversationHttpDependencies): (request: Request) => Promise<Response>;
