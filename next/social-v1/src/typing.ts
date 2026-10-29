/** Offline timing assumptions, not measurements of human typing. No timers or I/O. */
export interface TypingConfig {
  enabled: boolean;
  charsPerSecond: number;
  minDelayMs: number;
  maxDelayMs: number;
  jitterFraction: number;
  maxGraphemes: number;
  maxCodeUnits: number;
}
export type MessageKind = 'social' | 'code-result' | 'control-ack';
export const DEFAULT_TYPING_CONFIG: Readonly<TypingConfig> = Object.freeze({
  enabled: true, charsPerSecond: 12, minDelayMs: 150, maxDelayMs: 6000,
  jitterFraction: 0.1, maxGraphemes: 8000, maxCodeUnits: 64000,
});
function finite(value: number): boolean { return Number.isFinite(value); }
export function validateTypingConfig(config: TypingConfig): void {
  if (typeof config.enabled !== 'boolean' || !finite(config.charsPerSecond) || config.charsPerSecond <= 0
    || !finite(config.minDelayMs) || config.minDelayMs < 0 || !finite(config.maxDelayMs)
    || config.maxDelayMs < config.minDelayMs || !finite(config.jitterFraction)
    || config.jitterFraction < 0 || config.jitterFraction > 0.25
    || !Number.isSafeInteger(config.maxGraphemes) || config.maxGraphemes < 1
    || !Number.isSafeInteger(config.maxCodeUnits) || config.maxCodeUnits < 1) throw new Error('INVALID_TYPING_CONFIG');
}
export interface TypingPlan { graphemes: number; delayMs: number }
export function planTyping(text: string, kind: MessageKind | 'repetition', config: TypingConfig = DEFAULT_TYPING_CONFIG,
  sample: () => number = () => 0.5): TypingPlan {
  validateTypingConfig(config);
  if (!['social', 'repetition', 'code-result', 'control-ack'].includes(kind)) throw new Error('INVALID_MESSAGE_KIND');
  if (typeof text !== 'string' || text.length > config.maxCodeUnits) throw new Error('MESSAGE_TOO_LONG');
  let graphemes = 0;
  for (const _segment of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)) {
    if (++graphemes > config.maxGraphemes) throw new Error('MESSAGE_TOO_LONG');
  }
  if (!config.enabled || kind !== 'social') return { graphemes, delayMs: 0 };
  const random = sample();
  if (!finite(random) || random < 0 || random > 1) throw new Error('INVALID_RANDOM_SAMPLE');
  const base = graphemes / config.charsPerSecond * 1000;
  const delayMs = Math.max(config.minDelayMs, Math.min(config.maxDelayMs,
    Math.round(base * (1 + (random * 2 - 1) * config.jitterFraction))));
  return { graphemes, delayMs };
}
export interface ConversationKey {
  namespace: string;
  opaqueId: string;
  accountKey: string;
  bindingRevision: number;
}
export interface QueuedMessage {
  conversation: ConversationKey;
  text: string;
  kind: MessageKind;
  policyRevision: number;
}
export interface ClaimChecks {
  bindingRevision: number;
  policyRevision: number;
  outboundAllowed: boolean;
  /** Stops new Code work only. It does not revoke an existing code-result. */
  codeEnabled?: boolean;
}
export interface LocalClaim { id: number; message: QueuedMessage; dueAt: number }
export type ClaimResult = { status: 'empty' | 'waiting' | 'in-flight' }
  | { status: 'recheck'; id: number; policyRevision: number }
  | { status: 'cancelled'; id: number; reason: 'cancelled' | 'binding-changed' | 'policy-changed' | 'outbound-blocked' }
  | { status: 'blocked'; id: number; reason: 'binding-changed' | 'policy-changed' | 'outbound-blocked' }
  | { status: 'claimed'; claim: LocalClaim };
interface Entry extends LocalClaim { claimed: boolean; cancelled: boolean; pendingRevision: number | null }
function revision(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function keyOf(key: ConversationKey): string {
  if (!key || ![key.namespace, key.opaqueId, key.accountKey].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512)
    || !revision(key.bindingRevision)) throw new Error('INVALID_CONVERSATION_KEY');
  return JSON.stringify([key.namespace, key.opaqueId, key.accountKey, key.bindingRevision]);
}
function time(value: number): void {
  if (!finite(value) || value < 0) throw new Error('INVALID_CLOCK');
}
/** All kinds preserve conversation FIFO; UI control acknowledgements should bypass this queue.
 * In-memory FIFO. A claim is local and single-use; no external delivery guarantee. */
