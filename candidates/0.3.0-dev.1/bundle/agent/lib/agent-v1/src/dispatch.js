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
    constructor(runtime, creation, code, now = Date.now, options = {}) {
        ensure(options.sendTimeoutMs === undefined || Number.isSafeInteger(options.sendTimeoutMs) && options.sendTimeoutMs >= 1 && options.sendTimeoutMs <= 25000);
        this.runtime = runtime;
        this.creation = creation;
        this.code = code;
        this.now = now;
        this.outbox = runtime.outbox;
        this.options = options;
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
        const settled = this.outbox.finish(entry.id, entry.claim, this.now(), result.status, result.receipt);
        this.runtime.recordDelivery(settled);
        if (entry.kind === 'creation') {
            const id = entry.payload.workId;
            const work = this.creation.read(id);
            if (work)
                try {
                    this.creation.recordOutcome(id, work.revision, settled.status === 'unknown' ? 'unknown' : settled.status === 'failed' ? 'failed' : result.visibility ?? 'accepted', result.receipt);
                }
                catch { /* outbox is authoritative; explicit reconciliation repairs projection */ }
        }
        else if (entry.kind === 'code-result' && settled.status === 'confirmed') {
            try {
                this.code.markResultDelivered(entry.payload.taskId, this.now());
            }
            catch { /* retained body can be reconciled; never re-send by another id */ }
        }
        return settled;
    }
}
