import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError, MemoryStore, STORAGE_APPLICATION_ID, STORAGE_SCHEMA_VERSION } from '../src/index.ts';
import type { CorePolicy, MemoryContext, MemoryRecord, SharingGrant, SqliteDatabase, VectorSpace } from '../src/index.ts';

const BOT = '90001';
const ADMIN = '10001';
const DM = { kind: 'private' as const, id: ADMIN };
const G1 = { kind: 'group' as const, id: '20001' };
const G2 = { kind: 'group' as const, id: '20002' };
const SPACE: VectorSpace = { provider: 'synthetic', model: 'fixture', generation: 1, dimensions: 2 };
const permissions = { receive: true, save: true, learn: true, send: true };
function policy(botId = BOT): CorePolicy {
  return { botId, connectionId: 'fixture', channels: [DM, G1, G2].map(conversation => ({ conversation, permissions: { ...permissions } })) };
}
function context(conversation = DM as MemoryContext['conversation'], changes: Partial<MemoryContext> = {}): MemoryContext {
  return { botId: BOT, conversation, domain: 'social', workspaceId: null, personaId: 'juejue', adminId: ADMIN, adminBindingId: 'binding-1', ...changes };
}
function memory(changes: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id: 'fact', botId: BOT, domain: 'social', workspaceId: null, personaId: null, kind: 'fact', subjectId: ADMIN,
    adminBindingId: null, origin: DM, scope: { kind: 'private', userId: ADMIN }, deleted: false, derived: false, sourceIds: [], ...changes };
}
function grant(changes: Partial<SharingGrant> = {}): SharingGrant {
  return { id: 'grant', memoryId: 'fact', botId: BOT, approvedBy: ADMIN, adminBindingId: 'binding-1', active: true, targets: [G1], ...changes };
}
const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  const store = new MemoryStore(db as unknown as SqliteDatabase, BOT, { initialize: true });
  t.after(() => store.close());
  return { db, store };
}
function disk(t: { after(fn: () => void): void }) {
  const parent = path.resolve(fileURLToPath(new URL('../.test-tmp/', import.meta.url)));
  mkdirSync(parent, { recursive: true });
  const created = realpathSync(mkdtempSync(path.join(parent, 'juebot-storage-')));
  const databases: DatabaseSync[] = [];
  t.after(() => {
    for (const db of databases.reverse()) if (db.isOpen) db.close();
    // Delete only this test's exact newly-created directory, after verifying its identity and parent.
    assert.equal(realpathSync(created), created);
    assert.equal(path.dirname(created), realpathSync(parent));
    assert.ok(path.basename(created).startsWith('juebot-storage-'));
    rmSync(created, { recursive: true, force: false });
  });
  return { directory: created, open: () => {
    const db = new DatabaseSync(path.join(created, 'memory.sqlite'), { allowExtension: false });
    databases.push(db);
    return db;
  } };
}

test('storage requires explicit initialization and tags a new owned schema atomically', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => new MemoryStore(db as unknown as SqliteDatabase, BOT), code('INITIALIZATION_REQUIRED'));
    assert.equal(db.prepare('PRAGMA application_id').get()?.application_id, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.n, 0);
    const store = new MemoryStore(db as unknown as SqliteDatabase, BOT, { initialize: true });
    assert.equal(db.prepare('PRAGMA application_id').get()?.application_id, STORAGE_APPLICATION_ID);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, STORAGE_SCHEMA_VERSION);
    assert.equal(store.stateRevision(), 0);
    store.close();
  } finally { if (db.isOpen) db.close(); }
});

test('foreign and future databases are rejected without altering their contents or version', () => {
  for (const future of [false, true]) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'keep\')');
      if (future) db.exec(`PRAGMA application_id=${STORAGE_APPLICATION_ID}; PRAGMA user_version=99`);
      assert.throws(() => new MemoryStore(db as unknown as SqliteDatabase, BOT, { initialize: true }), code(future ? 'UNSUPPORTED_SCHEMA_VERSION' : 'FOREIGN_DATABASE'));
      assert.equal(db.prepare('SELECT value FROM unrelated').get()?.value, 'keep');
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, future ? 99 : 0);
    } finally { db.close(); }
  }
});