export class TypingQueue {
  private readonly queues = new Map<string, Entry[]>();
  private readonly config: TypingConfig;
  private nextId = 1;
  private count = 0;
  private readonly capacity: number;
  constructor(capacity = 100, config: TypingConfig = DEFAULT_TYPING_CONFIG) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('INVALID_CAPACITY');
    validateTypingConfig(config);
    this.capacity = capacity;
    this.config = { ...config };
  }
  get size(): number { return this.count; }
  enqueue(message: QueuedMessage, now: number, sample: () => number = () => 0.5): LocalClaim {
    // Copy-paste repetitions go directly through the shared outbound gates/Outbox,
    // never behind artificial typing deadlines. The type and runtime guard agree.
    if (!['social', 'code-result', 'control-ack'].includes(message.kind)) throw new Error('MESSAGE_KIND_NOT_ALLOWED_IN_TYPING_QUEUE');
    time(now);
    const key = keyOf(message.conversation);
    if (!revision(message.policyRevision)) throw new Error('INVALID_POLICY_REVISION');
    if (this.count >= this.capacity) throw new Error('QUEUE_FULL');
    if (!Number.isSafeInteger(this.nextId)) throw new Error('ID_EXHAUSTED');
    const plan = planTyping(message.text, message.kind, this.config, sample);
    const queue = this.queues.get(key) ?? [];
    const dueAt = Math.max(now, queue.at(-1)?.dueAt ?? now) + plan.delayMs;
    if (!finite(dueAt) || dueAt > Number.MAX_SAFE_INTEGER) throw new Error('INVALID_DEADLINE');
    const copy = { ...message, conversation: { ...message.conversation } };
    const entry: Entry = { id: this.nextId++, message: copy, dueAt, claimed: false, cancelled: false, pendingRevision: null };
    queue.push(entry);
    this.queues.set(key, queue);
    this.count++;
    return this.copy(entry);
  }
  cancel(key: ConversationKey, id: number): boolean {
    const entry = this.queues.get(keyOf(key))?.find(item => item.id === id);
    if (!entry || entry.claimed || entry.message.kind !== 'social') return false;
    entry.cancelled = true;
    return true;
  }
  claim(key: ConversationKey, now: number, checks: ClaimChecks): ClaimResult {
    time(now);
    if (!revision(checks.bindingRevision) || !revision(checks.policyRevision) || typeof checks.outboundAllowed !== 'boolean')
      throw new Error('INVALID_CLAIM_CHECKS');
    const queueKey = keyOf(key);
    const entry = this.queues.get(queueKey)?.[0];
    if (!entry) return { status: 'empty' };
    if (entry.claimed) return { status: 'in-flight' };
    if (!entry.cancelled && entry.message.kind === 'social' && entry.pendingRevision !== null
      && checks.policyRevision < entry.pendingRevision)
      return { status: 'recheck', id: entry.id, policyRevision: entry.pendingRevision };
    const reason = entry.cancelled ? 'cancelled' : checks.bindingRevision !== entry.message.conversation.bindingRevision
      ? 'binding-changed' : checks.policyRevision !== entry.message.policyRevision ? 'policy-changed'
      : !checks.outboundAllowed ? 'outbound-blocked' : null;
    if (reason === 'policy-changed' && entry.message.kind === 'social') {
      entry.pendingRevision = checks.policyRevision;
      return { status: 'recheck', id: entry.id, policyRevision: checks.policyRevision };
    }
    if (reason === 'outbound-blocked' || (entry.message.kind === 'code-result' && reason !== null && reason !== 'cancelled'))
      return { status: 'blocked', id: entry.id, reason };
    if (reason) { this.remove(queueKey); return { status: 'cancelled', id: entry.id, reason }; }
    if (now < entry.dueAt) return { status: 'waiting' };
    entry.claimed = true;
    return { status: 'claimed', claim: this.copy(entry) };
  }
  /** Trusted Host only: invoke after the exact original text passes the latest expression policy.
   * Rewrites must cancel the social draft and enqueue the checked replacement as a new item.
   * This does not itself perform expression checks or authorize outbound delivery.
   */
  revalidateSocial(key: ConversationKey, id: number, checked: { policyRevision: number; checkedText: string }): boolean {
    const entry = this.queues.get(keyOf(key))?.find(item => item.id === id);
    if (!entry || entry.claimed || entry.cancelled || entry.message.kind !== 'social'
      || !revision(checked.policyRevision) || entry.pendingRevision !== checked.policyRevision
      || checked.policyRevision < entry.message.policyRevision || checked.checkedText !== entry.message.text) return false;
    entry.message.policyRevision = checked.policyRevision;
    entry.pendingRevision = null;
    return true;
  }
  /** Call after the consumer resolves its own delivery outcome. No retry is automatic. */
  complete(key: ConversationKey, id: number): boolean {
    const queueKey = keyOf(key);
    const entry = this.queues.get(queueKey)?.[0];
    if (!entry?.claimed || entry.id !== id) return false;
    this.remove(queueKey);
    return true;
  }
  private remove(key: string): void {
    const queue = this.queues.get(key)!;
    queue.shift(); this.count--;
    if (!queue.length) this.queues.delete(key);
  }
  private copy(entry: Entry): LocalClaim {
    return { id: entry.id, dueAt: entry.dueAt, message: { ...entry.message, conversation: { ...entry.message.conversation } } };
  }
}
