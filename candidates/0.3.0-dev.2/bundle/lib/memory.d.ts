import type { Conversation, CorePolicy, Gate } from './contracts.ts';
export type MemoryScope = Readonly<{
    kind: 'private';
    userId: string;
}> | Readonly<{
    kind: 'conversation';
    conversation: Conversation;
}> | Readonly<{
    kind: 'admin-global';
}> | Readonly<{
    kind: 'grant';
    grantId: string;
}>;
export type MemoryRecord = Readonly<{
    id: string;
    botId: string;
    domain: 'social' | 'code';
    workspaceId: string | null;
    personaId: string | null;
    kind: 'admin-identity' | 'admin-relationship' | 'preference' | 'fact' | 'summary' | 'expression' | 'engineering';
    subjectId: string | null;
    adminBindingId: string | null;
    origin: Conversation;
    scope: MemoryScope;
    deleted: boolean;
    derived: boolean;
    sourceIds: readonly string[];
}>;
export type SharingGrant = Readonly<{
    id: string;
    memoryId: string;
    botId: string;
    approvedBy: string;
    adminBindingId: string;
    active: boolean;
    targets: 'authorized' | readonly Conversation[];
}>;
export type MemoryContext = Readonly<{
    botId: string;
    conversation: Conversation;
    domain: 'social' | 'code';
    workspaceId: string | null;
    personaId: string | null;
    adminId: string;
    adminBindingId: string;
}>;
export type MemoryLookup = Readonly<{
    record(id: string): MemoryRecord | undefined;
    grant(id: string): SharingGrant | undefined;
}>;
/**
 * Synchronous, fail-closed metadata gate; does not persist, index, retrieve text or delete data.
 * The trusted host owns records, source edges and grants; a model cannot author grants or
 * relabel a private fact as admin identity. Use a consistent storage snapshot, and recheck
 * current authorization before context assembly and dispatch. No snapshot/cache invalidation
 * or real send-time race control is implemented by this standalone function.
 */
export declare function memoryGate(id: string, context: MemoryContext, policy: CorePolicy, lookup: MemoryLookup): Gate;
