import type { Delivery } from './outbox.ts';
import type { DispatchCoordinator } from './dispatch.ts';
export interface DeliveryEvidence {
    deliveryId: string;
    account: string;
    fingerprint: string;
    outcome: 'confirmed' | 'failed';
    receipt: string;
    notSubmitted: boolean;
    visibility?: 'accepted' | 'pending-review' | 'published';
}
export interface ReconciliationDependencies {
    authorizeHuman(principal: string): boolean;
    /** Trusted, read-only platform evidence query. A UI-supplied conclusion is never evidence. */
    query?(item: Readonly<Delivery>, signal: AbortSignal): Promise<DeliveryEvidence | null>;
    timeoutMs?: number;
}
export declare const deliveryFingerprint: (item: Delivery) => string;
export declare class DeliveryReconciler {
    private dispatcher;
    private deps;
    constructor(dispatcher: DispatchCoordinator, deps: ReconciliationDependencies);
    reconcile(id: string, expectedRevision: number, principal: string, beforeCommit?: () => Promise<void>): Promise<{
        id: string;
        status: string;
        revision: number;
        reason: string;
    }>;
}
