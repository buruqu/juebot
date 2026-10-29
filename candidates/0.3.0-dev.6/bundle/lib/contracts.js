export const ALLOW = Object.freeze({ allowed: true });
export function deny(reason) { return { allowed: false, reason }; }
export class CoreError extends Error {
    code;
    constructor(code) {
        super(code);
        this.name = 'CoreError';
        this.code = code;
    }
}
export function requireCondition(value, code) {
    if (!value)
        throw new CoreError(code);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isId(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function isQQId(value) {
    return typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value);
}
export function isConversation(value) {
    return isRecord(value) && (value.kind === 'private' || value.kind === 'group') && isQQId(value.id);
}
export function sameConversation(a, b) {
    return a.kind === b.kind && a.id === b.id;
}
export function channelKey(channel) {
    return JSON.stringify([channel.kind, channel.id]);
}
export function permissionsFor(policy, channel) {
    return policy.channels.find(rule => sameConversation(rule.conversation, channel))?.permissions;
}
/** Defensive snapshot: changes to callers' objects cannot change an admitted task's policy. */
export function snapshotPolicy(policy) {
    requireCondition(isRecord(policy) && isQQId(policy.botId) && isId(policy.connectionId), 'INVALID_POLICY');
    requireCondition(Array.isArray(policy.channels) && policy.channels.length <= 10000, 'INVALID_CHANNELS');
    const keys = new Set();
    const channels = policy.channels.map((rule) => {
        requireCondition(isRecord(rule) && isConversation(rule.conversation) && isRecord(rule.permissions), 'INVALID_CHANNEL_RULE');
        const p = rule.permissions;
        requireCondition(['receive', 'save', 'learn', 'send'].every(key => typeof p[key] === 'boolean'), 'INVALID_PERMISSIONS');
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
export function normalizeMessage(value) {
    if (!isRecord(value) || !isId(value.eventId) || !isQQId(value.senderId)
        || !isConversation(value.conversation) || typeof value.text !== 'string' || value.text.length > 32768
        || !['plain', 'quoted', 'forwarded', 'mixed'].includes(value.form))
        return undefined;
    if (value.conversation.kind === 'private' && value.conversation.id !== value.senderId)
        return undefined;
    return Object.freeze({
        eventId: value.eventId,
        senderId: value.senderId,
        conversation: Object.freeze({ kind: value.conversation.kind, id: value.conversation.id }),
        text: value.text,
        form: value.form,
    });
}
