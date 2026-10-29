import type { BotRuntime, Profile } from './runtime.ts';
import type { CreationService, TrustedAsset } from './creation.ts';
import type { CodeTasks } from './code-jobs.ts';
import type { CreativeRequest } from './creative-workflow.ts';
export interface AgentAccess {
    revision: number;
    readKeys: string[];
    bodyKeys: string[];
    manage: boolean;
    review: boolean;
    bindingRevisions?: Record<string, number>;
}
export interface AgentApiDependencies {
    runtime: BotRuntime;
    creation: CreationService;
    code: CodeTasks;
    resolvePrincipal(request: Request): Promise<string | null>;
    access(principal: string): Promise<AgentAccess>;
    assets?: {
        read(previewRef: string): {
            bytes: Uint8Array;
            mime: string;
            asset: TrustedAsset;
        };
        resolve(ref: string): TrustedAsset | null;
    };
    identity?: {
        read(): {
            revision: number;
            profile: Profile;
            profiles?: Partial<Record<Profile['mode'], Profile>>;
        };
        write(expectedRevision: number, profile: Profile): unknown;
    };
    submitCreation(id: string, expectedRevision: number): unknown;
    recoverCreation?(id: string, expectedRevision: number, principal: string, reason: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
    reconcileDelivery?(id: string, expectedRevision: number, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
    startCreation?(key: string, intentionId: string, request: CreativeRequest, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
    prepareCreationIntention?(key: string, topic: string, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
    prepareSummaryCreation?(key: string, input: Record<string, unknown>, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
    evaluateGrowth?(input: {
        key: string;
        id: string;
        expectedRevision: number;
    }, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
    biliSources?: {
        capture(input: Record<string, unknown>, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
        read(id: string, revision: number | undefined, principal: string): unknown;
        revoke(input: Record<string, unknown>, principal: string): unknown;
        learning(input: Record<string, unknown>, principal: string): unknown;
    };
    now?: () => number;
}
/** Host facade only; no SDK, listener, account login, filesystem or credentials provider. */
export declare function createAgentApi(deps: AgentApiDependencies): (request: Request) => Promise<Response>;