test('migration failure rolls back partial DDL and ownership tags', () => {
  const db = new DatabaseSync(':memory:');
  const failing: SqliteDatabase = {
    close: () => db.close(), prepare: sql => db.prepare(sql) as unknown as ReturnType<SqliteDatabase['prepare']>,
    exec: sql => {
      if (sql.includes('CREATE TABLE memory_records')) {
        db.exec(`CREATE TABLE partial(value TEXT); PRAGMA application_id=${STORAGE_APPLICATION_ID}; PRAGMA user_version=1`);
        throw new Error('synthetic migration failure');
      }
      db.exec(sql);
    },
  };
  try {
    assert.throws(() => new MemoryStore(failing, BOT, { initialize: true }), /synthetic migration failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.n, 0);
    assert.equal(db.prepare('PRAGMA application_id').get()?.application_id, 0);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
  } finally { db.close(); }
});

test('reopening refuses missing or modified FTS triggers rather than accepting stale indexes', t => {
  const { db } = fixture(t);
  db.exec('DROP TRIGGER memory_update');
  assert.throws(() => new MemoryStore(db as unknown as SqliteDatabase, BOT), code('UNSUPPORTED_SCHEMA_LAYOUT'));
  db.exec('CREATE TRIGGER memory_update AFTER UPDATE OF body ON memory_records BEGIN SELECT 1; END;');
  assert.throws(() => new MemoryStore(db as unknown as SqliteDatabase, BOT), code('UNSUPPORTED_SCHEMA_LAYOUT'));
});

test('invisible corpus changes do not alter public lexical scores', t => {
  const { store } = fixture(t);
  store.put(memory({ id: 'public', origin: G1, scope: { kind: 'conversation', conversation: G1 } }), '上海市公开资料', null, policy());
  const before = store.searchText('上海市', context(G1), policy());
  store.put(memory({ id: 'zz-private', origin: G2, scope: { kind: 'conversation', conversation: G2 } }), '不可见'.repeat(300), null, policy());
  assert.equal(store.getVisible('zz-private', context(G1), policy()).allowed, false);
  assert.deepEqual(store.searchText('上海市', context(G1), policy()), before);
  store.put(memory({ id: 'zz-private', origin: G2, scope: { kind: 'conversation', conversation: G2 } }), '上海市私密资料'.repeat(300), 1, policy());
  assert.deepEqual(store.searchText('上海市', context(G1), policy()), before);
});

test('put/read and optimistic revisions do not silently overwrite or mutate caller data', t => {
  const { store } = fixture(t);
  const record = memory();
  assert.equal(store.put(record, '管理员喜欢绿茶', null, policy()), 1);
  const visible = store.getVisible('fact', context(), policy());
  assert.equal(visible.allowed, true);
  if (visible.allowed) {
    assert.equal(visible.value.body, '管理员喜欢绿茶');
    (visible.value.record.scope as { kind: string }).kind = 'admin-global';
  }
  assert.equal(store.getVisible('fact', context(G1), policy()).allowed, false);
  assert.throws(() => store.put(record, 'overwrite', null, policy()), code('REVISION_CONFLICT'));
  assert.equal(store.put(record, '管理员改为喜欢红茶', 1, policy()), 2);
  assert.throws(() => store.put(record, 'stale', 1, policy()), code('REVISION_CONFLICT'));
  assert.equal(store.stateRevision(), 2);
});

test('metadata snapshots discard undeclared conversation and target payload fields', t => {
  const { store, db } = fixture(t);
  const extraOrigin = { ...DM, secret: 'synthetic-extra' };
  store.put(memory({ origin: extraOrigin, scope: { kind: 'conversation', conversation: extraOrigin } }), 'body', null, policy());
  const metadata = store.metadata('fact')!.record;
  assert.deepEqual(metadata.origin, DM);
  assert.deepEqual(metadata.scope, { kind: 'conversation', conversation: DM });
  store.putGrant(grant({ targets: [{ ...G1, secret: 'synthetic-extra' } as typeof G1] }), null);
  assert.ok(!String(db.prepare('SELECT metadata FROM sharing_grants').get()?.metadata).includes('synthetic-extra'));
});

