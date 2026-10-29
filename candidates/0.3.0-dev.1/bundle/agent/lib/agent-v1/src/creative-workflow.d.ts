import type { Snapshot } from './store.ts';
import type { SelfGrowthEngine, SelfScope, Intention } from './self-growth.ts';
import type { CreationService, CreationAction, CreationTarget, CreationSource, CreationWork, WorkflowFailure } from './creation.ts';
export interface CreativePolicy {
    revision: number;
    allowedAccounts: string[];
    allowedActions: CreationAction[];
}
export interface CreativeMaterials {
    revision: number;
    sources: CreationSource[];
    items: {
        id: string;
        text: string;
    }[];
}
export interface CreativePlan {
    brief: string;
    script: string | null;
    title: string;
    description: string;
    tags: string[];
    text: string;
}
export interface CreativeRequest {
    action: CreationAction;
    accountId: string;
    target: CreationTarget;
}
export interface CreativeWorkflowDependencies {
    self: SelfGrowthEngine;
    creation: CreationService;
    scope: SelfScope;
    now(): number;
    policy(): CreativePolicy;
    /** Trusted projection of materials approved for public creation, never a full memory dump. */
    materials(intention: Intention, target: CreationTarget): Promise<CreativeMaterials>;
    plan(input: {
        intention: Intention;
        action: CreationAction;
        materials: CreativeMaterials;
    }): Promise<CreativePlan>;
}
export interface CreativeResult {
    status: 'ready' | 'failed' | 'recovery-required';
    duplicate: boolean;
    work: Snapshot<CreationWork>;
    reasonCode: WorkflowFailure | null;
}
/** Durable intention -> actual preparation -> final review only. Never approves, uploads or submits. */
export declare class CreativeWorkflow {
    private readonly deps;
    private readonly scope;
    constructor(deps: CreativeWorkflowDependencies);
    private id;
    private intention;
    start(intentId: string, request: CreativeRequest): Promise<CreativeResult>;
}
