import {
  CoreError, isConversation, isId, isQQId, isRecord, permissionsFor,
  requireCondition, snapshotPolicy,
} from './contracts.ts';
import type { CorePolicy, Gate } from './contracts.ts';
import { memoryGate } from './memory.ts';
import type { MemoryContext, MemoryLookup, MemoryRecord, MemoryScope, SharingGrant } from './memory.ts';

/** Minimal synchronous SQLite port; the native driver stays outside the portable core. */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: SqlValue[]): SqlRow | undefined;
    all(...values: SqlValue[]): SqlRow[];
    run(...values: SqlValue[]): { changes: number | bigint };
  };
  close(): void;
}
export const STORAGE_APPLICATION_ID = 0x4a554542;
export const STORAGE_SCHEMA_VERSION = 1;
export type MemoryView = Readonly<{ record: MemoryRecord; body: string; revision: number }>;
export type VisibleMemory = Readonly<{ allowed: true; value: MemoryView }> | Readonly<{ allowed: false; reason: string }>;
export type VectorSpace = Readonly<{ provider: string; model: string; generation: number; dimensions: number }>;
export type SearchMatch = Readonly<{ value: MemoryView; score: number }>;
export type SearchResult = Readonly<{ method: 'fts5-trigram' | 'substring' | 'exact-cosine'; bounded: true; matches: readonly SearchMatch[] }>;

const schema = `
CREATE TABLE memory_records (
  bot_id TEXT NOT NULL, id TEXT NOT NULL, domain TEXT NOT NULL CHECK(domain IN ('social','code')),
  workspace_id TEXT, persona_id TEXT, metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  body TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), PRIMARY KEY(bot_id,id)
);
CREATE TABLE memory_edges (
  bot_id TEXT NOT NULL, memory_id TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
  PRIMARY KEY(bot_id,memory_id,source_id),
  FOREIGN KEY(bot_id,memory_id) REFERENCES memory_records(bot_id,id) ON DELETE CASCADE,
  FOREIGN KEY(bot_id,source_id) REFERENCES memory_records(bot_id,id)
);
CREATE TABLE sharing_grants (
  bot_id TEXT NOT NULL, id TEXT NOT NULL, memory_id TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK(json_valid(metadata)), revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(bot_id,id), FOREIGN KEY(bot_id,memory_id) REFERENCES memory_records(bot_id,id)
);
CREATE TABLE memory_vectors (
  bot_id TEXT NOT NULL, memory_id TEXT NOT NULL, memory_revision INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, generation INTEGER NOT NULL, dimensions INTEGER NOT NULL,
  vector TEXT NOT NULL CHECK(json_valid(vector)),
  PRIMARY KEY(bot_id,memory_id,provider,model,generation,dimensions),
  FOREIGN KEY(bot_id,memory_id) REFERENCES memory_records(bot_id,id) ON DELETE CASCADE
);
CREATE TABLE store_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
INSERT INTO store_state VALUES (1,0);
CREATE INDEX memory_domain ON memory_records(bot_id,domain,workspace_id,persona_id,deleted);
CREATE VIRTUAL TABLE memory_fts USING fts5(body, content='memory_records', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER memory_insert AFTER INSERT ON memory_records BEGIN
  INSERT INTO memory_fts(rowid,body) VALUES(new.rowid,new.body);
END;
CREATE TRIGGER memory_delete AFTER DELETE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts,rowid,body) VALUES('delete',old.rowid,old.body);
END;
CREATE TRIGGER memory_update AFTER UPDATE OF body ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts,rowid,body) VALUES('delete',old.rowid,old.body);
  INSERT INTO memory_fts(rowid,body) VALUES(new.rowid,new.body);
END;
PRAGMA application_id = ${STORAGE_APPLICATION_ID};
PRAGMA user_version = ${STORAGE_SCHEMA_VERSION};
`;

