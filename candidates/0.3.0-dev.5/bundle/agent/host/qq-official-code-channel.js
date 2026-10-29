import { createCodeBridge } from './code-bridge.js';
import { createDshCodeExecutor } from './dsh-code-executor.js';
import { createQQOfficialIngress } from './qq-official-ingress.js';
import { createCodeInteractions } from './code-interactions.js';

// Required Cordis scope for a Host integrating this library. This is not an
// auto-loaded plugin and never creates/logs in an SDK or grants administrator status.
export const inject = ['agents', 'sandboxPolicy'];
const owners = new WeakMap();
const need = (ok, code = 'CODE_MAINTENANCE_INVALID') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const label = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function shape(value, allowed, required = allowed) {
  need(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  need(Reflect.ownKeys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
  need(Object.values(Object.getOwnPropertyDescriptors(value)).every(item => 'value' in item));
}
function trustedTrue(callback, argument, code) {
  let result;
  try { result = callback?.(argument); } catch { need(false, code); }
  if (result instanceof Promise) result.catch(() => {});
  need(result === true, code);
}

/** Compose an already authenticated official QQ SDK with an already opened
 * juebot application and the native DSH agent loop. Host must use the same
 * getAdminGrant for application.codeAuthorization and this ingress. The SDK
 * subscription starts only on explicit start(); no sender/model call at setup. */
export function createQQOfficialCodeChannel({ application, ctx, stateStore, sdk, qq,
  authenticateEvent, resolveBinding, authorizeReply, getAdminGrant,
  resolveWorkspace, model, onInteraction, timeoutMs, cleanupTimeoutMs,
  authorizeCodeMaintenance, verifyCodeSessionStopped, now = Date.now }) {
  if (!application?.code || !application?.runtime || typeof application.dispatcher?.enqueueCode !== 'function'
    || typeof application.dispatcher.registerCodeInteractions !== 'function')
    throw Object.assign(new Error('CODE_CHANNEL_INVALID_APPLICATION'), { code: 'CODE_CHANNEL_INVALID_APPLICATION' });
  if (owners.has(application)) throw Object.assign(new Error('CODE_CHANNEL_ALREADY_OWNED'), { code: 'CODE_CHANNEL_ALREADY_OWNED' });
  const profile = application.runtime.profile;
  const currentProfile = () => application.runtime.profile.botId === profile.botId && application.runtime.profile.personaId === profile.personaId;
  let interactions; let archiveSubjects = null;
  const executor = createDshCodeExecutor({ ctx, store: stateStore, resolveWorkspace, model, onInteraction, timeoutMs, cleanupTimeoutMs,
    interactions: { request(payload, options) {
      const check = () => {
        if (!currentProfile()) throw Object.assign(new Error('CODE_CHANNEL_IDENTITY_CHANGED'), { code: 'CODE_CHANNEL_IDENTITY_CHANGED' });
        options.check();
      };
      return interactions.request(payload, { ...options, check });
    } } });
  interactions = createCodeInteractions({ store: stateStore, code: application.code, getOutbox: () => application.runtime.outbox,
    now, timeoutMs: Math.min(timeoutMs ?? 300000, 300000), authorizeMaintenance(reviewer) {
      maintenance(reviewer); for (const id of archiveSubjects ?? []) privateTask(id); return true; } });
  const bridge = createCodeBridge({ code: application.code, executor, getDispatcher: () => application.dispatcher, interactions, now });
  const ingress = createQQOfficialIngress({ appId: qq?.appId, issuer: qq?.issuer, botId: profile.botId, personaId: profile.personaId,
    stateStore, authenticateEvent,
    resolveBinding(identity) {
      if (!currentProfile()) throw Object.assign(new Error('CODE_CHANNEL_IDENTITY_CHANGED'), { code: 'CODE_CHANNEL_IDENTITY_CHANGED' });
      return resolveBinding(identity);
    },
    authorizeReply, getAdminGrant, codeTasks: bridge, onSocial: async () => { throw new Error('CODE_CHANNEL_GROUP_DISABLED'); },
    groupSocialEnabled: () => false, now });
  const releaseInteractionGate = application.dispatcher.registerCodeInteractions(interactions);
  let unsubscribe = null; let closed = false; let closing = null;
  const lifetime = new AbortController(); const resolving = new Set();
  const closedError = () => Object.assign(new Error('CODE_CHANNEL_CLOSED'), { code: 'CODE_CHANNEL_CLOSED' });
  function quiet() {
    need(!closed && currentProfile(), 'CODE_MAINTENANCE_UNAVAILABLE');
    const status = bridge.status();
    need(!application.code.snapshot().value.enabled, 'CODE_RECOVERY_REQUIRES_OFF');
    need(status.active === null && status.pending === 0 && !application.code.list().some(task => task.state === 'running')
      && !interactions.list().some(row => row.status === 'pending'), 'CODE_MAINTENANCE_BUSY');
  }
  function maintenance(reviewer) {
    need(label(reviewer)); quiet();
    trustedTrue(authorizeCodeMaintenance, reviewer, 'CODE_MAINTENANCE_DENIED'); quiet();
  }
  function privateTask(id) {
    need(label(id)); const task = application.code.get(id); let grant;
    try { grant = getAdminGrant(); } catch { need(false, 'CODE_MAINTENANCE_DENIED'); }
    need(grant?.verified === true && stable(grant) === stable(task.authorization), 'CODE_AUTH_CHANGED');
    return task;
  }
  function resolveReplyContext(delivery, options = {}) {
    if (closed) return Promise.reject(closedError());
    const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(25000)]);
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    const operation = Promise.race([ingress.resolveReplyContext(delivery, { signal }), cancelled]).then(result => {
      signal.throwIfAborted(); if (closed || !currentProfile()) throw closedError(); return result;
    }).finally(() => { signal.removeEventListener('abort', abort); resolving.delete(operation); });
    resolving.add(operation); return operation;
  }
  const channel = {
    account: ingress.account,
    start() {
      if (closed) throw Object.assign(new Error('CODE_CHANNEL_CLOSED'), { code: 'CODE_CHANNEL_CLOSED' });
      if (!unsubscribe) unsubscribe = ingress.subscribeSDK(sdk);
    },
    async idle() { await ingress.idle(); await bridge.idle(); },
    resolveReplyContext,
    status() { return { started: !!unsubscribe, closed, code: bridge.status(), pendingInteractions: closed ? []
      : interactions.list().filter(row => row.status === 'pending').map(({ id, taskId, kind, revision, deadline }) => ({ id, taskId, kind, revision, deadline })) }; },
    enqueueResult: bridge.enqueueResult,
    /** Host-only maintenance capability. Never registered as an Agent tool or
     * inferred from QQ/HTTP payloads. A new request is still required afterward. */
    inspectRecovery(input) {
      shape(input, ['taskId', 'reviewer']); input = structuredClone(input); maintenance(input.reviewer);
      const task = privateTask(input.taskId); const session = executor.inspectRecovery(task);
      maintenance(input.reviewer); privateTask(input.taskId);
      return { taskId: task.id, expectedStateRevision: application.code.snapshot().revision, session };
    },
    abandonSession(input) {
      shape(input, ['taskId', 'expectedStateRevision', 'expectedSessionRevision', 'reviewer', 'reason']);
      input = structuredClone(input);
      need(label(input.reason, 512) && Number.isSafeInteger(input.expectedStateRevision) && input.expectedStateRevision > 0
        && Number.isSafeInteger(input.expectedSessionRevision) && input.expectedSessionRevision > 0);
      maintenance(input.reviewer); const task = privateTask(input.taskId); const time = now();
      return stateStore.atomic(tx => {
        const session = executor.recoverIn(tx, task, { expectedRevision: input.expectedSessionRevision,
          reviewer: input.reviewer, reason: input.reason, now: time,
          verifyStopped(proof) { maintenance(input.reviewer); privateTask(input.taskId);
            trustedTrue(verifyCodeSessionStopped, proof, 'CODE_SESSION_STOP_UNPROVEN'); return true; } });
        const stopped = application.code.abandonIn(tx, task.id, { expectedRevision: input.expectedStateRevision,
          reviewer: input.reviewer, reason: input.reason, now: time });
        maintenance(input.reviewer); privateTask(input.taskId);
        return { taskId: stopped.id, state: stopped.state, session };
      });
    },
    archiveInteractions(input) {
      shape(input, ['ids', 'reviewer', 'reason']);
      need(Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 32);
      for (const item of input.ids) shape(item, ['id', 'revision']);
      input = structuredClone(input); maintenance(input.reviewer);
      need(archiveSubjects === null, 'CODE_MAINTENANCE_BUSY');
      const subjects = input.ids.map(item => { shape(item, ['id', 'revision']); return privateTask(interactions.get(item.id).taskId).id; });
      archiveSubjects = subjects;
      try { return interactions.archive(input); } finally { archiveSubjects = null; }
    },
    listArchivedInteractions(input) {
      shape(input, ['reviewer', 'offset', 'limit'], ['reviewer']); input = structuredClone(input); maintenance(input.reviewer);
      const result = interactions.listArchives({ ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.limit === undefined ? {} : { limit: input.limit }) });
      for (const row of result.items) privateTask(row.taskId);
      maintenance(input.reviewer); for (const row of result.items) privateTask(row.taskId); return result;
    },
    readArchivedInteraction(input) {
      shape(input, ['id', 'reviewer']); input = structuredClone(input); maintenance(input.reviewer);
      const row = interactions.get(input.id); need(row.archive, 'CODE_INTERACTION_NOT_ARCHIVED'); privateTask(row.taskId);
      maintenance(input.reviewer); privateTask(row.taskId); return row;
    },
    close() {
      if (closing) return closing;
      closed = true; let shutdownFailed = false;
      try { lifetime.abort(closedError()); } catch { shutdownFailed = true; }
      try { unsubscribe?.(); } catch { shutdownFailed = true; }
      unsubscribe = null;
      // Stop admission/abort executor now, then await both tails while the Host
      // still owns SQLite. Do not disconnect somebody else's QQ SDK instance.
      const codeClosing = Promise.resolve().then(() => bridge.close());
      closing = Promise.allSettled([ingress.idle(), codeClosing, Promise.allSettled([...resolving])]).then(results => {
        // Keep the failed owner/gate closed until explicit Host recovery. Every
        // asynchronous tail has settled before the failure is reported.
        if (shutdownFailed || results.some(result => result.status === 'rejected'))
          throw Object.assign(new Error('CODE_CHANNEL_CLOSE_FAILED'), { code: 'CODE_CHANNEL_CLOSE_FAILED' });
        releaseInteractionGate();
        if (owners.get(application) === channel) owners.delete(application);
      }); closing.catch(() => {}); return closing;
    }
  };
  owners.set(application, channel); return channel;
}
