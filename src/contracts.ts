/** Pure domain contracts. None of these fields proves a real QQ connection or OS permission. */
export type IdentityMode = 'juejue' | 'persona';
export type Conversation = Readonly<{ kind: 'private' | 'group'; id: string }>;
export type Permissions = Readonly<{
  receive: boolean;
  save: boolean;
  learn: boolean;
  send: boolean;
}>;
export type ChannelRule = Readonly<{ conversation: Conversation; permissions: Permissions }>;
export type CorePolicy = Readonly<{
  botId: string;
  connectionId: string;
  channels: readonly ChannelRule[];
}>;

/** Supplied by a future trusted connector, NOT copied from the message body. */
export type TransportContext = Readonly<{ connectionId: string; selfId: string }>;
/** Internal normalized input, NOT the unverified SnowLuma wire schema. */
export type InboundMessage = Readonly<{
  eventId: string;
  senderId: string;
  conversation: Conversation;
  text: string;
  form: 'plain' | 'quoted' | 'forwarded' | 'mixed';
}>;

/** Host-only assertions; a future adapter must independently verify and enforce each one. */
export type CodeAuthorization = Readonly<{
  id: string;
  workspace: string;
  sessionId: string;
  modelConfigured: boolean;
  budgetAvailable: boolean;
  sandboxVerified: boolean;
  toolsRestricted: boolean;
}>;
export type Gate = Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: string }>;
export const ALLOW: Gate = Object.freeze({ allowed: true });
export function deny(reason: string): Gate { return { allowed: false, reason }; }

export class CoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CoreError';
    this.code = code;
  }
}
export function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new CoreError(code);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function isQQId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value);
}
export function isConversation(value: unknown): value is Conversation {
  return isRecord(value) && (value.kind === 'private' || value.kind === 'group') && isQQId(value.id);
}
export function sameConversation(a: Conversation, b: Conversation): boolean {
  return a.kind === b.kind && a.id === b.id;
}
export function channelKey(channel: Conversation): string {
  return JSON.stringify([channel.kind, channel.id]);
}
export function permissionsFor(policy: CorePolicy, channel: Conversation): Permissions | undefined {
  return policy.channels.find(rule => sameConversation(rule.conversation, channel))?.permissions;
}

/** Defensive snapshot: changes to callers' objects cannot change an admitted task's policy. */
export function snapshotPolicy(policy: CorePolicy): CorePolicy {
  requireCondition(isRecord(policy) && isQQId(policy.botId) && isId(policy.connectionId), 'INVALID_POLICY');
  requireCondition(Array.isArray(policy.channels) && policy.channels.length <= 10000, 'INVALID_CHANNELS');
  const keys = new Set<string>();
  const channels = policy.channels.map((rule: ChannelRule) => {
    requireCondition(isRecord(rule) && isConversation(rule.conversation) && isRecord(rule.permissions), 'INVALID_CHANNEL_RULE');
    const p = rule.permissions;
    requireCondition(['receive', 'save', 'learn', 'send'].every(key => typeof p[key as keyof Permissions] === 'boolean'), 'INVALID_PERMISSIONS');
    const key = channelKey(rule.conversation);
    requireCondition(!keys.has(key), 'DUPLICATE_CHANNEL_RULE');
    keys.add(key);
    return Object.freeze({
      conversation: Object.freeze({ kind: rule.conversation.kind, id: rule.conversation.id }),
      permissions: Object.freeze({ receive: p.receive, save: p.save, learn: p.learn, send: p.send }),
    });
  });
  return Object.freeze({ botId: policy.botId, connectionId: policy.connectionId, channels: Object.freeze(channels) });
}

export function normalizeMessage(value: unknown): InboundMessage | undefined {
  if (!isRecord(value) || !isId(value.eventId) || !isQQId(value.senderId)
    || !isConversation(value.conversation) || typeof value.text !== 'string' || value.text.length > 32768
    || !['plain', 'quoted', 'forwarded', 'mixed'].includes(value.form as string)) return undefined;
  if (value.conversation.kind === 'private' && value.conversation.id !== value.senderId) return undefined;
  return Object.freeze({
    eventId: value.eventId,
    senderId: value.senderId,
    conversation: Object.freeze({ kind: value.conversation.kind, id: value.conversation.id }),
    text: value.text,
    form: value.form as InboundMessage['form'],
  });
}
