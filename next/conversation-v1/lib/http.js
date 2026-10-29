import { ConversationError, id } from "./contracts.js";
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
// A valid namespaced key is repeated inside the cursor; percent-encoded Unicode
// must fit too. Individual key/cursor limits remain independently enforced.
const QUERY_BYTES = 32 * 1024;
const CURSOR_BYTES = 8 * 1024;
const encoder = new TextEncoder();
function response(value, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}
function failure(code, status, headers = {}) {
    return response({ ok: false, error: { code } }, status, headers);
}
function invalid() { throw new ConversationError('INVALID_INPUT'); }
function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
    if (!/^[1-9][0-9]*$/u.test(value))
        invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max)
        invalid();
    return number;
}
function params(url, allowed) {
    if (encoder.encode(url.search).byteLength > QUERY_BYTES)
        invalid();
    const seen = new Set();
    for (const key of url.searchParams.keys()) {
        if (!allowed.includes(key) || seen.has(key))
            invalid();
        seen.add(key);
    }
    return url.searchParams;
}
function pageOptions(query) {
    const options = {};
    const limit = query.get('limit');
    if (limit !== null)
        options.limit = positiveInteger(limit, 100);
    const cursor = query.get('cursor');
    if (cursor !== null) {
        if (!cursor.length || encoder.encode(cursor).byteLength > CURSOR_BYTES || /[\u0000-\u001f\u007f]/u.test(cursor))
            invalid();
        options.cursor = cursor;
    }
    return options;
}
function requiredKey(query) {
    const key = query.get('key');
    id(key, 4096);
    return key;
}
function publicFailure(error) {
    if (error instanceof ConversationError) {
        switch (error.code) {
            case 'INVALID_INPUT':
            case 'INVALID_CURSOR': return failure(error.code, 400);
            case 'ACCESS_DENIED':
            case 'ACCESS_CHANGED': return failure(error.code, 403);
            case 'BINDING_CONFLICT':
            case 'EVENT_CONFLICT': return failure(error.code, 409);
            case 'CONVERSATION_NOT_FOUND':
            case 'SOURCE_NOT_FOUND': return failure(error.code, 404);
        }
    }
    // Neither arbitrary exception text nor SDK/storage details leave this boundary.
    return failure('STORAGE_FAILURE', 503);
}
/** Offline read-only WHATWG handler. Does not listen, register a Host route, or authorize a platform action. */
export function createConversationHttp({ reader, resolvePrincipal }) {
    return async (request) => {
        try {
            request.signal.throwIfAborted();
            const principal = await resolvePrincipal(request);
            request.signal.throwIfAborted();
            if (typeof principal !== 'string' || !principal.length)
                return failure('UNAUTHENTICATED', 401);
            if (request.method !== 'GET')
                return failure('METHOD_NOT_ALLOWED', 405, { allow: 'GET' });
            const url = new URL(request.url);
            let data;
            switch (url.pathname) {
                case '/juebot/conversations': {
                    const query = params(url, ['limit', 'cursor']);
                    data = await reader.list(principal, pageOptions(query));
                    break;
                }
                case '/juebot/conversation-events': {
                    const query = params(url, ['key', 'limit', 'cursor']);
                    data = await reader.events(principal, requiredKey(query), pageOptions(query));
                    break;
                }
                case '/juebot/conversation-body': {
                    const query = params(url, ['key', 'sequence']);
                    const sequence = query.get('sequence');
                    if (sequence === null)
                        invalid();
                    data = await reader.body(principal, requiredKey(query), positiveInteger(sequence));
                    break;
                }
                default: return failure('CONVERSATION_NOT_FOUND', 404);
            }
            request.signal.throwIfAborted();
            return response({ ok: true, data });
        }
        catch (error) {
            // An aborted consumer cannot receive a reliable success/failure delivery acknowledgement.
            request.signal.throwIfAborted();
            return publicFailure(error);
        }
    };
}