test('permissions precede body retrieval and textual retrieval, not merely final display', () => {
  const db = new DatabaseSync(':memory:');
  const statements: string[] = [];
  const port: SqliteDatabase = { exec: sql => db.exec(sql), close: () => db.close(), prepare: sql => {
    statements.push(sql);
    return db.prepare(sql) as unknown as ReturnType<SqliteDatabase['prepare']>;
  } };
  const store = new MemoryStore(port, BOT, { initialize: true });
  try {
    store.put(memory(), '秘密南京市行程', null, policy());
    statements.length = 0;
    assert.equal(store.getVisible('fact', context(G1), policy()).allowed, false);
    assert.deepEqual(store.searchText('南京市', context(G1), policy()).matches, []);
    assert.ok(!statements.some(sql => /^SELECT body\b/u.test(sql)));
    assert.ok(!statements.some(sql => sql.includes('memory_fts MATCH')));
  } finally { store.close(); }
});

for (const field of ['receive', 'save'] as const) {
  test(`storage write requires current ${field} permission`, t => {
    const { store } = fixture(t);
    const p = policy();
    const denied = { ...p, channels: p.channels.map(rule => ({ ...rule, permissions: { ...rule.permissions, [field]: false } })) };
    assert.throws(() => store.put(memory(), 'not saved', null, denied), code('SAVE_NOT_AUTHORIZED'));
    assert.equal(store.metadata('fact'), undefined);
    assert.equal(store.stateRevision(), 0);
  });
}

test('trigram and short Chinese/astral substring fallback use Unicode code points', t => {
  const { store } = fixture(t);
  store.put(memory(), '南京市长江大桥，𠮷野家，绿茶', null, policy());
  for (const [text, method] of [['南京市', 'fts5-trigram'], ['南京', 'substring'], ['𠮷野家', 'fts5-trigram'], ['𠮷野', 'substring'], ['绿茶', 'substring']]) {
    const result = store.searchText(text!, context(), policy());
    assert.equal(result.method, method);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.value.record.id, 'fact');
  }
  assert.deepEqual(store.searchText(' ', context(), policy()).matches, []);
});

test('SQL binding and FTS literal escaping keep operators, quotes and wildcard characters as data', t => {
  const { store } = fixture(t);
  store.put(memory({ id: 'literal' }), '南京市 OR 博物院; O\'Reilly; 100%_literal; 猫"猫"猫', null, policy());
  store.put(memory({ id: 'other' }), '南京市很美', null, policy());
  assert.deepEqual(store.searchText('南京市 OR 博物院', context(), policy()).matches.map(m => m.value.record.id), ['literal']);
  for (const text of ['O\'Reilly', '%_', '猫"猫"猫']) assert.equal(store.searchText(text, context(), policy()).matches.length, 1);
  assert.equal(store.searchText("' OR 1=1 --", context(), policy()).matches.length, 0);
  assert.equal(store.metadata('other')?.revision, 1);
});

test('explicit sharing is target-limited, CAS-protected, and revocation keeps source access', t => {
  const { store } = fixture(t);
  store.put(memory({ scope: { kind: 'grant', grantId: 'grant' } }), '共享南京市资料', null, policy());
  assert.equal(store.getVisible('fact', context(G1), policy()).allowed, false);
  assert.equal(store.putGrant(grant(), null), 1);
  assert.equal(store.searchText('南京市', context(G1), policy()).matches.length, 1);
  assert.equal(store.searchText('南京市', context(G2), policy()).matches.length, 0);
  assert.throws(() => store.putGrant(grant({ active: false }), null), code('REVISION_CONFLICT'));
  assert.equal(store.putGrant(grant({ active: false }), 1), 2);
  assert.equal(store.getVisible('fact', context(G1), policy()).allowed, false);
  assert.equal(store.getVisible('fact', context(), policy()).allowed, true);
});

test('private ancestors cannot be laundered; grant revocation is checked on every call', t => {
  const { store } = fixture(t);
  store.put(memory(), '私聊的南京市资料', null, policy());
  const child = memory({ id: 'summary', kind: 'summary', derived: true, sourceIds: ['fact'], scope: { kind: 'grant', grantId: 'child-grant' } });
  store.put(child, '南京市摘要', null, policy());
  store.putGrant(grant({ id: 'child-grant', memoryId: 'summary' }), null);
  assert.equal(store.getVisible('summary', context(G1), policy()).allowed, false);
  // Updating the parent binds a new revision; the child must explicitly be rebuilt.
  store.put(memory({ scope: { kind: 'grant', grantId: 'grant' } }), '私聊的南京市资料', 1, policy());
  store.putGrant(grant(), null);
  assert.equal(store.getVisible('summary', context(G1), policy()).allowed, false);
  store.put(child, '经重建的南京市摘要', 1, policy());
  assert.equal(store.getVisible('summary', context(G1), policy()).allowed, true);
  store.putGrant(grant({ active: false }), 1);
  assert.equal(store.getVisible('summary', context(G1), policy()).allowed, false);
  assert.equal(store.getVisible('summary', context(), policy()).allowed, true);
});

