import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { apply, normalizeHostConfig } from '../bundle/host.js';
import { openStorage } from '../bundle/sqlite-driver.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const bundle = path.join(project, 'bundle');
const sqlite = createRequire(import.meta.url)('node:sqlite');
const Database = sqlite.DatabaseSync;
const code = expected => error => error?.code === expected;
function temp(t) {
  const parent = path.join(project, '.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'juebot-host-')));
  const closers = [];
  t.after(() => {
    for (const closer of closers.reverse()) closer();
    assert.equal(fs.realpathSync(directory), directory);
    assert.equal(path.dirname(directory), fs.realpathSync(parent));
    assert.ok(path.basename(directory).startsWith('juebot-host-'));
    fs.rmSync(directory, { recursive: true, force: false });
  });
  return { directory, file: path.join(directory, 'data.sqlite'), track: resource => {
    closers.push(() => { if (resource instanceof Database ? resource.isOpen : true) resource.close(); });
    return resource;
  } };
}
function instrumentDatabases(operation, fakeWal = false) {
  const created = [];
  const original = sqlite.DatabaseSync;
  sqlite.DatabaseSync = new Proxy(original, { construct(target, args) {
    const db = Reflect.construct(target, args);
    const observation = { db, closeCalls: 0 };
    created.push(observation);
    const close = db.close.bind(db);
    db.close = () => { observation.closeCalls += 1; return close(); };
    if (fakeWal) {
      const prepare = db.prepare.bind(db);
      db.prepare = sql => sql === 'PRAGMA journal_mode=WAL' ? { get: () => ({ journal_mode: 'delete' }) } : prepare(sql);
    }
    return db;
  } });
  try { operation(created); }
  finally {
    sqlite.DatabaseSync = original;
    for (const item of created) if (item.db.isOpen) item.db.close();
  }
}

test('host null configuration is inert and validates only explicitly supported fields', () => {
  let effects = 0;
  apply({ effect: () => { effects += 1; } });
  apply({ effect: () => { effects += 1; } }, { storagePath: null });
  apply(undefined, {});
  assert.equal(effects, 0);
  assert.ok(Object.isFrozen(normalizeHostConfig({})));
  for (const config of [null, [], { connectQQ: true }, { storagePath: '' }, { storagePath: '/tmp/a.sqlite' }, { initializeStorage: 'yes' }, { botId: 123 }]) {
    assert.throws(() => normalizeHostConfig(config), code('INVALID_HOST_CONFIGURATION'));
  }
});

test('inert bundle import works when Node SQLite capability is unavailable', () => {
  const entry = pathToFileURL(path.join(bundle, 'host.js')).href;
  const script = `const m = await import(${JSON.stringify(entry)}); m.apply(undefined, {storagePath:null});`;
  const child = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', script], { stdio: 'inherit' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
});

test('explicit storage activation fails closed if native SQLite is unavailable', t => {
  const files = temp(t);
  const entry = pathToFileURL(path.join(bundle, 'sqlite-driver.js')).href;
  const script = `const m = await import(${JSON.stringify(entry)}); try { m.openStorage(${JSON.stringify({ storagePath: files.file, botId: '90001', initializeStorage: true })}); process.exitCode=2; } catch(e) { if(e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw e; }`;
  const child = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', script], { stdio: 'inherit' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(fs.existsSync(files.file), false);
});

test('missing storage does not create a file without explicit initialization', t => {
  const files = temp(t);
  assert.throws(() => openStorage({ storagePath: files.file, botId: '90001' }), code('INITIALIZATION_REQUIRED'));
  assert.equal(fs.existsSync(files.file), false);
});

test('storage factory creates an owned WAL database outside the package and reopens it', t => {
  const files = temp(t);
  const store = files.track(openStorage({ storagePath: files.file, botId: '90001', initializeStorage: true }));
  assert.equal(store.stateRevision(), 0);
  const reader = files.track(new Database(files.file));
  assert.equal(reader.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  reader.close(); store.close();
  const reopened = files.track(openStorage({ storagePath: files.file, botId: '90001' }));
  assert.equal(reopened.stateRevision(), 0);
});

test('host registers one context-owned cleanup and closes the native handle exactly once', t => {
  const files = temp(t);
  instrumentDatabases(created => {
    const effects = [];
    const ctx = { effect: (setup, label) => { const cleanup = setup(); effects.push({ label, cleanup }); return cleanup; } };
    apply(ctx, { storagePath: files.file, botId: '90001', initializeStorage: true });
    assert.equal(effects.length, 1);
    assert.equal(effects[0].label, 'juebot.storage');
    assert.equal(created.length, 1);
    assert.equal(created[0].db.isOpen, true);
    effects[0].cleanup(); effects[0].cleanup();
    assert.equal(created[0].closeCalls, 1);
    assert.equal(created[0].db.isOpen, false);
  });
});

test('foreign-database setup failure closes the unowned connection and preserves user data', t => {
  const files = temp(t);
  const original = new Database(files.file);
  original.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('unchanged'); PRAGMA application_id=1234;");
  original.close();
  const before = fs.readFileSync(files.file);
  instrumentDatabases(created => {
    assert.throws(() => openStorage({ storagePath: files.file, botId: '90001', initializeStorage: true }), code('FOREIGN_DATABASE'));
    assert.equal(created.length, 1);
    assert.equal(created[0].closeCalls, 1);
    assert.equal(created[0].db.isOpen, false);
  });
  assert.deepEqual(fs.readFileSync(files.file), before);
});

test('post-construction WAL failure closes the owned store without deleting the file', t => {
  const files = temp(t);
  instrumentDatabases(created => {
    assert.throws(() => openStorage({ storagePath: files.file, botId: '90001', initializeStorage: true }), code('WAL_UNAVAILABLE'));
    assert.equal(created[0].closeCalls, 1);
    assert.equal(created[0].db.isOpen, false);
  }, true);
  assert.equal(fs.existsSync(files.file), true);
});

test('package, node_modules, relative and network-style data paths are refused', t => {
  const files = temp(t);
  assert.throws(() => openStorage({ storagePath: path.join(bundle, 'forbidden.sqlite'), botId: '90001', initializeStorage: true }), code('STORAGE_INSIDE_PACKAGE'));
  const dependencyPath = path.join(files.directory, 'node_modules');
  fs.mkdirSync(dependencyPath);
  assert.throws(() => openStorage({ storagePath: path.join(dependencyPath, 'forbidden.sqlite'), botId: '90001', initializeStorage: true }), code('STORAGE_INSIDE_PACKAGE'));
  for (const storagePath of ['relative.sqlite', '\\\\server\\share\\data.sqlite', '//server/share/data.sqlite', path.join(files.directory, 'wrong.json')]) {
    assert.throws(() => openStorage({ storagePath, botId: '90001', initializeStorage: true }), code('INVALID_STORAGE_PATH'));
  }
  assert.equal(fs.existsSync(path.join(bundle, 'forbidden.sqlite')), false);
});

test('leaf symlinks including dangling ones cannot redirect database creation', t => {
  const files = temp(t);
  const target = path.join(files.directory, 'redirected.sqlite');
  const link = path.join(files.directory, 'link.sqlite');
  fs.symlinkSync(target, link, 'file');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(link), false);
  assert.throws(() => openStorage({ storagePath: link, botId: '90001', initializeStorage: true }), code('STORAGE_PATH_NOT_REGULAR_FILE'));
  assert.equal(fs.existsSync(target), false);
  fs.writeFileSync(target, 'still not a database');
  assert.throws(() => openStorage({ storagePath: link, botId: '90001', initializeStorage: true }), code('STORAGE_PATH_NOT_REGULAR_FILE'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'still not a database');
});

test('host lifecycle absence or unknown configuration cannot start storage', t => {
  const files = temp(t);
  assert.throws(() => apply({}, { storagePath: files.file, botId: '90001', initializeStorage: true }), code('HOST_LIFECYCLE_UNAVAILABLE'));
  assert.throws(() => apply({ effect: fn => fn() }, { storagePath: files.file, botId: '90001', initializeStorage: true, model: 'unexpected' }), code('INVALID_HOST_CONFIGURATION'));
  assert.equal(fs.existsSync(files.file), false);
});

test('bundle metadata keeps storage disabled and includes every runtime resource', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@local/dsh-juebot');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.engines.dsh, '0.2.1-rc.3');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  const patch = fs.readFileSync(path.join(bundle, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: juebot-host/u);
  assert.match(patch, /disabled: true/u);
  assert.match(patch, /storagePath: null/u);
  assert.equal((patch.match(/- insert:/gu) ?? []).length, 1);
  const files = new Set(['package.json', ...manifest.files.flatMap(pattern => fs.globSync(pattern, { cwd: bundle }))
    .map(file => file.split(path.sep).join('/'))]);
  for (const file of ['host.js', 'sqlite-driver.js', 'console-host.js', 'diagnostics.js', 'client.js', 'storage-locale/en.json', 'storage-locale/zh.json', 'lib/index.js', 'lib/storage.js', 'lib/contracts.js', 'lib/memory.js', 'lib/runtime.js', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'NOTICE', 'cordis.patch.yml']) {
    assert.ok(files.has(file), `not shipped: ${file}`);
    assert.ok(fs.lstatSync(path.join(bundle, file)).isFile());
  }
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(fs.readFileSync(path.join(bundle, 'locale', `${language}.json`), 'utf8'));
    assert.ok(locale.meta.title.includes('juebot'));
    assert.ok(locale.meta.description.length > 20);
  }
  const icon = fs.readFileSync(path.join(bundle, 'icon.svg'), 'utf8');
  assert.ok(Buffer.byteLength(icon) < 256 * 1024);
  assert.match(icon, /<svg\b/u);
  assert.doesNotMatch(icon, /<script\b|<foreignObject\b|\son\w+=|<!DOCTYPE|<!ENTITY/iu);
});
