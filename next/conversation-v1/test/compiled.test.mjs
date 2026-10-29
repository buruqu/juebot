import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ConversationLedger } from '../lib/ledger.js';
import { ConversationReadService } from '../lib/read-service.js';
import { createConversationHttp } from '../lib/http.js';

test('emitted ESM imports resolve and preserve scoped HTTP/body separation with real SQLite', async t => {
  const db = new DatabaseSync(':memory:', { allowExtension: false }); t.after(() => db.close());
  const ledger = new ConversationLedger(db, { namespace: 'compiled-fixture', initialize: true });
  const conversation = ledger.registerConversation({ botId: 'bot', personaId: 'persona', connector: 'local-test', issuer: 'test', accountId: 'account', kind: 'group', remoteId: 'group' }, 1, 1);
  const stored = ledger.append({ conversationKey: conversation.key, bindingRevision: 1, sourceEventId: 'source', occurredAt: 2,
    eventType: 'message.received', reasonCode: 'NONE', actorId: 'actor', runId: null, causedBy: null, body: 'synthetic compiled payload' });
  const reader = new ConversationReadService(ledger, async () => ({ revision: 1, grants: [{ key: conversation.key, bindingRevision: 1, metadata: true, body: false }] }));
  const handle = createConversationHttp({ reader, resolvePrincipal: async () => 'synthetic-owner' });
  const list = await handle(new Request('https://fixture.invalid/juebot/conversations'));
  assert.equal(list.status, 200); assert.equal((await list.text()).includes('synthetic compiled payload'), false);
  const url = new URL('https://fixture.invalid/juebot/conversation-body'); url.searchParams.set('key', conversation.key); url.searchParams.set('sequence', String(stored.event.sequence));
  const denied = await handle(new Request(url)); assert.equal(denied.status, 403);
});
