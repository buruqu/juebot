import { createHash } from 'node:crypto';
import { clone, ensure, integer, stable, text } from "./common.js";
export const DELIVERY_RECEIPT_MAX = 1024;
const archiveHash = (value) => createHash('sha256').update(stable(value)).digest('hex');
function archiveShape(value, keys) {
    ensure(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
    for (const key of Reflect.ownKeys(value))
        ensure(typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key));
}
function freezeProof(value) { if (value && typeof value === 'object') {
    for (const item of Object.values(value))
        freezeProof(item);
    Object.freeze(value);
} return value; }
const KEY = 'outbox:v1';
const ARCHIVES = 'outbox:archives:v1';
const empty = () => ({ serial: 0, paused: true, pausedAccounts: [], items: [], budgets: [] });
export class DurableOutbox {
    store;
    constructor(store) { this.store = store; }
    list() { return this.store.read(KEY)?.value.items ?? []; }
    archiveKey(id) { return JSON.stringify(['outbox-delivery-archive-v1', id]); }
    cold(id, read = this.store.read.bind(this.store)) {
        const metadata = read(ARCHIVES)?.value.find(item => item.id === id);
        const record = read(this.archiveKey(id));
        if (!metadata && !record)
            return null;
        ensure(metadata, 'ARCHIVE_CORRUPT');
        ensure(record && record.revision === 1 && stable(record.value.metadata) === stable(metadata)
            && record.value.delivery.id === id && archiveHash(record.value.delivery) === metadata.hash
            && archiveHash({ delivery: record.value.delivery, audit: record.value.audit }) === metadata.recordHash, 'ARCHIVE_CORRUPT');
        return clone(record.value);
    }
    get(id) { text(id); const hot = this.list().find(item => item.id === id); if (hot)
        return clone(hot); const cold = this.cold(id); ensure(cold, 'NOT_FOUND'); return cold.delivery; }
    readArchive(id) { text(id); const record = this.cold(id); ensure(record, 'ARCHIVE_NOT_FOUND'); return record; }
    listArchives(options = {}) {
        archiveShape(options, ['offset', 'limit']);
        const offset = options.offset ?? 0, limit = options.limit ?? 100;
        integer(offset, 0, 4096);
        integer(limit, 1, 100);
        return clone((this.store.read(ARCHIVES)?.value ?? []).slice(offset, offset + limit));
    }
    inspectArchive(ids) {
        ensure(Array.isArray(ids) && ids.length > 0 && ids.length <= 64 && new Set(ids).size === ids.length);
        const current = this.store.read(KEY);
        ensure(current, 'NOT_FOUND');
        return { revision: current.revision, items: ids.map(id => {
                text(id);
                const item = current.value.items.find(item => item.id === id);
                ensure(item, 'NOT_FOUND');
                return { id, hash: archiveHash(item), status: item.status, sequence: item.sequence, at: item.createdAt };
            }) };
    }
    archive(ids, options) { return this.store.atomic(tx => this.archiveIn(tx, ids, options)); }
    archiveIn(tx, ids, options) {
        archiveShape(options, ['expectedRevision', 'reviewer', 'reason', 'now', 'authorize']);
        const authorize = options.authorize;
        const captured = clone({ expectedRevision: options.expectedRevision, reviewer: options.reviewer, reason: options.reason, now: options.now });
        integer(captured.expectedRevision, 1);
        integer(captured.now);
        text(captured.reviewer);
        text(captured.reason, 512);
        ensure(captured.reviewer.trim() && captured.reason.trim() && typeof authorize === 'function');
        ensure(Array.isArray(ids) && ids.length > 0 && ids.length <= 64 && new Set(ids).size === ids.length);
        ids = clone(ids);
        ids.forEach(id => text(id));
        const current = tx.read(KEY);
        ensure(current?.revision === captured.expectedRevision, 'CONFLICT');
        ensure(current.value.paused, 'ARCHIVE_REQUIRES_PAUSE');
        const index = tx.read(ARCHIVES);
        ensure((index?.value.length ?? 0) + ids.length <= 4096, 'ARCHIVE_CAPACITY');
        const items = ids.map(id => { const item = current.value.items.find(item => item.id === id); ensure(item, 'NOT_FOUND'); return clone(item); });
        for (const item of items) {
            ensure(['confirmed', 'failed', 'cancelled'].includes(item.status) && item.claim === null && item.leaseUntil === null, 'ARCHIVE_NOT_TERMINAL');
            ensure(captured.now >= item.createdAt && tx.read(this.archiveKey(item.id)) === null
                && !index?.value.some(metadata => metadata.id === item.id), 'ARCHIVE_CONFLICT');
        }
        const fingerprint = stable([current, index]);
        const proof = freezeProof({ domain: 'outbox', revision: current.revision, ids: clone(ids), hashes: items.map(archiveHash), items: clone(items),
            reviewer: captured.reviewer, reason: captured.reason, at: captured.now });
        const authorized = () => { const result = authorize(proof); if (result && typeof result.then === 'function')
            Promise.resolve(result).catch(() => { }); ensure(result === true, 'ARCHIVE_NOT_AUTHORIZED'); };
        authorized();
        authorized();
        ensure(stable([tx.read(KEY), tx.read(ARCHIVES)]) === fingerprint, 'CONFLICT');
        const state = clone(current.value);
        const metadata = [];
        for (const delivery of items) {
            ensure(tx.read(this.archiveKey(delivery.id)) === null, 'ARCHIVE_CONFLICT');
            const audit = { reviewer: captured.reviewer, reason: captured.reason, at: captured.now };
            const item = { id: delivery.id, hash: archiveHash(delivery), recordHash: archiveHash({ delivery, audit }), status: delivery.status, sequence: delivery.sequence, at: captured.now };
            tx.write(this.archiveKey(delivery.id), 0, { delivery, metadata: item, audit });
            metadata.push(item);
        }
        state.items = state.items.filter(item => !ids.includes(item.id));
        tx.write(ARCHIVES, index?.revision ?? 0, [...(index?.value ?? []), ...metadata]);
        tx.write(KEY, current.revision, state);
        return clone(metadata);
    }
    state() {
        const s = this.store.read(KEY);
        return { revision: s?.revision ?? 0, paused: s?.value.paused ?? true, pausedAccounts: s?.value.pausedAccounts ?? [] };
    }
    setPause(expectedRevision, paused, accounts = []) {
        ensure(typeof paused === 'boolean' && Array.isArray(accounts) && accounts.length <= 128);
        accounts.forEach(a => text(a, 4096));
        this.store.atomic(tx => {
            const s = tx.read(KEY);
            ensure((s?.revision ?? 0) === expectedRevision, 'CONFLICT');
            const value = s?.value ?? empty();
            value.paused = paused;
            value.pausedAccounts = [...new Set(accounts)];
            tx.write(KEY, expectedRevision, value);
        });
    }
    enqueue(input) { return this.store.atomic(tx => this.enqueueIn(tx, input)); }
    /** For creation approval consumption and enqueue to commit in one transaction. */
    enqueueIn(tx, input) {
        text(input.id);
        text(input.account, 4096);
        text(input.conversation, 4096);
        text(input.body, 16000);
        ensure(['social', 'repetition', 'code-result', 'code-interaction', 'creation'].includes(input.kind));
        for (const value of Object.values(input.revisions))
            integer(value);
        ensure(Object.keys(input.revisions).sort().join(',') === 'binding,expression,identity,memory,policy');
        integer(input.createdAt);
        integer(input.dueAt, input.createdAt);
        integer(input.expiresAt, input.createdAt + 1);
        integer(input.costUnits, 0, 100000000);
        ensure(Array.isArray(input.sourceRefs) && input.sourceRefs.length <= 128);
        input.sourceRefs.forEach(r => { text(r.id, 4096); integer(r.revision); });
        stable(input.payload);
        const snapshot = tx.read(KEY);
        const value = snapshot?.value ?? empty();
        const existing = value.items.find(item => item.id === input.id) ?? this.cold(input.id, tx.read)?.delivery;
        if (existing) {
            const { sequence, status, reason, claim, leaseUntil, receipt, charged, budgetWindow, ...original } = existing;
            void sequence;
            void status;
            void reason;
            void claim;
            void leaseUntil;
            void receipt;
            void charged;
            void budgetWindow;
            ensure(stable(original) === stable(input), 'EVENT_CONFLICT');
            return existing.id;
        }
        ensure(value.items.length < 2000, 'CAPACITY');
        integer(value.serial, 0, Number.MAX_SAFE_INTEGER - 1);
        value.items.push({ ...clone(input), sequence: ++value.serial, status: 'queued', reason: 'NONE', claim: null,
            leaseUntil: null, receipt: null, charged: false, budgetWindow: null });
        tx.write(KEY, snapshot?.revision ?? 0, value);
        return input.id;
    }
    claim(account, owner, now, leaseMs, budget, gate) {
        text(account, 4096);
        text(owner);
        integer(now);
        integer(leaseMs, 1, 300000);
        if (budget) {
            text(budget.id);
            integer(budget.limit, 0, 1000000000);
        }
        return this.store.atomic(tx => {
            const snapshot = tx.read(KEY);
            if (!snapshot)
                return null;
            const value = snapshot.value;
            let changed = false;
            for (const item of value.items)
                if (item.status === 'sending' && item.leaseUntil <= now) {
                    item.status = 'unknown';
                    item.reason = 'LEASE_EXPIRED';
                    changed = true;
                }
            const persist = () => { if (changed)
                tx.write(KEY, snapshot.revision, value); };
            if (value.paused || value.pausedAccounts.includes(account) || !budget
                || value.items.some(item => item.account === account && ['sending', 'unknown'].includes(item.status))) {
                persist();
                return null;
            }
            // Copy-paste and Code results bypass artificial typing deadlines, but never an in-flight real send.
            const candidates = value.items.filter(item => item.account === account && item.status === 'queued')
                .sort((a, b) => a.dueAt - b.dueAt || a.sequence - b.sequence);
            for (const item of candidates) {
                if (item.expiresAt <= now) {
                    item.status = item.kind === 'code-result' ? 'held' : 'cancelled';
                    item.reason = 'EXPIRED';
                    changed = true;
                    continue;
                }
                if (item.dueAt > now)
                    continue;
                if (item.kind === 'social' && value.items.some(other => other.conversation === item.conversation
                    && other.kind === 'social' && other.sequence < item.sequence && ['queued', 'held'].includes(other.status)))
                    continue;
                const check = gate(clone(item));
                ensure(typeof check.allowed === 'boolean');
                text(check.reason);
                if (!check.allowed) {
                    item.status = item.kind === 'code-result' ? 'held' : 'cancelled';
                    item.reason = check.reason;
                    changed = true;
                    continue;
                }
                let window = value.budgets.find(b => b.window === budget.id);
                if (!window) {
                    ensure(value.budgets.length < 400, 'CAPACITY');
                    window = { window: budget.id, spent: 0, reserved: 0 };
                    value.budgets.push(window);
                }
                if (window.spent + window.reserved + item.costUnits > budget.limit) {
                    persist();
                    return null;
                }
                window.reserved += item.costUnits;
                item.budgetWindow = budget.id;
                item.status = 'sending';
                item.claim = `${owner}:${snapshot.revision + 1}:${item.sequence}`;
                item.leaseUntil = now + leaseMs;
                integer(item.leaseUntil);
                item.reason = 'NONE';
                changed = true;
                persist();
                return clone(item);
            }
            persist();
            return null;
        });
    }
    finish(id, claim, now, outcome, receipt, accounting = 'spent', project) {
        text(id);
        text(claim);
        integer(now);
        ensure(['confirmed', 'failed', 'unknown'].includes(outcome));
        if (receipt !== null)
            text(receipt, DELIVERY_RECEIPT_MAX);
        ensure(outcome !== 'confirmed' || receipt !== null, 'RECEIPT_REQUIRED');
        ensure(accounting === 'spent' || (accounting === 'not-submitted' && outcome === 'failed' && receipt !== null), 'SUBMISSION_PROOF_REQUIRED');
        return this.store.atomic(tx => {
            const snapshot = tx.read(KEY);
            ensure(snapshot, 'NOT_FOUND');
            const item = snapshot.value.items.find(i => i.id === id);
            ensure(item, 'NOT_FOUND');
            ensure(item.status === 'sending' && item.claim === claim, 'STALE_CLAIM');
            if (item.leaseUntil <= now) {
                item.status = 'unknown';
                item.reason = 'LEASE_EXPIRED';
            }
            else {
                item.status = outcome;
                item.receipt = receipt;
                item.reason = outcome === 'unknown' ? 'DELIVERY_UNCERTAIN' : 'NONE';
            }
            if (item.status === 'confirmed' || item.status === 'failed')
                this.settle(snapshot.value, item, accounting !== 'not-submitted');
            tx.write(KEY, snapshot.revision, snapshot.value);
            this.project(tx, item, project);
            return clone(item);
        });
    }
    /** Trusted operator/platform reconciliation with an external evidence id; never automatically retries unknown. */
    releaseUnsent(id, claim, now, reason) {
        text(id);
        text(claim);
        integer(now);
        text(reason);
        return this.store.atomic(tx => {
            const s = tx.read(KEY);
            ensure(s, 'NOT_FOUND');
            const item = s.value.items.find(i => i.id === id);
            ensure(item?.status === 'sending' && item.claim === claim, 'STALE_CLAIM');
            // An expired ownership lease is uncertain, even if this caller did not submit.
            if (item.leaseUntil <= now) {
                item.status = 'unknown';
                item.reason = 'LEASE_EXPIRED';
            }
            else {
                item.status = item.kind === 'code-result' ? 'held' : 'cancelled';
                item.reason = reason;
                this.settle(s.value, item, false);
            }
            tx.write(KEY, s.revision, s.value);
            return clone(item);
        });
    }
    /** Trusted operator/platform reconciliation with an external evidence id; never automatically retries unknown. */
    reconcile(id, outcome, proof, accounting = 'spent', expectedRevision, project) {
        text(proof, DELIVERY_RECEIPT_MAX);
        ensure(outcome === 'confirmed' || outcome === 'failed');
        ensure(accounting === 'spent' || (accounting === 'not-submitted' && outcome === 'failed'));
        return this.store.atomic(tx => {
            const snapshot = tx.read(KEY);
            ensure(snapshot, 'NOT_FOUND');
            ensure(expectedRevision === undefined || snapshot.revision === expectedRevision, 'CONFLICT');
            const item = snapshot.value.items.find(i => i.id === id);
            ensure(item?.status === 'unknown', 'INVALID_STATE');
            item.status = outcome;
            item.receipt = proof;
            item.reason = 'RECONCILED';
            this.settle(snapshot.value, item, accounting !== 'not-submitted');
            tx.write(KEY, snapshot.revision, snapshot.value);
            this.project(tx, item, project);
            return clone(item);
        });
    }
    project(tx, item, project) {
        const result = project?.(tx, clone(item));
        ensure(!result || typeof result.then !== 'function', 'ASYNC_TRANSACTION');
    }
    settle(value, item, spent) {
        const budget = value.budgets.find(b => b.window === item.budgetWindow);
        ensure(budget && budget.reserved >= item.costUnits, 'STORE_MISMATCH');
        budget.reserved -= item.costUnits;
        if (spent)
            budget.spent += item.costUnits;
        item.charged = spent;
        // Settled terminal outcomes no longer own a live sending lease. Unknown
        // outcomes never enter settle(), so their account locks remain intact.
        item.claim = null;
        item.leaseUntil = null;
    }
    cancel(id) {
        this.store.atomic(tx => {
            const s = tx.read(KEY);
            ensure(s, 'NOT_FOUND');
            const item = s.value.items.find(i => i.id === id);
            ensure(item && item.kind !== 'code-result' && ['queued', 'held'].includes(item.status), 'INVALID_STATE');
            item.status = 'cancelled';
            item.reason = 'CANCELLED';
            tx.write(KEY, s.revision, s.value);
        });
    }
    recover() {
        this.store.atomic(tx => {
            const s = tx.read(KEY);
            if (!s)
                return;
            s.value.paused = true;
            for (const item of s.value.items) {
                if (item.status === 'sending') {
                    item.status = 'unknown';
                    item.reason = 'RESTART_UNCERTAIN';
                }
                if (item.status === 'queued' && item.kind !== 'code-result' && item.kind !== 'creation') {
                    item.status = 'cancelled';
                    item.reason = 'RESTART_NO_REPLAY';
                }
            }
            tx.write(KEY, s.revision, s.value);
        });
    }
}
