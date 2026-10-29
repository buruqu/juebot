import type { BotRuntime, Profile } from './runtime.ts';
import type { CreationService, TrustedAsset } from './creation.ts';
import type { CodeTasks } from './code-jobs.ts';
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
    now?: () => number;
}
/** Host facade only; no SDK, listener, account login, filesystem or credentials provider. */
export declare function createAgentApi(deps: AgentApiDependencies): (request: Request) => Promise<Response>;
