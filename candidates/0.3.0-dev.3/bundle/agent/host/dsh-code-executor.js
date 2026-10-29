import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

const failure = code => Object.assign(new Error(code), { code });
const need = (ok, code = 'DSH_CODE_INVALID_CONFIG') => { if (!ok) throw failure(code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function directory(value) {
  need(typeof value === 'string' && isAbsolute(value), 'DSH_CODE_WORKSPACE_INVALID');
  try {
    const result = normalize(realpathSync.native(value));
    need(statSync(result).isDirectory(), 'DSH_CODE_WORKSPACE_INVALID'); return result;
  } catch { throw failure('DSH_CODE_WORKSPACE_INVALID'); }
}
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function bounded(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('DSH_CODE_CLEANUP_PENDING')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Extract only the final assistant's public text from this submitted turn.
 * Session idle, partial text, another user's turn and a tool call are not success. */
function finalText(events, messageId) {
  let turn = null; let sawInput = false; let closed = false; let last = null; let assistantCount = 0;
  need(Array.isArray(events) && events.length <= 20000, 'DSH_CODE_RESULT_INVALID');
  for (const event of events) {
    const data = event?.data;
    if (event?.type === 'turn/start') {
      need(turn === null && Number.isSafeInteger(data?.turn), 'DSH_CODE_TURN_AMBIGUOUS'); turn = data.turn;
    } else if (event?.type === 'user/message') {
      // DSH also admits its own runtime-context as role=user. It is not a new
      // external request. Any other submitted user input contaminates the turn.
      if (data?.source?.kind === 'runtime-context') continue;
      need(!closed && turn !== null && !sawInput && data?.id === messageId && data?.role === 'user'
        && data?.source?.kind === 'user', 'DSH_CODE_TURN_AMBIGUOUS'); sawInput = true;
    } else if (event?.type === 'assistant/message') {
      need(!closed && sawInput && data?.turn === turn && !data.interrupted && data.message?.role === 'assistant'
        && data.message?.source?.kind === 'model' && Array.isArray(data.message.content), 'DSH_CODE_RESULT_INVALID');
      last = data.message; assistantCount++;
    } else if (event?.type === 'turn/end') {
      need(!closed && sawInput && data?.turn === turn && data.reason?.kind === 'completed', 'DSH_CODE_TURN_INCOMPLETE'); closed = true;
    } else if (event?.type === 'approval/asked') throw failure('DSH_CODE_NEEDS_APPROVAL');
  }
  need(closed && assistantCount > 0 && last, 'DSH_CODE_TURN_INCOMPLETE');
  need(last.content.every(block => block?.type === 'text' || block?.type === 'reasoning'), 'DSH_CODE_RESULT_INVALID');
  const blocks = last.content.filter(block => block.type === 'text');
  need(blocks.length > 0 && blocks.every(block => typeof block.text === 'string'), 'DSH_CODE_RESULT_INVALID');
  const result = blocks.map(block => block.text).join('');
  need(result.trim().length > 0 && result.length <= 16000 && !/[\u0000\uD800-\uDFFF]/u.test(result), 'DSH_CODE_RESULT_INVALID');
  return result;
}

/** Existing DSH rc.3 Agent bridge; constructing it runs no Agent/model/tools.
 * ctx must be injected in the owning Cordis scope with agents,sandboxPolicy.
 * resolveWorkspace is a trusted synchronous workspace-id -> absolute directory
 * resolver. It is not an authorization grant or an OS confinement proof.
 * Questions/approvals stop in needs-review; this bridge supplies no answerer.
 */
export function createDshCodeExecutor({ ctx, store, resolveWorkspace, model, onInteraction,
  timeoutMs = 300000, cleanupTimeoutMs = 5000, maxModelCalls = 32, namespace = 'default' }) {
  need(ctx?.agents && typeof ctx.agents.create === 'function' && typeof ctx.agents.resume === 'function'
    && typeof ctx.sandboxPolicy?.resolve === 'function' && typeof store?.read === 'function'
    && typeof store?.atomic === 'function' && typeof resolveWorkspace === 'function');
  need(model && label(model.provider) && label(model.model) && Number.isSafeInteger(model.maxTokens)
    && model.maxTokens >= 1 && model.maxTokens <= 131072 && Object.keys(model).every(key => ['provider', 'model', 'maxTokens'].includes(key)));
  need(onInteraction === undefined || typeof onInteraction === 'function');
  need(label(namespace) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000
    && Number.isSafeInteger(cleanupTimeoutMs) && cleanupTimeoutMs > 0 && cleanupTimeoutMs <= 30000
    && Number.isSafeInteger(maxModelCalls) && maxModelCalls > 0 && maxModelCalls <= 128);
  const route = Object.freeze({ ...model });

  return async function execute({ task, signal, gateTool, gateModel }) {
    need(task?.state === 'running' && label(task.id) && signal instanceof AbortSignal
      && typeof gateTool === 'function' && typeof gateModel === 'function', 'DSH_CODE_CONTEXT_INVALID');
    signal.throwIfAborted(); gateModel();
    const grant = task.authorization;
    need(grant && label(grant.workspaceId) && label(grant.sessionId) && Array.isArray(grant.allowedTools)
      && grant.allowedTools.every(label) && new Set(grant.allowedTools).size === grant.allowedTools.length, 'DSH_CODE_CONTEXT_INVALID');
    const workspace = directory(resolveWorkspace(grant.workspaceId));
    const binding = hash([namespace, grant.adminActor, grant.conversationKey, grant.account, grant.workspaceId,
      grant.sessionId, grant.revision, [...grant.allowedTools].sort(), workspace, route]);
    const sessionId = `juebot-code-${binding}`;
    const mappingKey = JSON.stringify(['dsh-code-session-v1', namespace, binding]);
    const attemptKey = JSON.stringify(['dsh-code-attempt-v1', namespace, binding, task.id]);
    const messageId = `juebot-code-input-${hash([binding, task.id, task.input.eventId])}`;
    const reservation = store.atomic(tx => {
      const previous = tx.read(mappingKey);
      if (tx.read(attemptKey) !== null) return { error: 'DSH_CODE_ATTEMPT_ALREADY_EXISTS' };
      if (previous && !(previous.value.binding === binding && previous.value.sessionId === sessionId
        && previous.value.phase === 'idle' && samePath(previous.value.workspace, workspace))) return { error: 'DSH_CODE_SESSION_NEEDS_REVIEW' };
      tx.write(mappingKey, previous?.revision ?? 0, { binding, sessionId, workspace, phase: 'active', taskId: task.id });
      tx.write(attemptKey, 0, { taskId: task.id, sessionId, phase: 'active' });
      return { fresh: previous === null };
    });
    if (reservation.error) throw failure(reservation.error);
    const fresh = reservation.fresh;
    const controller = new AbortController(); const disposers = []; const cleaned = new WeakMap(); const observed = [];
    let agent; let handle; let firstFailure; let modelCalls = 0; let submitted = false; let baseSeq; let result;
    const stop = code => {
      firstFailure ??= failure(code);
      if (!controller.signal.aborted) controller.abort(firstFailure);
      try { agent?.cancel({ kind: 'hook', reason: code }); } catch { /* cleanup retries disposal */ }
      return firstFailure;
    };
    const abort = () => stop('DSH_CODE_ABORTED');
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const timer = setTimeout(() => stop('DSH_CODE_TIMEOUT'), timeoutMs);
    const check = current => {
      controller.signal.throwIfAborted(); gateModel();
      need(samePath(directory(resolveWorkspace(grant.workspaceId)), workspace), 'DSH_CODE_WORKSPACE_CHANGED');
      if (current) {
        need(current.id === sessionId && current.session?.id === sessionId
          && samePath(directory(current.session.header?.cwd), workspace), 'DSH_CODE_SESSION_MISMATCH');
        const policy = ctx.sandboxPolicy.resolve({ session: current.session });
        need(policy && ['read-only', 'workspace-write'].includes(policy.mode) && policy.sessionId === sessionId
          && samePath(directory(policy.workspaceRoot), workspace), 'DSH_CODE_SANDBOX_UNSAFE');
      }
    };
    const checkRoute = config => need(config?.provider === route.provider && config.model === route.model
      && config.maxTokens === route.maxTokens, 'DSH_CODE_MODEL_ROUTE_CHANGED');
    const interaction = (kind, extra = {}) => {
      // No question contents, prompts, arguments, assistant reasoning or raw SDK
      // error text cross this callback. Detailed review stays in the DSH session.
      const code = kind === 'approval' ? 'DSH_CODE_NEEDS_APPROVAL' : 'DSH_CODE_NEEDS_INPUT';
      if (!firstFailure && onInteraction) {
        try { Promise.resolve(onInteraction({ kind, taskId: task.id, sessionId, state: 'needs-review', ...extra })).catch(() => {}); }
        catch { /* notification is non-authoritative */ }
      }
      stop(code);
    };
    const cleanup = value => {
      if (!value || typeof value !== 'object') return Promise.resolve();
      if (cleaned.has(value)) return cleaned.get(value);
      const promise = Promise.resolve().then(async () => {
        try { value.agent?.cancel({ kind: 'disposed' }); } catch { /* dispose remains required */ }
        need(typeof value.dispose === 'function', 'DSH_CODE_SDK_CONTRACT_INVALID');
        await value.dispose();
        // Guards remain installed if disposal hangs/fails: aborted calls must
        // stay denied while the Host still owns a possibly live Agent.
        for (const dispose of disposers.splice(0).reverse()) await dispose();
      });
      cleaned.set(value, promise); promise.catch(() => {}); return promise;
    };
    try {
      check();
      const setup = (agentCtx, current) => {
        agent = current; check(current);
        need(typeof agentCtx?.on === 'function' && typeof agentCtx.tools?.restrict === 'function'
          && typeof agentCtx.tools.guard === 'function' && typeof current.followup === 'function'
          && typeof current.whenIdle === 'function' && typeof current.cancel === 'function', 'DSH_CODE_SDK_CONTRACT_INVALID');
        // SDK's reserved PTC wrapper cannot appear in restrict(). It still must
        // be explicitly authorized by gateTool; all nested tools are guarded.
        disposers.push(agentCtx.tools.restrict({ allow: grant.allowedTools.filter(name => name !== 'run_code') }));
        disposers.push(agentCtx.tools.guard(exec => {
          try {
            need(exec?.agent === current && grant.allowedTools.includes(exec.name), 'DSH_CODE_TOOL_DENIED');
            check(current); gateTool(exec.name); return undefined;
          } catch (error) { stop(error?.code === 'DSH_CODE_TOOL_DENIED' ? error.code : 'DSH_CODE_GATE_REVOKED'); return 'DSH_CODE_TOOL_DENIED'; }
        }));
        disposers.push(agentCtx.on('agent/request', async (payload, next) => {
          try {
            need(submitted && payload?.agent === current && ++modelCalls <= maxModelCalls, 'DSH_CODE_MODEL_LIMIT');
            check(current); const config = await next(); check(current); checkRoute(config); return config;
          } catch (error) { stop(error?.code?.startsWith('DSH_CODE_') ? error.code : 'DSH_CODE_GATE_REVOKED'); throw firstFailure; }
        }, { prepend: true }));
        disposers.push(agentCtx.on('agent/request-error', payload => {
          // rc.3 delegates failed-step retry to this waterfall. Cancel even if
          // outer middleware later returns {kind:'retry'}: the loop checks its
          // aborted signal before continuing. Never replay failed Code work.
          if (payload?.agent === current) stop('DSH_CODE_MODEL_FAILED');
          return undefined;
        }, { prepend: true }));
        disposers.push(agentCtx.on('approval/request', request => {
          if (request?.agent !== current) return 'unavailable';
          interaction('approval', { toolName: label(request.toolName) ? request.toolName : 'unknown' }); return 'unavailable';
        }, { prepend: true }));
        disposers.push(agentCtx.on('user-questions/request', request => {
          if (request?.agent === current) interaction('question', { questionCount: Array.isArray(request.questions) ? request.questions.length : 0 });
          throw failure('DSH_CODE_NEEDS_INPUT');
        }, { prepend: true }));
        disposers.push(agentCtx.on('session/event', (session, event) => {
          if (session !== current.session) return;
          try {
            if (submitted && event.seq >= baseSeq && ['turn/start', 'turn/end', 'user/message', 'assistant/message', 'approval/asked'].includes(event.type)) {
              need(observed.length < 20000, 'DSH_CODE_EVENT_LIMIT'); observed.push(event);
            }
            if (event.type === 'assistant/attempt') stop('DSH_CODE_MODEL_FAILED');
            else if (event.type === 'approval/asked') interaction('approval', { toolName: label(event.data?.toolName) ? event.data.toolName : 'unknown' });
            else if (event.type === 'request/header') { check(current); checkRoute(event.data?.header?.config); }
            else if (event.type === 'sandbox/mode') check(current);
            else if (event.type === 'working-directory/change') {
              need(samePath(directory(event.data?.cwd), workspace), 'DSH_CODE_WORKSPACE_CHANGED'); check(current);
            }
          } catch (error) { stop(error?.code?.startsWith('DSH_CODE_') ? error.code : 'DSH_CODE_GATE_REVOKED'); }
        }));
        need(disposers.every(dispose => typeof dispose === 'function'), 'DSH_CODE_SDK_CONTRACT_INVALID');
      };
      const options = { agentOptions: { ...route }, setup, signal: controller.signal };
      const creation = Promise.resolve().then(() => fresh
        ? ctx.agents.create({ ...options, sessionId, meta: { cwd: workspace } })
        : ctx.agents.resume({ ...options, resumeSessionId: sessionId }));
      // If an SDK factory ignores abort and resolves late, its handle is still
      // disposed. This late cleanup never touches a closed StateStore.
      creation.then(value => { if (controller.signal.aborted) void cleanup(value); }, () => {});
      handle = await abortable(creation, controller.signal);
      need(handle?.agent === agent && typeof handle.dispose === 'function', 'DSH_CODE_SDK_CONTRACT_INVALID');
      check(agent);
      need(agent.status === 'idle' && agent.inbox?.nextTurn?.length === 0 && agent.inbox?.nextStep?.length === 0,
        'DSH_CODE_SESSION_NOT_IDLE');
      baseSeq = agent.session.seq;
      need(Number.isSafeInteger(baseSeq) && baseSeq >= 0, 'DSH_CODE_SDK_CONTRACT_INVALID');
      submitted = true;
      agent.followup({ id: messageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task.input.text }] });
      await abortable(Promise.resolve().then(() => agent.whenIdle()), controller.signal);
      check(agent);
      result = finalText(observed, messageId);
      need(modelCalls > 0, 'DSH_CODE_TURN_INCOMPLETE');
    } catch (error) {
      stop(error?.code?.startsWith('DSH_CODE_') ? error.code : 'DSH_CODE_EXECUTION_FAILED');
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (!controller.signal.aborted) controller.abort(failure('DSH_CODE_FINISHED'));
      try { if (handle) await bounded(cleanup(handle), cleanupTimeoutMs); }
      catch { firstFailure ??= failure('DSH_CODE_CLEANUP_PENDING'); }
      // Do not lift guards after a failed/hanging factory's setup. The SDK owns
      // its scope lifetime; our aborted controller keeps those guards closed.
      const persisted = store.atomic(tx => {
        const mapping = tx.read(mappingKey); const attempt = tx.read(attemptKey);
        if (mapping?.value.taskId !== task.id || attempt?.value.phase !== 'active') return false;
        tx.write(mappingKey, mapping.revision, { ...mapping.value, phase: firstFailure ? 'needs-review' : 'idle' });
        tx.write(attemptKey, attempt.revision, { ...attempt.value, phase: firstFailure ? 'needs-review' : 'completed', reason: firstFailure?.code ?? 'COMPLETED' });
        return true;
      });
      need(persisted, 'DSH_CODE_STATE_CONFLICT');
    }
    if (firstFailure) throw firstFailure;
    return result;
  };
}
