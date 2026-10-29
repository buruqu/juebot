import { createHash } from 'node:crypto';
import { AgentError, clone, ensure, integer, stable, text } from './common.ts';
import type { Snapshot, StateStore, Transaction } from './store.ts';
import type { Delivery } from './outbox.ts';
import { canonicalIdentity, conversationKey } from '../../conversation-v1/src/identity.ts';

export interface CodeAuthorization {
  revision: number; adminActor: string; conversationKey: string; account: string; workspaceId: string; sessionId: string;
  modelConfigured: boolean; budgetAvailable: boolean; sandboxVerified: boolean; toolsRestricted: boolean;
  allowedTools: string[]; verified: boolean;
}
export interface CodeInput { eventId: string; actor: string; conversationKey: string; account: string; plain: true; text: string }
export interface CodeTask {
  id: string; input: CodeInput; authorization: CodeAuthorization; createdAt: number; updatedAt: number;
  state: 'queued' | 'held' | 'running' | 'needs-review' | 'completed' | 'stopped';
  result: string | null; resultDelivery: 'none' | 'ready' | 'held' | 'delivered'; reason: string;
  recovery?: { reviewer: string; reason: string; at: number };
}
export interface CodeState { enabled: boolean; authorization: CodeAuthorization | null; nextId: number; tasks: Record<string, CodeTask> }
export interface CodeArchiveMetadata { id: string; hash: string; recordHash?: string; eventHash: string; state: CodeTask['state']; at: number }
export interface CodeArchiveRecord { task: CodeTask; metadata: CodeArchiveMetadata; audit: { reviewer: string; reason: string; at: number } }
export interface CodeArchiveProof { domain: 'code'; revision: number; ids: readonly string[]; hashes: readonly string[]; items: readonly CodeTask[]; reviewer: string; reason: string; at: number }
export interface CodeArchiveOptions { expectedRevision: number; reviewer: string; reason: string; now: number; authorize(proof: Readonly<CodeArchiveProof>): boolean }
const archiveHash = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
function freezeProof<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeProof(item); Object.freeze(value); } return value; }
export interface CodeExecutorContext { task: CodeTask; signal: AbortSignal; gateTool(tool: string): void; gateModel(): void }
export type CodeExecutor = (context: CodeExecutorContext) => Promise<string>;
export interface CodeTasksOptions { getAuthorization: () => CodeAuthorization | null; namespace?: string }
function shape(value: unknown, keys: string[]): void {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
  for (const key of Reflect.ownKeys(value)) {
    ensure(typeof key === 'string' && keys.includes(key));
    ensure('value' in Object.getOwnPropertyDescriptor(value, key)!);
  }
}
function boundedBody(value: unknown, maximum: number): asserts value is string {
  ensure(typeof value === 'string' && value.length <= maximum && !/[\u0000\uD800-\uDFFF]/u.test(value));
}
function same(a: unknown, b: unknown): boolean { return stable(a) === stable(b); }

