import { randomBytes } from 'node:crypto';

// Lifecycle/transport bridge only. A trusted Host adapter must supply decode,
// authenticated ingress and actual protocol capabilities; QQ account validation
// for the selected official/personal route remains a separate acceptance step.
const owners = new WeakMap();
export const RUNNER_LIMITS = Object.freeze({ accounts: 16, idlePlans: 16, creationPlans: 8, pendingIngress: 64, minIntervalMs: 100, maxIntervalMs: 3600000 });
const SAFE_CODES = new Set(['MODEL_NOT_CONFIGURED', 'NOT_CONFIGURED', 'ACCESS_DENIED', 'ACCESS_CHANGED', 'BINDING_CONFLICT',
  'CONVERSATION_BUSY', 'RUNTIME_CLOSED', 'CANCELLED', 'SOURCE_REVOKED', 'CONTEXT_STALE', 'POLICY_CHANGED', 'IDENTITY_CHANGED',
  'MODEL_CHANGED', 'EXPRESSION_BLOCKED', 'STYLE_BLOCKED', 'STYLE_REVIEW_REQUIRED', 'CONTACT_REFUSED', 'QUIET_HOURS', 'DAILY_LIMIT',
  'UNANSWERED_LIMIT', 'CAPACITY', 'CONFLICT', 'STALE_CLAIM', 'STORAGE_FAILURE', 'STORE_CLOSED', 'STORE_MISMATCH', 'BUDGET_EXCEEDED',
  'MODEL_BUDGET_DENIED', 'MODEL_BUDGET_SETTLEMENT_FAILED', 'MODEL_CANCELLED', 'MODEL_TIMEOUT', 'MODEL_CREDENTIAL_UNAVAILABLE',
  'MODEL_CONTEXT_TOO_LARGE', 'MODEL_RESPONSE_INVALID', 'MODEL_REDIRECT_BLOCKED', 'MODEL_HTTP_FAILURE', 'MODEL_RESPONSE_TOO_LARGE',
  'MODEL_RESPONSE_ENCODING', 'MODEL_JSON_INVALID', 'MODEL_USAGE_INVALID', 'MODEL_INCOMPLETE', 'MODEL_UNEXPECTED_TOOLS',
  'MODEL_OUTPUT_TOO_LARGE', 'MODEL_OUTPUT_INVALID', 'MODEL_REQUEST_FAILED', 'TURN_FAILED']);
const failure = code => Object.assign(new Error(code), { code });
const need = (ok, code = 'RUNNER_INVALID_CONFIG') => { if (!ok) throw failure(code); };
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function plain(value, keys) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
  need(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)));
}

