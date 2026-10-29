import type { ConversationIdentity } from './contracts.ts';
/** Stable stream identity. Binding revision is separate so a rebind does not manufacture a person link. */
export declare function canonicalIdentity(value: unknown): ConversationIdentity;
/** Lossless tuple encoding, never nickname matching, numeric coercion or implicit OpenID mapping. */
export declare function conversationKey(value: unknown): string;
