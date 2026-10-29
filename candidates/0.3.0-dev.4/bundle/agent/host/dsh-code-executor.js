import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

const ownedFailures = new WeakSet();
const failure = code => { const error = Object.assign(new Error(code), { code }); ownedFailures.add(error); return error; };
// SDK/providers/brokers may supply arbitrary code strings. Only errors minted
// here can preserve a reason across the persistent Code-state boundary.
const errorCode = (error, fallback) => ownedFailures.has(error) ? error.code : fallback;
const need = (ok, code = 'DSH_CODE_INVALID_CONFIG') => { if (!ok) throw failure(code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function jsonSnapshot(value, maximum = 12000) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw failure('DSH_CODE_INTERACTION_INVALID'); }
  need(typeof encoded === 'string' && encoded.length <= maximum, 'DSH_CODE_INTERACTION_INVALID');
  return JSON.parse(encoded);
}
function questionBatch(value) {
  const questions = jsonSnapshot(value);
  need(Array.isArray(questions) && questions.length > 0 && questions.length <= 8
    && new Set(questions.map(item => item?.id)).size === questions.length, 'DSH_CODE_INTERACTION_INVALID');
  for (const item of questions) {
    need(item && label(item.id) && typeof item.question === 'string' && item.question.trim()
      && (item.detail === undefined || typeof item.detail === 'string')
      && (item.header === undefined || typeof item.header === 'string')
      && (item.multiSelect === undefined || typeof item.multiSelect === 'boolean')
      && Object.keys(item).every(key => ['id', 'question', 'detail', 'header', 'options', 'multiSelect', 'intent'].includes(key)), 'DSH_CODE_INTERACTION_INVALID');
    if (item.options !== undefined) need(Array.isArray(item.options) && item.options.length <= 16
      && item.options.every(option => label(option?.label) && (option.description === undefined || typeof option.description === 'string')
        && Object.keys(option).every(key => ['label', 'description'].includes(key)))
      && new Set(item.options.map(option => option.label)).size === item.options.length, 'DSH_CODE_INTERACTION_INVALID');
    if (item.intent !== undefined) need(item.intent?.kind === 'plan-review' && label(item.intent.approve)
      && item.options?.some(option => option.label === item.intent.approve) && typeof item.detail === 'string', 'DSH_CODE_INTERACTION_INVALID');
  }
  return questions;
}
function questionAnswer(value, questions) {
  const answer = jsonSnapshot(value);
  need(answer && Object.keys(answer).length === 1 && Array.isArray(answer.answers)
    && answer.answers.length === questions.length && new Set(answer.answers.map(item => item?.id)).size === questions.length, 'DSH_CODE_ANSWER_INVALID');
  for (const item of answer.answers) {
    const question = questions.find(question => question.id === item?.id);
    need(question && Array.isArray(item.selected) && item.selected.every(label) && new Set(item.selected).size === item.selected.length
      && (question.multiSelect || item.selected.length <= 1) && item.selected.every(selected => question.options?.some(option => option.label === selected))
      && (item.custom === undefined || typeof item.custom === 'string') && (item.selected.length > 0 || item.custom?.trim())
      && Object.keys(item).every(key => ['id', 'selected', 'custom'].includes(key)), 'DSH_CODE_ANSWER_INVALID');
  }
  return answer;
}
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
function finalText(events, messageId, approvals) {
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
    } else if (event?.type === 'approval/asked') {
      const approval = approvals.get(data?.id);
      need(approval?.settled && approval.audited && ['allowed-once', 'rejected'].includes(approval.outcome), 'DSH_CODE_NEEDS_APPROVAL');
    }
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
 * An optional trusted interactions port answers the same pending Agent call.
 * Without it, questions/approvals retain the needs-review behavior.
 */