/** Construction is inert. First start is an explicit operator action, never an import side effect. */
export function createRunner(options) {
  plain(options, ['runtime', 'dispatcher', 'accounts', 'subscribe', 'decode', 'now', 'setTimer', 'clearTimer', 'intervalMs', 'idlePlans', 'creationPlans', 'prepareCreation', 'onDiagnostic']);
  const { runtime, dispatcher } = options;
  need(runtime && typeof runtime.receive === 'function' && typeof runtime.idle === 'function');
  need(dispatcher && typeof dispatcher === 'object' && typeof dispatcher.dispatch === 'function');
  need(Array.isArray(options.accounts) && options.accounts.length <= RUNNER_LIMITS.accounts);
  const accounts = options.accounts.map(account => {
    plain(account, ['id', 'budget', 'send']); need(text(account.id, 4096) && typeof account.budget === 'function' && typeof account.send === 'function');
    return { id: account.id, budget: account.budget, send: account.send };
  });
  need(new Set(accounts.map(account => account.id)).size === accounts.length);
  for (const key of ['subscribe', 'decode', 'now', 'setTimer', 'clearTimer', 'idlePlans', 'creationPlans', 'prepareCreation', 'onDiagnostic']) need(options[key] === undefined || typeof options[key] === 'function');
  need(options.creationPlans === undefined || typeof options.prepareCreation === 'function');
  need((options.setTimer === undefined) === (options.clearTimer === undefined));
  const intervalMs = options.intervalMs ?? 1000;
  need(Number.isSafeInteger(intervalMs) && intervalMs >= RUNNER_LIMITS.minIntervalMs && intervalMs <= RUNNER_LIMITS.maxIntervalMs);
  const now = options.now ?? Date.now; const setTimer = options.setTimer ?? setTimeout; const clearTimer = options.clearTimer ?? clearTimeout;
  const owner = `runner_${randomBytes(16).toString('hex')}`;
  let started = false; let closed = false; let timer; let activeRun; let starting; let stopping; let unsubscribe;
  const ingress = new Set();
  const diagnostic = (stage, code) => { try { options.onDiagnostic?.({ stage, code }); } catch { /* observers never own lifecycle */ } };
  const safeCode = (error, fallback) => {
    try { const code = error?.code; if (SAFE_CODES.has(code)) return code; const message = error?.message; if (SAFE_CODES.has(message)) return message; } catch {}
    return fallback;
  };
  const report = (stage, error, fallback) => diagnostic(stage, safeCode(error, fallback));
  const clock = () => { const value = now(); need(Number.isSafeInteger(value) && value >= 0, 'RUNNER_INVALID_CLOCK'); return value; };
  const once = action => { let result; return () => result ??= Promise.resolve().then(action); };
  const clear = () => { if (timer !== undefined) { const previous = timer; timer = undefined; try { clearTimer(previous); } catch { diagnostic('lifecycle', 'TIMER_CLEAR_FAILED'); } } };
  const schedule = () => {
    if (!started || closed) return false;
    if (timer !== undefined || activeRun) return true;
    try {
      timer = setTimer(() => { timer = undefined; if (!closed) void runOnce().catch(() => {}); }, intervalMs);
      timer?.unref?.();
      return true;
    } catch (error) { report('lifecycle', error, 'TIMER_SETUP_FAILED'); void stop(); return false; }
  };
  const accept = raw => {
    if (!started || closed) { diagnostic('receive', 'RUNNER_STOPPED'); return Promise.resolve({ accepted: false, code: 'RUNNER_STOPPED' }); }
    if (!options.decode) { diagnostic('receive', 'DECODE_NOT_CONFIGURED'); return Promise.resolve({ accepted: false, code: 'DECODE_NOT_CONFIGURED' }); }
    if (ingress.size >= RUNNER_LIMITS.pendingIngress) { diagnostic('receive', 'INGRESS_CAPACITY'); return Promise.resolve({ accepted: false, code: 'INGRESS_CAPACITY' }); }
    let operation;
    operation = Promise.resolve().then(async () => {
      try {
        if (closed) return { accepted: false, code: 'RUNNER_STOPPED' };
        const envelope = options.decode(raw);
        need(!envelope || typeof envelope.then !== 'function', 'RUNNER_INVALID_DECODE');
        if (closed) return { accepted: false, code: 'RUNNER_STOPPED' };
        if (envelope === null || envelope === undefined) { diagnostic('receive', 'INGRESS_IGNORED'); return { accepted: false, code: 'INGRESS_IGNORED' }; }
        need(envelope && typeof envelope === 'object' && !Array.isArray(envelope), 'RUNNER_INVALID_DECODE');
        // Decode is an attested adapter boundary, not a public owner/role flag.
        const result = await runtime.receive(structuredClone(envelope));
        diagnostic('receive', 'RECEIVED'); return { accepted: true, result };
      } catch (error) {
        const code = safeCode(error, 'RECEIVE_FAILED');
        diagnostic('receive', code); return { accepted: false, code };
      } finally { ingress.delete(operation); }
    });
    ingress.add(operation); return operation;
  };
  function runOnce() {
    if (closed) return Promise.reject(failure('RUNNER_STOPPED'));
    if (!started) return Promise.reject(failure('RUNNER_NOT_STARTED'));
    if (activeRun) return activeRun;
    clear();
    const operation = (async () => {
      clock();
      if (options.idlePlans && !closed) {
        try {
          const plans = options.idlePlans(); need(Array.isArray(plans) && plans.length <= RUNNER_LIMITS.idlePlans, 'RUNNER_INVALID_IDLE_PLAN');
          const seen = new Set();
          const captured = plans.map(plan => {
            plain(plan, ['key', 'topic', 'action']); need(text(plan.key, 4096) && text(plan.topic, 512)
              && ['group-participation', 'idle-topic', 'direct-contact'].includes(plan.action), 'RUNNER_INVALID_IDLE_PLAN');
            const key = JSON.stringify([plan.key, plan.action]); need(!seen.has(key), 'RUNNER_INVALID_IDLE_PLAN'); seen.add(key); return { ...plan };
          });
          for (const plan of captured) { if (closed) break; try { await runtime.idle(plan.key, plan.topic, plan.action); diagnostic('idle', 'IDLE_EVALUATED'); } catch (error) { report('idle', error, 'IDLE_FAILED'); } }
        } catch (error) { report('idle', error, 'IDLE_PLAN_FAILED'); }
      }
      if (options.creationPlans && !closed) {
        try {
          const plans = options.creationPlans(); if (plans?.then) Promise.resolve(plans).catch(() => {});
          need(Array.isArray(plans) && plans.length <= RUNNER_LIMITS.creationPlans, 'RUNNER_INVALID_CREATION_PLAN');
          const seen = new Set();
          const captured = plans.map(plan => {
            plain(plan, ['key', 'topic', 'request']); need(text(plan.key, 4096) && text(plan.topic, 128), 'RUNNER_INVALID_CREATION_PLAN');
            plain(plan.request, ['action', 'accountId', 'target']);
            need(['qqspace', 'bili.comment', 'bili.reply', 'bili.dynamic', 'bili.video'].includes(plan.request.action) && text(plan.request.accountId, 128)
              && plan.request.target && typeof plan.request.target === 'object', 'RUNNER_INVALID_CREATION_PLAN');
            const key = JSON.stringify([plan.key, plan.topic]); need(!seen.has(key), 'RUNNER_INVALID_CREATION_PLAN'); seen.add(key); return structuredClone(plan);
          });
          for (const plan of captured) { if (closed) break; try { const result=await options.prepareCreation(plan);
            diagnostic('creation',result?.status==='ready'?'CREATION_READY_FOR_REVIEW':result?.status==='failed'?'CREATION_PREPARATION_FAILED':'CREATION_NOT_PREPARED');
          } catch (error) { report('creation', error, 'CREATION_PREPARATION_FAILED'); } }
        } catch (error) { report('creation', error, 'CREATION_PLAN_FAILED'); }
      }
      for (const account of accounts) {
        if (closed) break;
        try {
          const budget = account.budget();
          need(budget === null || (budget && text(budget.id, 256) && Number.isSafeInteger(budget.limit) && budget.limit >= 0 && budget.limit <= 1000000000), 'RUNNER_INVALID_BUDGET');
          if (closed) break;
          // One selected sender only. No retries, fallback API, or unknown replay.
          const result = await dispatcher.dispatch(account.id, owner, budget && { id: budget.id, limit: budget.limit }, async (item,signal) => {
            if (closed) throw failure('RUNNER_STOPPED');
            return account.send(item,signal);
          });
          diagnostic('dispatch', result?.status === 'unknown' ? 'DELIVERY_UNCERTAIN' : result ? 'DISPATCH_COMPLETED' : 'NO_DELIVERY');
        } catch (error) { report('dispatch', error, 'DISPATCH_FAILED'); }
      }
    })();
    activeRun = operation.finally(() => { activeRun = undefined; schedule(); }); return activeRun;
  }
  const stop = () => {
    if (stopping) return stopping;
    closed = true; clear(); // Ownership is closed synchronously, before the first await.
    stopping = (async () => {
      if (unsubscribe) { try { await unsubscribe(); } catch (error) { report('lifecycle', error, 'UNSUBSCRIBE_FAILED'); } }
      // In-flight transport results remain owned by the dispatcher and may be
      // confirmed or unknown. Never claim that stop means "not submitted".
      await Promise.allSettled([...(activeRun ? [activeRun] : []), ...ingress]);
      if (owners.get(dispatcher) === owner) owners.delete(dispatcher);
      diagnostic('lifecycle', 'STOPPED');
    })();
    return stopping;
  };
  const start = () => {
    if (closed) return Promise.reject(failure('RUNNER_STOPPED'));
    if (starting) return starting;
    if (owners.has(dispatcher)) return Promise.reject(failure('RUNNER_ALREADY_RUNNING'));
    owners.set(dispatcher, owner); started = true;
    starting = (async () => {
      try {
        clock();
        if (options.subscribe) {
          const dispose = await options.subscribe(accept);
          need(typeof dispose === 'function', 'RUNNER_INVALID_SUBSCRIPTION');
          unsubscribe = once(dispose);
          if (closed) { await unsubscribe(); return; }
        }
        if (!closed) { need(schedule(), 'RUNNER_TIMER_FAILED'); diagnostic('lifecycle', 'STARTED'); }
      } catch (error) {
        report('lifecycle', error, 'SUBSCRIBE_FAILED'); await stop(); throw failure('RUNNER_START_FAILED');
      }
    })();
    return starting;
  };
  // Does not recover/unpause an Outbox or read/replay old ingress. Application
  // startup owns conservative persisted recovery; first timer is a new cycle.
  return Object.freeze({ start, runOnce, stop, status: () => ({ started, closed, running: !!activeRun, pendingIngress: ingress.size }) });
}