// Exact requirements derived from our fixed v1 migration, not a general-purpose SQL parser.
const canonicalSql = (sql: string): string => sql.trim().replace(/;+$/u, '').replace(/\s+/gu, ' ');
const requiredSchema = [...schema.matchAll(/CREATE (?:VIRTUAL TABLE|TABLE|INDEX) [\s\S]*?;|CREATE TRIGGER [\s\S]*?END;/gu)].map(match => {
  const header = /^CREATE (VIRTUAL TABLE|TABLE|INDEX|TRIGGER) (\w+)/u.exec(match[0])!;
  return { name: header[2]!, type: header[1]!.includes('TABLE') ? 'table' : header[1]!.toLowerCase(), sql: canonicalSql(match[0]) };
});

function integer(value: unknown, code = 'INVALID_STORAGE_INTEGER'): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, code);
  return value;
}
function parseJson(value: unknown): unknown {
  requireCondition(typeof value === 'string', 'INVALID_STORED_JSON');
  try { return JSON.parse(value); } catch { throw new CoreError('INVALID_STORED_JSON'); }
}
function scopeSnapshot(value: unknown): MemoryScope {
  requireCondition(isRecord(value), 'INVALID_MEMORY_SCOPE');
  if (value.kind === 'private') {
    requireCondition(isQQId(value.userId), 'INVALID_MEMORY_SCOPE');
    return { kind: 'private', userId: value.userId };
  }
  if (value.kind === 'conversation') {
    requireCondition(isConversation(value.conversation), 'INVALID_MEMORY_SCOPE');
    return { kind: 'conversation', conversation: { kind: value.conversation.kind, id: value.conversation.id } };
  }
  if (value.kind === 'admin-global') return { kind: 'admin-global' };
  requireCondition(value.kind === 'grant' && isId(value.grantId), 'INVALID_MEMORY_SCOPE');
  return { kind: 'grant', grantId: value.grantId };
}
function recordSnapshot(value: unknown): MemoryRecord {
  requireCondition(isRecord(value) && isId(value.id) && isQQId(value.botId)
    && (value.domain === 'social' || value.domain === 'code') && isConversation(value.origin), 'INVALID_MEMORY');
  requireCondition(value.domain === 'social' ? value.workspaceId === null : isId(value.workspaceId), 'INVALID_MEMORY_WORKSPACE');
  requireCondition(value.personaId === null || isId(value.personaId), 'INVALID_MEMORY_PERSONA');
  requireCondition(value.subjectId === null || isQQId(value.subjectId), 'INVALID_MEMORY_SUBJECT');
  requireCondition(value.adminBindingId === null || isId(value.adminBindingId), 'INVALID_MEMORY_BINDING');
  requireCondition(typeof value.kind === 'string' && ['admin-identity', 'admin-relationship', 'preference', 'fact', 'summary', 'expression', 'engineering'].includes(value.kind), 'INVALID_MEMORY_KIND');
  requireCondition(value.kind !== 'engineering' || value.domain === 'code', 'ENGINEERING_REQUIRES_CODE_DOMAIN');
  requireCondition(typeof value.deleted === 'boolean' && typeof value.derived === 'boolean'
    && Array.isArray(value.sourceIds) && value.sourceIds.length <= 64 && value.sourceIds.every(isId)
    && value.derived === (value.sourceIds.length > 0) && !value.sourceIds.includes(value.id)
    && new Set(value.sourceIds).size === value.sourceIds.length, 'INVALID_MEMORY_SOURCES');
  const scope = scopeSnapshot(value.scope);
  if (scope.kind === 'admin-global') requireCondition(['admin-identity', 'admin-relationship'].includes(value.kind)
    && isQQId(value.subjectId) && isId(value.adminBindingId), 'INVALID_ADMIN_GLOBAL_MEMORY');
  return {
    id: value.id, botId: value.botId, domain: value.domain, workspaceId: value.workspaceId as string | null,
    personaId: value.personaId as string | null, kind: value.kind as MemoryRecord['kind'],
    subjectId: value.subjectId as string | null, adminBindingId: value.adminBindingId as string | null,
    origin: { kind: value.origin.kind, id: value.origin.id }, scope, deleted: value.deleted, derived: value.derived, sourceIds: [...value.sourceIds],
  };
}
function grantSnapshot(value: unknown): SharingGrant {
  requireCondition(isRecord(value) && isId(value.id) && isId(value.memoryId) && isQQId(value.botId)
    && isQQId(value.approvedBy) && isId(value.adminBindingId) && typeof value.active === 'boolean', 'INVALID_SHARING_GRANT');
  requireCondition(value.targets === 'authorized' || (Array.isArray(value.targets)
    && value.targets.length > 0 && value.targets.length <= 10000 && value.targets.every(isConversation)), 'INVALID_SHARING_TARGETS');
  return { id: value.id, memoryId: value.memoryId, botId: value.botId, approvedBy: value.approvedBy,
    adminBindingId: value.adminBindingId, active: value.active,
    targets: value.targets === 'authorized' ? 'authorized' : value.targets.map(target => ({ kind: target.kind, id: target.id })) };
}
function spaceSnapshot(value: VectorSpace): VectorSpace {
  requireCondition(isRecord(value) && isId(value.provider) && isId(value.model)
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && Number.isSafeInteger(value.dimensions) && value.dimensions > 0 && value.dimensions <= 4096, 'INVALID_VECTOR_SPACE');
  return { provider: value.provider, model: value.model, generation: value.generation, dimensions: value.dimensions };
}
function unitVector(values: readonly number[], dimensions: number): number[] {
  requireCondition(Array.isArray(values) && values.length === dimensions && values.every(Number.isFinite), 'INVALID_VECTOR');
  const scale = Math.max(...values.map(Math.abs));
  requireCondition(Number.isFinite(scale) && scale > 0, 'INVALID_VECTOR_NORM');
  const scaled = values.map(value => value / scale);
  const norm = Math.hypot(...scaled);
  return scaled.map(value => value / norm);
}

