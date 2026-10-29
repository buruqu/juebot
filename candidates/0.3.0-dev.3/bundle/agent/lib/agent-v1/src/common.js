export class AgentError extends Error {
    code;
    constructor(code) { super(code); this.name = 'AgentError'; this.code = code; }
}
export function ensure(ok, code = 'INVALID_INPUT') {
    if (!ok)
        throw new AgentError(code);
}
export function text(value, max = 256) {
    ensure(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\uD800-\uDFFF]/u.test(value));
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    ensure(Number.isSafeInteger(value) && value >= min && value <= max);
}
export function clone(value) { return structuredClone(value); }
export function plain(value, keys) {
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
    if (keys)
        ensure(Object.keys(value).every(key => keys.includes(key)));
}
/** Stable JSON is a comparison representation, never a cryptographic signature or permission. */
export function stable(value, depth = 0) {
    ensure(depth <= 32);
    if (value === null || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        ensure(Number.isFinite(value));
        return JSON.stringify(value);
    }
    if (typeof value === 'string') {
        ensure(!/[\u0000\uD800-\uDFFF]/u.test(value));
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        ensure(value.length <= 50000);
        return '[' + value.map(v => stable(v, depth + 1)).join(',') + ']';
    }
    plain(value);
    const keys = Object.keys(value).sort();
    ensure(keys.length <= 50000);
    return '{' + keys.map(key => stable(key, depth + 1) + ':' + stable(value[key], depth + 1)).join(',') + '}';
}
