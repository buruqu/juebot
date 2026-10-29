import { AgentError, clone, ensure } from "./common.js";
import { DurableOutbox } from "./outbox.js";
import { CreationService } from "./creation.js";
import { CodeTasks } from "./code-jobs.js";
import { BotRuntime } from "./runtime.js";
/** Same namespace as ingress/runtime; a raw QQ number or OpenID is never an account lock. */
export function canonicalAccount(value) {
    let parts;
    try {
        parts = JSON.parse(value);
    }
    catch {
        throw new AgentError('ACCOUNT_UNBOUND');
    }
    ensure(Array.isArray(parts) && parts.length === 3 && ['qq-personal', 'qq-official', 'bilibili', 'local-test'].includes(parts[0])
        && parts.every(p => typeof p === 'string' && p.length > 0 && p.length <= 256) && JSON.stringify(parts) === value, 'ACCOUNT_UNBOUND');
    return value;
}
/** Single common sender. Transport owns actual platform protocol/capabilities; no implicit fallback. */
export class DispatchCoordinator {
    runtime;
    creation;
    code;
    now;
    outbox;
    options;
    interactions = null;
    constructor(runtime, creation, code, now = Date.now, options = {}) {
        ensure(options.sendTimeoutMs === undefined || Number.isSafeInteger(options.sendTimeoutMs) && options.sendTimeoutMs >= 1 && options.sendTimeoutMs <= 25000);
        this.runtime = runtime;
        this.creation = creation;
        this.code = code;
        this.now = now;
        this.outbox = runtime.outbox;
        this.options = options;
    }
    /** Trusted Host owns this binding. A second live broker cannot replace it. */
    registerCodeInteractions(service) {
        ensure(service && typeof service.gate === 'function', 'NOT_CONFIGURED');
        ensure(this.interactions === null, 'CODE_INTERACTIONS_ALREADY_OWNED');
        this.interactions = service;
        return () => { if (this.interactions === service)
            this.interactions = null; };
    }
    account(handle) { const resolved = this.options.resolveAccount ? this.options.resolveAccount(handle) : handle; ensure(resolved, 'ACCOUNT_UNBOUND'); return canonicalAccount(resolved); }
    submitCreation(id, expectedRevision) {
        return this.creation.submit(id, expectedRevision, (tx, snapshot) => {
            const now = this.now();
            const intentId = 'publication:' + snapshot.workId + ':' + snapshot.version;
            return this.outbox.enqueueIn(tx, { id: intentId, account: this.account(snapshot.manifest.accountId), conversation: 'publication:' + snapshot.manifest.accountId,
                kind: 'creation', body: snapshot.manifest.text || snapshot.manifest.title || '作品', payload: snapshot,
                revisions: { binding: snapshot.accountRevision, policy: snapshot.policyRevision, memory: snapshot.policyRevision, expression: snapshot.policyRevision, identity: snapshot.version },
                sourceRefs: snapshot.sources.map(s => ({ id: s.id, revision: s.revision })), createdAt: now, dueAt: now, expiresAt: snapshot.approval.expiresAt, costUnits: 1 });
        });
    }
    enqueueCode(id) {
        const result = this.code.takeResult(id);
        const task = result.task;
        return this.outbox.enqueue({ id: result.id, account: this.account(task.authorization.account), conversation: task.authorization.conversationKey,
            kind: 'code-result', body: result.result || '任务已结束，结果为空。', payload: { taskId: id },
            revisions: { binding: task.authorization.revision, policy: 0, memory: 0, expression: 0, identity: 0 }, sourceRefs: [],
            createdAt: task.updatedAt, dueAt: task.updatedAt, expiresAt: Number.MAX_SAFE_INTEGER, costUnits: 1 });
    }
    gate(item) {
        try {
            ensure(this.options.isActive?.() !== false, 'RUNTIME_CLOSED');
            if (item.kind === 'creation') {
                const snapshot = item.payload;
                this.creation.validateSubmission(snapshot, item.id);
                ensure(this.account(snapshot.manifest.accountId) === item.account, 'ACCOUNT_BINDING_CHANGED');
            }
            else if (item.kind === 'code-result') {
                const result = this.code.takeResult(item.payload.taskId);
                ensure(result.id === item.id && (result.result || '任务已结束，结果为空。') === item.body
                    && this.account(result.task.authorization.account) === item.account && result.task.authorization.conversationKey === item.conversation, 'CODE_RESULT_CHANGED');
            }
            else if (item.kind === 'code-interaction') {
                ensure(this.interactions, 'CODE_INTERACTIONS_UNAVAILABLE');
                return this.interactions.gate(clone(item));
            }
            else
                return this.runtime.sendGate(item);
            return { allowed: true, reason: 'NONE' };
        }
        catch (error) {
            return { allowed: false, reason: error instanceof AgentError ? error.code : 'SEND_RECHECK_FAILED' };
        }
    }
    async dispatch(account, owner, budget, send) {
        canonicalAccount(account);
        const entry = this.outbox.claim(account, owner, this.now(), 30000, budget, item => this.gate(item));
        if (!entry)
            return null;
        // Synchronous asset/authority checks can take time or revoke a binding. Recheck the actual lease after them.
        const gate = this.gate(entry);
        const state = this.outbox.state();
        const current = this.outbox.list().find(item => item.id === entry.id);
        const now = this.now();
        if (!current || current.status !== 'sending' || current.claim !== entry.claim)
            return current ?? null;
        if (!gate.allowed || state.paused || state.pausedAccounts.includes(account) || current.leaseUntil <= now || entry.expiresAt <= now) {
            return this.outbox.releaseUnsent(entry.id, entry.claim, now, !gate.allowed ? gate.reason : 'SEND_WINDOW_CLOSED');
        }
        // No await between the final gate/lease check and the selected transport.
        let result;
        const controller = new AbortController();
        let timer;
        const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'unknown', receipt: null }); }, this.options.sendTimeoutMs ?? 25000); });
        try {
            result = await Promise.race([send(clone(entry), controller.signal), deadline]);
        }
        catch {
            result = { status: 'unknown', receipt: null };
        }
        finally {
            clearTimeout(timer);
        }
        const settled = this.outbox.finish(entry.id, entry.claim, this.now(), result.status, result.receipt, 'spent', (tx, item) => this.synchronizeOutcome(tx, item, result.visibility));
        this.runtime.recordDelivery(settled);
        return settled;
    }
    /** Commit Outbox accounting and all required domain projections in the same transaction. Never sends. */
    reconcile(id, outcome, receipt, notSubmitted, expectedRevision, visibility) {
        const result = this.outbox.reconcile(id, outcome, receipt, notSubmitted ? 'not-submitted' : 'spent', expectedRevision, (tx, item) => this.synchronizeOutcome(tx, item, visibility));
        // Audit is secondary to the committed delivery fact; failure cannot reopen or resend it.
        try {
            this.runtime.recordDelivery(result);
        }
        catch { /* Committed Outbox/domain outcome remains authoritative. */ }
        return result;
    }
    synchronizeOutcome(tx, entry, visibility) {
        ensure(['confirmed', 'failed', 'unknown'].includes(entry.status), 'INVALID_STATE');
        const settled = entry;
        if (entry.kind === 'creation') {
            const id = entry.payload.workId;
            const work = this.creation.read(id);
            ensure(work?.value.submission?.intentId === entry.id, 'CREATION_SUBMISSION_STALE');
            this.creation.recordOutcomeIn(tx, id, work.revision, settled.status === 'unknown' ? 'unknown' : settled.status === 'failed' ? 'failed' : visibility ?? 'accepted', settled.receipt);
        }
        else if (entry.kind === 'code-result' && settled.status === 'confirmed') {
            this.code.markResultDeliveredIn(tx, entry.payload.taskId, this.now(), entry);
        }
    }
}