/**
 * Trusted Host storage API, NOT a QQ/RPC/model tool. Owns its connection after construction.
 * Records/provenance/grants must be authored by trusted application code. No timers, networking,
 * automatic task execution, history import, or restart/queue policy is provided here.
 */
export class MemoryStore {
  #db: SqliteDatabase;
  #botId: string;
  #closed = false;
  #inTransaction = false;

  constructor(db: SqliteDatabase, botId: string, options: { initialize?: boolean } = {}) {
    requireCondition(isQQId(botId), 'INVALID_BOT_ID');
    this.#db = db;
    this.#botId = botId;
    const applicationId = integer(db.prepare('PRAGMA application_id').get()?.application_id);
    const version = integer(db.prepare('PRAGMA user_version').get()?.user_version);
    if (applicationId === 0 && version === 0) {
      requireCondition(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() === undefined, 'FOREIGN_DATABASE');
      requireCondition(options.initialize === true, 'INITIALIZATION_REQUIRED');
      db.exec('PRAGMA foreign_keys=ON');
      this.#transaction(true, () => { db.exec(schema); });
    } else {
      requireCondition(applicationId === STORAGE_APPLICATION_ID, 'FOREIGN_DATABASE');
      requireCondition(version === STORAGE_SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA_VERSION');
      db.exec('PRAGMA foreign_keys=ON');
    }
    requireCondition(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1, 'FOREIGN_KEYS_UNAVAILABLE');
    // A matching version number alone is insufficient: triggers, keys and index definitions matter.
    requireCondition(requiredSchema.length === 10, 'INVALID_MIGRATION_DEFINITION');
    for (const expected of requiredSchema) {
      const actual = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(expected.name);
      requireCondition(actual?.type === expected.type && typeof actual.sql === 'string'
        && canonicalSql(actual.sql) === expected.sql, 'UNSUPPORTED_SCHEMA_LAYOUT');
    }
    this.stateRevision();
  }

  #assertOpen(): void { requireCondition(!this.#closed, 'STORAGE_CLOSED'); }
  #transaction<T>(write: boolean, operation: () => T): T {
    this.#assertOpen();
    requireCondition(!this.#inTransaction, 'NESTED_STORAGE_TRANSACTION');
    this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    this.#inTransaction = true;
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { throw new CoreError('STORAGE_ROLLBACK_FAILED'); }
      throw error;
    } finally { this.#inTransaction = false; }
  }
  #row(id: string): SqlRow | undefined {
    requireCondition(isId(id), 'INVALID_MEMORY_ID');
    return this.#db.prepare('SELECT bot_id,id,domain,workspace_id,persona_id,metadata,revision,deleted FROM memory_records WHERE bot_id=? AND id=?').get(this.#botId, id);
  }
  #metadata(row: SqlRow): { record: MemoryRecord; revision: number } {
    const record = recordSnapshot(parseJson(row.metadata));
    requireCondition(record.botId === this.#botId && record.id === row.id && record.domain === row.domain
      && record.workspaceId === row.workspace_id && record.personaId === row.persona_id
      && Number(record.deleted) === row.deleted, 'CORRUPT_MEMORY_METADATA');
    return { record, revision: integer(row.revision) };
  }
  #bump(): void { this.#db.exec('UPDATE store_state SET revision=revision+1 WHERE singleton=1'); }
  #expected(row: SqlRow | undefined, expected: number | null): void {
    requireCondition(expected === null || (Number.isSafeInteger(expected) && expected > 0), 'INVALID_EXPECTED_REVISION');
    requireCondition(row ? expected === row.revision : expected === null, 'REVISION_CONFLICT');
  }
  #writePolicy(record: MemoryRecord, policy: CorePolicy): void {
    requireCondition(policy.botId === this.#botId && record.botId === this.#botId, 'BOT_SCOPE_MISMATCH');
    const p = permissionsFor(policy, record.origin);
    requireCondition(p?.receive === true && p.save === true, 'SAVE_NOT_AUTHORIZED');
  }

  stateRevision(): number {
    this.#assertOpen();
    return integer(this.#db.prepare('SELECT revision FROM store_state WHERE singleton=1').get()?.revision);
  }
  metadata(id: string): { record: MemoryRecord; revision: number } | undefined {
    this.#assertOpen();
    const row = this.#row(id);
    return row ? this.#metadata(row) : undefined;
  }

  /** null expectedRevision creates only; updates require the observed positive revision. */
  put(recordInput: MemoryRecord, body: string, expectedRevision: number | null, policyInput: CorePolicy): number {
    const record = recordSnapshot(recordInput);
    const policy = snapshotPolicy(policyInput);
    this.#writePolicy(record, policy);
    requireCondition(!record.deleted, 'USE_TOMBSTONE_OPERATION');
    requireCondition(typeof body === 'string' && body.length <= 32768, 'INVALID_MEMORY_BODY');
    return this.#transaction(true, () => {
      const existing = this.#row(record.id);
      this.#expected(existing, expectedRevision);
      if (existing) {
        const old = this.#metadata(existing).record;
        requireCondition(!old.deleted, 'TOMBSTONED_MEMORY');
        requireCondition(old.domain === record.domain && old.workspaceId === record.workspaceId
          && old.kind === record.kind && old.origin.kind === record.origin.kind && old.origin.id === record.origin.id,
        'MEMORY_IDENTITY_IMMUTABLE');
      }
      const edges = record.sourceIds.map(id => {
        const row = this.#row(id);
        requireCondition(row, 'MEMORY_SOURCE_MISSING');
        const source = this.#metadata(row);
        requireCondition(!source.record.deleted && source.record.domain === record.domain
          && source.record.workspaceId === record.workspaceId, 'MEMORY_SOURCE_DOMAIN_MISMATCH');
        return { id, revision: source.revision };
      });
      const revision = existing ? integer(existing.revision) + 1 : 1;
      this.#db.prepare(`INSERT INTO memory_records(bot_id,id,domain,workspace_id,persona_id,metadata,body,revision,deleted)
        VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(bot_id,id) DO UPDATE SET
        persona_id=excluded.persona_id,metadata=excluded.metadata,body=excluded.body,revision=excluded.revision`)
        .run(this.#botId, record.id, record.domain, record.workspaceId, record.personaId, JSON.stringify(record), body, revision);
      this.#db.prepare('DELETE FROM memory_edges WHERE bot_id=? AND memory_id=?').run(this.#botId, record.id);
      for (const edge of edges) this.#db.prepare('INSERT INTO memory_edges VALUES(?,?,?,?)').run(this.#botId, record.id, edge.id, edge.revision);
      // Content updates invalidate old embeddings, even if model and dimension stayed the same.
      this.#db.prepare('DELETE FROM memory_vectors WHERE bot_id=? AND memory_id=?').run(this.#botId, record.id);
      this.#bump();
      return revision;
    });
  }

  putGrant(input: SharingGrant, expectedRevision: number | null): number {
    const grant = grantSnapshot(input);
    requireCondition(grant.botId === this.#botId, 'BOT_SCOPE_MISMATCH');
    return this.#transaction(true, () => {
      const memory = this.#row(grant.memoryId);
      requireCondition(memory && memory.deleted === 0, 'MEMORY_MISSING_OR_DELETED');
      const old = this.#db.prepare('SELECT * FROM sharing_grants WHERE bot_id=? AND id=?').get(this.#botId, grant.id);
      this.#expected(old, expectedRevision);
      requireCondition(!old || old.memory_id === grant.memoryId, 'GRANT_TARGET_IMMUTABLE');
      const revision = old ? integer(old.revision) + 1 : 1;
      this.#db.prepare(`INSERT INTO sharing_grants VALUES(?,?,?,?,?) ON CONFLICT(bot_id,id)
        DO UPDATE SET metadata=excluded.metadata,revision=excluded.revision`)
        .run(this.#botId, grant.id, grant.memoryId, JSON.stringify(grant), revision);
      this.#bump();
      return revision;
    });
  }

  tombstone(id: string, expectedRevision: number): number {
    return this.#transaction(true, () => {
      const row = this.#row(id);
      requireCondition(row, 'MEMORY_MISSING');
      this.#expected(row, expectedRevision);
      const old = this.#metadata(row);
      requireCondition(!old.record.deleted, 'TOMBSTONED_MEMORY');
      const revision = old.revision + 1;
      this.#db.prepare('UPDATE memory_records SET metadata=?,body=?,revision=?,deleted=1 WHERE bot_id=? AND id=?')
        .run(JSON.stringify({ ...old.record, deleted: true }), '', revision, this.#botId, id);
      this.#db.prepare('DELETE FROM memory_vectors WHERE bot_id=? AND memory_id=?').run(this.#botId, id);
      this.#db.prepare("UPDATE sharing_grants SET metadata=json_set(metadata,'$.active',json('false')),revision=revision+1 WHERE bot_id=? AND memory_id=?")
        .run(this.#botId, id);
      this.#bump();
      return revision;
    });
  }

  #lookup(): MemoryLookup {
    const records = new Map<string, MemoryRecord | undefined>();
    const grants = new Map<string, SharingGrant | undefined>();
    return {
      record: id => {
        if (records.has(id)) return records.get(id);
        const row = this.#row(id);
        if (!row) { records.set(id, undefined); return undefined; }
        const data = this.#metadata(row);
        const edges = this.#db.prepare(`SELECT e.source_id,e.source_revision,r.revision AS current_revision,r.deleted
          FROM memory_edges e LEFT JOIN memory_records r ON r.bot_id=e.bot_id AND r.id=e.source_id
          WHERE e.bot_id=? AND e.memory_id=?`).all(this.#botId, id);
        const stale = edges.length !== data.record.sourceIds.length
          || edges.some(edge => !data.record.sourceIds.includes(String(edge.source_id))
            || edge.deleted !== 0 || edge.source_revision !== edge.current_revision);
        const value = stale ? undefined : data.record;
        records.set(id, value);
        return value;
      },
      grant: id => {
        if (grants.has(id)) return grants.get(id);
        const row = this.#db.prepare('SELECT * FROM sharing_grants WHERE bot_id=? AND id=?').get(this.#botId, id);
        const grant = row ? grantSnapshot(parseJson(row.metadata)) : undefined;
        requireCondition(!grant || (grant.botId === this.#botId && grant.id === id && grant.memoryId === row?.memory_id), 'CORRUPT_GRANT_METADATA');
        grants.set(id, grant);
        return grant;
      },
    };
  }
  #view(id: string): MemoryView {
    const row = this.#row(id);
    const payload = this.#db.prepare('SELECT body FROM memory_records WHERE bot_id=? AND id=?').get(this.#botId, id);
    requireCondition(row && payload && typeof payload.body === 'string', 'MEMORY_MISSING');
    return { ...this.#metadata(row), body: payload.body };
  }
  #context(context: MemoryContext, policyInput: CorePolicy): { context: MemoryContext; policy: CorePolicy } {
    const policy = snapshotPolicy(policyInput);
    requireCondition(isRecord(context) && context.botId === this.#botId && policy.botId === this.#botId
      && isConversation(context.conversation) && isQQId(context.adminId) && isId(context.adminBindingId)
      && (context.domain === 'social' || context.domain === 'code')
      && (context.domain === 'social' ? context.workspaceId === null : isId(context.workspaceId))
      && (context.personaId === null || isId(context.personaId)), 'INVALID_MEMORY_CONTEXT');
    return { context: { ...context, conversation: { ...context.conversation } }, policy };
  }

  getVisible(id: string, contextInput: MemoryContext, policyInput: CorePolicy): VisibleMemory {
    const { context, policy } = this.#context(contextInput, policyInput);
    return this.#transaction(false, () => {
      const gate = memoryGate(id, context, policy, this.#lookup());
      return gate.allowed ? { allowed: true, value: this.#view(id) } : gate;
    });
  }
  #visibleIds(context: MemoryContext, policy: CorePolicy, scanLimit: number): string[] {
    requireCondition(Number.isSafeInteger(scanLimit) && scanLimit > 0 && scanLimit <= 2000, 'INVALID_SCAN_LIMIT');
    const rows = this.#db.prepare(`SELECT id FROM memory_records WHERE bot_id=? AND domain=? AND workspace_id IS ?
      AND (persona_id IS NULL OR persona_id=?) AND deleted=0 ORDER BY id LIMIT ?`)
      .all(this.#botId, context.domain, context.workspaceId, context.personaId, scanLimit);
    const lookup = this.#lookup();
    // Authorize metadata/provenance first. No memory body or embedding leaves SQL before this gate.
    return rows.map(row => String(row.id)).filter(id => memoryGate(id, context, policy, lookup).allowed);
  }
  #limit(value: number): void { requireCondition(Number.isSafeInteger(value) && value > 0 && value <= 100, 'INVALID_SEARCH_LIMIT'); }

  searchText(query: string, contextInput: MemoryContext, policyInput: CorePolicy, limit = 20, scanLimit = 500): SearchResult {
    requireCondition(typeof query === 'string' && query.length <= 256, 'INVALID_SEARCH_QUERY');
    this.#limit(limit);
    const { context, policy } = this.#context(contextInput, policyInput);
    const text = query.trim();
    const method = Array.from(text).length >= 3 ? 'fts5-trigram' : 'substring';
    return this.#transaction(false, () => {
      if (!text) return { method, bounded: true, matches: [] };
      const ids = this.#visibleIds(context, policy, scanLimit);
      if (!ids.length) return { method, bounded: true, matches: [] };
      const allowed = JSON.stringify(ids);
      const rows = method === 'fts5-trigram'
        ? this.#db.prepare(`SELECT r.id,0 AS score FROM memory_fts JOIN memory_records r ON r.rowid=memory_fts.rowid
            WHERE memory_fts MATCH ? AND r.bot_id=? AND r.id IN (SELECT value FROM json_each(?))
            ORDER BY score,r.id LIMIT ?`).all('"' + text.replaceAll('"', '""') + '"', this.#botId, allowed, limit)
        : this.#db.prepare(`SELECT id,0 AS score FROM memory_records WHERE bot_id=? AND id IN (SELECT value FROM json_each(?))
            AND instr(body,?)>0 ORDER BY id LIMIT ?`).all(this.#botId, allowed, text, limit);
      return { method, bounded: true, matches: rows.map(row => ({ value: this.#view(String(row.id)), score: Number(row.score) })) };
    });
  }

  putVector(id: string, spaceInput: VectorSpace, values: readonly number[], expectedRevision: number, policyInput: CorePolicy): void {
    const space = spaceSnapshot(spaceInput);
    const normalized = unitVector(values, space.dimensions);
    const policy = snapshotPolicy(policyInput);
    this.#transaction(true, () => {
      const row = this.#row(id);
      requireCondition(row && row.deleted === 0, 'MEMORY_MISSING_OR_DELETED');
      this.#expected(row, expectedRevision);
      this.#writePolicy(this.#metadata(row).record, policy);
      this.#db.prepare(`INSERT INTO memory_vectors VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(bot_id,memory_id,provider,model,generation,dimensions)
        DO UPDATE SET memory_revision=excluded.memory_revision,vector=excluded.vector`)
        .run(this.#botId, id, expectedRevision, space.provider, space.model, space.generation, space.dimensions, JSON.stringify(normalized));
      this.#bump();
    });
  }

  searchVector(spaceInput: VectorSpace, values: readonly number[], contextInput: MemoryContext, policyInput: CorePolicy, limit = 20, scanLimit = 500): SearchResult {
    const space = spaceSnapshot(spaceInput);
    const query = unitVector(values, space.dimensions);
    this.#limit(limit);
    const { context, policy } = this.#context(contextInput, policyInput);
    return this.#transaction(false, () => {
      const ids = this.#visibleIds(context, policy, scanLimit);
      if (!ids.length) return { method: 'exact-cosine', bounded: true, matches: [] };
      const rows = this.#db.prepare(`SELECT v.memory_id,v.vector FROM memory_vectors v
        JOIN memory_records r ON r.bot_id=v.bot_id AND r.id=v.memory_id AND r.revision=v.memory_revision
        WHERE v.bot_id=? AND v.provider=? AND v.model=? AND v.generation=? AND v.dimensions=?
        AND v.memory_id IN (SELECT value FROM json_each(?))`).all(this.#botId, space.provider, space.model, space.generation, space.dimensions, JSON.stringify(ids));
      const ranked = rows.map(row => {
        const raw = parseJson(row.vector);
        requireCondition(Array.isArray(raw), 'INVALID_STORED_VECTOR');
        const vector = unitVector(raw, space.dimensions);
        const score = Math.max(-1, Math.min(1, vector.reduce((sum, value, index) => sum + value * query[index]!, 0)));
        return { id: String(row.memory_id), score };
      }).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
      return { method: 'exact-cosine', bounded: true, matches: ranked.map(row => ({ value: this.#view(row.id), score: row.score })) };
    });
  }

  close(): void {
    if (this.#closed) return;
    requireCondition(!this.#inTransaction, 'STORAGE_TRANSACTION_ACTIVE');
    this.#db.close();
    this.#closed = true;
  }
}
