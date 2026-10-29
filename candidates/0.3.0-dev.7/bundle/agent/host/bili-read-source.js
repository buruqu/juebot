const fail = code => { throw Object.assign(new Error(code), { code }); };
export const requireBili = (ok, code = 'BILI_INVALID_INPUT') => { if (!ok) fail(code); };
export function biliShape(value, keys, required = keys) {
  requireBili(value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)));
  requireBili(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)) && required.every(key => Object.hasOwn(value, key)));
  requireBili(Object.values(Object.getOwnPropertyDescriptors(value)).every(item => !item.get && !item.set));
}
export function biliText(value, max, empty = false) {
  requireBili(typeof value === 'string' && value.length <= max && (empty || value.trim()) && !/[\u0000\uD800-\uDFFF]/u.test(value)); return value;
}
export function biliId(value) {
  requireBili((typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value)) || (Number.isSafeInteger(value) && value > 0), 'BILI_UNSAFE_ID'); return String(value);
}
export function biliAccount(value) {
  biliText(value, 1024); let tuple; try { tuple = JSON.parse(value); } catch { fail('BILI_ACCOUNT_INVALID'); }
  requireBili(Array.isArray(tuple) && tuple.length === 3 && tuple[0] === 'bilibili' && tuple.every(item => typeof item === 'string' && item.trim() && item.length <= 256 && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(item))
    && JSON.stringify(tuple) === value, 'BILI_ACCOUNT_INVALID'); return value;
}
function grant(authorize, input) {
  let result; try { result = authorize?.(structuredClone(input)); } catch { fail('BILI_NOT_AUTHORIZED'); }
  if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  requireBili(result && result.allowed === true && Number.isSafeInteger(result.revision) && result.revision >= 0 && typeof result.then !== 'function', 'BILI_NOT_AUTHORIZED');
  return result.revision;
}
/** Explicit read only. No credentials, global fetch, SDK imports, timers or network work at construction. */
export function createBiliReadSource({ transport, authorize, budget, now, timeoutMs = 10000, maxResponseBytes = 524288 }) {
  requireBili(typeof transport === 'function' && typeof authorize === 'function' && typeof budget?.consume === 'function' && typeof now === 'function');
  requireBili(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 25000 && Number.isSafeInteger(maxResponseBytes) && maxResponseBytes >= 128 && maxResponseBytes <= 1048576);
  let closed = false; const active = new Set(), stops = new Map();
  const read = async (input, { signal } = {}) => {
    requireBili(!closed, 'BILI_CLOSED');
    biliShape(input, ['account', 'bvid', 'page', 'limit', 'sort'], ['account', 'bvid']);
    const request = { account: biliAccount(input.account), bvid: biliText(input.bvid, 12), page: input.page ?? 1, limit: input.limit ?? 20, sort: input.sort ?? 0 };
    requireBili(/^BV[1-9A-HJ-NP-Za-km-z]{10}$/u.test(request.bvid) && Number.isSafeInteger(request.page) && request.page >= 1 && request.page <= 100
      && Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 && [0, 1, 2].includes(request.sort));
    const permission = { operation: 'read', ...request }, revision = grant(authorize, permission);
    const controller = new AbortController(); let timer, reader;
    const check = () => { requireBili(!closed, 'BILI_CLOSED'); requireBili(!signal?.aborted && !controller.signal.aborted, 'BILI_CANCELLED'); requireBili(grant(authorize, permission) === revision, 'BILI_ACCESS_CHANGED'); requireBili(!closed, 'BILI_CLOSED'); };
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; timer = setTimeout(() => { controller.abort(); failDeadline('BILI_TIMEOUT'); }, timeoutMs); });
    const failDeadline = code => rejectDeadline(Object.assign(Error(code), { code }));
    stops.set(controller, () => { controller.abort(); failDeadline('BILI_CLOSED'); });
    const abort = () => { controller.abort(); failDeadline('BILI_CANCELLED'); }; signal?.addEventListener('abort', abort, { once: true });
    const wait = async promise => { const value = await Promise.race([promise, deadline]); check(); return value; };
    const fetchJson = async (path, params) => {
      check(); const url = 'https://api.bilibili.com' + path + '?' + new URLSearchParams(params);
      const consumed = budget.consume({ account: request.account, bvid: request.bvid, endpoint: path, requests: 1 });
      if (consumed && typeof consumed.then === 'function') Promise.resolve(consumed).catch(() => {});
      requireBili(consumed === true, 'BILI_BUDGET_DENIED'); check();
      const response = await wait(transport(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json' } }));
      requireBili(response && !response.redirected && response.type !== 'opaqueredirect' && response.status === 200 && !response.headers.has('location')
        && (!response.url || response.url === url), 'BILI_RESPONSE_REJECTED');
      requireBili(/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') && response.body, 'BILI_RESPONSE_REJECTED');
      const length = response.headers.get('content-length'); requireBili(length === null || (/^[0-9]+$/u.test(length) && Number(length) <= maxResponseBytes), 'BILI_RESPONSE_TOO_LARGE');
      reader = response.body.getReader(); const parts = []; let size = 0;
      try { for (;;) { const part = await wait(reader.read()); if (part.done) break; size += part.value.byteLength; requireBili(size <= maxResponseBytes, 'BILI_RESPONSE_TOO_LARGE'); parts.push(part.value); } }
      finally { try { void reader.cancel().catch(() => {}); } catch {} reader = null; }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      let json; try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('BILI_RESPONSE_INVALID'); }
      requireBili(json?.code === 0 && json.data && typeof json.data === 'object', 'BILI_PLATFORM_REJECTED'); return json.data;
    };
    try {
      check(); const video = await fetchJson('/x/web-interface/view', { bvid: request.bvid }); check();
      requireBili(video.bvid === request.bvid, 'BILI_VIDEO_MISMATCH'); const aid = biliId(video.aid), cid = biliId(video.cid);
      const title = biliText(video.title, 256), description = biliText(video.desc, 3500, true), author = { id: biliId(video.owner?.mid), name: biliText(video.owner?.name, 128) };
      const page = await fetchJson('/x/v2/reply', { type: '1', oid: aid, pn: String(request.page), ps: String(request.limit), sort: String(request.sort) }); check();
      requireBili(page.page?.num === request.page && page.page?.size === request.limit && Number.isSafeInteger(page.page?.count) && page.page.count >= 0, 'BILI_PAGE_MISMATCH');
      const rows = page.replies ?? []; requireBili(Array.isArray(rows) && rows.length <= request.limit && page.page.count >= rows.length, 'BILI_RESPONSE_INVALID');
      const seen = new Set(); const comments = rows.map(row => {
        const id = biliId(row.rpid_str ?? row.rpid); requireBili(row.rpid === undefined || biliId(row.rpid) === id, 'BILI_COMMENT_MISMATCH');
        requireBili(biliId(row.oid) === aid && !seen.has(id), 'BILI_COMMENT_MISMATCH'); seen.add(id);
        return { id, author: { id: biliId(row.member?.mid), name: biliText(row.member?.uname, 128) }, text: biliText(row.content?.message, 3600) };
      });
      const observedAt = now(); requireBili(Number.isSafeInteger(observedAt) && observedAt >= 0); check();
      return { ...request, aid, cid, title, description, author, comments, observedAt, page: { number: request.page, size: request.limit, total: page.page.count },
        truncated: request.page > 1 || page.page.count > comments.length, coverage: 'metadata-and-top-level-comments-only' };
    } catch (error) { if (typeof error?.code === 'string' && error.code.startsWith('BILI_')) throw error; fail('BILI_READ_FAILED'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); stops.delete(controller); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
  };
  return { read(...args) { const operation = read(...args); active.add(operation); void operation.finally(() => active.delete(operation)).catch(() => {}); return operation; },
    close() { closed = true; for (const stop of stops.values()) stop(); return Promise.allSettled([...active]).then(() => undefined); } };
}
