import type { Snapshot, StateStore, Transaction } from './store.ts';
import type { SelfScope, SourceRef } from './self-growth.ts';
export type CreationAction = 'qqspace' | 'bili.comment' | 'bili.reply' | 'bili.dynamic' | 'bili.video';
export type CreationStage = 'intention' | 'brief' | 'script' | 'assets' | 'final-review' | 'rejected' | 'approved' | 'submission';
export interface CreationTarget {
    objectId: string | null;
    parentId: string | null;
    visibility: string;
    category: string | null;
}
export interface CreationSource {
    id: string;
    revision: number;
    personLinkRevision: number | null;
}
export interface AssetReference {
    ref: string;
    sha256: string;
    previewRef: string;
}
export interface TrustedAsset extends AssetReference {
    kind: 'video' | 'audio' | 'subtitles' | 'image';
    ready: boolean;
}
export interface FinalManifest {
    accountId: string;
    target: CreationTarget;
    title: string;
    description: string;
    tags: string[];
    text: string;
    video: AssetReference | null;
    audio: AssetReference[];
    subtitles: AssetReference[];
    cover: AssetReference | null;
    attachments: AssetReference[];
}
export interface CreationAuthority {
    policyRevision: number;
    accountRevision: number;
    publishAllowed: boolean;
    /** Active Host persona/identity configuration revision; omitted only for independent legacy callers. */
    contextRevision?: number;
    sources: (CreationSource & {
        publishAllowed: boolean;
    })[];
}
export interface FinalWorkSnapshot {
    workId: string;
    action: CreationAction;
    version: number;
    manifest: FinalManifest;
    manifestHash: string;
    sources: CreationSource[];
    policyRevision: number;
    accountRevision: number;
    contextRevision: number;
}
export interface CreationApproval {
    principal: string;
    approvedAt: number;
    expiresAt: number;
    snapshotHash: string;
}
export type SubmissionState = 'queued' | 'unknown' | 'accepted' | 'pending-review' | 'published' | 'failed' | 'removed';
export interface CreationSubmission {
    intentId: string;
    state: SubmissionState;
    platformObjectId: string | null;
}
export type WorkflowFailure = 'INTENTION_UNAVAILABLE' | 'POLICY_CHANGED' | 'MATERIALS_CHANGED' | 'INVALID_PLAN' | 'PLAN_FAILED' | 'PRODUCTION_FAILED' | 'CREATION_FAILED' | 'HUMAN_ABANDONED';
export interface CreativeRecoveryAudit {
    decision: 'recover' | 'abandon';
    principal: string;
    reason: string;
    at: number;
    fromRevision: number;
    phase: CreationWorkflowState['phase'];
}
export interface CreationWorkflowState {
    selfScope: SelfScope;
    intentionSources: SourceRef[];
    identityRevision: number;
    growthVersion: string;
    modelVersion: string;
    mode: 'juejue' | 'persona';
    intentId: string;
    phase: 'planning' | 'producing' | 'ready' | 'failed';
    reasonCode: WorkflowFailure | null;
    policyRevision: number;
    materialsRevision: number | null;
    publication: Pick<FinalManifest, 'title' | 'description' | 'tags' | 'text'> | null;
}
export interface CreationWork {
    id: string;
    action: CreationAction;
    stage: CreationStage;
    version: number;
    intention: string;
    brief: string | null;
    script: string | null;
    accountId: string;
    target: CreationTarget;
    sources: CreationSource[];
    assets: AssetReference[];
    final: FinalWorkSnapshot | null;
    approval: CreationApproval | null;
    submission: CreationSubmission | null;
    workflow: CreationWorkflowState | null;
    review: {
        decision: 'rejected' | 'changes-requested' | 'revoked';
        reason: string;
        principal: string;
        rejectedManifestHash: string | null;
    } | null;
}
export interface CreateWorkInput {
    id: string;
    action: CreationAction;
    intention: string;
    accountId: string;
    target: CreationTarget;
    sources: CreationSource[];
}
export interface CreationDependencies {
    now(): number;
    /** Host-owned identity check. Model arguments cannot supply or override this verifier. */
    authorizeHuman(principal: string): boolean;
    resolveAsset(ref: string): TrustedAsset | null;
    currentAuthority(work: Readonly<CreationWork>): CreationAuthority;
    /** Trusted Host checks current source authorization and self context, without applying intention launch expiry. */
    validateWorkflow?(work: Readonly<CreationWork>): boolean;
    productionProvider?: {
        produce(work: Readonly<CreationWork>): Promise<FinalManifest>;
    };
}
export interface SubmissionSnapshot extends FinalWorkSnapshot {
    workId: string;
    action: CreationAction;
    approval: CreationApproval;
}
export interface CreationSubmitResult {
    intentId: string;
    duplicate: boolean;
    work: Snapshot<CreationWork>;
}
export interface CreationSummary {
    id: string;
    revision: number;
    action: CreationAction;
    stage: CreationStage;
    version: number;
    readyForReview: boolean;
}
/** Durable preparation and approval only. No upload, platform client, model, or synthetic media generator. */
export declare class CreationService {
    private readonly store;
    private readonly dependencies;
    constructor(store: StateStore, dependencies: CreationDependencies);
    private key;
    read(id: string): Snapshot<CreationWork> | null;
    /** Host-only metadata projection. Does not expose intention, sources, targets, accounts or private media. */
    list(limit?: number): CreationSummary[];
    create(input: CreateWorkInput): Snapshot<CreationWork>;
    /** Host-only workflow journal. It never grants approval or changes final assets/submission state. */
    setWorkflow(id: string, expectedRevision: number, value: CreationWorkflowState): Snapshot<CreationWork>;
    private workflowContext;
    /** Trusted human operation: fences old async writers using the same work CAS and leaves an append-only decision journal. */
    recoverWorkflow(id: string, expectedRevision: number, principal: string, reason: string): Snapshot<CreationWork>;
    abandonWorkflow(id: string, expectedRevision: number, principal: string, reason: string): Snapshot<CreationWork>;
    recoveryAudit(id: string): CreativeRecoveryAudit[];
    private recoveryDecision;
    /** Rechecked before local work; publication still requires separate final human approval. */
    validatePreparation(work: Readonly<CreationWork>): void;
    private loaded;
    private change;
    revise(id: string, expectedRevision: number, input: Omit<CreateWorkInput, 'id'>): Snapshot<CreationWork>;
    setBrief(id: string, expectedRevision: number, brief: string): Snapshot<CreationWork>;
    setScript(id: string, expectedRevision: number, script: string): Snapshot<CreationWork>;
    setAssets(id: string, expectedRevision: number, references: AssetReference[]): Snapshot<CreationWork>;
    private authority;
    private verifyAssets;
    prepareFinal(id: string, expectedRevision: number, value: FinalManifest): Snapshot<CreationWork>;
    produce(id: string, expectedRevision: number, beforeCommit?: () => Promise<void>): Promise<Snapshot<CreationWork>>;
    private human;
    private currentFinal;
    approve(id: string, expectedRevision: number, principal: string, expiresAt: number): Snapshot<CreationWork>;
    private review;
    reject(id: string, revision: number, principal: string, reason: string): Snapshot<CreationWork>;
    requestChanges(id: string, revision: number, principal: string, reason: string): Snapshot<CreationWork>;
    revoke(id: string, revision: number, principal: string, reason: string): Snapshot<CreationWork>;
    /** Outbox insertion and approval consumption share the caller's store transaction. Callback must not perform IO. */
    submit(id: string, expectedRevision: number, enqueue: (tx: Transaction, snapshot: SubmissionSnapshot) => string): CreationSubmitResult;
    recordOutcome(id: string, expectedRevision: number, state: SubmissionState, platformObjectId: string | null): Snapshot<CreationWork>;
    recordOutcomeIn(tx: Transaction, id: string, expectedRevision: number, state: SubmissionState, platformObjectId: string | null): Snapshot<CreationWork>;
    /** Revalidate the consumed human approval and immutable work again at the actual send boundary. */
    validateSubmission(snapshot: SubmissionSnapshot, intentId: string): void;
}
