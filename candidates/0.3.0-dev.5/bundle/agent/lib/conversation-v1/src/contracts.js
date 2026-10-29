/** Offline conversation ledger contracts. Host supplies identities and permissions. */
export const LIMITS = Object.freeze({ id: 256, body: 16000, grants: 128, page: 100 });
export class ConversationError extends Error {
    code;
    constructor(code) { super(code); this.name = 'ConversationError'; this.code = code; }
}
export function demand(ok, code = 'INVALID_INPUT') {
    if (!ok)
        throw new ConversationError(code);
}
export function record(value, keys) {
    demand(value !== null && typeof value === 'object' && !Array.isArray(value));
    demand(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    demand(Object.keys(value).every(key => keys.includes(key)));
}
export function id(value, max = LIMITS.id) {
    demand(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
        && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value));
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    demand(Number.isSafeInteger(value) && value >= min && value <= max);
}
export const EVENT_TYPES = ['message.received', 'reply.draft', 'decision.recorded', 'reply.submitted',
    'reply.confirmed', 'reply.failed', 'reply.unknown', 'policy.changed'];
export const REASONS = ['NONE', 'NOT_INTERESTED', 'EXPRESSION_BLOCKED', 'OUTBOUND_PAUSED', 'POLICY_CHANGED',
    'MODEL_ERROR', 'TOOL_ERROR', 'DELIVERY_UNCERTAIN'];
export function validateEvent(value) {
    record(value, ['conversationKey', 'bindingRevision', 'sourceEventId', 'occurredAt', 'eventType', 'reasonCode', 'actorId', 'runId', 'causedBy', 'body']);
    id(value.conversationKey, 4096);
    integer(value.bindingRevision);
    id(value.sourceEventId);
    integer(value.occurredAt);
    demand(EVENT_TYPES.includes(value.eventType) && REASONS.includes(value.reasonCode));
    for (const key of ['actorId', 'runId'])
        if (value[key] !== null)
            id(value[key]);
    if (value.causedBy !== null)
        integer(value.causedBy, 1);
    demand(value.body === null || (typeof value.body === 'string' && value.body.length <= LIMITS.body && !/[\u0000\uD800-\uDFFF]/u.test(value.body)));
    // Delivery outcomes reference the prior draft rather than copying its body into every event.
    if (value.eventType !== 'message.received' && value.eventType !== 'reply.draft' && value.eventType !== 'decision.recorded')
        demand(value.body === null);
}
