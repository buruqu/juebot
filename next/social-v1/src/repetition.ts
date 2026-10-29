/** Offline +1 candidate detection only. No sends, QQ +1 API, attachments, models or storage.
 * Host snapshots are not send authorization: candidates must still pass source/privacy,
 * expression and outbound checks before any separately implemented delivery.
 * Copy-paste repetition adds no typing delay and bypasses the artificial typing queue.
 */
export interface RepetitionConversationKey {
  namespace: string;
  opaqueId: string;
  accountKey: string;
  bindingRevision: number;
}
export interface RepetitionEvent {
  conversationKey: RepetitionConversationKey;
  id: string;
  actorKey: string;
  actorVerified: boolean;
  observedAt: number;
  senderKind: 'human' | 'bot' | 'unknown';
  kind: 'text' | 'image' | 'attachment' | 'other';
  text: string;
}
export interface RepetitionContext {
  conversationKey: RepetitionConversationKey;
  conversationKind: 'group' | 'direct';
  wantsToRepeat: boolean;
  enabled: boolean;
  outboundAllowed: boolean;
  botActorKey: string;
  now: number;
  lastAttemptAt: number | null;
}
export interface RepetitionConfig {
  windowEvents: number;
  windowMs: number;
  minOccurrences: number;
  minDistinctHumans: number;
  cooldownMs: number;
}
/** Tunable product assumptions, not a claim about natural group behavior. */
export const DEFAULT_REPETITION_CONFIG: Readonly<RepetitionConfig> = Object.freeze({
  windowEvents: 20, windowMs: 120000, minOccurrences: 3, minDistinctHumans: 2, cooldownMs: 60000,
});
export const REPETITION_LIMITS = Object.freeze({ inputEvents: 1000, textCodeUnits: 4000, keyCodeUnits: 512, idCodeUnits: 256 });
export type RepetitionSkipReason = 'invalid-input' | 'invalid-config' | 'clock-anomaly' | 'disabled'
  | 'not-group' | 'not-wanted' | 'outbound-blocked' | 'cooldown' | 'no-events' | 'wrong-conversation'
  | 'ineligible-anchor' | 'duplicate-anchor' | 'expired-anchor' | 'insufficient-repetition' | 'insufficient-humans';
export type RepetitionDecision = { action: 'candidate'; text: string; sourceEventIds: string[] }
  | { action: 'skip'; reason: RepetitionSkipReason };
