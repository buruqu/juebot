import { MemoryStore } from './lib/storage.js';

export const CONSOLE_VERSION = '0.3.0-dev.2';
export const STATUS_INPUT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
const checkSchema = values => ({ type: 'string', enum: values });
const checks = {
  driver: checkSchema(['ok', 'unavailable', 'error']),
  schema: checkSchema(['ok', 'error', 'not-run']),
  fts5: checkSchema(['ok', 'error', 'not-run']),
  shortQuery: checkSchema(['ok', 'error', 'not-run']),
  privacy: checkSchema(['ok', 'error', 'not-run']),
  cleanup: checkSchema(['ok', 'error', 'not-needed']),
};
export const STATUS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion','packageVersion','capturedAt','mode','hostNode','platform','architecture','sqliteVersion','checks','failureCode','backendDefaultDisabled','persistentStorage','qq','models','code'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    packageVersion: { type: 'string' }, capturedAt: { type: 'string' },
    mode: { type: 'string', enum: ['diagnostics-only'] },
    hostNode: { type: 'string' }, platform: { type: 'string' }, architecture: { type: 'string' },
    sqliteVersion: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    checks: { type: 'object', additionalProperties: false, required: Object.keys(checks), properties: checks },
    failureCode: { oneOf: [
      { type: 'string', enum: ['SQLITE_MODULE_UNAVAILABLE','SQLITE_OPEN_FAILED','SCHEMA_PROBE_FAILED','ROUNDTRIP_FAILED','CLEANUP_FAILED'] },
      { type: 'null' },
    ] },
    backendDefaultDisabled: { type: 'boolean', enum: [true] },
    persistentStorage: { type: 'string', enum: ['not-opened-by-console'] },
    qq: { type: 'string', enum: ['not-connected'] },
    models: { type: 'string', enum: ['not-connected'] },
    code: { type: 'string', enum: ['not-connected'] },
  },
};

export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Called only during console Host activation. All probe data is synthetic and memory-only. */
export async function probeHostOnce(options = {}) {
  const loadSqlite = options.loadSqlite ?? (() => import('node:sqlite'));
  const createStore = options.createStore ?? ((db, id, config) => new MemoryStore(db, id, config));
  const snapshot = {
    schemaVersion: 1, packageVersion: CONSOLE_VERSION,
    capturedAt: (options.now ?? (() => new Date()))().toISOString(), mode: 'diagnostics-only',
    hostNode: options.hostNode ?? process.version,
    platform: options.platform ?? process.platform, architecture: options.architecture ?? process.arch,
    sqliteVersion: null,
    checks: { driver: 'unavailable', schema: 'not-run', fts5: 'not-run', shortQuery: 'not-run', privacy: 'not-run', cleanup: 'not-needed' },
    failureCode: null, backendDefaultDisabled: true, persistentStorage: 'not-opened-by-console',
    qq: 'not-connected', models: 'not-connected', code: 'not-connected',
  };
  let phase = 'module';
  let database;
  let store;
  try {
    const sqlite = await loadSqlite();
    if (typeof sqlite.DatabaseSync !== 'function') throw new Error('No SQLite constructor');
    phase = 'open';
    database = new sqlite.DatabaseSync(':memory:', { allowExtension: false, enableForeignKeyConstraints: true });
    database.exec('PRAGMA temp_store=MEMORY');
    const attached = database.prepare('PRAGMA database_list').all();
    if (attached.some(row => row.file !== '')) throw new Error('Memory-only probe expected');
    const version = database.prepare('SELECT sqlite_version() AS version').get()?.version;
    if (typeof version !== 'string' || version.length > 64) throw new Error('Invalid SQLite version');
    snapshot.sqliteVersion = version;
    snapshot.checks.driver = 'ok';
    phase = 'schema';
    store = createStore(database, '90001', { initialize: true });
    if (store.stateRevision() !== 0) throw new Error('New memory store expected');
    snapshot.checks.schema = 'ok';
    const privateChannel = { kind: 'private', id: '10001' };
    const group = { kind: 'group', id: '20001' };
    const policy = { botId: '90001', connectionId: 'host-diagnostic-only', channels: [privateChannel, group].map(conversation => ({
      conversation, permissions: { receive: true, save: true, learn: false, send: true },
    })) };
    const record = { id: 'diagnostic-fixture', botId: '90001', domain: 'social', workspaceId: null, personaId: null,
      kind: 'fact', subjectId: null, adminBindingId: null, origin: privateChannel,
      scope: { kind: 'private', userId: '10001' }, deleted: false, derived: false, sourceIds: [] };
    const context = { botId: '90001', conversation: privateChannel, domain: 'social', workspaceId: null,
      personaId: null, adminId: '10001', adminBindingId: 'synthetic-not-a-real-binding' };
    phase = 'fts5';
    store.put(record, '南京市宿主内存验证', null, policy);
    if (store.searchText('南京市', context, policy).matches.length !== 1) throw new Error('FTS probe failed');
    snapshot.checks.fts5 = 'ok';
    phase = 'shortQuery';
    if (store.searchText('南京', context, policy).matches.length !== 1) throw new Error('Short query probe failed');
    snapshot.checks.shortQuery = 'ok';
    phase = 'privacy';
    const deniedContext = { ...context, conversation: group };
    if (store.getVisible(record.id, deniedContext, policy).allowed
      || store.searchText('南京市', deniedContext, policy).matches.length !== 0) throw new Error('Visibility probe failed');
    snapshot.checks.privacy = 'ok';
  } catch {
    // Do not publish raw messages, stacks, file paths, account ids or environment values.
    if (phase === 'module') {
      snapshot.checks.driver = 'unavailable';
      snapshot.failureCode = 'SQLITE_MODULE_UNAVAILABLE';
    } else if (phase === 'open') {
      snapshot.checks.driver = 'error';
      snapshot.failureCode = 'SQLITE_OPEN_FAILED';
    } else if (phase === 'schema') {
      snapshot.checks.schema = 'error';
      snapshot.failureCode = 'SCHEMA_PROBE_FAILED';
    } else {
      snapshot.checks[phase] = 'error';
      snapshot.failureCode = 'ROUNDTRIP_FAILED';
    }
  } finally {
    if (database) {
      try {
        if (store) store.close();
        else database.close();
        if (database.isOpen === true) throw new Error('Probe connection remains open');
        snapshot.checks.cleanup = 'ok';
      } catch {
        snapshot.checks.cleanup = 'error';
        snapshot.failureCode = 'CLEANUP_FAILED';
        // One bounded best-effort release; the diagnostic remains failed even if fallback succeeds.
        try { if (database.isOpen !== false) database.close(); } catch { /* already reported */ }
      }
    }
  }
  return deepFreeze(snapshot);
}

/** Both external read paths use this same immutable Host-local read model. */
export function createStatusService(snapshot) {
  const captured = deepFreeze(snapshot);
  return Object.freeze({ getStatus: () => captured });
}
