import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLedger, CONVERSATION_APPLICATION_ID } from '../src/ledger.ts';
import { ConversationError } from '../src/contracts.ts';
import type { ConversationIdentity, EventInput, SqliteDatabase } from '../src/contracts.ts';

// Real Node SQLite with synthetic values only. Driver/file opening is owned by
// these tests, never by the ledger; no profile or pre-existing database is read.
const identity: ConversationIdentity = { botId: 'synthetic-bot', personaId: 'persona', connector: 'local-test',
  issuer: 'fixture', accountId: 'account', kind: 'group', remoteId: 'group-a' };
const code = (expected: string) => (error: unknown) => error instanceof ConversationError && error.code === expected
  && error.message === expected;
function database() { return new DatabaseSync(':memory:', { allowExtension: false }); }
function fixture(t: { after(fn: () => void): void }) {
  const db = database(); t.after(() => db.close());
  const ledger = new ConversationLedger(db as SqliteDatabase, { namespace: 'synthetic', initialize: true });
  const conversation = ledger.registerConversation(identity, 0, 100);
  const event = (patch: Partial<EventInput> = {}): EventInput => ({ conversationKey: conversation.key,
    bindingRevision: 0, sourceEventId: 'event-a', occurredAt: 101, eventType: 'message.received',
    reasonCode: 'NONE', actorId: 'actor', runId: null, causedBy: null, body: 'PRIVATE-SYNTHETIC-BODY', ...patch });
  return { db, ledger, conversation, event };
}
function scalar(db: DatabaseSync, sql: string): unknown { return Object.values(db.prepare(sql).get()!)[0]; }

