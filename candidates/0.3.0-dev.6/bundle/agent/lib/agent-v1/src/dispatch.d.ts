import { DurableOutbox } from './outbox.ts';
import type { BudgetWindow, Delivery } from './outbox.ts';
import { CreationService } from './creation.ts';
import { CodeTasks } from './code-jobs.ts';
import { BotRuntime } from './runtime.ts';
export interface TransportResult {
    status: 'confirmed' | 'failed' | 'unknown';
    receipt: string | null;
    visibility?: 'accepted' | 'pending-review' | 'published';
}
export interface DispatchOptions {
    resolveAccount?(handle: string): string | null;
    isActive?(): boolean;
    sendTimeoutMs?: number;
}
export interface CodeInteractionGate {
    gate(delivery: Delivery): {
        allowed: boolean;
        reason: string;
    };
}
/** Same namespace as ingress/runtime; a raw QQ number or OpenID is never an account lock. */
export declare function canonicalAccount(value: string): string;
/** Single common sender. Transport owns actual platform protocol/capabilities; no implicit fallback. */
export declare class DispatchCoordinator {
    private runtime;
    private creation;
    private code;
    private now;
    readonly outbox: DurableOutbox;
    private options;
    private interactions;
    constructor(runtime: BotRuntime, creation: CreationService, code: CodeTasks, now?: () => number, options?: DispatchOptions);
    /** Trusted Host owns this binding. A second live broker cannot replace it. */
    registerCodeInteractions(service: CodeInteractionGate): () => void;
    private account;
    submitCreation(id: string, expectedRevision: number): unknown;
    enqueueCode(id: string): string;
    private gate;
    dispatch(account: string, owner: string, budget: BudgetWindow | null, send: (entry: Delivery, signal: AbortSignal) => Promise<TransportResult>): Promise<Delivery | null>;
    /** Commit Outbox accounting and all required domain projections in the same transaction. Never sends. */
    reconcile(id: string, outcome: 'confirmed' | 'failed', receipt: string, notSubmitted: boolean, expectedRevision: number, visibility?: 'accepted' | 'pending-review' | 'published'): Delivery;
    private synchronizeOutcome;
}