test('source revision changes invalidate descendants and vectors until explicit rebuild', t => {
  const { store } = fixture(t);
  store.put(memory(), '旧的父事实', null, policy());
  const child = memory({ id: 'summary', kind: 'summary', derived: true, sourceIds: ['fact'] });
  store.put(child, '旧的南京市摘要', null, policy());
  store.putVector('summary', SPACE, [1, 0], 1, policy());
  store.put(memory(), '纠正后的父事实', 1, policy());
  assert.equal(store.getVisible('summary', context(), policy()).allowed, false);
  assert.equal(store.searchText('南京市', context(), policy()).matches.length, 0);
  assert.equal(store.searchVector(SPACE, [1, 0], context(), policy()).matches.length, 0);
  store.put(child, '新的南京市摘要', 1, policy());
  assert.equal(store.getVisible('summary', context(), policy()).allowed, true);
  assert.equal(store.searchVector(SPACE, [1, 0], context(), policy()).matches.length, 0);
});

test('tombstones clear current payload/index and prevent resurrection or derived reuse', t => {
  const { store, db } = fixture(t);
  store.put(memory(), '南京市秘密', null, policy());
  store.put(memory({ id: 'child', derived: true, sourceIds: ['fact'] }), '派生南京市秘密', null, policy());
  store.putVector('fact', SPACE, [1, 0], 1, policy());
  assert.equal(store.tombstone('fact', 1), 2);
  assert.equal(db.prepare('SELECT body FROM memory_records WHERE id=?').get('fact')?.body, '');
  assert.equal(store.searchText('南京市', context(), policy()).matches.length, 0);
  assert.equal(store.searchVector(SPACE, [1, 0], context(), policy()).matches.length, 0);
  assert.throws(() => store.put(memory(), 'revived', 2, policy()), code('TOMBSTONED_MEMORY'));
  assert.throws(() => store.putGrant(grant(), null), code('MEMORY_MISSING_OR_DELETED'));
});

test('record updates cannot change origin or domain, and engineering is never social', t => {
  const { store } = fixture(t);
  store.put(memory(), 'original', null, policy());
  assert.throws(() => store.put(memory({ origin: G1 }), 'moved', 1, policy()), code('MEMORY_IDENTITY_IMMUTABLE'));
  assert.throws(() => store.put(memory({ domain: 'code', workspaceId: 'project' }), 'moved', 1, policy()), code('MEMORY_IDENTITY_IMMUTABLE'));
  assert.throws(() => store.put(memory({ id: 'engineering', kind: 'engineering' }), 'code', null, policy()), code('ENGINEERING_REQUIRES_CODE_DOMAIN'));
  assert.equal(store.stateRevision(), 1);
});

