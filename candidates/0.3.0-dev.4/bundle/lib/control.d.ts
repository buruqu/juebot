export type IdentitySettings = {
    name: string;
    mode: 'juejue' | 'persona';
    personaCard: string | null;
};
export type ControlState = {
    schemaVersion: 1;
    profileKey: string;
    revision: number;
    identity: IdentitySettings;
    admin: {
        qq: string | null;
        bindingEpoch: number;
        proofState: 'unconfigured' | 'pending-proof';
    };
    dataPath: {
        candidate: string | null;
        confirmedCandidate: string | null;
        approvedAt: string | null;
        fingerprint: string | null;
    };
};
export interface ControlPersistence {
    read(): ControlState;
    update(expectedRevision: number, change: (current: ControlState) => ControlState | undefined, signal?: AbortSignal): Promise<ControlState>;
    close(): Promise<void>;
}
export type PathObservation = {
    canonicalPath: string;
    fingerprint: string;
    exists: boolean;
};
export type ControlSummary = {
    revision: number;
    identity: {
        name: string;
        mode: 'juejue' | 'persona';
        personaCardConfigured: boolean;
        personaCardLength: number;
    };
    adminConfigured: boolean;
    adminProofState: 'unconfigured' | 'pending-proof';
    bindingEpoch: number;
    dataPathConfigured: boolean;
    dataPathConfirmed: boolean;
    businessEnabled: false;
};
export declare function controlRevision(value: unknown): number;
export declare function freezeControl<T>(value: T): T;
export declare function cloneControl<T>(value: T): T;
export declare function initialControl(profileKey: string): ControlState;
export declare function validateControl(input: unknown, profileKey: string): ControlState;
export declare function publicControl(state: ControlState): ControlSummary;
export declare function parseIdentityUpdate(input: unknown): {
    expectedRevision: number;
    patch: Partial<IdentitySettings>;
};
/** Shared application methods. Owner actions are passed only to authenticated owner-route code. */
export declare function createControlService(port: ControlPersistence, dependencies: {
    inspectPath(path: string, signal?: AbortSignal): Promise<PathObservation>;
    token(): string;
    now(): number;
}): Readonly<{
    readOwner: () => ControlState;
    readSummary: () => ControlSummary;
    updateIdentity: (input: unknown, signal?: AbortSignal, authorize?: () => void) => Promise<ControlState>;
    owner: Readonly<{
        setAdmin(input: unknown, signal?: AbortSignal): Promise<ControlState>;
        checkPath(input: unknown, signal?: AbortSignal): Promise<{
            revision: number;
            token: string;
            expiresAt: string;
            observation: PathObservation;
            opensDatabase: boolean;
        }>;
        confirmPath(input: unknown, signal?: AbortSignal): Promise<ControlState>;
        clearPath(input: unknown, signal?: AbortSignal): Promise<ControlState>;
    }>;
    executeIdentityRequest(input: unknown, signal?: AbortSignal, authorize?: () => void): Promise<ControlSummary>;
    close(): Promise<void>;
}>;
