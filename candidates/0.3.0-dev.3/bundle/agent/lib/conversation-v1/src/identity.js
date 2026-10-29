import { demand, id, record } from "./contracts.js";
/** Stable stream identity. Binding revision is separate so a rebind does not manufacture a person link. */
export function canonicalIdentity(value) {
    record(value, ['botId', 'personaId', 'connector', 'issuer', 'accountId', 'kind', 'remoteId']);
    for (const key of ['botId', 'personaId', 'issuer', 'accountId', 'remoteId'])
        id(value[key]);
    demand(['qq-personal', 'qq-official', 'bilibili', 'local-test'].includes(value.connector));
    demand(['group', 'direct', 'thread'].includes(value.kind));
    demand(value.connector === 'local-test' || (value.connector === 'bilibili'
        ? value.kind !== 'group' : value.kind !== 'thread'));
    return { botId: value.botId, personaId: value.personaId,
        connector: value.connector, issuer: value.issuer,
        accountId: value.accountId, kind: value.kind, remoteId: value.remoteId };
}
/** Lossless tuple encoding, never nickname matching, numeric coercion or implicit OpenID mapping. */
export function conversationKey(value) {
    const identity = canonicalIdentity(value);
    return JSON.stringify(['juebot-conversation-v1', identity.botId, identity.personaId, identity.connector,
        identity.issuer, identity.accountId, identity.kind, identity.remoteId]);
}
