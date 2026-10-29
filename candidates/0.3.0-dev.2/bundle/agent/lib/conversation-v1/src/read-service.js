import { ConversationError, LIMITS, demand, id, integer, record } from "./contracts.js";
function snapshot(value) {
    record(value, ['revision', 'grants']);
    integer(value.revision);
    demand(Array.isArray(value.grants) && value.grants.length <= LIMITS.grants);
    const seen = new Set();
    const grants = value.grants.map(grant => {
        record(grant, ['key', 'bindingRevision', 'metadata', 'body']);
        id(grant.key, 4096);
        integer(grant.bindingRevision);
        demand(typeof grant.metadata === 'boolean' && typeof grant.body === 'boolean' && (!grant.body || grant.metadata));
        demand(!seen.has(grant.key));
        seen.add(grant.key);
        return { key: grant.key, bindingRevision: grant.bindingRevision, metadata: grant.metadata, body: grant.body };
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return { revision: value.revision, grants };
}
function options(value) {
    record(value, ['limit', 'cursor']);
    const limit = value.limit ?? 50;
    integer(limit, 1, LIMITS.page);
    if (value.cursor === undefined)
        return { limit, cursor: null };
    try {
        id(value.cursor, 8192);
        const parsed = JSON.parse(value.cursor);
        record(parsed, ['v', 'kind', 'revision', 'key', 'binding', 'after']);
        demand(parsed.v === 1 && ['list', 'events'].includes(parsed.kind));
        integer(parsed.revision);
        if (parsed.kind === 'list') {
            demand(parsed.key === null && parsed.binding === null);
            id(parsed.after, 4096);
        }
        else {
            id(parsed.key, 4096);
            integer(parsed.binding);
            integer(parsed.after, 1);
        }
        return { limit, cursor: parsed };
    }
    catch {
        throw new ConversationError('INVALID_CURSOR');
    }
}
function grantFor(access, key, body) {
    const grant = access.grants.find(item => item.key === key);
    demand(grant?.metadata && (!body || grant.body), 'ACCESS_DENIED');
    return grant;
}
/** No write, model or network methods. Cursors are untrusted positions, never authorization. */
export class ConversationReadService {
    ledger;
    access;
    constructor(ledger, access) { this.ledger = ledger; this.access = access; }
    async before(principal) { id(principal); return snapshot(await this.access(principal)); }
    async after(principal, before) {
        const after = snapshot(await this.access(principal));
        demand(JSON.stringify(before) === JSON.stringify(after), 'ACCESS_CHANGED');
    }
    async list(principal, input = {}) {
        const query = options(input);
        const access = await this.before(principal);
        if (query.cursor)
            demand(query.cursor.kind === 'list' && query.cursor.revision === access.revision, 'INVALID_CURSOR');
        const permitted = access.grants.filter(item => item.metadata);
        const keys = permitted.map(item => item.key);
        const rows = [];
        // The allowed key set is bounded, and the ledger never sees keys outside it.
        let afterKey = query.cursor?.after;
        while (keys.length && rows.length <= query.limit) {
            const batch = this.ledger.listConversations(keys, afterKey ?? null, 101);
            for (const row of batch)
                if (permitted.some(grant => grant.key === row.key && grant.bindingRevision === row.bindingRevision))
                    rows.push(row);
            if (batch.length < 101)
                break;
            const next = batch.at(-1).key;
            demand(next !== afterKey, 'STORAGE_FAILURE');
            afterKey = next;
        }
        const items = rows.slice(0, query.limit);
        await this.after(principal, access);
        for (const item of items)
            demand(this.ledger.getConversation(item.key)?.bindingRevision === item.bindingRevision, 'BINDING_CONFLICT');
        return { items, nextCursor: rows.length > query.limit ? JSON.stringify({ v: 1, kind: 'list', revision: access.revision,
                key: null, binding: null, after: items.at(-1).key }) : null };
    }
    async events(principal, key, input = {}) {
        id(key, 4096);
        const query = options(input);
        const access = await this.before(principal);
        const grant = grantFor(access, key, false);
        if (query.cursor)
            demand(query.cursor.kind === 'events' && query.cursor.key === key
                && query.cursor.binding === grant.bindingRevision && query.cursor.revision === access.revision, 'INVALID_CURSOR');
        const current = this.ledger.getConversation(key);
        demand(current, 'CONVERSATION_NOT_FOUND');
        demand(current.bindingRevision === grant.bindingRevision, 'BINDING_CONFLICT');
        const rows = this.ledger.pageEvents(key, grant.bindingRevision, query.cursor?.after ?? 0, query.limit + 1);
        const items = rows.slice(0, query.limit);
        await this.after(principal, access);
        // A rebind while awaiting the second permission snapshot invalidates the collected page.
        demand(this.ledger.getConversation(key)?.bindingRevision === grant.bindingRevision, 'BINDING_CONFLICT');
        return { items, nextCursor: rows.length > query.limit ? JSON.stringify({ v: 1, kind: 'events', revision: access.revision,
                key, binding: grant.bindingRevision, after: items.at(-1).sequence }) : null };
    }
    async body(principal, key, sequence) {
        id(key, 4096);
        integer(sequence, 1);
        const access = await this.before(principal);
        const grant = grantFor(access, key, true);
        const text = this.ledger.readBody(key, grant.bindingRevision, sequence);
        demand(text !== null, 'SOURCE_NOT_FOUND');
        await this.after(principal, access);
        demand(this.ledger.getConversation(key)?.bindingRevision === grant.bindingRevision, 'BINDING_CONFLICT');
        return { sequence, text };
    }
}
