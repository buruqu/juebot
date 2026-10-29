import type { CorePolicy } from './contracts.ts';
import type { MemoryContext, MemoryRecord, SharingGrant } from './memory.ts';
/** Minimal synchronous SQLite port; the native driver stays outside the portable core. */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;
export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): {
        get(...values: SqlValue[]): SqlRow | undefined;
        all(...values: SqlValue[]): SqlRow[];
        run(...values: SqlValue[]): {
            changes: number | bigint;
        };
    };
    close(): void;
}
export declare const STORAGE_APPLICATION_ID = 1247102274;
export declare const STORAGE_SCHEMA_VERSION = 1;
export type MemoryView = Readonly<{
    record: MemoryRecord;
    body: string;
    revision: number;
}>;
export type VisibleMemory = Readonly<{
    allowed: true;
    value: MemoryView;
}> | Readonly<{
    allowed: false;
    reason: string;
}>;
export type VectorSpace = Readonly<{
    provider: string;
    model: string;
    generation: number;
    dimensions: number;
}>;
export type SearchMatch = Readonly<{
    value: MemoryView;
    score: number;
}>;
export type SearchResult = Readonly<{
    method: 'fts5-trigram' | 'substring' | 'exact-cosine';
    bounded: true;
    matches: readonly SearchMatch[];
}>;
/**
 * Trusted Host storage API, NOT a QQ/RPC/model tool. Owns its connection after construction.
 * Records/provenance/grants must be authored by trusted application code. No timers, networking,
 * automatic task execution, history import, or restart/queue policy is provided here.
 */
export declare class MemoryStore {
    #private;
    constructor(db: SqliteDatabase, botId: string, options?: {
        initialize?: boolean;
    });
    stateRevision(): number;
    metadata(id: string): {
        record: MemoryRecord;
        revision: number;
    } | undefined;
    /** null expectedRevision creates only; updates require the observed positive revision. */
    put(recordInput: MemoryRecord, body: string, expectedRevision: number | null, policyInput: CorePolicy): number;
    putGrant(input: SharingGrant, expectedRevision: number | null): number;
    tombstone(id: string, expectedRevision: number): number;
    getVisible(id: string, contextInput: MemoryContext, policyInput: CorePolicy): VisibleMemory;
    searchText(query: string, contextInput: MemoryContext, policyInput: CorePolicy, limit?: number, scanLimit?: number): SearchResult;
    putVector(id: string, spaceInput: VectorSpace, values: readonly number[], expectedRevision: number, policyInput: CorePolicy): void;
    searchVector(spaceInput: VectorSpace, values: readonly number[], contextInput: MemoryContext, policyInput: CorePolicy, limit?: number, scanLimit?: number): SearchResult;
    close(): void;
}
