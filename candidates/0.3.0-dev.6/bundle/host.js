import { CoreError, isQQId, isRecord } from './lib/contracts.js';
import { openStorage } from './sqlite-driver.js';

/** No Config export yet: this skeleton deliberately has no editable Settings/RPC surface. */
export function normalizeHostConfig(raw = {}) {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['storagePath', 'botId', 'initializeStorage'].includes(key))) {
    throw new CoreError('INVALID_HOST_CONFIGURATION');
  }
  const storagePath = raw.storagePath ?? null;
  const botId = raw.botId ?? null;
  const initializeStorage = raw.initializeStorage ?? false;
  if ((storagePath !== null && (typeof storagePath !== 'string' || !storagePath.trim()))
    || (botId !== null && !isQQId(botId)) || typeof initializeStorage !== 'boolean'
    || (storagePath !== null && botId === null)) throw new CoreError('INVALID_HOST_CONFIGURATION');
  return Object.freeze({ storagePath, botId, initializeStorage });
}

/** Native Cordis apply form. The Loader patch disables the row; null storage is additionally inert. */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeHostConfig(rawConfig);
  if (config.storagePath === null) return;
  if (!ctx || typeof ctx.effect !== 'function') throw new CoreError('HOST_LIFECYCLE_UNAVAILABLE');
  ctx.effect(() => {
    const store = openStorage(config);
    return () => store.close();
  }, 'juebot.storage');
}

// No Tools, RPC, Agent, Session, QQ connector, model provider, timers or UI registrations.