/** Persistent Code domain. This service owns no shell, model, network or filesystem. */
export class CodeTasks {
  private readonly store: StateStore;
  private readonly getAuthorization: () => CodeAuthorization | null;
  private readonly key: string;
  private recoveryRequired: boolean;
  private readonly executions = new Map<string, AbortController>();
  constructor(store: StateStore, options: CodeTasksOptions) {
    shape(options, ['getAuthorization', 'namespace']); ensure(typeof options.getAuthorization === 'function');
    if (options.namespace !== undefined) text(options.namespace);
    this.store = store; this.getAuthorization = options.getAuthorization;
    this.key = JSON.stringify(['code-jobs-v1', options.namespace ?? 'default']);
    this.recoveryRequired = store.read(this.key) !== null;
  }
  private read(): Snapshot<CodeState> {
    return clone(this.store.read<CodeState>(this.key) ?? { revision: 0, value: { enabled: false, authorization: null, nextId: 1, tasks: {} } });
  }
  snapshot(): Snapshot<CodeState> { return this.read(); }
  private change<T>(work: (state: CodeState, tx: Transaction) => T): T {
    return this.store.atomic(tx => {
      const current = clone(tx.read<CodeState>(this.key) ?? { revision: 0, value: { enabled: false, authorization: null, nextId: 1, tasks: {} } });
      const result = work(current.value, tx);
      // Reserve worst-case JSON-escaped result space BEFORE admitting work, so
      // ordinary completion cannot hit the store cap after a task has executed.
      const pending = Object.values(current.value.tasks).filter(task => task.result === null).length;
      ensure(stable(current.value).length + pending * 200000 <= 7 * 1024 * 1024, 'CODE_CAPACITY');
      tx.write(this.key, current.revision, current.value); return clone(result);
    });
  }
  private authorization(): CodeAuthorization {
    let value: CodeAuthorization | null;
    try { value = this.getAuthorization(); } catch { throw new AgentError('CODE_AUTH_UNAVAILABLE'); }
    ensure(value, 'CODE_NOT_AUTHORIZED');
    shape(value, ['revision', 'adminActor', 'conversationKey', 'account', 'workspaceId', 'sessionId', 'modelConfigured', 'budgetAvailable', 'sandboxVerified', 'toolsRestricted', 'allowedTools', 'verified']);
    integer(value.revision); for (const key of ['adminActor', 'account', 'workspaceId', 'sessionId'] as const) text(value[key]);
    text(value.conversationKey, 4096);
    for (const key of ['modelConfigured', 'budgetAvailable', 'sandboxVerified', 'toolsRestricted', 'verified'] as const) ensure(typeof value[key] === 'boolean');
    ensure(value.verified, 'CODE_NOT_AUTHORIZED');
    ensure(value.modelConfigured && value.budgetAvailable && value.sandboxVerified && value.toolsRestricted, 'CODE_PREREQUISITES_MISSING');
    ensure(Array.isArray(value.allowedTools) && value.allowedTools.length <= 128 && new Set(value.allowedTools).size === value.allowedTools.length);
    for (const tool of value.allowedTools) text(tool);
    try {
      const tuple: unknown = JSON.parse(value.conversationKey);
      ensure(Array.isArray(tuple) && tuple.length === 8 && tuple[0] === 'juebot-conversation-v1');
      const identity = canonicalIdentity({ botId: tuple[1], personaId: tuple[2], connector: tuple[3], issuer: tuple[4], accountId: tuple[5], kind: tuple[6], remoteId: tuple[7] });
      ensure(identity.kind === 'direct' && identity.accountId === value.account && conversationKey(identity) === value.conversationKey, 'CODE_PRIVATE_ROUTE_REQUIRED');
    } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError('CODE_PRIVATE_ROUTE_REQUIRED'); }
    return clone(value);
  }
  private ready(): void { ensure(!this.recoveryRequired, 'CODE_RECOVERY_REQUIRED'); }
  private task(state: CodeState, id: string): CodeTask { text(id); ensure(Object.hasOwn(state.tasks, id), 'CODE_TASK_NOT_FOUND'); return state.tasks[id]!; }
  private archiveIndexKey(): string { return `${this.key}:archives:v1`; }
  private archiveKey(id: string): string { return JSON.stringify(['code-task-archive-v1', this.key, id]); }
  private archivedEventKey(eventHash: string): string { return JSON.stringify(['code-event-archive-v1', this.key, eventHash]); }
  private cold(id: string, read: StateStore['read'] = this.store.read.bind(this.store)): CodeArchiveRecord | null {
    const index = read<CodeArchiveMetadata[]>(this.archiveIndexKey())?.value ?? [];
    const metadata = index.find(item => item.id === id);
    const record = read<CodeArchiveRecord>(this.archiveKey(id));
    if (!metadata && !record) return null;
    ensure(metadata, 'ARCHIVE_CORRUPT');
    ensure(record && record.revision === 1 && same(record.value.metadata, metadata)
      && record.value.task.id === id && archiveHash(record.value.task) === metadata.hash
      && archiveHash({ task: record.value.task, audit: record.value.audit }) === metadata.recordHash
      && archiveHash([record.value.task.input.account, record.value.task.input.conversationKey, record.value.task.input.eventId]) === metadata.eventHash, 'ARCHIVE_CORRUPT');
    const event = read<{ id: string; inputHash: string }>(this.archivedEventKey(metadata.eventHash));
    ensure(event?.revision === 1 && event.value.id === id && event.value.inputHash === archiveHash(record.value.task.input), 'ARCHIVE_CORRUPT');
    return clone(record.value);
  }
  get(id: string): CodeTask {
    text(id); const state = this.read().value;
    if (Object.hasOwn(state.tasks, id)) return clone(state.tasks[id]!);
    const record = this.cold(id); ensure(record, 'CODE_TASK_NOT_FOUND'); return record.task;
  }
  readArchive(id: string): CodeArchiveRecord { text(id); const record = this.cold(id); ensure(record, 'CODE_ARCHIVE_NOT_FOUND'); return record; }
  listArchives(options: { offset?: number; limit?: number } = {}): CodeArchiveMetadata[] {
    shape(options, ['offset', 'limit']); const offset = options.offset ?? 0, limit = options.limit ?? 100;
    integer(offset, 0, 4096); integer(limit, 1, 100);
    return clone((this.store.read<CodeArchiveMetadata[]>(this.archiveIndexKey())?.value ?? []).slice(offset, offset + limit));
  }
  inspectArchive(ids: string[]): { revision: number; items: CodeArchiveMetadata[] } {
    ensure(Array.isArray(ids) && ids.length > 0 && ids.length <= 64 && new Set(ids).size === ids.length);
    const current = this.read(); return { revision: current.revision, items: ids.map(id => {
      const task = this.task(current.value, id); return { id, hash: archiveHash(task),
        eventHash: archiveHash([task.input.account, task.input.conversationKey, task.input.eventId]), state: task.state, at: task.updatedAt };
    }) };
  }
  archive(ids: string[], options: CodeArchiveOptions): CodeArchiveMetadata[] { return this.store.atomic(tx => this.archiveIn(tx, ids, options)); }
  archiveIn(tx: Transaction, ids: string[], options: CodeArchiveOptions): CodeArchiveMetadata[] {
    this.ready(); shape(options, ['expectedRevision', 'reviewer', 'reason', 'now', 'authorize']);
    const authorize = options.authorize;
    const captured = clone({ expectedRevision: options.expectedRevision, reviewer: options.reviewer, reason: options.reason, now: options.now });
    integer(captured.expectedRevision, 1); integer(captured.now); text(captured.reviewer); text(captured.reason, 512);
    ensure(captured.reviewer.trim() && captured.reason.trim() && typeof authorize === 'function');
    ensure(Array.isArray(ids) && ids.length > 0 && ids.length <= 64 && new Set(ids).size === ids.length);
    ids = clone(ids); ids.forEach(id => text(id));
    ensure(this.executions.size === 0, 'CODE_EXECUTION_ACTIVE'); const grant = this.authorization();
    const current = tx.read<CodeState>(this.key); ensure(current?.revision === captured.expectedRevision, 'CONFLICT');
    ensure(!current.value.enabled, 'CODE_ARCHIVE_REQUIRES_OFF');
    const index = tx.read<CodeArchiveMetadata[]>(this.archiveIndexKey());
    ensure((index?.value.length ?? 0) + ids.length <= 4096, 'ARCHIVE_CAPACITY');
    const tasks = ids.map(id => clone(this.task(current.value, id)));
    for (const task of tasks) {
      ensure((task.state === 'completed' && task.result !== null && task.resultDelivery === 'delivered')
        || (task.state === 'stopped' && task.result === null && task.resultDelivery === 'none'
          && task.reason === 'RECOVERY_ABANDONED' && task.recovery), 'CODE_ARCHIVE_NOT_TERMINAL');
      ensure(captured.now >= task.updatedAt && tx.read(this.archiveKey(task.id)) === null
        && tx.read(this.archivedEventKey(archiveHash([task.input.account, task.input.conversationKey, task.input.eventId]))) === null
        && !index?.value.some(item => item.id === task.id), 'CODE_ARCHIVE_CONFLICT');
    }
    const fingerprint = stable([current, index]);
    const proof = freezeProof({ domain: 'code' as const, revision: current.revision, ids: clone(ids), hashes: tasks.map(archiveHash), items: clone(tasks),
      reviewer: captured.reviewer, reason: captured.reason, at: captured.now });
    const authorized = () => { const result: unknown = authorize(proof); if (result && typeof (result as { then?: unknown }).then === 'function') Promise.resolve(result).catch(() => {}); ensure(result === true, 'ARCHIVE_NOT_AUTHORIZED'); };
    authorized(); authorized();
    ensure(this.executions.size === 0 && same(this.authorization(), grant), 'CODE_AUTH_CHANGED');
    ensure(stable([tx.read(this.key), tx.read(this.archiveIndexKey())]) === fingerprint, 'CONFLICT');
    const state = clone(current.value); const metadata: CodeArchiveMetadata[] = [];
    for (const task of tasks) {
      ensure(tx.read(this.archiveKey(task.id)) === null, 'CODE_ARCHIVE_CONFLICT');
      const audit = { reviewer: captured.reviewer, reason: captured.reason, at: captured.now };
      const item = { id: task.id, hash: archiveHash(task), recordHash: archiveHash({ task, audit }), eventHash: archiveHash([task.input.account, task.input.conversationKey, task.input.eventId]), state: task.state, at: captured.now };
      tx.write(this.archiveKey(task.id), 0, { task, metadata: item, audit });
      tx.write(this.archivedEventKey(item.eventHash), 0, { id: task.id, inputHash: archiveHash(task.input) });
      metadata.push(item); delete state.tasks[task.id];
    }
    tx.write(this.archiveIndexKey(), index?.revision ?? 0, [...(index?.value ?? []), ...metadata]);
    tx.write(this.key, current.revision, state); return clone(metadata);
  }
  list(): CodeTask[] { return Object.values(this.read().value.tasks).map(clone); }

  /** Trusted Host recovery composes this with session retirement in one transaction.
   * It never requeues the original request or changes its recipient/workspace. */
  abandonIn(tx: Transaction, id: string, options: { expectedRevision: number; reviewer: string; reason: string; now: number }): CodeTask {
    this.ready(); shape(options, ['expectedRevision', 'reviewer', 'reason', 'now']);
    options = clone(options);
    integer(options.expectedRevision, 1); integer(options.now); text(options.reviewer); text(options.reason, 512);
    ensure(this.executions.size === 0, 'CODE_EXECUTION_ACTIVE');
    const authorization = this.authorization(); const current = tx.read<CodeState>(this.key);
    ensure(current && current.revision === options.expectedRevision, 'CONFLICT');
    ensure(!current.value.enabled, 'CODE_RECOVERY_REQUIRES_OFF');
    const state = clone(current.value); const task = this.task(state, id);
    ensure(['held', 'needs-review', 'stopped'].includes(task.state) && task.result === null
      && task.resultDelivery === 'none' && !task.recovery, 'CODE_RECOVERY_NOT_ALLOWED');
    ensure(same(task.authorization, authorization), 'CODE_AUTH_CHANGED');
    ensure(options.now >= task.updatedAt, 'INVALID_INPUT');
    task.state = 'stopped'; task.updatedAt = options.now; task.reason = 'RECOVERY_ABANDONED';
    task.recovery = { reviewer: options.reviewer, reason: options.reason, at: options.now };
    // A synchronous Host callback may have revoked the grant while resolving it.
    ensure(same(this.authorization(), authorization), 'CODE_AUTH_CHANGED');
    tx.write(this.key, current.revision, state); return clone(task);
  }

  enable(now: number): Snapshot<CodeState> {
    this.ready(); integer(now); const authorization = this.authorization();
    const existing = this.read();
    // Repeated commands are no-ops only after revalidating the live grant.
    // A changed grant must still update the binding and hold stale queued work.
    if (existing.value.enabled && same(existing.value.authorization, authorization)) return existing;
    this.change(state => {
      state.enabled = true; state.authorization = authorization;
      for (const task of Object.values(state.tasks)) if (task.state === 'queued' && !same(task.authorization, authorization)) {
        task.state = 'held'; task.reason = 'AUTH_CHANGED'; task.updatedAt = now;
      }
    });
    return this.read();
  }
  disable(now: number): Snapshot<CodeState> {
    integer(now);
    const existing = this.read(); if (!existing.value.enabled) return existing;
    this.change(state => {
      state.enabled = false;
      for (const task of Object.values(state.tasks)) if (task.state === 'queued') {
        task.state = 'held'; task.reason = 'CODE_OFF'; task.updatedAt = now;
      }
    });
    // OFF deliberately does not abort currently running executors.
    return this.read();
  }
  admit(input: CodeInput, now: number): { task: CodeTask; duplicate: boolean } {
    this.ready(); integer(now); shape(input, ['eventId', 'actor', 'conversationKey', 'account', 'plain', 'text']);
    for (const key of ['eventId', 'actor', 'account'] as const) text(input[key]); text(input.conversationKey, 4096);
    boundedBody(input.text, 16000); ensure(input.text.trim().length > 0 && input.plain === true, 'CODE_PLAIN_INPUT_REQUIRED');
    const authorization = this.authorization();
    ensure(input.actor === authorization.adminActor && input.account === authorization.account
      && input.conversationKey === authorization.conversationKey, 'CODE_ADMIN_ROUTE_REQUIRED');
    const captured = clone(input);
    return this.change((state, tx) => {
      const eventHash = archiveHash([captured.account, captured.conversationKey, captured.eventId]);
      const archived = tx.read<CodeArchiveMetadata[]>(this.archiveIndexKey())?.value.find(item => item.eventHash === eventHash);
      const event = tx.read<{ id: string; inputHash: string }>(this.archivedEventKey(eventHash));
      ensure((!event && !archived) || (event?.revision === 1 && event.value.id === archived?.id), 'ARCHIVE_CORRUPT');
      if (event) { const record = this.cold(event.value.id, tx.read); ensure(record && archiveHash(record.task.input) === event.value.inputHash, 'ARCHIVE_CORRUPT'); ensure(same(record.task.input, captured), 'CODE_EVENT_CONFLICT'); return { task: record.task, duplicate: true }; }
      const existing = Object.values(state.tasks).find(task => task.input.eventId === captured.eventId
        && task.input.account === captured.account && task.input.conversationKey === captured.conversationKey);
      if (existing) { ensure(same(existing.input, captured), 'CODE_EVENT_CONFLICT'); return { task: existing, duplicate: true }; }
      ensure(state.enabled, 'CODE_DISABLED'); ensure(same(state.authorization, authorization), 'CODE_AUTH_CHANGED');
      ensure(Object.keys(state.tasks).length < 64, 'CODE_CAPACITY'); integer(state.nextId, 1, Number.MAX_SAFE_INTEGER - 1);
      const id = `code-${state.nextId++}`;
      const task: CodeTask = { id, input: captured, authorization, createdAt: now, updatedAt: now, state: 'queued',
        result: null, resultDelivery: 'none', reason: 'ADMITTED' };
      state.tasks[id] = task; return { task, duplicate: false };
    });
  }
  start(id: string, now: number): CodeTask {
    this.ready(); integer(now); const authorization = this.authorization();
    return this.change(state => {
      const task = this.task(state, id); ensure(state.enabled, 'CODE_DISABLED');
      ensure(task.state === 'queued', 'CODE_TASK_NOT_QUEUED');
      ensure(same(task.authorization, authorization) && same(state.authorization, authorization), 'CODE_AUTH_CHANGED');
      task.state = 'running'; task.updatedAt = now; task.reason = 'STARTED'; return task;
    });
  }
  finish(id: string, result: string, now: number): CodeTask {
    integer(now); boundedBody(result, 32768);
    let authorization: CodeAuthorization | null = null;
    try { authorization = this.authorization(); } catch { /* retain result even after revocation or depleted budget */ }
    return this.change(state => {
      const task = this.task(state, id);
      if (task.result !== null) { ensure(task.result === result, 'CODE_RESULT_CONFLICT'); return task; }
      ensure(['running', 'needs-review', 'stopped'].includes(task.state), 'CODE_TASK_NOT_RUNNING');
      const deliverable = task.state === 'running' && !this.recoveryRequired && authorization !== null && same(task.authorization, authorization);
      if (task.state === 'running') task.state = 'completed';
      task.result = result; task.resultDelivery = deliverable ? 'ready' : 'held'; task.updatedAt = now;
      task.reason = deliverable ? 'RESULT_READY' : 'RESULT_REQUIRES_REVIEW'; return task;
    });
  }
  /** Root may hand this result to its unique Outbox. No social learning is performed. */
  takeResult(id: string): { id: string; task: CodeTask; result: string } {
    this.ready(); const authorization = this.authorization(); const task = this.get(id);
    ensure(task.result !== null, 'CODE_RESULT_NOT_READY'); ensure(task.resultDelivery === 'ready', 'CODE_RESULT_HELD');
    ensure(same(task.authorization, authorization), 'CODE_AUTH_CHANGED');
    return { id: `${id}:result`, task, result: task.result };
  }
  markResultDelivered(id: string, now: number): CodeTask {
    const result = this.takeResult(id); integer(now);
    return this.change(state => {
      const task = this.task(state, id); ensure(same(task, result.task), 'CODE_RESULT_CHANGED');
      task.resultDelivery = 'delivered'; task.updatedAt = now; return task;
    });
  }
  /** Record an already-sent fact, including after restart/revocation. This cannot authorize a new send. */
  markResultDeliveredIn(tx: Transaction, id: string, now: number, delivery: Readonly<Delivery>): CodeTask {
    integer(now); const current = tx.read<CodeState>(this.key); ensure(current, 'CODE_TASK_NOT_FOUND');
    const state = clone(current.value); const task = this.task(state, id);
    ensure(delivery.status === 'confirmed' && delivery.kind === 'code-result' && delivery.id === `${id}:result`
      && (delivery.payload as { taskId?: unknown })?.taskId === id && task.result !== null
      && (task.result || '任务已结束，结果为空。') === delivery.body
      && task.authorization.conversationKey === delivery.conversation, 'CODE_RESULT_CHANGED');
    // The canonical account records the originally authorized account; do not consult today's grant.
    let route: unknown; try { route = JSON.parse(task.authorization.conversationKey); } catch { throw new AgentError('CODE_RESULT_CHANGED'); }
    ensure(Array.isArray(route) && route.length === 8 && delivery.account === JSON.stringify(route.slice(3, 6))
      && route[5] === task.authorization.account, 'CODE_RESULT_CHANGED');
    if (task.resultDelivery === 'delivered') return task;
    ensure(['ready', 'held'].includes(task.resultDelivery), 'CODE_RESULT_CHANGED');
    task.resultDelivery = 'delivered'; task.updatedAt = now;
    tx.write(this.key, current.revision, state); return clone(task);
  }
  /** Explicit Host review after restart/revocation; never changes the private recipient or workspace. */
  releaseResult(id: string, now: number): CodeTask {
    this.ready(); integer(now); const authorization = this.authorization();
    return this.change(state => {
      const task = this.task(state, id);
      ensure(task.result !== null && task.resultDelivery === 'held', 'CODE_RESULT_NOT_HELD');
      ensure(task.input.actor === authorization.adminActor && task.input.account === authorization.account
        && task.input.conversationKey === authorization.conversationKey
        && task.authorization.workspaceId === authorization.workspaceId && task.authorization.sessionId === authorization.sessionId, 'CODE_ADMIN_ROUTE_REQUIRED');
      task.authorization = authorization; task.resultDelivery = 'ready'; task.updatedAt = now; task.reason = 'RESULT_REVIEWED'; return task;
    });
  }
  stop(id: string, now: number): CodeTask {
    integer(now);
    const task = this.change(state => {
      const task = this.task(state, id); task.state = 'stopped'; task.updatedAt = now; task.reason = 'EXPLICIT_STOP';
      if (task.resultDelivery === 'ready') task.resultDelivery = 'held'; return task;
    });
    this.executions.get(id)?.abort(new AgentError('CODE_STOPPED')); return task;
  }
  restart(now: number): Snapshot<CodeState> {
    integer(now);
    this.change(state => {
      state.enabled = false;
      for (const task of Object.values(state.tasks)) {
        if (task.state === 'running') { task.state = 'needs-review'; task.reason = 'RESTART_REVIEW'; task.updatedAt = now; }
        else if (task.state === 'queued') { task.state = 'held'; task.reason = 'RESTART_HELD'; task.updatedAt = now; }
        if (task.resultDelivery === 'ready') task.resultDelivery = 'held';
      }
    });
    for (const execution of this.executions.values()) execution.abort(new AgentError('CODE_RESTARTED'));
    this.recoveryRequired = false; return this.read();
  }
  resume(id: string, strategy: 'requeue' | 'keep-held', now: number): CodeTask {
    this.ready(); integer(now); ensure(strategy === 'requeue' || strategy === 'keep-held', 'CODE_RECOVERY_STRATEGY_REQUIRED');
    const authorization = this.authorization();
    return this.change(state => {
      const task = this.task(state, id); ensure(task.state === 'held' || task.state === 'needs-review', 'CODE_TASK_NOT_HELD');
      ensure(task.result === null, 'CODE_RESULT_ALREADY_EXISTS');
      if (strategy === 'requeue') {
        ensure(state.enabled && same(state.authorization, authorization), 'CODE_DISABLED');
        ensure(task.input.actor === authorization.adminActor && task.input.account === authorization.account
          && task.input.conversationKey === authorization.conversationKey, 'CODE_ADMIN_ROUTE_REQUIRED');
        task.authorization = authorization; task.state = 'queued'; task.reason = 'EXPLICIT_REQUEUE';
      } else { task.state = 'held'; task.reason = 'EXPLICIT_HELD'; }
      task.updatedAt = now; return task;
    });
  }
  async execute(id: string, executor?: CodeExecutor, options: { signal?: AbortSignal; now?: () => number } = {}): Promise<CodeTask> {
    this.ready(); ensure(typeof executor === 'function', 'NOT_CONFIGURED');
    const now = options.now ?? (() => Date.now()); integer(now()); options.signal?.throwIfAborted();
    ensure(!this.executions.has(id), 'CODE_EXECUTION_ACTIVE');
    const task = this.start(id, now()); const controller = new AbortController();
    this.executions.set(id, controller);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const gateModel = () => {
      controller.signal.throwIfAborted(); this.ready();
      const current = this.get(id); ensure(current.state === 'running', 'CODE_TASK_NOT_RUNNING');
      ensure(same(current.authorization, this.authorization()), 'CODE_AUTH_CHANGED');
    };
    const gateTool = (tool: string) => {
      text(tool); gateModel(); const authorization = this.authorization();
      ensure(same(this.get(id).authorization, authorization), 'CODE_AUTH_CHANGED');
      ensure(authorization.allowedTools.includes(tool), 'CODE_TOOL_NOT_ALLOWED');
    };
    try {
      gateModel();
      const result = await executor({ task: clone(task), signal: controller.signal, gateTool, gateModel });
      return this.finish(id, result, now());
    } catch (error) {
      // Only these public bridge states are persisted. Raw SDK errors, prompts,
      // tool arguments and reasoning never become task/log text.
      const bridgeReasons = ['DSH_CODE_NEEDS_APPROVAL', 'DSH_CODE_NEEDS_INPUT', 'DSH_CODE_TIMEOUT', 'DSH_CODE_ABORTED', 'DSH_CODE_CLEANUP_PENDING'];
      const reported = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const bridgeReason = typeof reported === 'string' && bridgeReasons.includes(reported) ? reported : null;
      this.change(state => {
        const current = this.task(state, id);
        if (current.state === 'running') { current.state = 'needs-review'; current.reason = controller.signal.aborted ? 'EXECUTION_ABORTED' : bridgeReason ?? 'EXECUTION_FAILED'; current.updatedAt = now(); }
      });
      if (error instanceof AgentError) throw error;
      if (bridgeReason) throw new AgentError(bridgeReason);
      throw new AgentError(controller.signal.aborted ? 'CODE_ABORTED' : 'CODE_EXECUTION_FAILED');
    } finally {
      options.signal?.removeEventListener('abort', abort); this.executions.delete(id);
    }
  }
}
