import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../bundle/lib/storage.js';
import { apply, inject } from '../bundle/console-host.js';
import { CONSOLE_VERSION, STATUS_SCHEMA, deepFreeze, probeHostOnce, createStatusService } from '../bundle/diagnostics.js';

function context({ routeFailure = false } = {}) {
  const providers = new Map();
  const routes = new Map();
  const effects = [];
  const ctx = {
    effect(setup) {
      const dispose = setup();
      let done = false;
      const cleanup = () => { if (!done) { done = true; return dispose(); } };
      effects.push(cleanup);
      return cleanup;
    },
    cordisInspect: { register(provider) {
      assert.ok(!providers.has(provider.manifest.id));
      providers.set(provider.manifest.id, provider);
      return () => providers.delete(provider.manifest.id);
    } },
    connection: { fetch: { register(route) {
      if (routeFailure) throw new Error('synthetic duplicate route');
      return ctx.effect(() => {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      });
    } } },
  };
  return { ctx, providers, routes, dispose: async () => { for (const dispose of effects.reverse()) await dispose(); } };
}

function assertShape(value) {
  assert.deepEqual(Object.keys(value).sort(), [...STATUS_SCHEMA.required].sort());
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.packageVersion, CONSOLE_VERSION);
  assert.equal(value.mode, 'diagnostics-only');
  assert.equal(new Date(value.capturedAt).toISOString(), value.capturedAt);
  assert.deepEqual(Object.keys(value.checks).sort(), [...STATUS_SCHEMA.properties.checks.required].sort());
  for (const [key, rule] of Object.entries(STATUS_SCHEMA.properties.checks.properties)) assert.ok(rule.enum.includes(value.checks[key]));
  assert.ok(value.failureCode === null || STATUS_SCHEMA.properties.failureCode.oneOf[0].enum.includes(value.failureCode));
  assert.equal(value.backendDefaultDisabled, true);
  assert.equal(value.persistentStorage, 'not-opened-by-console');
  for (const name of ['qq', 'models', 'code']) assert.equal(value[name], 'not-connected');
}

test('status schema obeys the verified Inspect nullable dialect restrictions', () => {
  function visit(schema) {
    assert.equal(Array.isArray(schema.type), false, 'real Inspect rejects type arrays');
    if (schema.oneOf) {
      assert.equal(schema.type, undefined, 'oneOf cannot have a sibling type');
      assert.equal(schema.enum, undefined, 'oneOf cannot have a sibling enum');
      for (const branch of schema.oneOf) visit(branch);
    }
    if (schema.properties) for (const value of Object.values(schema.properties)) visit(value);
  }
  visit(STATUS_SCHEMA);
  assert.deepEqual(STATUS_SCHEMA.properties.sqliteVersion.oneOf, [{ type: 'string' }, { type: 'null' }]);
});

test('console version, enabled root and disabled storage exports are internally consistent', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../bundle/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, CONSOLE_VERSION);
  assert.equal(manifest.exports['.'], './console-host.js');
  assert.equal(manifest.exports['./storage-host'], './host.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.deepEqual(inject, ['cordisInspect', 'connection']);
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  const patch = fs.readFileSync(new URL('../bundle/cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: juebot-console\s+name: '@local\/dsh-juebot'\s+config: \{\}/u);
  assert.match(patch, /id: juebot-host\s+name: '@local\/dsh-juebot\/storage-host'\s+disabled: true\s+config:\s+storagePath: null/u);
});

test('actual local probe is memory-only, closes once, and returns bounded immutable facts', async () => {
  let opened = 0;
  let closed = 0;
  let observed;
  class ObservedDatabase extends DatabaseSync {
    constructor(target, options) {
      assert.equal(target, ':memory:');
      assert.equal(options.allowExtension, false);
      super(target, options);
      opened += 1;
      observed = this;
    }
    close() { closed += 1; return super.close(); }
  }
  const result = await probeHostOnce({ loadSqlite: async () => ({ DatabaseSync: ObservedDatabase }) });
  assertShape(result);
  assert.equal(result.hostNode, process.version);
  assert.equal(result.sqliteVersion, process.versions.sqlite);
  assert.equal(result.failureCode, null);
  assert.ok(Object.values(result.checks).every(value => value === 'ok'));
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(observed.isOpen, false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.checks));
  assert.ok(JSON.stringify(result).length < 1600);
  assert.ok(!JSON.stringify(result).includes('diagnostic-fixture'));
});

test('unavailable SQLite does not prevent sanitized diagnostics from being created', async () => {
  const result = await probeHostOnce({ loadSqlite: async () => { throw new Error('SECRET /private/path token=DO_NOT_RETURN'); } });
  assertShape(result);
  assert.equal(result.checks.driver, 'unavailable');
  assert.equal(result.failureCode, 'SQLITE_MODULE_UNAVAILABLE');
  assert.equal(result.checks.cleanup, 'not-needed');
  assert.equal(result.sqliteVersion, null);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(!JSON.stringify(result).includes('/private/path'));
});