function skip(reason: RepetitionSkipReason): RepetitionDecision { return { action: 'skip', reason }; }
function integer(value: number, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function textKey(value: string, limit: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}
function validKey(value: RepetitionConversationKey): boolean {
  return !!value && [value.namespace, value.opaqueId, value.accountKey].every(item => textKey(item, REPETITION_LIMITS.keyCodeUnits))
    && integer(value.bindingRevision, 0);
}
function sameKey(left: RepetitionConversationKey, right: RepetitionConversationKey): boolean {
  return left.namespace === right.namespace && left.opaqueId === right.opaqueId
    && left.accountKey === right.accountKey && left.bindingRevision === right.bindingRevision;
}
function sameEvent(left: RepetitionEvent, right: RepetitionEvent): boolean {
  return sameKey(left.conversationKey, right.conversationKey) && left.id === right.id
    && left.actorKey === right.actorKey && left.actorVerified === right.actorVerified
    && left.observedAt === right.observedAt && left.senderKind === right.senderKind
    && left.kind === right.kind && left.text === right.text;
}
/** Only line endings and leading/trailing whitespace are normalized; no semantic matching. */
function visibleText(value: string): string { return value.replace(/\r\n?/g, '\n').trim(); }
function eligible(event: RepetitionEvent, botActorKey: string): boolean {
  return event.senderKind === 'human' && event.actorVerified && event.actorKey !== botActorKey && event.kind === 'text';
}
export function considerRepetition(events: readonly RepetitionEvent[], context: RepetitionContext,
  options: Partial<RepetitionConfig> = {}): RepetitionDecision {
  const config = { ...DEFAULT_REPETITION_CONFIG, ...options };
  if (!integer(config.windowEvents, 3, 200) || !integer(config.windowMs, 1, 600000)
    || !integer(config.minOccurrences, 3, config.windowEvents) || !integer(config.minDistinctHumans, 2, config.minOccurrences)
    || !integer(config.cooldownMs, 0, 3600000)) return skip('invalid-config');
  if (!Array.isArray(events) || events.length > REPETITION_LIMITS.inputEvents || !context || !validKey(context.conversationKey)
    || !['group', 'direct'].includes(context.conversationKind) || !textKey(context.botActorKey, REPETITION_LIMITS.keyCodeUnits)
    || [context.enabled, context.outboundAllowed, context.wantsToRepeat].some(value => typeof value !== 'boolean')) return skip('invalid-input');
  if (!integer(context.now, 0) || (context.lastAttemptAt !== null && (!integer(context.lastAttemptAt, 0)
    || context.lastAttemptAt > context.now))) return skip('clock-anomaly');
  let previousTime = -1;
  for (const event of events) {
    if (!event || !validKey(event.conversationKey) || !textKey(event.id, REPETITION_LIMITS.idCodeUnits)
      || !textKey(event.actorKey, REPETITION_LIMITS.keyCodeUnits) || typeof event.actorVerified !== 'boolean'
      || !['human', 'bot', 'unknown'].includes(event.senderKind) || !['text', 'image', 'attachment', 'other'].includes(event.kind)
      || typeof event.text !== 'string' || event.text.length > REPETITION_LIMITS.textCodeUnits) return skip('invalid-input');
    if (!integer(event.observedAt, 0) || event.observedAt > context.now || event.observedAt < previousTime) return skip('clock-anomaly');
    previousTime = event.observedAt;
  }
  if (!context.enabled) return skip('disabled');
  if (context.conversationKind !== 'group') return skip('not-group');
  if (!context.wantsToRepeat) return skip('not-wanted');
  if (!context.outboundAllowed) return skip('outbound-blocked');
  if (context.lastAttemptAt !== null && context.now - context.lastAttemptAt < config.cooldownMs) return skip('cooldown');
  const anchor = events.at(-1);
  if (!anchor) return skip('no-events');
  if (!sameKey(anchor.conversationKey, context.conversationKey)) return skip('wrong-conversation');
  const anchorText = visibleText(anchor.text);
  if (!eligible(anchor, context.botActorKey) || !anchorText) return skip('ineligible-anchor');
  if (context.now - anchor.observedAt > config.windowMs) return skip('expired-anchor');
  // Deduplicate before counting and limit the current conversation only. Conflicting
  // duplicate IDs are rejected instead of choosing whichever copy gives a candidate.
  const unique = new Map<string, RepetitionEvent>();
  let duplicateAnchor = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (!sameKey(event.conversationKey, context.conversationKey)) continue;
    const previous = unique.get(event.id);
    if (previous) {
      if (!sameEvent(previous, event)) return skip('invalid-input');
      if (index === events.length - 1) duplicateAnchor = true;
      continue;
    }
    unique.set(event.id, event);
  }
  if (duplicateAnchor) return skip('duplicate-anchor');
  const recent = [...unique.values()].slice(-config.windowEvents)
    .filter(event => context.now - event.observedAt <= config.windowMs);
  const matching = recent.filter(event => eligible(event, context.botActorKey) && visibleText(event.text) === anchorText);
  if (matching.length < config.minOccurrences) return skip('insufficient-repetition');
  if (new Set(matching.map(event => event.actorKey)).size < config.minDistinctHumans) return skip('insufficient-humans');
  return { action: 'candidate', text: anchorText, sourceEventIds: matching.map(event => event.id) };
}
