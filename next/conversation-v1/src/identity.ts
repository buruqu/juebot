import { demand, id, record } from './contracts.ts';
import type { ConversationIdentity } from './contracts.ts';

/** Stable stream identity. Binding revision is separate so a rebind does not manufacture a person link. */
export function canonicalIdentity(value: unknown): ConversationIdentity {
  record(value, ['botId', 'personaId', 'connector', 'issuer', 'accountId', 'kind', 'remoteId']);
  for (const key of ['botId', 'personaId', 'issuer', 'accountId', 'remoteId']) id(value[key]);
  demand(['qq-personal', 'qq-official', 'bilibili', 'local-test'].includes(value.connector as string));
  demand(['group', 'direct', 'thread'].includes(value.kind as string));
  demand(value.connector === 'local-test' || (value.connector === 'bilibili'
    ? value.kind !== 'group' : value.kind !== 'thread'));
  return { botId: value.botId as string, personaId: value.personaId as string,
    connector: value.connector as ConversationIdentity['connector'], issuer: value.issuer as string,
    accountId: value.accountId as string, kind: value.kind as ConversationIdentity['kind'], remoteId: value.remoteId as string };
}
/** Lossless tuple encoding, never nickname matching, numeric coercion or implicit OpenID mapping. */
export function conversationKey(value: unknown): string {
  const identity = canonicalIdentity(value);
  return JSON.stringify(['juebot-conversation-v1', identity.botId, identity.personaId, identity.connector,
    identity.issuer, identity.accountId, identity.kind, identity.remoteId]);
}