test('SQLite opening and schema failures produce explicit non-success states', async () => {
  const openFailure = await probeHostOnce({ loadSqlite: async () => ({ DatabaseSync: class { constructor() { throw new Error('secret'); } } }) });
  assert.equal(openFailure.failureCode, 'SQLITE_OPEN_FAILED');
  assert.equal(openFailure.checks.driver, 'error');
  assertShape(openFailure);
  let db;
  const schemaFailure = await probeHostOnce({
    loadSqlite: async () => ({ DatabaseSync: class extends DatabaseSync { constructor(...args) { super(...args); db = this; } } }),
    createStore: () => { throw new Error('schema detail must not be returned'); },
  });
  assert.equal(schemaFailure.failureCode, 'SCHEMA_PROBE_FAILED');
  assert.equal(schemaFailure.checks.schema, 'error');
  assert.equal(schemaFailure.checks.cleanup, 'ok');
  assert.equal(db.isOpen, false);
  assertShape(schemaFailure);
});

test('roundtrip and cleanup faults do not become healthy status', async () => {
  const badRoundtrip = await probeHostOnce({ createStore: (db, id, config) => {
    const store = new MemoryStore(db, id, config);
    store.searchText = () => ({ matches: [] });
    return store;
  } });
  assert.equal(badRoundtrip.failureCode, 'ROUNDTRIP_FAILED');
  assert.equal(badRoundtrip.checks.fts5, 'error');
  assert.equal(badRoundtrip.checks.cleanup, 'ok');
  let db;
  const badCleanup = await probeHostOnce({ createStore: (database, id, config) => {
    db = database;
    const store = new MemoryStore(database, id, config);
    store.close = () => { throw new Error('synthetic cleanup failure'); };
    return store;
  } });
  assert.equal(badCleanup.failureCode, 'CLEANUP_FAILED');
  assert.equal(badCleanup.checks.cleanup, 'error');
  assert.equal(db.isOpen, false); // bounded raw-connection fallback actually released the memory DB
});

test('status service also freezes descendants of an already-frozen root', () => {
  const source = Object.freeze({ nested: { value: 1 } });
  deepFreeze(source);
  assert.ok(Object.isFrozen(source.nested));
  const service = createStatusService(source);
  assert.equal(service.getStatus(), source);
});

test('Inspect and GET share one captured snapshot and never perform another probe', async () => {
  const state = context();
  try {
    await apply(state.ctx, {});
    const provider = state.providers.get('JuebotStatus');
    const route = state.routes.get('/api/juebot/status');
    assert.ok(provider && route);
    assert.deepEqual(route.methods, ['GET']);
    assert.equal(route.requestBody, 'buffered');
    const signal = new AbortController().signal;
    const queryContext = { signal, get agent() { throw new Error('Agent must not be read'); } };
    const snapshot = provider.query('getStatus', {}, queryContext);
    assertShape(snapshot);
    assert.equal(provider.query('getStatus', null, queryContext), snapshot);
    assert.equal(provider.query('getStatus', undefined, queryContext), snapshot);
    const response = await route.fetch(new Request('http://localhost/api/juebot/status'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), snapshot);
    const responseAgain = await route.fetch(new Request('http://localhost/api/juebot/status'));
    assert.deepEqual(await responseAgain.json(), snapshot);
  } finally { await state.dispose(); }
  assert.equal(state.providers.size, 0);
  assert.equal(state.routes.size, 0);
});

test('status surface rejects unsupported inputs, methods and cancellation', async () => {
  const state = context();
  try {
    await apply(state.ctx);
    const provider = state.providers.get('JuebotStatus');
    const route = state.routes.get('/api/juebot/status');
    const queryContext = { signal: new AbortController().signal };
    for (const input of [{ enable: true }, [], 'run']) assert.throws(() => provider.query('getStatus', input, queryContext), /INPUT_NOT_SUPPORTED/u);
    assert.throws(() => provider.query('enable', {}, queryContext), /METHOD_NOT_SUPPORTED/u);
    const controller = new AbortController(); controller.abort();
    assert.throws(() => provider.query('getStatus', {}, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal((await route.fetch(new Request('http://localhost/api/juebot/status?refresh=1'))).status, 400);
    assert.equal((await route.fetch(new Request('http://localhost/api/juebot/status', { method: 'POST' }))).status, 405);
    await assert.rejects(() => route.fetch(new Request('http://localhost/api/juebot/status', { signal: controller.signal })), { name: 'AbortError' });
  } finally { await state.dispose(); }
});

test('console configuration cannot activate data or business features', async () => {
  const state = context();
  await assert.rejects(() => apply(state.ctx, { storagePath: 'unexpected.sqlite' }), /INPUT_NOT_SUPPORTED/u);
  await assert.rejects(() => apply(state.ctx, { enableQQ: true }), /INPUT_NOT_SUPPORTED/u);
  assert.equal(state.providers.size, 0);
  assert.equal(state.routes.size, 0);
});

test('failed route registration removes this activation Inspect provider', async () => {
  const state = context({ routeFailure: true });
  await assert.rejects(() => apply(state.ctx), /synthetic duplicate route/u);
  assert.equal(state.providers.size, 0);
  assert.equal(state.routes.size, 0);
  await state.dispose();
});
