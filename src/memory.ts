import {
  ALLOW, deny, isConversation, isId, isQQId, isRecord, permissionsFor, sameConversation,
} from './contracts.ts';
import type { Conversation, CorePolicy, Gate } from './contracts.ts';

export type MemoryScope =
  | Readonly<{ kind: 'private'; userId: string }>
  | Readonly<{ kind: 'conversation'; conversation: Conversation }>
  | Readonly<{ kind: 'admin-global' }>
  | Readonly<{ kind: 'grant'; grantId: string }>;
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
export function memoryGate(id: string, context: MemoryContext, policy: CorePolicy, lookup: MemoryLookup): Gate {
  try {
    if (!isId(id) || !isRecord(context) || !isConversation(context.conversation)
      || !isQQId(context.adminId) || !isId(context.adminBindingId)
      || context.botId !== policy.botId || !['social', 'code'].includes(context.domain)
      || !(context.personaId === null || isId(context.personaId))) return deny('INVALID_MEMORY_CONTEXT');
    const destination = permissionsFor(policy, context.conversation);
    if (destination?.receive !== true || destination.send !== true) return deny('DESTINATION_NOT_AUTHORIZED');
    if (context.domain === 'code' && (!isId(context.workspaceId)
      || context.conversation.kind !== 'private' || context.conversation.id !== context.adminId)) return deny('CODE_CONTEXT_NOT_AUTHORIZED');
    if (context.domain === 'social' && context.workspaceId !== null) return deny('INVALID_SOCIAL_CONTEXT');

    const active = new Set<string>();
    const memo = new Map<string, Gate>();
    let remaining = 512;

    function visit(recordId: string, depth: number): Gate {
      if (depth > 64 || --remaining < 0) return deny('MEMORY_GRAPH_LIMIT');
      if (active.has(recordId)) return deny('MEMORY_SOURCE_CYCLE');
      const cached = memo.get(recordId);
      if (cached) return cached;
      const record = lookup.record(recordId);
      if (!isRecord(record) || record.id !== recordId || record.deleted !== false) return deny('MEMORY_MISSING_OR_DELETED');
      if (record.botId !== context.botId || record.domain !== context.domain) return deny('MEMORY_DOMAIN_MISMATCH');
      if (!['admin-identity', 'admin-relationship', 'preference', 'fact', 'summary', 'expression', 'engineering'].includes(record.kind)
        || !isConversation(record.origin) || !isRecord(record.scope)
        || !(record.personaId === null || isId(record.personaId))) return deny('INVALID_MEMORY_RECORD');
      if (record.kind === 'engineering' && record.domain !== 'code') return deny('ENGINEERING_REQUIRES_CODE_DOMAIN');
      if (record.personaId !== null && record.personaId !== context.personaId) return deny('PERSONA_MISMATCH');
      if (record.workspaceId !== context.workspaceId) return deny('WORKSPACE_MISMATCH');
      if (!Array.isArray(record.sourceIds) || record.sourceIds.length > 64 || !record.sourceIds.every(isId)
        || typeof record.derived !== 'boolean' || record.derived !== (record.sourceIds.length > 0)) return deny('INVALID_MEMORY_SOURCES');
      const origin = permissionsFor(policy, record.origin);
      if (origin?.receive !== true || origin.save !== true) return deny('SOURCE_NOT_AUTHORIZED');

      const scope = record.scope;
      if (scope.kind === 'private') {
        if (!isQQId(scope.userId) || record.origin.kind !== 'private' || record.origin.id !== scope.userId
          || context.conversation.kind !== 'private' || context.conversation.id !== scope.userId) return deny('PRIVATE_MEMORY');
      } else if (scope.kind === 'conversation') {
        if (!isConversation(scope.conversation) || !sameConversation(scope.conversation, record.origin)
          || !sameConversation(scope.conversation, context.conversation)) return deny('CONVERSATION_MEMORY');
      } else if (scope.kind === 'admin-global') {
        if (record.domain !== 'social' || !['admin-identity', 'admin-relationship'].includes(record.kind)
          || record.subjectId !== context.adminId || record.adminBindingId !== context.adminBindingId) return deny('INVALID_ADMIN_GLOBAL_MEMORY');
      } else if (scope.kind === 'grant') {
        if (!isId(scope.grantId)) return deny('INVALID_SHARING_GRANT');
        // Sharing adds destinations; revoking it must not delete lawful source access.
        if (!sameConversation(context.conversation, record.origin)) {
          const grant = lookup.grant(scope.grantId);
          if (!isRecord(grant) || grant.id !== scope.grantId || grant.active !== true
            || grant.memoryId !== record.id || grant.botId !== context.botId
            || grant.approvedBy !== context.adminId || grant.adminBindingId !== context.adminBindingId) return deny('SHARING_NOT_AUTHORIZED');
          if (grant.targets !== 'authorized') {
            if (!Array.isArray(grant.targets) || grant.targets.length > 10000
              || !grant.targets.every(isConversation)
              || !grant.targets.some(target => sameConversation(target, context.conversation))) return deny('SHARING_TARGET_MISMATCH');
          }
        }
      } else return deny('UNKNOWN_MEMORY_SCOPE');

      // Every source must still be usable. A public summary cannot launder a private fact;
      // revoking/deleting any ancestor denies all descendants on the next check.
      active.add(recordId);
      for (const source of record.sourceIds) {
        const gate = visit(source, depth + 1);
        if (!gate.allowed) { active.delete(recordId); memo.set(recordId, gate); return gate; }
      }
      active.delete(recordId);
      memo.set(recordId, ALLOW);
      return ALLOW;
    }
    return visit(id, 0);
  } catch {
    // Corrupt storage or a failed lookup must not broaden a record's visibility.
    return deny('MEMORY_LOOKUP_FAILED');
  }
}