test('row, FTS and source-edge updates roll back together when a later statement fails', t => {
  const { store, db } = fixture(t);
  store.put(memory(), 'parent', null, policy());
  db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON memory_edges BEGIN SELECT RAISE(ABORT,'synthetic edge failure'); END;");
  const child = memory({ id: 'child', derived: true, sourceIds: ['fact'] });
  assert.throws(() => store.put(child, '南京市回滚文本', null, policy()), /synthetic edge failure/);
  assert.equal(store.metadata('child'), undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH ?').get('南京市')?.n, 0);
  assert.equal(store.stateRevision(), 1);
  db.exec('DROP TRIGGER synthetic_fail');
  assert.equal(store.put(child, '南京市正常文本', null, policy()), 1);
});

test('corrupt provenance and metadata deny visibility instead of releasing payload', t => {
  const { store, db } = fixture(t);
  store.put(memory(), 'parent', null, policy());
  store.put(memory({ id: 'other' }), 'other', null, policy());
  store.put(memory({ id: 'child', derived: true, sourceIds: ['fact'] }), '南京市秘密', null, policy());
  db.prepare('UPDATE memory_edges SET source_id=? WHERE memory_id=?').run('other', 'child');
  assert.equal(store.getVisible('child', context(), policy()).allowed, false);
  db.prepare('UPDATE memory_records SET metadata=? WHERE id=?').run('{"id":"broken"}', 'fact');
  assert.equal(store.getVisible('fact', context(), policy()).allowed, false);
});

test('vector spaces isolate provider/model/generation/dimension and content revisions', t => {
  const { store } = fixture(t);
  store.put(memory(), 'embedding fixture', null, policy());
  store.putVector('fact', SPACE, [1, 0], 1, policy());
  assert.equal(store.searchVector(SPACE, [1, 0], context(), policy()).matches.length, 1);
  for (const changed of [{ ...SPACE, provider: 'other' }, { ...SPACE, model: 'other' }, { ...SPACE, generation: 2 }]) {
    assert.equal(store.searchVector(changed, [1, 0], context(), policy()).matches.length, 0);
  }
  assert.equal(store.searchVector({ ...SPACE, dimensions: 3 }, [1, 0, 0], context(), policy()).matches.length, 0);
  assert.equal(store.searchVector(SPACE, [1, 0], context(G1), policy()).matches.length, 0);
  store.put(memory(), 'changed content', 1, policy());
  assert.equal(store.searchVector(SPACE, [1, 0], context(), policy()).matches.length, 0);
});

for (const values of [[0, 0], [NaN, 1], [Infinity, 1], [1], []]) {
  test(`invalid vector rejected: ${String(values)}`, t => {
    const { store } = fixture(t);
    store.put(memory(), 'fixture', null, policy());
    assert.throws(() => store.putVector('fact', SPACE, values, 1, policy()));
    assert.equal(store.stateRevision(), 1);
  });
}

test('cosine normalization handles huge and subnormal values, with deterministic ties', t => {
  const { store } = fixture(t);
  for (const id of ['b', 'a']) {
    store.put(memory({ id }), id, null, policy());
    store.putVector(id, SPACE, [Number.MIN_VALUE, Number.MIN_VALUE], 1, policy());
  }
  const result = store.searchVector(SPACE, [Number.MAX_VALUE, 0], context(), policy());
  assert.deepEqual(result.matches.map(m => m.value.record.id), ['a', 'b']);
  assert.ok(Math.abs(result.matches[0]!.score - Math.SQRT1_2) < 1e-12);
});

test('disk reopen preserves data, revoked grants and tombstones; bot namespaces remain separate', t => {
  const files = disk(t);
  let first = new MemoryStore(files.open() as unknown as SqliteDatabase, BOT, { initialize: true });
  first.put(memory({ scope: { kind: 'grant', grantId: 'grant' } }), '南京市持久资料', null, policy());
  first.putGrant(grant(), null);
  first.putGrant(grant({ active: false }), 1);
  first.put(memory({ id: 'deleted' }), '不复活', null, policy());
  first.tombstone('deleted', 1);
  const revision = first.stateRevision();
  first.close();
  first = new MemoryStore(files.open() as unknown as SqliteDatabase, BOT);
  assert.equal(first.stateRevision(), revision);
  assert.equal(first.getVisible('fact', context(), policy()).allowed, true);
  assert.equal(first.getVisible('fact', context(G1), policy()).allowed, false);
  assert.equal(first.getVisible('deleted', context(), policy()).allowed, false);
  const secondBot = '90002';
  const second = new MemoryStore(files.open() as unknown as SqliteDatabase, secondBot);
  assert.equal(second.metadata('fact'), undefined);
  second.put(memory({ botId: secondBot }), '第二个账号的南京市资料', null, policy(secondBot));
  const found = second.searchText('南京市', context(DM, { botId: secondBot }), policy(secondBot));
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0]?.value.record.botId, secondBot);
  assert.throws(() => first.getVisible('fact', context(DM, { botId: secondBot }), policy(secondBot)), code('INVALID_MEMORY_CONTEXT'));
  second.close(); first.close();
});

test('closed storage and invalid search bounds fail clearly', t => {
  const { store } = fixture(t);
  assert.throws(() => store.searchText('test', context(), policy(), 0), code('INVALID_SEARCH_LIMIT'));
  assert.throws(() => store.searchText('test', context(), policy(), 1, 2001), code('INVALID_SCAN_LIMIT'));
  store.close(); store.close();
  assert.throws(() => store.stateRevision(), code('STORAGE_CLOSED'));
});