export function createDshCodeExecutor({ ctx, store, resolveWorkspace, model, onInteraction, interactions,
  timeoutMs = 300000, cleanupTimeoutMs = 5000, maxModelCalls = 32, namespace = 'default' }) {
  need(ctx?.agents && typeof ctx.agents.create === 'function' && typeof ctx.agents.resume === 'function'
    && typeof ctx.sandboxPolicy?.resolve === 'function' && typeof store?.read === 'function'
    && typeof store?.atomic === 'function' && typeof resolveWorkspace === 'function');
  need(model && label(model.provider) && label(model.model) && Number.isSafeInteger(model.maxTokens)
    && model.maxTokens >= 1 && model.maxTokens <= 131072 && Object.keys(model).every(key => ['provider', 'model', 'maxTokens'].includes(key)));
  need(onInteraction === undefined || typeof onInteraction === 'function');
  need(interactions === undefined || typeof interactions?.request === 'function');
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
    const executions = new Map(); const approvals = new Map(); let questionSequence = 0; let pendingInteractions = 0;
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
    const waitForHuman = async (current, request, payload, recheck) => {
      need(interactions && request.agent === current && current === agent && submitted, 'DSH_CODE_INTERACTION_INVALID');
      const combined = AbortSignal.any([controller.signal, ...(request.signal ? [request.signal] : [])]);
      const verify = () => {
        combined.throwIfAborted(); check(current); checkRoute(current.options); recheck();
      };
      const poll = setInterval(() => {
        try { verify(); } catch (error) { stop(errorCode(error, 'DSH_CODE_GATE_REVOKED')); }
      }, 1000);
      pendingInteractions++;
      try {
        verify();
        const pending = Promise.resolve().then(() => interactions.request(jsonSnapshot(payload), { signal: combined, check: verify }));
        const answer = await abortable(pending, combined);
        verify(); return answer;
      } catch (error) {
        stop(errorCode(error, combined.aborted ? 'DSH_CODE_INTERACTION_CANCELLED' : 'DSH_CODE_INTERACTION_FAILED'));
        throw firstFailure;
      } finally { clearInterval(poll); pendingInteractions--; }
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
            const captured = executions.get(exec.callId);
            if (captured) need(!captured.closed && captured.exec === exec && captured.inputHash === hash([exec.name, exec.callId, exec.arguments]), 'DSH_CODE_APPROVAL_INPUT_CHANGED');
            check(current); gateTool(exec.name); return undefined;
          } catch (error) { stop(error?.code === 'DSH_CODE_TOOL_DENIED' ? error.code : 'DSH_CODE_GATE_REVOKED'); return 'DSH_CODE_TOOL_DENIED'; }
        }));
        if (interactions) disposers.push(agentCtx.on('tools/pre-execute', async (exec, next) => {
          try {
            need(exec?.agent === current && label(exec.callId) && !executions.has(exec.callId)
              && executions.size < 256 && grant.allowedTools.includes(exec.name), 'DSH_CODE_TOOL_DENIED');
            check(current); gateTool(exec.name);
            const args = jsonSnapshot(exec.arguments);
            executions.set(exec.callId, { exec, args, closed: false, inputHash: hash([exec.name, exec.callId, args]) });
            const decision = await next(); check(current);
            need(hash([exec.name, exec.callId, exec.arguments]) === executions.get(exec.callId).inputHash, 'DSH_CODE_APPROVAL_INPUT_CHANGED');
            return decision;
          } catch (error) { stop(errorCode(error, 'DSH_CODE_GATE_REVOKED')); throw firstFailure; }
        }, { prepend: true }));
        if (interactions) disposers.push(agentCtx.on('tools/result', exec => {
          const captured = executions.get(exec?.callId);
          if (captured?.exec === exec) captured.closed = true;
        }));
        disposers.push(agentCtx.on('agent/request', async (payload, next) => {
          try {
            need(submitted && payload?.agent === current && ++modelCalls <= maxModelCalls, 'DSH_CODE_MODEL_LIMIT');
            check(current); const config = await next(); check(current); checkRoute(config); return config;
          } catch (error) { stop(errorCode(error, 'DSH_CODE_GATE_REVOKED')); throw firstFailure; }
        }, { prepend: true }));
        disposers.push(agentCtx.on('agent/request-error', payload => {
          // rc.3 delegates failed-step retry to this waterfall. Cancel even if
          // outer middleware later returns {kind:'retry'}: the loop checks its
          // aborted signal before continuing. Never replay failed Code work.
          if (payload?.agent === current) stop('DSH_CODE_MODEL_FAILED');
          return undefined;
        }, { prepend: true }));
        disposers.push(agentCtx.on('approval/request', async request => {
          if (request?.agent !== current) return 'unavailable';
          if (!interactions) { interaction('approval', { toolName: label(request.toolName) ? request.toolName : 'unknown' }); return 'unavailable'; }
          try {
            const captured = executions.get(request.callId);
            const pending = [...approvals.values()].filter(item => !item.claimed && item.callId === request.callId && item.toolName === request.toolName);
            need(captured && !captured.closed && captured.exec.name === request.toolName && pending.length === 1, 'DSH_CODE_APPROVAL_UNBOUND');
            const approval = pending[0]; approval.claimed = true;
            const detail = jsonSnapshot({ toolName: request.toolName, args: captured.args,
              ...(request.reason === undefined ? {} : { reason: request.reason }),
              ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }) });
            need((detail.reason === undefined || typeof detail.reason === 'string')
              && (detail.displayReason === undefined || typeof detail.displayReason === 'string'), 'DSH_CODE_INTERACTION_INVALID');
            const fingerprint = hash(detail);
            const recheck = () => {
              need(!captured.closed && captured.exec.agent === current && executions.get(request.callId) === captured
                && captured.inputHash === hash([captured.exec.name, captured.exec.callId, captured.exec.arguments])
                && fingerprint === hash({ toolName: request.toolName, args: captured.exec.arguments,
                  ...(request.reason === undefined ? {} : { reason: request.reason }),
                  ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }) }), 'DSH_CODE_APPROVAL_INPUT_CHANGED');
              gateTool(request.toolName);
            };
            const answer = await waitForHuman(current, request, { kind: 'approval', taskId: task.id, sessionId,
              callId: request.callId, approval: detail }, recheck);
            need(answer === 'allowed-once' || answer === 'rejected', 'DSH_CODE_ANSWER_INVALID');
            approval.settled = true; approval.outcome = answer;
            return answer;
          } catch (error) { stop(errorCode(error, 'DSH_CODE_INTERACTION_FAILED')); return 'unavailable'; }
        }, { prepend: true }));
        disposers.push(agentCtx.on('user-questions/request', async request => {
          if (!interactions) {
            if (request?.agent === current) interaction('question', { questionCount: Array.isArray(request.questions) ? request.questions.length : 0 });
            throw failure('DSH_CODE_NEEDS_INPUT');
          }
          try {
            const questions = questionBatch(request.questions); const fingerprint = hash(questions);
            const callId = request.wait?.callId ?? `juebot-question-${hash([task.id, ++questionSequence])}`;
            need(label(callId), 'DSH_CODE_INTERACTION_INVALID');
            const response = await waitForHuman(current, request, { kind: 'question', taskId: task.id, sessionId, callId, questions }, () => {
              need(hash(request.questions) === fingerprint, 'DSH_CODE_INTERACTION_CHANGED');
            });
            return questionAnswer(response, questions);
          } catch (error) { stop(errorCode(error, 'DSH_CODE_INTERACTION_FAILED')); throw firstFailure; }
        }, { prepend: true }));
        disposers.push(agentCtx.on('session/event', (session, event) => {
          if (session !== current.session) return;
          try {
            if (submitted && event.seq >= baseSeq && ['turn/start', 'turn/end', 'user/message', 'assistant/message', 'approval/asked'].includes(event.type)) {
              need(observed.length < 20000, 'DSH_CODE_EVENT_LIMIT'); observed.push(event);
            }
            if (event.type === 'assistant/attempt') stop('DSH_CODE_MODEL_FAILED');
            else if (event.type === 'approval/asked') {
              if (!interactions) interaction('approval', { toolName: label(event.data?.toolName) ? event.data.toolName : 'unknown' });
              else {
                need(label(event.data?.id) && label(event.data.callId) && label(event.data.toolName)
                  && !approvals.has(event.data.id) && approvals.size < 256, 'DSH_CODE_APPROVAL_UNBOUND');
                approvals.set(event.data.id, { ...event.data, claimed: false, settled: false, audited: false });
              }
            } else if (event.type === 'approval/decided' && interactions) {
              const approval = approvals.get(event.data?.id);
              need(approval?.settled && !approval.audited && approval.outcome === event.data.outcome, 'DSH_CODE_APPROVAL_UNBOUND');
              approval.audited = true;
            }
            else if (event.type === 'request/header') { check(current); checkRoute(event.data?.header?.config); }
            else if (event.type === 'sandbox/mode') check(current);
            else if (event.type === 'working-directory/change') {
              need(samePath(directory(event.data?.cwd), workspace), 'DSH_CODE_WORKSPACE_CHANGED'); check(current);
            }
          } catch (error) { stop(errorCode(error, 'DSH_CODE_GATE_REVOKED')); }
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
      need(pendingInteractions === 0, 'DSH_CODE_INTERACTION_PENDING');
      result = finalText(observed, messageId, approvals);
      need(modelCalls > 0, 'DSH_CODE_TURN_INCOMPLETE');
    } catch (error) {
      stop(errorCode(error, 'DSH_CODE_EXECUTION_FAILED'));
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
