import { randomUUID } from 'node:crypto';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const need = (value, code = 'CODE_INTERACTION_INVALID') => { if (!value) fail(code); };
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const string = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
function shape(value, keys, required = keys) {
  need(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  need(Reflect.ownKeys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key)));
  need(Object.values(Object.getOwnPropertyDescriptors(value)).every(item => !item.get && !item.set));
}
function json(value) {
  const visit = (item, depth) => {
    need(depth < 20);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { need(Number.isFinite(item)); return; }
    if (typeof item === 'string') { need(item.length <= 12000 && !item.includes('\0')); return; }
    if (Array.isArray(item)) { need(item.length <= 64); item.forEach(child => visit(child, depth + 1)); return; }
    shape(item, Object.keys(item)); need(Object.keys(item).length <= 64); Object.values(item).filter(child => child !== undefined).forEach(child => visit(child, depth + 1));
  };
  visit(value, 0); need(JSON.stringify(value).length <= 12000); return JSON.parse(JSON.stringify(value));
}
function payload(value) {
  shape(value, ['kind', 'taskId', 'sessionId', 'callId', 'approval', 'questions'], ['kind', 'taskId', 'sessionId', 'callId']);
  need(['approval', 'question'].includes(value.kind) && [value.taskId, value.sessionId, value.callId].every(item => string(item)));
  const result = json(value);
  if (result.kind === 'approval') {
    need(result.questions === undefined); shape(result.approval, ['toolName', 'args', 'reason', 'displayReason'], ['toolName', 'args']);
    need(string(result.approval.toolName) && (result.approval.reason === undefined || typeof result.approval.reason === 'string')
      && (result.approval.displayReason === undefined || typeof result.approval.displayReason === 'string'));
  } else {
    need(result.approval === undefined && Array.isArray(result.questions) && result.questions.length > 0 && result.questions.length <= 8);
    const ids = new Set();
    for (const q of result.questions) {
      shape(q, ['id', 'question', 'detail', 'header', 'options', 'multiSelect', 'intent'], ['id', 'question']);
      need(string(q.id) && !ids.has(q.id) && typeof q.question === 'string' && q.question.trim()); ids.add(q.id);
      for (const key of ['detail', 'header']) need(q[key] === undefined || typeof q[key] === 'string');
      need(q.multiSelect === undefined || typeof q.multiSelect === 'boolean');
      if (q.options !== undefined) {
        need(Array.isArray(q.options) && q.options.length <= 16 && new Set(q.options.map(option => option.label)).size === q.options.length);
        for (const option of q.options) { shape(option, ['label', 'description'], ['label']); need(string(option.label) && (option.description === undefined || typeof option.description === 'string')); }
      }
      if (q.intent !== undefined) {
        shape(q.intent, ['kind', 'approve', 'callId'], ['kind', 'approve']);
        need(q.intent.kind === 'plan-review' && string(q.intent.approve) && q.options?.some(option => option.label === q.intent.approve)
          && typeof q.detail === 'string' && (q.intent.callId === undefined || string(q.intent.callId)));
      }
    }
  }
  return result;
}
function answer(answers, questions) {
  const checked = json(answers); need(Array.isArray(checked) && checked.length === questions.length);
  const seen = new Set();
  for (const item of checked) {
    shape(item, ['id', 'selected', 'custom'], ['id', 'selected']); const q = questions.find(q => q.id === item.id);
    need(q && !seen.has(item.id)); seen.add(item.id);
    need(Array.isArray(item.selected) && new Set(item.selected).size === item.selected.length && (q.multiSelect || item.selected.length <= 1)
      && item.selected.every(label => q.options?.some(option => option.label === label))
      && (item.custom === undefined || typeof item.custom === 'string') && (item.selected.length > 0 || item.custom?.trim()));
  }
  return { answers: checked };
}

