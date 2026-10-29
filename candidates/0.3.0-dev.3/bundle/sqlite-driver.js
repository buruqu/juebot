import { createRequire } from 'node:module';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError, isQQId } from './lib/contracts.js';
import { MemoryStore } from './lib/storage.js';

const requireBuiltin = createRequire(import.meta.url);
function ensure(condition, code) { if (!condition) throw new CoreError(code); }
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/** Trusted local setup only. No mkdir, extension loading, model call, socket or implicit data path. */
export function openStorage({ storagePath, botId, initializeStorage = false }) {
  ensure(typeof storagePath === 'string' && storagePath.length <= 4096 && path.isAbsolute(storagePath)
    && !/[\u0000-\u001f\u007f]/u.test(storagePath) && !storagePath.startsWith('\\\\')
    && !storagePath.startsWith('//') && path.extname(storagePath).toLowerCase() === '.sqlite', 'INVALID_STORAGE_PATH');
  ensure(isQQId(botId) && typeof initializeStorage === 'boolean', 'INVALID_STORAGE_CONFIGURATION');
  const requested = path.resolve(storagePath);
  const parent = realpathSync(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  const packageDirectory = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
  ensure(!inside(packageDirectory, requested) && !inside(packageDirectory, target)
    && !target.split(path.sep).some(part => part.toLowerCase() === 'node_modules'), 'STORAGE_INSIDE_PACKAGE');
  ensure(lstatSync(parent).isDirectory(), 'STORAGE_PARENT_NOT_DIRECTORY');
  let info;
  try { info = lstatSync(target); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (info) ensure(info.isFile() && !info.isSymbolicLink(), 'STORAGE_PATH_NOT_REGULAR_FILE');
  ensure(info !== undefined || initializeStorage, 'INITIALIZATION_REQUIRED');
  // Load only after explicit configuration; importing the bundle/default apply does not open SQLite.
  const { DatabaseSync } = requireBuiltin('node:sqlite');
  const database = new DatabaseSync(target, { allowExtension: false, enableForeignKeyConstraints: true });
  let store;
  try {
    store = new MemoryStore(database, botId, { initialize: initializeStorage });
    database.exec('PRAGMA busy_timeout=1000');
    const journal = database.prepare('PRAGMA journal_mode=WAL').get();
    ensure(journal?.journal_mode === 'wal', 'WAL_UNAVAILABLE');
    database.exec('PRAGMA synchronous=FULL');
    return store;
  } catch (error) {
    // Never unlink the configured file: it may pre-exist, or another actor may have replaced it.
    if (store) store.close();
    else database.close();
    throw error;
  }
}