test('requires explicit initialization and stamps isolated application/version/namespace', t => {
  const db = database(); t.after(() => db.close());
  assert.throws(() => new ConversationLedger(db as SqliteDatabase, { namespace: 'fixture' }), code('STORE_NOT_INITIALIZED'));
  assert.equal(scalar(db, 'SELECT count(*) FROM sqlite_schema'), 0);
  const ledger = new ConversationLedger(db as SqliteDatabase, { namespace: 'fixture', initialize: true });
  assert.equal(scalar(db, 'PRAGMA application_id'), CONVERSATION_APPLICATION_ID);
  assert.equal(scalar(db, 'PRAGMA user_version'), 1);
  assert.equal(scalar(db, 'SELECT owner_namespace FROM ledger_metadata'), 'fixture');
  ledger.close();
  assert.doesNotThrow(() => new ConversationLedger(db as SqliteDatabase, { namespace: 'fixture' }));
});
test('refuses foreign, old-memory, partial, future and other namespace databases without rewriting', t => {
  for (const mutation of [
    'CREATE TABLE unrelated(value TEXT)', 'PRAGMA application_id=1247102274', 'PRAGMA user_version=9',
  ]) {
    const db = database(); t.after(() => db.close()); db.exec(mutation);
    const before = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    assert.throws(() => new ConversationLedger(db as SqliteDatabase, { namespace: 'fixture', initialize: true }), code('STORE_MISMATCH'));
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before);
  }
  for (const mutation of ['DROP TABLE event_bodies', 'PRAGMA user_version=2', 'PRAGMA application_id=0',
    'CREATE TABLE extra(value TEXT)', 'CREATE TABLE sqlitexhidden(value TEXT)']) {
    const db = database(); t.after(() => db.close());
    new ConversationLedger(db as SqliteDatabase, { namespace: 'fixture', initialize: true }).close(); db.exec(mutation);
    assert.throws(() => new ConversationLedger(db as SqliteDatabase, { namespace: 'fixture', initialize: true }), code('STORE_MISMATCH'));
  }
  const db = database(); t.after(() => db.close());
  new ConversationLedger(db as SqliteDatabase, { namespace: 'owner-a', initialize: true }).close();
  assert.throws(() => new ConversationLedger(db as SqliteDatabase, { namespace: 'owner-b', initialize: true }), code('STORE_MISMATCH'));
});
test('schema creation failure rolls back ownership and every created table', t => {
  const db = database(); t.after(() => db.close());
  // Only fault injection is synthetic; every executed statement uses real SQLite.
  let creates = 0;
  const broken: SqliteDatabase = { prepare: sql => db.prepare(sql), exec: sql => {
    if (sql.startsWith('CREATE TABLE') && ++creates === 2) throw new Error('PRIVATE-driver-failure'); db.exec(sql);
  } };
  assert.throws(() => new ConversationLedger(broken, { namespace: 'synthetic', initialize: true }), code('STORAGE_FAILURE'));
  assert.equal(scalar(db, 'SELECT count(*) FROM sqlite_schema'), 0);
  assert.equal(scalar(db, 'PRAGMA application_id'), 0);
  assert.equal(scalar(db, 'PRAGMA user_version'), 0);
  assert.doesNotThrow(() => new ConversationLedger(db as SqliteDatabase, { namespace: 'synthetic', initialize: true }));
});
test('registration idempotence, immutable returned copies and binding CAS', t => {
  const { ledger, conversation } = fixture(t);
  assert.deepEqual(ledger.registerConversation(identity, 0, 999), conversation);
  conversation.identity.remoteId = 'modified-copy';
  assert.equal(ledger.getConversation(conversation.key)!.identity.remoteId, 'group-a');
  assert.throws(() => ledger.registerConversation(identity, 1, 102), code('BINDING_CONFLICT'));
  const changed = ledger.changeBinding(conversation.key, 0, 2, 103);
  assert.equal(changed.bindingRevision, 2); assert.equal(changed.createdAt, 100); assert.equal(changed.updatedAt, 103);
  assert.throws(() => ledger.changeBinding(conversation.key, 0, 3, 104), code('BINDING_CONFLICT'));
  assert.throws(() => ledger.changeBinding(conversation.key, 2, 2, 104), code('INVALID_INPUT'));
  assert.throws(() => ledger.changeBinding('missing', 0, 1, 104), code('CONVERSATION_NOT_FOUND'));
});
test('append persists body separately, metadata never includes it, exact replay is idempotent', t => {
  const { db, ledger, event, conversation } = fixture(t);
  const first = ledger.append(event()); const replay = ledger.append(event());
  assert.equal(first.duplicate, false); assert.equal(replay.duplicate, true); assert.deepEqual(replay.event, first.event);
  assert.equal(first.event.bodyRef, first.event.sequence);
  assert.equal(scalar(db, 'SELECT count(*) FROM ledger_events'), 1);
  assert.equal(scalar(db, 'SELECT count(*) FROM event_bodies'), 1);
  assert.equal(ledger.readBody(conversation.key, 0, first.event.sequence), 'PRIVATE-SYNTHETIC-BODY');
  const metadata = [first.event, ...ledger.pageEvents(conversation.key, 0, 0, 101)];
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE-SYNTHETIC-BODY'));
  assert.ok(metadata.every(value => !Object.hasOwn(value, 'body')));
  const fields = db.prepare('PRAGMA table_info(ledger_events)').all().map(entry => entry.name);
  assert.ok(!fields.includes('body'));
});
test('same source id compares every contract field and private body', t => {
  const { ledger, event } = fixture(t); ledger.append(event());
  const changes: Partial<EventInput>[] = [{ occurredAt: 102 }, { eventType: 'reply.draft' }, { reasonCode: 'NOT_INTERESTED' },
    { actorId: 'other' }, { actorId: null }, { runId: 'run' }, { causedBy: 1 }, { body: 'DIFFERENT-PRIVATE' }, { body: null }];
  for (const change of changes) assert.throws(() => ledger.append(event(change)), code('EVENT_CONFLICT'));
});
test('nullable and empty bodies remain distinct and SQL-looking strings are data', t => {
  const { ledger, event, conversation } = fixture(t);
  for (const [sourceEventId, body] of [['null-body', null], ['empty-body', ''], ["x'); DROP TABLE event_bodies;--", "' OR 1=1 --"]] as const) {
    const saved = ledger.append(event({ sourceEventId, body }));
    assert.equal(saved.event.bodyRef, body === null ? null : saved.event.sequence);
    assert.equal(ledger.readBody(conversation.key, 0, saved.event.sequence), body);
  }
  assert.equal(ledger.pageEvents(conversation.key, 0, 0, 10).length, 3);
});
test('scope list/page/body and causal references never cross streams or bindings', t => {
  const { ledger, conversation, event } = fixture(t);
  const other = ledger.registerConversation({ ...identity, remoteId: 'group-b' }, 0, 100);
  const a = ledger.append(event());
  const b = ledger.append(event({ conversationKey: other.key, sourceEventId: 'event-b', body: 'OTHER-PRIVATE' }));
  assert.deepEqual(ledger.listConversations([other.key], null, 101).map(value => value.key), [other.key]);
  assert.deepEqual(ledger.listConversations([], null, 1), []);
  assert.deepEqual(ledger.pageEvents(conversation.key, 0, 0, 101).map(value => value.sequence), [a.event.sequence]);
  assert.equal(ledger.readBody(conversation.key, 0, b.event.sequence), null);
  assert.throws(() => ledger.append(event({ sourceEventId: 'cross-cause', causedBy: b.event.sequence })), code('SOURCE_NOT_FOUND'));
  assert.throws(() => ledger.append(event({ sourceEventId: 'absent-cause', causedBy: 999 })), code('SOURCE_NOT_FOUND'));
  assert.equal(ledger.append(event({ sourceEventId: 'valid-cause', causedBy: a.event.sequence, eventType: 'reply.confirmed', body: null })).duplicate, false);
  ledger.changeBinding(conversation.key, 0, 1, 200);
  assert.throws(() => ledger.pageEvents(conversation.key, 0, 0, 10), code('BINDING_CONFLICT'));
  assert.throws(() => ledger.readBody(conversation.key, 0, a.event.sequence), code('BINDING_CONFLICT'));
  assert.throws(() => ledger.append(event()), code('BINDING_CONFLICT'));
  assert.equal(ledger.readBody(conversation.key, 1, a.event.sequence), null);
  assert.deepEqual(ledger.pageEvents(conversation.key, 1, 0, 10), []);
  assert.throws(() => ledger.append(event({ bindingRevision: 1, sourceEventId: 'old-cause', causedBy: a.event.sequence })), code('SOURCE_NOT_FOUND'));
  assert.equal(ledger.append(event({ bindingRevision: 1 })).duplicate, false);
});
test('body insert failure cannot publish a half event and errors are redacted', t => {
  const { db, ledger, event, conversation } = fixture(t);
  db.exec("CREATE TRIGGER reject_body BEFORE INSERT ON event_bodies BEGIN SELECT RAISE(ABORT,'PRIVATE-SQLITE-DETAIL'); END");
  assert.throws(() => ledger.append(event()), code('STORAGE_FAILURE'));
  assert.equal(scalar(db, 'SELECT count(*) FROM ledger_events'), 0);
  assert.equal(scalar(db, 'SELECT count(*) FROM event_bodies'), 0);
  assert.deepEqual(ledger.pageEvents(conversation.key, 0, 0, 101), []);
  db.exec('DROP TRIGGER reject_body');
  const result = ledger.append(event()); assert.equal(result.duplicate, false);
  assert.equal(ledger.readBody(conversation.key, 0, result.event.sequence), event().body);
});
test('commit failure rolls back event and body before any append result returns', t => {
  const db = database(); t.after(() => db.close()); let failCommit = false;
  const port: SqliteDatabase = { prepare: sql => db.prepare(sql), exec: sql => {
    if (sql === 'COMMIT' && failCommit) throw new Error('PRIVATE-COMMIT'); db.exec(sql);
  } };
  const ledger = new ConversationLedger(port, { namespace: 'synthetic', initialize: true });
  const registered = ledger.registerConversation(identity, 0, 1); failCommit = true;
  const input: EventInput = { conversationKey: registered.key, bindingRevision: 0, sourceEventId: 'id', occurredAt: 1,
    eventType: 'reply.draft', reasonCode: 'NONE', actorId: null, runId: null, causedBy: null, body: 'PRIVATE' };
  assert.throws(() => ledger.append(input), code('STORAGE_FAILURE'));
  assert.equal(scalar(db, 'SELECT count(*) FROM ledger_events'), 0); assert.equal(scalar(db, 'SELECT count(*) FROM event_bodies'), 0);
  failCommit = false; assert.equal(ledger.append(input).duplicate, false);
});
test('strict reader ranges and append validation reject unsupported inputs', t => {
  const { ledger, event, conversation } = fixture(t);
  for (const limit of [0, -1, 102, 1.5, NaN, Infinity]) {
    assert.throws(() => ledger.pageEvents(conversation.key, 0, 0, limit), code('INVALID_INPUT'));
    assert.throws(() => ledger.listConversations([conversation.key], null, limit), code('INVALID_INPUT'));
  }
  assert.throws(() => ledger.listConversations(Array(129).fill(conversation.key), null, 1), code('INVALID_INPUT'));
  assert.throws(() => ledger.pageEvents(conversation.key, 0, -1, 1), code('INVALID_INPUT'));
  assert.throws(() => ledger.readBody(conversation.key, 0, 0), code('INVALID_INPUT'));
  assert.throws(() => ledger.append(event({ eventType: 'reply.confirmed' })), code('INVALID_INPUT'));
  assert.throws(() => ledger.append(event({ body: 'x'.repeat(16001) })), code('INVALID_INPUT'));
  assert.throws(() => ledger.append(event({ body: 'x\u0000y' })), code('INVALID_INPUT'));
});
test('synthetic disk reopen retains ownership, ordering, pagination and current binding', t => {
  const directory = mkdtempSync(join(tmpdir(), 'juebot-conversation-ledger-'));
  const file = join(directory, 'synthetic.sqlite');
  let db = new DatabaseSync(file, { allowExtension: false });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  let ledger = new ConversationLedger(db as SqliteDatabase, { namespace: 'synthetic', initialize: true });
  const keys = ['z', 'a', 'm'].map(remoteId => ledger.registerConversation({ ...identity, remoteId }, 0, 1).key);
  const key = keys[0]!;
  for (let i = 0; i < 7; i++) ledger.append({ conversationKey: key, bindingRevision: 0, sourceEventId: `message-${i}`,
    occurredAt: 100 - i, eventType: 'message.received', reasonCode: 'NONE', actorId: null, runId: null, causedBy: null, body: `synthetic-${i}` });
  ledger.close(); db.close();
  db = new DatabaseSync(file, { allowExtension: false });
  ledger = new ConversationLedger(db as SqliteDatabase, { namespace: 'synthetic' });
  const sorted = [...keys].sort(); const first = ledger.listConversations(keys, null, 2);
  assert.deepEqual(first.map(value => value.key), sorted.slice(0, 2));
  assert.deepEqual(ledger.listConversations(keys, first[1]!.key, 101).map(value => value.key), sorted.slice(2));
  const one = ledger.pageEvents(key, 0, 0, 3); const two = ledger.pageEvents(key, 0, one[2]!.sequence, 101);
  assert.equal(one.length, 3); assert.equal(two.length, 4);
  assert.ok([...one, ...two].every((value, index, all) => index === 0 || value.sequence > all[index - 1]!.sequence));
  assert.equal(ledger.readBody(key, 0, two[3]!.sequence), 'synthetic-6');
  ledger.changeBinding(key, 0, 3, 200); ledger.close(); db.close();
  db = new DatabaseSync(file, { allowExtension: false }); ledger = new ConversationLedger(db as SqliteDatabase, { namespace: 'synthetic' });
  assert.throws(() => ledger.pageEvents(key, 0, 0, 1), code('BINDING_CONFLICT'));
  assert.deepEqual(ledger.pageEvents(key, 3, 0, 1), []);
});
test('close denies every ledger operation but leaves caller database usable', t => {
  const { db, ledger, event, conversation } = fixture(t); ledger.close(); ledger.close();
  for (const operation of [() => ledger.registerConversation(identity, 0, 1), () => ledger.changeBinding(conversation.key, 0, 1, 1),
    () => ledger.append(event()), () => ledger.getConversation(conversation.key), () => ledger.listConversations([], null, 1),
    () => ledger.pageEvents(conversation.key, 0, 0, 1), () => ledger.readBody(conversation.key, 0, 1)]) {
    assert.throws(operation, code('STORE_CLOSED'));
  }
  assert.equal(scalar(db, 'SELECT 1'), 1);
});
