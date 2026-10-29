import { createCodeBridge } from './code-bridge.js';
import { createDshCodeExecutor } from './dsh-code-executor.js';
import { createQQOfficialIngress } from './qq-official-ingress.js';

// Required Cordis scope for a Host integrating this library. This is not an
// auto-loaded plugin and never creates/logs in an SDK or grants administrator status.
export const inject = ['agents', 'sandboxPolicy'];
const owners = new WeakMap();

/** Compose an already authenticated official QQ SDK with an already opened
 * juebot application and the native DSH agent loop. Host must use the same
 * getAdminGrant for application.codeAuthorization and this ingress. The SDK
 * subscription starts only on explicit start(); no sender/model call at setup. */
export function createQQOfficialCodeChannel({ application, ctx, stateStore, sdk, qq,
  authenticateEvent, resolveBinding, authorizeReply, getAdminGrant,
  resolveWorkspace, model, onInteraction, timeoutMs, cleanupTimeoutMs, now = Date.now }) {
  if (!application?.code || !application?.runtime || typeof application.dispatcher?.enqueueCode !== 'function')
    throw Object.assign(new Error('CODE_CHANNEL_INVALID_APPLICATION'), { code: 'CODE_CHANNEL_INVALID_APPLICATION' });
  if (owners.has(application)) throw Object.assign(new Error('CODE_CHANNEL_ALREADY_OWNED'), { code: 'CODE_CHANNEL_ALREADY_OWNED' });
  const profile = application.runtime.profile;
  const executor = createDshCodeExecutor({ ctx, store: stateStore, resolveWorkspace, model, onInteraction, timeoutMs, cleanupTimeoutMs });
  const bridge = createCodeBridge({ code: application.code, executor, getDispatcher: () => application.dispatcher, now });
  const currentProfile = () => application.runtime.profile.botId === profile.botId && application.runtime.profile.personaId === profile.personaId;
  const ingress = createQQOfficialIngress({ appId: qq?.appId, issuer: qq?.issuer, botId: profile.botId, personaId: profile.personaId,
    stateStore, authenticateEvent,
    resolveBinding(identity) {
      if (!currentProfile()) throw Object.assign(new Error('CODE_CHANNEL_IDENTITY_CHANGED'), { code: 'CODE_CHANNEL_IDENTITY_CHANGED' });
      return resolveBinding(identity);
    },
    authorizeReply, getAdminGrant, codeTasks: bridge, onSocial: async () => { throw new Error('CODE_CHANNEL_GROUP_DISABLED'); },
    groupSocialEnabled: () => false, now });
  let unsubscribe = null; let closed = false; let closing = null;
  const lifetime = new AbortController(); const resolving = new Set();
  const closedError = () => Object.assign(new Error('CODE_CHANNEL_CLOSED'), { code: 'CODE_CHANNEL_CLOSED' });
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
    status() { return { started: !!unsubscribe, closed, code: bridge.status() }; },
    enqueueResult: bridge.enqueueResult,
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort(closedError()); unsubscribe?.(); unsubscribe = null;
      // Stop admission/abort executor now, then await both tails while the Host
      // still owns SQLite. Do not disconnect somebody else's QQ SDK instance.
      const codeClosing = bridge.close();
      closing = Promise.all([ingress.idle(), codeClosing, Promise.allSettled([...resolving])]).then(() => {
        if (owners.get(application) === channel) owners.delete(application);
      }); return closing;
    }
  };
  owners.set(application, channel); return channel;
}
