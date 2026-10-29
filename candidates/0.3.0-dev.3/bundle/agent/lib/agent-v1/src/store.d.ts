import type { SqliteDatabase } from '../../conversation-v1/src/contracts.ts';
export interface Snapshot<T> {
    revision: number;
    value: T;
}
export interface Transaction {
    read<T>(key: string): Snapshot<T> | null;
    write<T>(key: string, expectedRevision: number, value: T): Snapshot<T>;
}
export interface StateStore {
    read<T>(key: string): Snapshot<T> | null;
    atomic<T>(fn: (tx: Transaction) => T): T;
}
export declare const AGENT_APPLICATION_ID = 1247102273;
/** Caller owns this connection. No path opening, profile lookup, timer, network or migration. */
export declare class SqliteStateStore implements StateStore {
    private db;
    private closed;
    private active;
    constructor(db: SqliteDatabase, options: {
        namespace: string;
        initialize?: boolean;
    });
    private open;
    read<T>(key: string): Snapshot<T> | null;
    atomic<T>(work: (tx: Transaction) => T): T;
    close(): void;
}
