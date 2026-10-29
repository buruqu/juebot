import type { Snapshot, StateStore, Transaction } from './store.ts';
/** Trusted Host supplies scope and event provenance. This module never sends or authorizes tools. */
export interface SelfScope {
    botId: string;
    personaId: string;
    scope: string;
}
export interface SourceRef {
    eventId: string;
    revision: number;
}
export type Action = 'group-participation' | 'idle-topic' | 'direct-contact';
export type Choice = 'reply' | 'silence' | 'decline' | 'defer' | 'leave-topic';
export interface Adaptation {
    warmth: number;
    curiosity: number;
    initiative: number;
}
export interface SelfState extends SelfScope {
    mode: 'juejue' | 'persona';
    name: string;
    aliases: string[];
    roleCore: string;
    identityRevision: number;
    growthVersion: string;
    modelVersion: string;
    adaptation: Adaptation;
    energy: number;
    energyAt: number;
    affect: {
        valence: number;
        intensity: number;
        at: number;
        trigger: SourceRef | null;
    };
    interests: Record<string, {
        score: number;
        sources: SourceRef[];
    }>;
    relationships: Record<string, {
        score: number;
        sources: SourceRef[];
    }>;
    evidence: Record<string, {
        revision: number;
        fingerprint: string;
        revoked: boolean;
    }>;
    counters: Partial<Record<Action, {
        day: number;
        count: number;
        unanswered: number;
        lastAttempt: number | null;
    }>>;
    intents: Intention[];
}
export interface Observation extends SourceRef {
    kind: 'external' | 'self';
    topic?: string;
    interestDelta?: number;
    affect?: {
        valence: number;
        intensity: number;
    };
    relationshipTarget?: string;
    relationshipDelta?: number;
    feedback?: 'support' | 'disagreement' | 'recovery' | 'interest' | 'disinterest';
}
export interface ParticipationPolicy {
    enabled: boolean;
    allowedTargets: string[];
    deniedTargets: string[];
    timeZoneOffsetMinutes: number;
    windows: {
        startMinute: number;
        endMinute: number;
    }[];
    cooldownMs: number;
    dailyLimit: number;
    unansweredLimit: number;
}
export interface DecisionInput {
    target: string;
    topic: string;
    action?: Action;
    policy: ParticipationPolicy;
    participation?: number;
    relationshipTarget?: string;
    sourceFilter?: string[];
    blocked?: boolean;
    topicClosed?: boolean;
    available?: boolean;
}
export interface Intention {
    id: string;
    action: Action;
    target: string;
    topic: string;
    reason: string;
    createdAt: number;
    expiresAt: number;
    sources: SourceRef[];
    status: 'pending' | 'attempted' | 'invalid';
    limits: {
        timeZoneOffsetMinutes: number;
        cooldownMs: number;
        dailyLimit: number;
        unansweredLimit: number;
    };
}
export interface Decision {
    choice: Choice;
    reason: string;
    score: number;
    intention: Intention | null;
}
export interface EvalSuite {
    id: string;
    version: number;
    checks: {
        id: string;
        required: boolean;
    }[];
}
export type Outcome = 'pass' | 'fail' | 'untested';
export interface Evaluation {
    suiteId: string;
    suiteVersion: number;
    modelVersion: string;
    baselineVersion: string;
    baseline: Record<string, Outcome>;
    candidate: Record<string, Outcome>;
}
export interface GrowthCandidate {
    id: string;
    baseVersion: string;
    adaptation: Adaptation;
    sources: SourceRef[];
    status: 'proposed' | 'evaluated' | 'approved' | 'rejected' | 'invalid' | 'active';
    evaluation: Evaluation | null;
    reviewer: string | null;
}
export declare class SelfGrowthEngine {
    private indexGrowth;
    listGrowth(scope: SelfScope): {
        candidates: Snapshot<GrowthCandidate>[];
        suites: Snapshot<EvalSuite>[];
        versions: {
            id: string;
            adaptation: Adaptation;
            modelVersion: string;
        }[];
    };
    private readonly store;
    private readonly clock;
    constructor(store: StateStore, options?: {
        clock?: () => number;
    });
    private now;
    private state;
    initialize(input: SelfScope & {
        mode: 'juejue' | 'persona';
        name: string;
        roleCore: string;
        modelVersion: string;
    }): Snapshot<SelfState>;
    get(scope: SelfScope): Snapshot<SelfState>;
    /** Trusted management changes the fixed identity, never a learning/model patch. */
    configureIdentity(scope: SelfScope, expectedRevision: number, name: string, roleCore: string): Snapshot<SelfState>;
    configureIdentityIn(tx: Transaction, scope: SelfScope, expectedRevision: number, name: string, roleCore: string): Snapshot<SelfState>;
    rename(scope: SelfScope, name: string, expectedRevision: number): Snapshot<SelfState>;
    setModelVersion(scope: SelfScope, modelVersion: string, expectedRevision: number): Snapshot<SelfState>;
    observe(scope: SelfScope, input: Observation): {
        state: Snapshot<SelfState>;
        duplicate: boolean;
        ignored: boolean;
    };
    observeIn(tx: Transaction, scope: SelfScope, input: Observation): {
        state: Snapshot<SelfState>;
        duplicate: boolean;
        ignored: boolean;
    };
    decide(scope: SelfScope, input: DecisionInput): Decision;
    /** Record an externally gated attempt; this is accounting, never a send permission. */
    recordAttempt(scope: SelfScope, intentId: string, input: {
        responded: boolean;
        timeZoneOffsetMinutes?: number;
    }): Snapshot<SelfState>;
    acknowledgeResponse(scope: SelfScope, action: Action): Snapshot<SelfState>;
    acknowledgeResponseIn(tx: Transaction, scope: SelfScope, action: Action): Snapshot<SelfState>;
    revokeSource(scope: SelfScope, eventId: string, revision: number): Snapshot<SelfState>;
    propose(scope: SelfScope, input: {
        id: string;
        adaptation: Adaptation;
        sources: SourceRef[];
    }): Snapshot<GrowthCandidate>;
    freezeSuite(scope: SelfScope, suite: EvalSuite): Snapshot<EvalSuite>;
    private candidate;
    getCandidate(scope: SelfScope, id: string): Snapshot<GrowthCandidate>;
    evaluate(scope: SelfScope, id: string, expectedRevision: number, evaluation: Evaluation): Snapshot<GrowthCandidate>;
    private eligible;
    review(scope: SelfScope, id: string, expectedRevision: number, input: {
        reviewer: string;
        human: true;
        approve: boolean;
    }): Snapshot<GrowthCandidate>;
    activate(scope: SelfScope, id: string, expectedCandidateRevision: number, expectedStateRevision: number): Snapshot<SelfState>;
    restore(scope: SelfScope, version: string, expectedStateRevision: number, input: {
        reviewer: string;
        human: true;
    }): Snapshot<SelfState>;
}
