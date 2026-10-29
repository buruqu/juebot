import { AgentError, clone, ensure, integer, stable, text } from './common.ts';
import type { SqliteDatabase } from '../../conversation-v1/src/contracts.ts';
export interface Snapshot<T> { revision: number; value: T }
export interface Transaction {
  read<T>(key: string): Snapshot<T> | null;
  write<T>(key: string, expectedRevision: number, value: T): Snapshot<T>;
}
export interface StateStore {
  read<T>(key: string): Snapshot<T> | null;
  atomic<T>(fn: (tx: Transaction) => T): T;
}
export const AGENT_APPLICATION_ID = 0x4a554541;
const TABLES = [
  'CREATE TABLE agent_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), namespace TEXT NOT NULL)',
  'CREATE TABLE agent_state (key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), value TEXT NOT NULL)',
];
const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
function safe<T>(work: () => T): T {
  try { return work(); } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError('STORAGE_FAILURE'); }
}
function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object', 'STORE_MISMATCH'); return value as Record<string, unknown>;
}
/** Caller owns this connection. No path opening, profile lookup, timer, network or migration. */
export class SqliteStateStore implements StateStore {
  private db: SqliteDatabase;
  private closed = false;
  private active = false;
  constructor(db: SqliteDatabase, options: { namespace: string; initialize?: boolean }) {
    text(options.namespace); ensure(options.initialize === undefined || typeof options.initialize === 'boolean'); this.db = db;
    safe(() => {
      const app = object(db.prepare('PRAGMA application_id').get()).application_id;
      const version = object(db.prepare('PRAGMA user_version').get()).user_version;
      const objects = db.prepare('SELECT name FROM sqlite_schema').all();
      if (app === 0 && version === 0 && objects.length === 0) {
        ensure(options.initialize === true, 'STORE_NOT_INITIALIZED');
        this.atomic(() => {
          ensure(object(db.prepare('PRAGMA application_id').get()).application_id === 0
            && object(db.prepare('PRAGMA user_version').get()).user_version === 0
            && db.prepare('SELECT name FROM sqlite_schema').all().length === 0, 'STORE_MISMATCH');
          for (const sql of TABLES) db.exec(sql);
          db.prepare('INSERT INTO agent_owner VALUES(1,?)').run(options.namespace);
          db.exec(`PRAGMA application_id=${AGENT_APPLICATION_ID}`); db.exec('PRAGMA user_version=1');
        });
      } else ensure(app === AGENT_APPLICATION_ID && version === 1, 'STORE_MISMATCH');
      const schema = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all().map(object);
      ensure(schema.length === 2 && schema.every((item, i) => item.type === 'table' && typeof item.sql === 'string'
        && normalize(item.sql) === normalize(TABLES[i]!)), 'STORE_MISMATCH');
      const owners = db.prepare('SELECT * FROM agent_owner').all().map(object);
      ensure(owners.length === 1 && owners[0]!.singleton === 1 && owners[0]!.namespace === options.namespace, 'STORE_MISMATCH');
    });
  }
  private open(): void { ensure(!this.closed, 'STORE_CLOSED'); }
  read<T>(key: string): Snapshot<T> | null {
    this.open(); text(key, 8192);
    return safe(() => {
      const result = this.db.prepare('SELECT revision,value FROM agent_state WHERE key=?').get(key);
      if (result === undefined) return null;
      const row = object(result); integer(row.revision, 1); ensure(typeof row.value === 'string', 'STORE_MISMATCH');
      const value: unknown = JSON.parse(row.value); ensure(stable(value).length <= 8 * 1024 * 1024, 'STORE_MISMATCH');
      return { revision: row.revision, value: value as T };
    });
  }
  atomic<T>(work: (tx: Transaction) => T): T {
    this.open(); ensure(!this.active, 'NESTED_TRANSACTION');
    return safe(() => {
      this.db.exec('BEGIN IMMEDIATE'); this.active = true; let alive = true;
      const tx: Transaction = {
        read: <V>(key: string) => { ensure(alive, 'TRANSACTION_CLOSED'); return this.read<V>(key); },
        write: <V>(key: string, expectedRevision: number, value: V): Snapshot<V> => {
          ensure(alive, 'TRANSACTION_CLOSED'); text(key, 8192); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1);
          const serialized = stable(value); ensure(serialized.length <= 8 * 1024 * 1024, 'CAPACITY');
          const previous = this.read<V>(key); ensure((previous?.revision ?? 0) === expectedRevision, 'CONFLICT');
          if (!previous) {
            const count = object(this.db.prepare('SELECT count(*) AS n FROM agent_state').get()).n;
            ensure(typeof count === 'number' && count < 50000, 'CAPACITY');
          }
          this.db.prepare('INSERT INTO agent_state(key,revision,value) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value')
            .run(key, expectedRevision + 1, serialized);
          return { revision: expectedRevision + 1, value: JSON.parse(serialized) as V };
        },
      };
      try {
        const result = work(tx);
        ensure(!result || typeof (result as { then?: unknown }).then !== 'function', 'ASYNC_TRANSACTION');
        const copy = clone(result); this.db.exec('COMMIT'); return copy;
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* original outcome may be uncertain */ } throw error; }
      finally { alive = false; this.active = false; }
    });
  }
  close(): void { ensure(!this.active, 'TRANSACTION_ACTIVE'); this.closed = true; }
}
