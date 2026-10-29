import type { StateStore, Transaction } from './store.ts';
export declare const DELIVERY_RECEIPT_MAX = 1024;
export type DeliveryProjection = (tx: Transaction, item: Readonly<Delivery>) => void;
export interface RevisionVector {
    binding: number;
    policy: number;
    memory: number;
    identity: number;
    expression: number;
}
export interface Outgoing {
    id: string;
    account: string;
    conversation: string;
    kind: 'social' | 'repetition' | 'code-result' | 'code-interaction' | 'creation';
    body: string;
    payload: unknown;
    revisions: RevisionVector;
    sourceRefs: {
        id: string;
        revision: number;
    }[];
    createdAt: number;
    dueAt: number;
    expiresAt: number;
    costUnits: number;
}
export interface Delivery extends Outgoing {
    sequence: number;
    status: 'queued' | 'sending' | 'confirmed' | 'failed' | 'unknown' | 'held' | 'cancelled';
    reason: string;
    claim: string | null;
    leaseUntil: number | null;
    receipt: string | null;
    charged: boolean;
    budgetWindow: string | null;
}
export interface BudgetWindow {
    id: string;
    limit: number;
}
export interface SendGate {
    allowed: boolean;
    reason: string;
}
export interface OutboxArchiveMetadata {
    id: string;
    hash: string;
    recordHash?: string;
    status: Delivery['status'];
    sequence: number;
    at: number;
}
export interface OutboxArchiveRecord {
    delivery: Delivery;
    metadata: OutboxArchiveMetadata;
    audit: {
        reviewer: string;
        reason: string;
        at: number;
    };
}
export interface OutboxArchiveProof {
    domain: 'outbox';
    revision: number;
    ids: readonly string[];
    hashes: readonly string[];
    items: readonly Delivery[];
    reviewer: string;
    reason: string;
    at: number;
}
export interface OutboxArchiveOptions {
    expectedRevision: number;
    reviewer: string;
    reason: string;
    now: number;
    authorize(proof: Readonly<OutboxArchiveProof>): boolean;
}
export declare class DurableOutbox {
    private store;
    constructor(store: StateStore);
    list(): Delivery[];
    private archiveKey;
    private cold;
    get(id: string): Delivery;
    readArchive(id: string): OutboxArchiveRecord;
    listArchives(options?: {
        offset?: number;
        limit?: number;
    }): OutboxArchiveMetadata[];
    inspectArchive(ids: string[]): {
        revision: number;
        items: OutboxArchiveMetadata[];
    };
    archive(ids: string[], options: OutboxArchiveOptions): OutboxArchiveMetadata[];
    archiveIn(tx: Transaction, ids: string[], options: OutboxArchiveOptions): OutboxArchiveMetadata[];
    state(): {
        revision: number;
        paused: boolean;
        pausedAccounts: string[];
    };
    setPause(expectedRevision: number, paused: boolean, accounts?: string[]): void;
    enqueue(input: Outgoing): string;
    /** For creation approval consumption and enqueue to commit in one transaction. */
    enqueueIn(tx: Transaction, input: Outgoing): string;
    claim(account: string, owner: string, now: number, leaseMs: number, budget: BudgetWindow | null, gate: (item: Delivery) => SendGate): Delivery | null;
    finish(id: string, claim: string, now: number, outcome: 'confirmed' | 'failed' | 'unknown', receipt: string | null, accounting?: 'spent' | 'not-submitted', project?: DeliveryProjection): Delivery;
    /** Trusted operator/platform reconciliation with an external evidence id; never automatically retries unknown. */
    releaseUnsent(id: string, claim: string, now: number, reason: string): Delivery;
    /** Trusted operator/platform reconciliation with an external evidence id; never automatically retries unknown. */
    reconcile(id: string, outcome: 'confirmed' | 'failed', proof: string, accounting?: 'spent' | 'not-submitted', expectedRevision?: number, project?: DeliveryProjection): Delivery;
    private project;
    private settle;
    cancel(id: string): void;
    recover(): void;
}
