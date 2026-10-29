import type { StateStore } from './store.ts';
import { PolicyMemory } from './policy-memory.ts';
import type { ContextTicket, SourceRef, MemoryRef } from './policy-memory.ts';
import type { ExpressionRule, StyleContract } from '../../social-v1/src/expression-policy.ts';
import { SelfGrowthEngine } from './self-growth.ts';
import type { SelfScope, ParticipationPolicy, Action, Observation } from './self-growth.ts';
import { DurableOutbox } from './outbox.ts';
import type { Delivery, BudgetWindow } from './outbox.ts';
import { ConversationLedger } from '../../conversation-v1/src/ledger.ts';
import type { ConversationIdentity } from '../../conversation-v1/src/contracts.ts';
import type { RepetitionEvent } from '../../social-v1/src/repetition.ts';
export interface Profile {
    botId: string;
    personaId: string;
    mode: 'juejue' | 'persona';
    name: string;
    roleCore: string;
}
export interface ModelRequest {
    kind: 'reply' | 'initiative';
    name: string;
    roleCore: string;
    prompt: string;
    input: string;
    memories: {
        id: string;
        text: string;
    }[];
    recent: {
        actor: string;
        text: string;
    }[];
    affect: {
        valence: number;
        intensity: number;
    };
    topic: string;
    expressionRules: readonly ExpressionRule[];
    styleContracts: readonly StyleContract[];
    rewrite?: {
        previousText: string;
        reason: string;
    };
}
export interface ModelOutput {
    text: string;
    learning: {
        text: string;
        kind: 'knowledge' | 'expression' | 'preference';
    }[];
}
export interface ModelPort {
    id: string;
    generate(request: ModelRequest, signal: AbortSignal): Promise<ModelOutput>;
    reviewStyle?(request: {
        text: string;
        styleContracts: readonly StyleContract[];
    }, signal: AbortSignal): Promise<'pass' | 'rewrite' | 'block'>;
}
export interface Envelope {
    key: string;
    bindingRevision: number;
    eventId: string;
    actor: string;
    actorKind: 'human' | 'bot' | 'unknown';
    plain: boolean;
    text: string;
    observedAt: number;
}
interface Catalog {
    items: {
        key: string;
        label: string;
        identity: ConversationIdentity;
        bindingRevision: number;
    }[];
}
interface Turn {
    id: string;
    key: string;
    input: Envelope;
    status: 'received' | 'generating' | 'queued' | 'skipped' | 'failed';
    reason: string;
    draftId: string | null;
    context: ContextTicket | null;
}
interface LearningProposal {
    id: string;
    key: string;
    text: string;
    kind: 'knowledge' | 'expression' | 'preference';
    sourceId: string;
    status: 'pending' | 'accepted' | 'rejected';
    sourceRefs: SourceRef[];
    derivedFrom: MemoryRef[];
    context: ContextTicket;
    modelVersion: string;
    bindingRevision: number;
    provenanceComplete: boolean;
}
export interface RuntimeOptions {
    profile: Profile;
    now?: () => number;
    model: ModelPort | null;
    /** This attestation belongs to a trusted connector. A public JSON boolean never grants ingress. */
    acceptIngress: (envelope: Envelope, identity: ConversationIdentity) => boolean;
    participation: (key: string, action: Action | null) => ParticipationPolicy;
    authorizeLearning: (principal: string) => boolean;
}
export declare class BotRuntime {
    readonly memory: PolicyMemory;
    readonly self: SelfGrowthEngine;
    readonly outbox: DurableOutbox;
    readonly ledger: ConversationLedger;
    private store;
    private options;
    private now;
    private inflight;
    private closed;
    private controllers;
    constructor(store: StateStore, ledger: ConversationLedger, options: RuntimeOptions);
    get profile(): Profile;
    get modelConfigured(): boolean;
    register(identity: ConversationIdentity, bindingRevision: number, label: string): string;
    conversations(): Catalog['items'];
    private conversation;
    private currentScope;
    scope(key: string): SelfScope;
    observe(key: string, event: Observation): void;
    /** Management route: revoke retrieval first, then idempotently invalidate experienced state. */
    revokeSource(sourceId: string, currentRevision: number, nextRevision: number): void;
    private event;
    private sourceAllowed;
    private validateRaw;
    private participationGate;
    private saveTurn;
    private validate;
    receive(envelope: Envelope): Promise<Turn>;
    private generate;
    learning(): LearningProposal[];
    reviewLearning(id: string, accepted: boolean, principal: string): void;
    idle(key: string, topic: string, action: Action): Promise<unknown>;
    private repetitionPlan;
    private commitRepetition;
    repeat(key: string, events: RepetitionEvent[], wantsToRepeat: boolean): string | null;
    repeatReviewed(key: string, events: RepetitionEvent[], wantsToRepeat: boolean): Promise<string | null>;
    sendGate(item: Delivery): {
        allowed: boolean;
        reason: string;
    };
    dispatch(account: string, owner: string, budget: BudgetWindow | null, send: (item: Delivery) => Promise<{
        status: 'confirmed' | 'failed' | 'unknown';
        receipt: string | null;
    }>): Promise<Delivery | null>;
    recordDelivery(item: Delivery): void;
    close(): void;
}
export {};
