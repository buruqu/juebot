import { AgentError, clone, ensure, integer, stable, text } from "./common.js";
import { canonicalIdentity, conversationKey } from "../../conversation-v1/src/identity.js";
function shape(value, keys) {
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
    for (const key of Reflect.ownKeys(value)) {
        ensure(typeof key === 'string' && keys.includes(key));
        ensure('value' in Object.getOwnPropertyDescriptor(value, key));
    }
}
function boundedBody(value, maximum) {
    ensure(typeof value === 'string' && value.length <= maximum && !/[\u0000\uD800-\uDFFF]/u.test(value));
}
function same(a, b) { return stable(a) === stable(b); }
/** Persistent Code domain. This service owns no shell, model, network or filesystem. */
export class CodeTasks {
    store;
    getAuthorization;
    key;
    recoveryRequired;
    executions = new Map();
    constructor(store, options) {
        shape(options, ['getAuthorization', 'namespace']);
        ensure(typeof options.getAuthorization === 'function');
        if (options.namespace !== undefined)
            text(options.namespace);
        this.store = store;
        this.getAuthorization = options.getAuthorization;
        this.key = JSON.stringify(['code-jobs-v1', options.namespace ?? 'default']);
        this.recoveryRequired = store.read(this.key) !== null;
    }
    read() {
        return clone(this.store.read(this.key) ?? { revision: 0, value: { enabled: false, authorization: null, nextId: 1, tasks: {} } });
    }
    snapshot() { return this.read(); }
    change(work) {
        return this.store.atomic(tx => {
            const current = clone(tx.read(this.key) ?? { revision: 0, value: { enabled: false, authorization: null, nextId: 1, tasks: {} } });
            const result = work(current.value);
            // Reserve worst-case JSON-escaped result space BEFORE admitting work, so
            // ordinary completion cannot hit the store cap after a task has executed.
            const pending = Object.values(current.value.tasks).filter(task => task.result === null).length;
            ensure(stable(current.value).length + pending * 200000 <= 7 * 1024 * 1024, 'CODE_CAPACITY');
            tx.write(this.key, current.revision, current.value);
            return clone(result);
        });
    }
    authorization() {
        let value;
        try {
            value = this.getAuthorization();
        }
        catch {
            throw new AgentError('CODE_AUTH_UNAVAILABLE');
        }
        ensure(value, 'CODE_NOT_AUTHORIZED');
        shape(value, ['revision', 'adminActor', 'conversationKey', 'account', 'workspaceId', 'sessionId', 'modelConfigured', 'budgetAvailable', 'sandboxVerified', 'toolsRestricted', 'allowedTools', 'verified']);
        integer(value.revision);
        for (const key of ['adminActor', 'account', 'workspaceId', 'sessionId'])
            text(value[key]);
        text(value.conversationKey, 4096);
        for (const key of ['modelConfigured', 'budgetAvailable', 'sandboxVerified', 'toolsRestricted', 'verified'])
            ensure(typeof value[key] === 'boolean');
        ensure(value.verified, 'CODE_NOT_AUTHORIZED');
        ensure(value.modelConfigured && value.budgetAvailable && value.sandboxVerified && value.toolsRestricted, 'CODE_PREREQUISITES_MISSING');
        ensure(Array.isArray(value.allowedTools) && value.allowedTools.length <= 128 && new Set(value.allowedTools).size === value.allowedTools.length);
        for (const tool of value.allowedTools)
            text(tool);
        try {
            const tuple = JSON.parse(value.conversationKey);
            ensure(Array.isArray(tuple) && tuple.length === 8 && tuple[0] === 'juebot-conversation-v1');
            const identity = canonicalIdentity({ botId: tuple[1], personaId: tuple[2], connector: tuple[3], issuer: tuple[4], accountId: tuple[5], kind: tuple[6], remoteId: tuple[7] });
            ensure(identity.kind === 'direct' && identity.accountId === value.account && conversationKey(identity) === value.conversationKey, 'CODE_PRIVATE_ROUTE_REQUIRED');
        }
        catch (error) {
            if (error instanceof AgentError)
                throw error;
            throw new AgentError('CODE_PRIVATE_ROUTE_REQUIRED');
        }
        return clone(value);
    }
    ready() { ensure(!this.recoveryRequired, 'CODE_RECOVERY_REQUIRED'); }
    task(state, id) { text(id); ensure(Object.hasOwn(state.tasks, id), 'CODE_TASK_NOT_FOUND'); return state.tasks[id]; }
    get(id) { return clone(this.task(this.read().value, id)); }
    list() { return Object.values(this.read().value.tasks).map(clone); }
    /** Trusted Host recovery composes this with session retirement in one transaction.
     * It never requeues the original request or changes its recipient/workspace. */
    abandonIn(tx, id, options) {
        this.ready();
        shape(options, ['expectedRevision', 'reviewer', 'reason', 'now']);
        options = clone(options);
        integer(options.expectedRevision, 1);
        integer(options.now);
        text(options.reviewer);
        text(options.reason, 512);
        ensure(this.executions.size === 0, 'CODE_EXECUTION_ACTIVE');
        const authorization = this.authorization();
        const current = tx.read(this.key);
        ensure(current && current.revision === options.expectedRevision, 'CONFLICT');
        ensure(!current.value.enabled, 'CODE_RECOVERY_REQUIRES_OFF');
        const state = clone(current.value);
        const task = this.task(state, id);
        ensure(['held', 'needs-review', 'stopped'].includes(task.state) && task.result === null
            && task.resultDelivery === 'none' && !task.recovery, 'CODE_RECOVERY_NOT_ALLOWED');
        ensure(same(task.authorization, authorization), 'CODE_AUTH_CHANGED');
        ensure(options.now >= task.updatedAt, 'INVALID_INPUT');
        task.state = 'stopped';
        task.updatedAt = options.now;
        task.reason = 'RECOVERY_ABANDONED';
        task.recovery = { reviewer: options.reviewer, reason: options.reason, at: options.now };
        // A synchronous Host callback may have revoked the grant while resolving it.
        ensure(same(this.authorization(), authorization), 'CODE_AUTH_CHANGED');
        tx.write(this.key, current.revision, state);
        return clone(task);
    }
    enable(now) {
        this.ready();
        integer(now);
        const authorization = this.authorization();
        const existing = this.read();
        // Repeated commands are no-ops only after revalidating the live grant.
        // A changed grant must still update the binding and hold stale queued work.
        if (existing.value.enabled && same(existing.value.authorization, authorization))
            return existing;
        this.change(state => {
            state.enabled = true;
            state.authorization = authorization;
            for (const task of Object.values(state.tasks))
                if (task.state === 'queued' && !same(task.authorization, authorization)) {
                    task.state = 'held';
                    task.reason = 'AUTH_CHANGED';
                    task.updatedAt = now;
                }
        });
        return this.read();
    }
    disable(now) {
        integer(now);
        const existing = this.read();
        if (!existing.value.enabled)
            return existing;
        this.change(state => {
            state.enabled = false;
            for (const task of Object.values(state.tasks))
                if (task.state === 'queued') {
                    task.state = 'held';
                    task.reason = 'CODE_OFF';
                    task.updatedAt = now;
                }
        });
        // OFF deliberately does not abort currently running executors.
        return this.read();
    }
    admit(input, now) {
        this.ready();
        integer(now);
        shape(input, ['eventId', 'actor', 'conversationKey', 'account', 'plain', 'text']);
        for (const key of ['eventId', 'actor', 'account'])
            text(input[key]);
        text(input.conversationKey, 4096);
        boundedBody(input.text, 16000);
        ensure(input.text.trim().length > 0 && input.plain === true, 'CODE_PLAIN_INPUT_REQUIRED');
        const authorization = this.authorization();
        ensure(input.actor === authorization.adminActor && input.account === authorization.account
            && input.conversationKey === authorization.conversationKey, 'CODE_ADMIN_ROUTE_REQUIRED');
        const captured = clone(input);
        return this.change(state => {
            const existing = Object.values(state.tasks).find(task => task.input.eventId === captured.eventId
                && task.input.account === captured.account && task.input.conversationKey === captured.conversationKey);
            if (existing) {
                ensure(same(existing.input, captured), 'CODE_EVENT_CONFLICT');
                return { task: existing, duplicate: true };
            }
            ensure(state.enabled, 'CODE_DISABLED');
            ensure(same(state.authorization, authorization), 'CODE_AUTH_CHANGED');
            ensure(Object.keys(state.tasks).length < 64, 'CODE_CAPACITY');
            integer(state.nextId, 1, Number.MAX_SAFE_INTEGER - 1);
            const id = `code-${state.nextId++}`;
            const task = { id, input: captured, authorization, createdAt: now, updatedAt: now, state: 'queued',
                result: null, resultDelivery: 'none', reason: 'ADMITTED' };
            state.tasks[id] = task;
            return { task, duplicate: false };
        });
    }
    start(id, now) {
        this.ready();
        integer(now);
        const authorization = this.authorization();
        return this.change(state => {
            const task = this.task(state, id);
            ensure(state.enabled, 'CODE_DISABLED');
            ensure(task.state === 'queued', 'CODE_TASK_NOT_QUEUED');
            ensure(same(task.authorization, authorization) && same(state.authorization, authorization), 'CODE_AUTH_CHANGED');
            task.state = 'running';
            task.updatedAt = now;
            task.reason = 'STARTED';
            return task;
        });
    }
    finish(id, result, now) {
        integer(now);
        boundedBody(result, 32768);
        let authorization = null;
        try {
            authorization = this.authorization();
        }
        catch { /* retain result even after revocation or depleted budget */ }
        return this.change(state => {
            const task = this.task(state, id);
            if (task.result !== null) {
                ensure(task.result === result, 'CODE_RESULT_CONFLICT');
                return task;
            }
            ensure(['running', 'needs-review', 'stopped'].includes(task.state), 'CODE_TASK_NOT_RUNNING');
            const deliverable = task.state === 'running' && !this.recoveryRequired && authorization !== null && same(task.authorization, authorization);
            if (task.state === 'running')
                task.state = 'completed';
            task.result = result;
            task.resultDelivery = deliverable ? 'ready' : 'held';
            task.updatedAt = now;
            task.reason = deliverable ? 'RESULT_READY' : 'RESULT_REQUIRES_REVIEW';
            return task;
        });
    }
    /** Root may hand this result to its unique Outbox. No social learning is performed. */
    takeResult(id) {
        this.ready();
        const authorization = this.authorization();
        const task = this.get(id);
        ensure(task.result !== null, 'CODE_RESULT_NOT_READY');
        ensure(task.resultDelivery === 'ready', 'CODE_RESULT_HELD');
        ensure(same(task.authorization, authorization), 'CODE_AUTH_CHANGED');
        return { id: `${id}:result`, task, result: task.result };
    }
    markResultDelivered(id, now) {
        const result = this.takeResult(id);
        integer(now);
        return this.change(state => {
            const task = this.task(state, id);
            ensure(same(task, result.task), 'CODE_RESULT_CHANGED');
            task.resultDelivery = 'delivered';
            task.updatedAt = now;
            return task;
        });
    }
    /** Record an already-sent fact, including after restart/revocation. This cannot authorize a new send. */
    markResultDeliveredIn(tx, id, now, delivery) {
        integer(now);
        const current = tx.read(this.key);
        ensure(current, 'CODE_TASK_NOT_FOUND');
        const state = clone(current.value);
        const task = this.task(state, id);
        ensure(delivery.status === 'confirmed' && delivery.kind === 'code-result' && delivery.id === `${id}:result`
            && delivery.payload?.taskId === id && task.result !== null
            && (task.result || '任务已结束，结果为空。') === delivery.body
            && task.authorization.conversationKey === delivery.conversation, 'CODE_RESULT_CHANGED');
        // The canonical account records the originally authorized account; do not consult today's grant.
        let route;
        try {
            route = JSON.parse(task.authorization.conversationKey);
        }
        catch {
            throw new AgentError('CODE_RESULT_CHANGED');
        }
        ensure(Array.isArray(route) && route.length === 8 && delivery.account === JSON.stringify(route.slice(3, 6))
            && route[5] === task.authorization.account, 'CODE_RESULT_CHANGED');
        if (task.resultDelivery === 'delivered')
            return task;
        ensure(['ready', 'held'].includes(task.resultDelivery), 'CODE_RESULT_CHANGED');
        task.resultDelivery = 'delivered';
        task.updatedAt = now;
        tx.write(this.key, current.revision, state);
        return clone(task);
    }
    /** Explicit Host review after restart/revocation; never changes the private recipient or workspace. */
    releaseResult(id, now) {
        this.ready();
        integer(now);
        const authorization = this.authorization();
        return this.change(state => {
            const task = this.task(state, id);
            ensure(task.result !== null && task.resultDelivery === 'held', 'CODE_RESULT_NOT_HELD');
            ensure(task.input.actor === authorization.adminActor && task.input.account === authorization.account
                && task.input.conversationKey === authorization.conversationKey
                && task.authorization.workspaceId === authorization.workspaceId && task.authorization.sessionId === authorization.sessionId, 'CODE_ADMIN_ROUTE_REQUIRED');
            task.authorization = authorization;
            task.resultDelivery = 'ready';
            task.updatedAt = now;
            task.reason = 'RESULT_REVIEWED';
            return task;
        });
    }
    stop(id, now) {
        integer(now);
        const task = this.change(state => {
            const task = this.task(state, id);
            task.state = 'stopped';
            task.updatedAt = now;
            task.reason = 'EXPLICIT_STOP';
            if (task.resultDelivery === 'ready')
                task.resultDelivery = 'held';
            return task;
        });
        this.executions.get(id)?.abort(new AgentError('CODE_STOPPED'));
        return task;
    }
    restart(now) {
        integer(now);
        this.change(state => {
            state.enabled = false;
            for (const task of Object.values(state.tasks)) {
                if (task.state === 'running') {
                    task.state = 'needs-review';
                    task.reason = 'RESTART_REVIEW';
                    task.updatedAt = now;
                }
                else if (task.state === 'queued') {
                    task.state = 'held';
                    task.reason = 'RESTART_HELD';
                    task.updatedAt = now;
                }
                if (task.resultDelivery === 'ready')
                    task.resultDelivery = 'held';
            }
        });
        for (const execution of this.executions.values())
            execution.abort(new AgentError('CODE_RESTARTED'));
        this.recoveryRequired = false;
        return this.read();
    }
    resume(id, strategy, now) {
        this.ready();
        integer(now);
        ensure(strategy === 'requeue' || strategy === 'keep-held', 'CODE_RECOVERY_STRATEGY_REQUIRED');
        const authorization = this.authorization();
        return this.change(state => {
            const task = this.task(state, id);
            ensure(task.state === 'held' || task.state === 'needs-review', 'CODE_TASK_NOT_HELD');
            ensure(task.result === null, 'CODE_RESULT_ALREADY_EXISTS');
            if (strategy === 'requeue') {
                ensure(state.enabled && same(state.authorization, authorization), 'CODE_DISABLED');
                ensure(task.input.actor === authorization.adminActor && task.input.account === authorization.account
                    && task.input.conversationKey === authorization.conversationKey, 'CODE_ADMIN_ROUTE_REQUIRED');
                task.authorization = authorization;
                task.state = 'queued';
                task.reason = 'EXPLICIT_REQUEUE';
            }
            else {
                task.state = 'held';
                task.reason = 'EXPLICIT_HELD';
            }
            task.updatedAt = now;
            return task;
        });
    }
    async execute(id, executor, options = {}) {
        this.ready();
        ensure(typeof executor === 'function', 'NOT_CONFIGURED');
        const now = options.now ?? (() => Date.now());
        integer(now());
        options.signal?.throwIfAborted();
        ensure(!this.executions.has(id), 'CODE_EXECUTION_ACTIVE');
        const task = this.start(id, now());
        const controller = new AbortController();
        this.executions.set(id, controller);
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted)
            abort();
        const gateModel = () => {
            controller.signal.throwIfAborted();
            this.ready();
            const current = this.get(id);
            ensure(current.state === 'running', 'CODE_TASK_NOT_RUNNING');
            ensure(same(current.authorization, this.authorization()), 'CODE_AUTH_CHANGED');
        };
        const gateTool = (tool) => {
            text(tool);
            gateModel();
            const authorization = this.authorization();
            ensure(same(this.get(id).authorization, authorization), 'CODE_AUTH_CHANGED');
            ensure(authorization.allowedTools.includes(tool), 'CODE_TOOL_NOT_ALLOWED');
        };
        try {
            gateModel();
            const result = await executor({ task: clone(task), signal: controller.signal, gateTool, gateModel });
            return this.finish(id, result, now());
        }
        catch (error) {
            // Only these public bridge states are persisted. Raw SDK errors, prompts,
            // tool arguments and reasoning never become task/log text.
            const bridgeReasons = ['DSH_CODE_NEEDS_APPROVAL', 'DSH_CODE_NEEDS_INPUT', 'DSH_CODE_TIMEOUT', 'DSH_CODE_ABORTED', 'DSH_CODE_CLEANUP_PENDING'];
            const reported = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            const bridgeReason = typeof reported === 'string' && bridgeReasons.includes(reported) ? reported : null;
            this.change(state => {
                const current = this.task(state, id);
                if (current.state === 'running') {
                    current.state = 'needs-review';
                    current.reason = controller.signal.aborted ? 'EXECUTION_ABORTED' : bridgeReason ?? 'EXECUTION_FAILED';
                    current.updatedAt = now();
                }
            });
            if (error instanceof AgentError)
                throw error;
            if (bridgeReason)
                throw new AgentError(bridgeReason);
            throw new AgentError(controller.signal.aborted ? 'CODE_ABORTED' : 'CODE_EXECUTION_FAILED');
        }
        finally {
            options.signal?.removeEventListener('abort', abort);
            this.executions.delete(id);
        }
    }
}
