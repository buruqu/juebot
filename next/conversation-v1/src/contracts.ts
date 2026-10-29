/** Offline conversation ledger contracts. Host supplies identities and permissions. */
export const LIMITS = Object.freeze({ id: 256, body: 16000, grants: 128, page: 100 });
export type ErrorCode = 'INVALID_INPUT' | 'STORE_NOT_INITIALIZED' | 'STORE_MISMATCH' | 'STORE_CLOSED'
  | 'CONVERSATION_NOT_FOUND' | 'BINDING_CONFLICT' | 'EVENT_CONFLICT' | 'SOURCE_NOT_FOUND'
  | 'ACCESS_DENIED' | 'ACCESS_CHANGED' | 'INVALID_CURSOR' | 'STORAGE_FAILURE';
export class ConversationError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.name = 'ConversationError'; this.code = code; }
}
export function demand(ok: unknown, code: ErrorCode = 'INVALID_INPUT'): asserts ok {
  if (!ok) throw new ConversationError(code);
}
export function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value));
  demand(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  demand(Object.keys(value).every(key => keys.includes(key)));
}
export function id(value: unknown, max: number = LIMITS.id): asserts value is string {
  demand(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value));
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  demand(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max);
}
export interface ConversationIdentity {
  botId: string; personaId: string;
  connector: 'qq-personal' | 'qq-official' | 'bilibili' | 'local-test';
  issuer: string; accountId: string;
  kind: 'group' | 'direct' | 'thread'; remoteId: string;
}
export interface ConversationRecord {
  key: string; identity: ConversationIdentity; bindingRevision: number; createdAt: number; updatedAt: number;
}
export const EVENT_TYPES = ['message.received', 'reply.draft', 'decision.recorded', 'reply.submitted',
  'reply.confirmed', 'reply.failed', 'reply.unknown', 'policy.changed'] as const;
export const REASONS = ['NONE', 'NOT_INTERESTED', 'EXPRESSION_BLOCKED', 'OUTBOUND_PAUSED', 'POLICY_CHANGED',
  'MODEL_ERROR', 'TOOL_ERROR', 'DELIVERY_UNCERTAIN'] as const;
export interface EventInput {
  conversationKey: string; bindingRevision: number; sourceEventId: string; occurredAt: number;
  eventType: typeof EVENT_TYPES[number]; reasonCode: typeof REASONS[number];
  actorId: string | null; runId: string | null; causedBy: number | null; body: string | null;
}
export interface StoredEvent extends Omit<EventInput, 'body'> { sequence: number; bodyRef: number | null }
export interface AppendResult { event: StoredEvent; duplicate: boolean }
export function validateEvent(value: unknown): asserts value is EventInput {
  record(value, ['conversationKey', 'bindingRevision', 'sourceEventId', 'occurredAt', 'eventType', 'reasonCode', 'actorId', 'runId', 'causedBy', 'body']);
  id(value.conversationKey, 4096); integer(value.bindingRevision); id(value.sourceEventId); integer(value.occurredAt);
  demand(EVENT_TYPES.includes(value.eventType as EventInput['eventType']) && REASONS.includes(value.reasonCode as EventInput['reasonCode']));
  for (const key of ['actorId', 'runId']) if (value[key] !== null) id(value[key]);
  if (value.causedBy !== null) integer(value.causedBy, 1);
  demand(value.body === null || (typeof value.body === 'string' && value.body.length <= LIMITS.body && !/[\u0000\uD800-\uDFFF]/u.test(value.body)));
  // Delivery outcomes reference the prior draft rather than copying its body into every event.
  if (value.eventType !== 'message.received' && value.eventType !== 'reply.draft' && value.eventType !== 'decision.recorded') demand(value.body === null);
}
export interface Statement {
  run(...args: (string | number | null)[]): unknown;
  get(...args: (string | number | null)[]): unknown;
  all(...args: (string | number | null)[]): unknown[];
}
export interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): Statement }
export interface LedgerReader {
  getConversation(key: string): ConversationRecord | null;
  listConversations(keys: readonly string[], afterKey: string | null, limit: number): ConversationRecord[];
  pageEvents(key: string, bindingRevision: number, afterSequence: number, limit: number): StoredEvent[];
  readBody(key: string, bindingRevision: number, sequence: number): string | null;
}
export interface ConversationGrant { key: string; bindingRevision: number; metadata: boolean; body: boolean }
export interface AccessSnapshot { revision: number; grants: readonly ConversationGrant[] }
export type AccessProvider = (principal: string) => Promise<AccessSnapshot>;
export interface Page<T> { items: T[]; nextCursor: string | null }
