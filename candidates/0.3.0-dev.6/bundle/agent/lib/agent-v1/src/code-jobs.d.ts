import type { Snapshot, StateStore, Transaction } from './store.ts';
import type { Delivery } from './outbox.ts';
export interface CodeAuthorization {
    revision: number;
    adminActor: string;
    conversationKey: string;
    account: string;
    workspaceId: string;
    sessionId: string;
    modelConfigured: boolean;
    budgetAvailable: boolean;
    sandboxVerified: boolean;
    toolsRestricted: boolean;
    allowedTools: string[];
    verified: boolean;
}
export interface CodeInput {
    eventId: string;
    actor: string;
    conversationKey: string;
    account: string;
    plain: true;
    text: string;
}
export interface CodeTask {
    id: string;
    input: CodeInput;
    authorization: CodeAuthorization;
    createdAt: number;
    updatedAt: number;
    state: 'queued' | 'held' | 'running' | 'needs-review' | 'completed' | 'stopped';
    result: string | null;
    resultDelivery: 'none' | 'ready' | 'held' | 'delivered';
    reason: string;
    recovery?: {
        reviewer: string;
        reason: string;
        at: number;
    };
}
export interface CodeState {
    enabled: boolean;
    authorization: CodeAuthorization | null;
    nextId: number;
    tasks: Record<string, CodeTask>;
}
export interface CodeArchiveMetadata {
    id: string;
    hash: string;
    recordHash?: string;
    eventHash: string;
    state: CodeTask['state'];
    at: number;
}
export interface CodeArchiveRecord {
    task: CodeTask;
    metadata: CodeArchiveMetadata;
    audit: {
        reviewer: string;
        reason: string;
        at: number;
    };
}
export interface CodeArchiveProof {
    domain: 'code';
    revision: number;
    ids: readonly string[];
    hashes: readonly string[];
    items: readonly CodeTask[];
    reviewer: string;
    reason: string;
    at: number;
}
export interface CodeArchiveOptions {
    expectedRevision: number;
    reviewer: string;
    reason: string;
    now: number;
    authorize(proof: Readonly<CodeArchiveProof>): boolean;
}
export interface CodeExecutorContext {
    task: CodeTask;
    signal: AbortSignal;
    gateTool(tool: string): void;
    gateModel(): void;
}
export type CodeExecutor = (context: CodeExecutorContext) => Promise<string>;
export interface CodeTasksOptions {
    getAuthorization: () => CodeAuthorization | null;
    namespace?: string;
}
/** Persistent Code domain. This service owns no shell, model, network or filesystem. */
export declare class CodeTasks {
    private readonly store;
    private readonly getAuthorization;
    private readonly key;
    private recoveryRequired;
    private readonly executions;
    constructor(store: StateStore, options: CodeTasksOptions);
    private read;
    snapshot(): Snapshot<CodeState>;
    private change;
    private authorization;
    private ready;
    private task;
    private archiveIndexKey;
    private archiveKey;
    private archivedEventKey;
    private cold;
    get(id: string): CodeTask;
    readArchive(id: string): CodeArchiveRecord;
    listArchives(options?: {
        offset?: number;
        limit?: number;
    }): CodeArchiveMetadata[];
    inspectArchive(ids: string[]): {
        revision: number;
        items: CodeArchiveMetadata[];
    };
    archive(ids: string[], options: CodeArchiveOptions): CodeArchiveMetadata[];
    archiveIn(tx: Transaction, ids: string[], options: CodeArchiveOptions): CodeArchiveMetadata[];
    list(): CodeTask[];
    /** Trusted Host recovery composes this with session retirement in one transaction.
     * It never requeues the original request or changes its recipient/workspace. */
    abandonIn(tx: Transaction, id: string, options: {
        expectedRevision: number;
        reviewer: string;
        reason: string;
        now: number;
    }): CodeTask;
    enable(now: number): Snapshot<CodeState>;
    disable(now: number): Snapshot<CodeState>;
    admit(input: CodeInput, now: number): {
        task: CodeTask;
        duplicate: boolean;
    };
    start(id: string, now: number): CodeTask;
    finish(id: string, result: string, now: number): CodeTask;
    /** Root may hand this result to its unique Outbox. No social learning is performed. */
    takeResult(id: string): {
        id: string;
        task: CodeTask;
        result: string;
    };
    markResultDelivered(id: string, now: number): CodeTask;
    /** Record an already-sent fact, including after restart/revocation. This cannot authorize a new send. */
    markResultDeliveredIn(tx: Transaction, id: string, now: number, delivery: Readonly<Delivery>): CodeTask;
    /** Explicit Host review after restart/revocation; never changes the private recipient or workspace. */
    releaseResult(id: string, now: number): CodeTask;
    stop(id: string, now: number): CodeTask;
    restart(now: number): Snapshot<CodeState>;
    resume(id: string, strategy: 'requeue' | 'keep-held', now: number): CodeTask;
    execute(id: string, executor?: CodeExecutor, options?: {
        signal?: AbortSignal;
        now?: () => number;
    }): Promise<CodeTask>;
}