/** A local human response resolves only its original running SDK promise. No SDK restart, approval tool or social learning. */
export function createCodeInteractions({ store, code, getOutbox, now = Date.now, namespace = 'default', timeoutMs = 300000 }) {
  need(store && code && typeof getOutbox === 'function' && string(namespace) && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 3600000);
  const key = JSON.stringify(['code-interactions-v1', namespace]); const live = new Map(); let closed = false;
  const state = () => store.read(key) ?? { revision: 0, value: { records: {}, replies: {}, events: {} } };
  const at = () => { const time = now(); need(Number.isSafeInteger(time) && time >= 0); return time; };
  const entries = () => Object.values(state().value.records).map(copy);
  const get = id => { const records = state().value.records; need(typeof id === 'string' && Object.hasOwn(records, id), 'CODE_INTERACTION_NOT_FOUND'); return copy(records[id]); };
  // Reserve worst-case escaped source text twice (request/task history), SDK answer,
  // and event metadata before accepting a wait. No approved detail is truncated.
  const capacity = value => need(Object.keys(value.records).length <= 64
    && JSON.stringify(value).length + Object.values(value.records).filter(row => row.status === 'pending').length * 300000 <= 7 * 1024 * 1024, 'CODE_INTERACTION_CAPACITY');
  const initial = state();
  if (Object.values(initial.value.records).some(row => row.status === 'pending')) store.atomic(tx => {
    const current = tx.read(key); for (const row of Object.values(current.value.records)) if (row.status === 'pending') { row.status = 'needs-review'; row.revision++; }
    tx.write(key, current.revision, current.value);
  });
  const verify = (row, waiting) => {
    need(!closed && waiting && !waiting.signal?.aborted, 'CODE_INTERACTION_UNAVAILABLE');
    need(row.status === 'pending' && at() < row.deadline, 'CODE_INTERACTION_EXPIRED');
    const task = code.get(row.taskId);
    need(task.state === 'running' && same(task.authorization, row.authorization) && same(task.input, row.input), 'CODE_INTERACTION_REVOKED');
    const result = waiting.check(); need(result !== false && (!result || typeof result.then !== 'function'), 'CODE_INTERACTION_INVALID');
  };
  const settle = (id, status, reason) => {
    const waiting = live.get(id); if (!waiting) return;
    let failureCode = reason;
    try {
      const current = state(); const row = current.value.records[id];
      if (row?.status === 'pending') store.atomic(tx => { const s = tx.read(key); const item = s.value.records[id]; if (item.status === 'pending') { item.status = status; item.revision++; tx.write(key, s.revision, s.value); } });
    } catch {
      // Leave an uncommitted pending row for startup invalidation. A timer or
      // AbortSignal callback must still release its original SDK waiter safely.
      failureCode = 'CODE_INTERACTION_STORAGE_FAILURE';
    } finally {
      live.delete(id); clearTimeout(waiting.timer);
      try { waiting.signal?.removeEventListener('abort', waiting.abort); } catch { /* Cleanup never grants permission. */ }
      waiting.reject(Object.assign(new Error(failureCode), { code: failureCode }));
    }
  };
  const replyEventId = taskId => state().value.replies[taskId]?.activeReplyEventId ?? code.get(taskId).input.eventId;
  const request = (raw, { signal, check } = {}) => {
    need(!closed && typeof check === 'function' && !signal?.aborted, 'CODE_INTERACTION_UNAVAILABLE');
    const value = payload(raw); const task = code.get(value.taskId); const time = at();
    need(task.state === 'running', 'CODE_INTERACTION_REVOKED');
    const current = state(); need(Object.keys(current.value.records).length < 64, 'CODE_INTERACTION_CAPACITY');
    // The authorized session name is logical. The trusted executor check proves the
    // derived SDK session; all further interactions for this task retain that binding.
    need(!Object.values(current.value.records).some(row => row.taskId === task.id && row.sessionId !== value.sessionId), 'CODE_INTERACTION_SESSION_CHANGED');
    need(!Object.values(current.value.records).some(row => row.taskId === task.id && row.status === 'pending'), 'CODE_INTERACTION_PENDING');
    need(!Object.values(current.value.records).some(row => row.taskId === task.id && row.sessionId === value.sessionId && row.callId === value.callId), 'CODE_INTERACTION_DUPLICATE');
    const tuple = JSON.parse(task.authorization.conversationKey);
    need(Array.isArray(tuple) && tuple.length === 8 && tuple[6] === 'direct' && tuple[5] === task.authorization.account && task.input.actor === task.authorization.adminActor, 'CODE_INTERACTION_ROUTE');
    const id = 'interaction-' + randomUUID(); const deadline = time + timeoutMs; need(Number.isSafeInteger(deadline));
    const context = `任务 ${task.id} · 工作区 ${task.authorization.workspaceId}\n`;
    const example = value.kind === 'question' ? JSON.stringify({ answers: value.questions.map(q => ({ id: q.id, selected: [], custom: '填写答复，或把选项标签填入 selected' })) }) : '';
    const text = value.kind === 'approval'
      ? `${context}工具审批（仅本次）\n${JSON.stringify(value.approval)}\n允许这一次：/code审批 ${id} 1 允许\n拒绝：/code审批 ${id} 1 拒绝`
      : `${context}任务问题\n${JSON.stringify(value.questions)}\n按各问题ID填写回答：\n/code答复 ${id} 1 ${example}`;
    need(text.length <= 16000 && new TextEncoder().encode(text).byteLength <= 16000, 'CODE_INTERACTION_TOO_LARGE');
    const row = { ...value, id, revision: 1, requestRevision: 1, text, status: 'pending', createdAt: time, deadline, authorization: copy(task.authorization), input: copy(task.input), sourceHistory: [] };
    const waiting = { signal, check }; verify(row, waiting);
    const projected = copy(current.value); projected.records[id] = row; capacity(projected);
    // Source is the latest successful, verified reply; the original task input is immutable.
    store.atomic(tx => {
      const s = tx.read(key) ?? { revision: 0, value: { records: {}, replies: {}, events: {} } };
      need(s.revision === current.revision, 'CODE_INTERACTION_CONFLICT'); s.value.records[id] = row;
      capacity(s.value); tx.write(key, s.revision, s.value);
      getOutbox().enqueueIn(tx, { id: id + ':notice', account: JSON.stringify(tuple.slice(3, 6)), conversation: task.authorization.conversationKey, kind: 'code-interaction',
        body: text, payload: { taskId: task.id, requestId: id, requestRevision: 1 },
        revisions: { binding: task.authorization.revision, policy: 0, memory: 0, expression: 0, identity: 0 }, sourceRefs: [], createdAt: time, dueAt: time, expiresAt: deadline, costUnits: 1 });
    });
    return new Promise((resolve, reject) => {
      Object.assign(waiting, { resolve, reject, abort: () => settle(id, 'cancelled', 'CODE_INTERACTION_CANCELLED') }); live.set(id, waiting);
      waiting.timer = setTimeout(() => settle(id, 'expired', 'CODE_INTERACTION_EXPIRED'), timeoutMs);
      signal?.addEventListener('abort', waiting.abort, { once: true }); if (signal?.aborted) waiting.abort();
    });
  };
  const respond = value => {
    shape(value, ['requestId', 'revision', 'kind', 'decision', 'answers', 'source'], ['requestId', 'revision', 'kind', 'source']);
    const row = get(value.requestId), waiting = live.get(row.id); verify(row, waiting);
    need(value.revision === row.revision && value.kind === row.kind, 'CODE_INTERACTION_CONFLICT');
    shape(value.source, ['eventId', 'actor', 'conversationKey', 'account', 'plain', 'text', 'observedAt']);
    const source = copy(value.source); need(string(source.eventId) && source.eventId !== row.input.eventId && source.actor === row.authorization.adminActor && source.account === row.authorization.account
      && source.conversationKey === row.authorization.conversationKey && source.plain === true && typeof source.text === 'string' && source.text.length <= 16000
      && Number.isSafeInteger(source.observedAt) && source.observedAt >= Math.floor(row.createdAt / 1000) * 1000
      && source.observedAt <= at() && at() - source.observedAt < 300000, 'CODE_INTERACTION_ROUTE');
    need(!Object.hasOwn(state().value.events, source.eventId), 'CODE_INTERACTION_EVENT_CONFLICT');
    let result;
    if (row.kind === 'approval') { need(value.answers === undefined && ['allowed-once', 'rejected'].includes(value.decision)); result = value.decision; }
    else { need(value.decision === undefined); result = answer(value.answers, row.questions); }
    store.atomic(tx => {
      const s = tx.read(key), saved = s.value.records[row.id]; need(saved.status === 'pending' && saved.revision === value.revision && !Object.hasOwn(s.value.events, source.eventId), 'CODE_INTERACTION_CONFLICT');
      saved.status = 'answered'; saved.revision++; saved.response = copy(result); saved.sourceHistory.push(source); saved.activeReplyEventId = source.eventId;
      Object.defineProperty(s.value.events, source.eventId, { value: row.id, enumerable: true, configurable: true, writable: true });
      const prior = s.value.replies[row.taskId] ?? { sourceHistory: [] }; prior.sourceHistory.push(source); prior.activeReplyEventId = source.eventId; s.value.replies[row.taskId] = prior;
      capacity(s.value); tx.write(key, s.revision, s.value);
    });
    live.delete(row.id); clearTimeout(waiting.timer); waiting.signal?.removeEventListener('abort', waiting.abort); waiting.resolve(copy(result));
    return { accepted: true, requestId: row.id, revision: row.revision + 1 };
  };
  const gate = delivery => {
    try {
      need(delivery.kind === 'code-interaction'); const row = get(delivery.payload?.requestId); verify(row, live.get(row.id));
      need(delivery.id === row.id + ':notice' && delivery.payload.taskId === row.taskId && delivery.payload.requestRevision === row.requestRevision
        && delivery.body === row.text && delivery.conversation === row.authorization.conversationKey
        && delivery.account === JSON.stringify(JSON.parse(row.authorization.conversationKey).slice(3, 6)), 'CODE_INTERACTION_ROUTE');
      return { allowed: true, reason: 'NONE' };
    } catch { return { allowed: false, reason: 'CODE_INTERACTION_UNAVAILABLE' }; }
  };
  return { request, respond, get, list: entries, gate, replyEventId,
    close() { if (closed) return; closed = true; for (const id of [...live.keys()]) settle(id, 'needs-review', 'CODE_INTERACTION_CLOSED'); } };
}
