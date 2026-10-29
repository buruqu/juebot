import { ConversationError, demand, id, integer, record, validateEvent, LIMITS } from "./contracts.js";
import { canonicalIdentity, conversationKey } from "./identity.js";
export const CONVERSATION_APPLICATION_ID = 0x4a554543;
export const CONVERSATION_SCHEMA_VERSION = 1;
const definitions = [
    `CREATE TABLE ledger_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_namespace TEXT NOT NULL)`,
    `CREATE TABLE conversation_records (
    conversation_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(binding_revision>=0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
    `CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL REFERENCES conversation_records(conversation_key), binding_revision INTEGER NOT NULL,
    source_event_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, event_type TEXT NOT NULL, reason_code TEXT NOT NULL,
    actor_id TEXT, run_id TEXT, caused_by INTEGER REFERENCES ledger_events(sequence), has_body INTEGER NOT NULL CHECK(has_body IN (0,1)),
    UNIQUE(conversation_key,binding_revision,source_event_id)
  )`,
    `CREATE TABLE event_bodies (sequence INTEGER PRIMARY KEY REFERENCES ledger_events(sequence), body TEXT NOT NULL)`,
    `CREATE INDEX ledger_events_stream ON ledger_events(conversation_key,binding_revision,sequence)`,
];
const normalized = (sql) => sql.trim().replace(/;+$/u, '').replace(/\s+/gu, ' ');
const expected = new Map(definitions.map(sql => {
    const match = /^CREATE (TABLE|INDEX) (\w+)/u.exec(sql);
    return [match[2], { type: match[1].toLowerCase(), sql: normalized(sql) }];
}));
function row(value) {
    demand(value !== null && typeof value === 'object' && !Array.isArray(value), 'STORE_MISMATCH');
    return value;
}
function safe(operation) {
    try {
        return operation();
    }
    catch (error) {
        if (error instanceof ConversationError)
            throw error;
        throw new ConversationError('STORAGE_FAILURE');
    }
}
function keyInput(key) { id(key, 4096); }
function pageInput(limit) { integer(limit, 1, LIMITS.page + 1); }
function decodeConversation(value) {
    const entry = row(value);
    demand(typeof entry.identity_json === 'string', 'STORE_MISMATCH');
    const identity = canonicalIdentity(JSON.parse(entry.identity_json));
    demand(conversationKey(identity) === entry.conversation_key, 'STORE_MISMATCH');
    integer(entry.binding_revision);
    integer(entry.created_at);
    integer(entry.updated_at);
    return { key: entry.conversation_key, identity, bindingRevision: entry.binding_revision,
        createdAt: entry.created_at, updatedAt: entry.updated_at };
}
function decodeEvent(value) {
    const entry = row(value);
    const input = {
        conversationKey: entry.conversation_key, bindingRevision: entry.binding_revision, sourceEventId: entry.source_event_id,
        occurredAt: entry.occurred_at, eventType: entry.event_type, reasonCode: entry.reason_code,
        actorId: entry.actor_id, runId: entry.run_id, causedBy: entry.caused_by, body: null,
    };
    validateEvent(input);
    integer(entry.sequence, 1);
    demand(entry.has_body === 0 || entry.has_body === 1, 'STORE_MISMATCH');
    const { body: ignored, ...metadata } = input;
    void ignored;
    return { ...metadata, sequence: entry.sequence, bodyRef: entry.has_body === 1 ? entry.sequence : null };
}
/** Injected SQLite only. No filesystem, profile lookup, driver import or caller-owned DB close. */
export class ConversationLedger {
    closed = false;
    db;
    constructor(db, options) {
        record(options, ['namespace', 'initialize']);
        id(options.namespace);
        demand(options.initialize === undefined || typeof options.initialize === 'boolean');
        this.db = db;
        safe(() => {
            const application = row(db.prepare('PRAGMA application_id').get()).application_id;
            const version = row(db.prepare('PRAGMA user_version').get()).user_version;
            const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all().map(row);
            if (application === 0 && version === 0 && objects.length === 0) {
                demand(options.initialize === true, 'STORE_NOT_INITIALIZED');
                this.transaction(() => {
                    // Recheck under the write lock before claiming an empty database.
                    demand(row(db.prepare('PRAGMA application_id').get()).application_id === 0
                        && row(db.prepare('PRAGMA user_version').get()).user_version === 0
                        && db.prepare('SELECT name FROM sqlite_schema').all().length === 0, 'STORE_MISMATCH');
                    for (const definition of definitions)
                        db.exec(definition);
                    db.prepare('INSERT INTO ledger_metadata(singleton,owner_namespace) VALUES(1,?)').run(options.namespace);
                    db.exec(`PRAGMA application_id=${CONVERSATION_APPLICATION_ID}`);
                    db.exec(`PRAGMA user_version=${CONVERSATION_SCHEMA_VERSION}`);
                });
            }
            else {
                demand(application === CONVERSATION_APPLICATION_ID && version === CONVERSATION_SCHEMA_VERSION, 'STORE_MISMATCH');
            }
            this.verifySchema(options.namespace);
        });
    }
    verifySchema(namespace) {
        const objects = this.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row);
        demand(objects.length === expected.size, 'STORE_MISMATCH');
        for (const entry of objects) {
            const requirement = expected.get(String(entry.name));
            demand(requirement && entry.type === requirement.type && typeof entry.sql === 'string'
                && normalized(entry.sql) === requirement.sql, 'STORE_MISMATCH');
        }
        const owners = this.db.prepare('SELECT singleton,owner_namespace FROM ledger_metadata').all().map(row);
        demand(owners.length === 1 && owners[0].singleton === 1 && owners[0].owner_namespace === namespace, 'STORE_MISMATCH');
    }
    assertOpen() { demand(!this.closed, 'STORE_CLOSED'); }
    transaction(operation, write = true) {
        this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            const result = operation();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { /* retain the original failure without SQL/body details */ }
            throw error;
        }
    }
    lookup(key) {
        const value = this.db.prepare('SELECT * FROM conversation_records WHERE conversation_key=?').get(key);
        return value === undefined ? null : decodeConversation(value);
    }
    requireBinding(key, bindingRevision) {
        const conversation = this.lookup(key);
        demand(conversation, 'CONVERSATION_NOT_FOUND');
        demand(conversation.bindingRevision === bindingRevision, 'BINDING_CONFLICT');
        return conversation;
    }
    registerConversation(identity, bindingRevision, now) {
        this.assertOpen();
        const canonical = canonicalIdentity(identity);
        const key = conversationKey(canonical);
        integer(bindingRevision);
        integer(now);
        return safe(() => this.transaction(() => {
            const current = this.lookup(key);
            if (current) {
                demand(current.bindingRevision === bindingRevision, 'BINDING_CONFLICT');
                return current;
            }
            this.db.prepare('INSERT INTO conversation_records(conversation_key,identity_json,binding_revision,created_at,updated_at) VALUES(?,?,?,?,?)')
                .run(key, JSON.stringify(canonical), bindingRevision, now, now);
            return this.lookup(key);
        }));
    }
    changeBinding(key, expectedRevision, nextRevision, now) {
        this.assertOpen();
        keyInput(key);
        integer(expectedRevision);
        integer(nextRevision);
        integer(now);
        demand(nextRevision > expectedRevision);
        return safe(() => this.transaction(() => {
            this.requireBinding(key, expectedRevision);
            this.db.prepare('UPDATE conversation_records SET binding_revision=?,updated_at=? WHERE conversation_key=? AND binding_revision=?')
                .run(nextRevision, now, key, expectedRevision);
            return this.requireBinding(key, nextRevision);
        }));
    }
    append(input) {
        this.assertOpen();
        validateEvent(input);
        // Snapshot primitive fields before touching the driver or entering a transaction.
        const event = { ...input };
        return safe(() => this.transaction(() => {
            this.requireBinding(event.conversationKey, event.bindingRevision);
            const existing = this.db.prepare('SELECT * FROM ledger_events WHERE conversation_key=? AND binding_revision=? AND source_event_id=?')
                .get(event.conversationKey, event.bindingRevision, event.sourceEventId);
            if (existing !== undefined) {
                const stored = decodeEvent(existing);
                const fields = ['conversationKey', 'bindingRevision', 'sourceEventId', 'occurredAt', 'eventType', 'reasonCode', 'actorId', 'runId', 'causedBy'];
                demand(fields.every(field => stored[field] === event[field]), 'EVENT_CONFLICT');
                demand(this.bodyFor(stored) === event.body, 'EVENT_CONFLICT');
                return { event: stored, duplicate: true };
            }
            if (event.causedBy !== null) {
                const source = this.db.prepare('SELECT sequence FROM ledger_events WHERE sequence=? AND conversation_key=? AND binding_revision=?')
                    .get(event.causedBy, event.conversationKey, event.bindingRevision);
                demand(source !== undefined, 'SOURCE_NOT_FOUND');
            }
            this.db.prepare(`INSERT INTO ledger_events(conversation_key,binding_revision,source_event_id,occurred_at,event_type,reason_code,actor_id,run_id,caused_by,has_body)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(event.conversationKey, event.bindingRevision, event.sourceEventId, event.occurredAt, event.eventType, event.reasonCode, event.actorId, event.runId, event.causedBy, event.body === null ? 0 : 1);
            const stored = decodeEvent(this.db.prepare('SELECT * FROM ledger_events WHERE sequence=last_insert_rowid()').get());
            if (event.body !== null)
                this.db.prepare('INSERT INTO event_bodies(sequence,body) VALUES(?,?)').run(stored.sequence, event.body);
            return { event: stored, duplicate: false };
        }));
    }
    bodyFor(event) {
        if (event.bodyRef === null)
            return null;
        const result = row(this.db.prepare('SELECT body FROM event_bodies WHERE sequence=?').get(event.bodyRef));
        demand(typeof result.body === 'string', 'STORE_MISMATCH');
        return result.body;
    }
    getConversation(key) {
        this.assertOpen();
        keyInput(key);
        return safe(() => this.lookup(key));
    }
    listConversations(keys, afterKey, limit) {
        this.assertOpen();
        demand(Array.isArray(keys) && keys.length <= LIMITS.grants);
        const selected = [...keys];
        for (const key of selected)
            keyInput(key);
        if (afterKey !== null)
            keyInput(afterKey);
        pageInput(limit);
        if (!selected.length)
            return [];
        return safe(() => this.db.prepare(`SELECT * FROM conversation_records WHERE conversation_key IN (${selected.map(() => '?').join(',')})
      AND (? IS NULL OR conversation_key>?) ORDER BY conversation_key ASC LIMIT ?`)
            .all(...selected, afterKey, afterKey, limit).map(decodeConversation));
    }
    pageEvents(key, bindingRevision, afterSequence, limit) {
        this.assertOpen();
        keyInput(key);
        integer(bindingRevision);
        integer(afterSequence);
        pageInput(limit);
        return safe(() => this.transaction(() => {
            this.requireBinding(key, bindingRevision);
            return this.db.prepare('SELECT * FROM ledger_events WHERE conversation_key=? AND binding_revision=? AND sequence>? ORDER BY sequence ASC LIMIT ?')
                .all(key, bindingRevision, afterSequence, limit).map(decodeEvent);
        }, false));
    }
    readBody(key, bindingRevision, sequence) {
        this.assertOpen();
        keyInput(key);
        integer(bindingRevision);
        integer(sequence, 1);
        return safe(() => this.transaction(() => {
            this.requireBinding(key, bindingRevision);
            const value = this.db.prepare('SELECT * FROM ledger_events WHERE sequence=? AND conversation_key=? AND binding_revision=?')
                .get(sequence, key, bindingRevision);
            return value === undefined ? null : this.bodyFor(decodeEvent(value));
        }, false));
    }
    close() { this.closed = true; }
}
