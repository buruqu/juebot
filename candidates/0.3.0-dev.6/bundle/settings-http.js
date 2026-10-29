import { CoreError } from './lib/contracts.js';

const MAX_BODY_BYTES = 65536;
const BODY_TIMEOUT_MS = 10000;
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const OPERATIONAL = Object.freeze({ adminVerified: false, storageBackendEnabled: false, qqConnected: false, modelsConnected: false, codeEnabled: false });
const error = code => new CoreError(code);

/** The route must use streaming: the SDK buffered cap is much larger than this configuration limit. */
export async function readControlJson(request, limits = {}) {
  const max = limits.maxBytes ?? MAX_BODY_BYTES;
  const timeout = limits.timeoutMs ?? BODY_TIMEOUT_MS;
  request.signal.throwIfAborted();
  if (request.method !== 'POST' || new URL(request.url).search) throw error('INVALID_CONTROL_REQUEST');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('content-type') ?? '')) throw error('JSON_CONTENT_TYPE_REQUIRED');
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw error('CONTENT_ENCODING_NOT_SUPPORTED');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > max)) throw error('CONTROL_BODY_TOO_LARGE');
  if (!request.body) throw error('INVALID_CONTROL_JSON');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  let timer;
  let rejectStop;
  const stop = new Promise((_, reject) => { rejectStop = reject; });
  const abort = () => rejectStop(error('CONTROL_REQUEST_ABORTED'));
  request.signal.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => rejectStop(error('CONTROL_BODY_TIMEOUT')), timeout);
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const part = await Promise.race([reader.read(), stop]);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw error('INVALID_CONTROL_BODY');
      total += part.value.byteLength;
      if (total > max) throw error('CONTROL_BODY_TOO_LARGE');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw error('INVALID_CONTROL_JSON'); }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    // Bounded cancellation: do not wait forever for a hostile stream's cancellation hook.
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* pending read is already cancelled */ }
  }
}
function statusFor(code) {
  if (code === 'CONTROL_REVISION_CONFLICT' || code === 'PATH_CHANGED_RECHECK' || code === 'PATH_CHECK_REQUIRED') return 409;
  if (code === 'CONTROL_BODY_TOO_LARGE') return 413;
  if (code === 'JSON_CONTENT_TYPE_REQUIRED' || code === 'CONTENT_ENCODING_NOT_SUPPORTED') return 415;
  if (code === 'CONTROL_UNAVAILABLE' || code === 'CONTROL_CLOSED' || code === 'CONTROL_OPERATION_FAILED') return 503;
  if (code === 'CONTROL_BODY_TIMEOUT') return 408;
  return 400;
}
function publicError(caught) {
  return caught instanceof CoreError && /^[A-Z][A-Z0-9_]{0,79}$/u.test(caught.code) ? caught.code : 'CONTROL_OPERATION_FAILED';
}

/** Only expose through Connection exact routes, which supply Host/Origin/auth/owner admission. */
export function controlRoutes(getService) {
  const response = state => new Response(JSON.stringify({ ok: true, state, operational: OPERATIONAL }), { headers });
  const run = operation => async request => {
    try { request.signal.throwIfAborted(); return await operation(request); }
    catch (caught) {
      try { void request.body?.cancel().catch(() => {}); } catch { /* may already be locked/cancelled */ }
      if (request.signal.aborted) throw caught;
      const code = publicError(caught);
      return new Response(JSON.stringify({ ok: false, error: { code } }), { status: statusFor(code), headers });
    }
  };
  const service = () => { const current = getService(); if (!current) throw error('CONTROL_UNAVAILABLE'); return current; };
  const post = (path, operation) => ({ path, methods: ['POST'], requestBody: 'streaming', fetch: run(async request => {
    const input = await readControlJson(request);
    return operation(service(), input, request.signal);
  }) });
  return [
    { path: '/api/juebot/settings', methods: ['GET'], requestBody: 'buffered', fetch: run(async request => {
      if (request.method !== 'GET' || new URL(request.url).search) throw error('INVALID_CONTROL_REQUEST');
      return response(service().readOwner());
    }) },
    post('/api/juebot/settings/identity', async (current, input, signal) => response(await current.updateIdentity(input, signal))),
    post('/api/juebot/settings/admin', async (current, input, signal) => response(await current.owner.setAdmin(input, signal))),
    post('/api/juebot/settings/path/check', async (current, input, signal) => new Response(JSON.stringify({ ok: true, check: await current.owner.checkPath(input, signal) }), { headers })),
    post('/api/juebot/settings/path/confirm', async (current, input, signal) => response(await current.owner.confirmPath(input, signal))),
    post('/api/juebot/settings/path/clear', async (current, input, signal) => response(await current.owner.clearPath(input, signal))),
  ];
}
