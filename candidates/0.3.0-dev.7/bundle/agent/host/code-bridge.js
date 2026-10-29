const fail = code => { throw Object.assign(new Error(code), { code }); };
const need = (ok, code = 'CODE_BRIDGE_INVALID_CONFIG') => { if (!ok) fail(code); };

/** Serial forwarding into the existing DSH executor. Only a trusted connector
 * may call admit; HTTP/UI payloads never obtain this capability. Results enter
 * the shared Outbox and are not sent by this bridge. Construction runs nothing. */
export function createCodeBridge({ code, executor, getDispatcher, interactions = null, now = Date.now }) {
  need(code && typeof code.admit === 'function' && typeof code.execute === 'function'
    && typeof executor === 'function' && typeof getDispatcher === 'function' && typeof now === 'function');
  const pending = new Set(); const controller = new AbortController();
  let drain = null; let closing = null; let closed = false; let active = null; let lastFailure = null;
  async function run() {
    while (!closed && pending.size) {
      const id = pending.values().next().value; pending.delete(id);
      active = id;
      try {
        if (code.get(id).state !== 'queued') continue;
        const task = await code.execute(id, executor, { signal: controller.signal, now });
        if (!closed && task.resultDelivery === 'ready') getDispatcher().enqueueCode(id);
      } catch (error) {
        // Preserve task/domain state; no auto retry, no raw errors/Code material
        // in social logs. A completed result can be explicitly queued later.
        const safe = typeof error?.code === 'string' && /^[A-Z_]{1,80}$/u.test(error.code);
        lastFailure = { taskId: id, code: safe ? error.code : 'CODE_BRIDGE_FAILED' };
      } finally { active = null; }
    }
  }
  function schedule() {
    if (drain || closed) return;
    drain = Promise.resolve().then(run).finally(() => { drain = null; if (!closed && pending.size) schedule(); });
  }
  const bridge = {
    admit(input, at = now()) {
      need(!closed, 'CODE_BRIDGE_CLOSED');
      const result = code.admit(input, at);
      if (result.task.state === 'queued') { pending.add(result.task.id); schedule(); }
      return result;
    },
    get(id) { return code.get(id); },
    getInteraction(id) { need(interactions, 'CODE_INTERACTIONS_UNAVAILABLE'); return interactions.get(id); },
    replyEventId(taskId) { return interactions?.replyEventId(taskId) ?? code.get(taskId).input.eventId; },
    respondInteraction(input) {
      need(!closed, 'CODE_BRIDGE_CLOSED'); need(interactions, 'CODE_INTERACTIONS_UNAVAILABLE');
      return interactions.respond(input);
    },
    /** Called only after the connector verifies the same administrator/private
     * route as ordinary Code input. Commands bypass the busy model queue. */
    control(command, at = now()) {
      need(!closed, 'CODE_BRIDGE_CLOSED');
      need(command === '/开启code' || command === '/关闭code', 'CODE_BRIDGE_INVALID_COMMAND');
      const result = command === '/开启code' ? code.enable(at) : code.disable(at);
      return { enabled: result.value.enabled };
    },
    async idle() { while (drain) await drain; },
    /** Explicit retry of queue insertion only; this never re-executes Code. */
    enqueueResult(id) { need(!closed, 'CODE_BRIDGE_CLOSED'); return getDispatcher().enqueueCode(id); },
    status() { return { closed, active, pending: pending.size, lastFailure: lastFailure && { ...lastFailure } }; },
    close() {
      if (closing) return closing;
      closed = true; pending.clear();
      // Unloading is distinct from OFF. OFF only uses CodeTasks.disable and
      // leaves active work alone; unload must settle work before closing SQLite.
      let failed = false;
      try { controller.abort(Object.assign(new Error('CODE_BRIDGE_CLOSED'), { code: 'CODE_BRIDGE_CLOSED' })); } catch { failed = true; }
      try { interactions?.close(); } catch { failed = true; }
      try { code.restart(now()); } catch { failed = true; }
      // A failed shutdown write never removes the awaitable execution tail.
      // Drain first, then report failure; retrying close must return this tail.
      closing = bridge.idle().then(() => { if (failed) fail('CODE_BRIDGE_CLOSE_FAILED'); }, () => fail('CODE_BRIDGE_CLOSE_FAILED'));
      closing.catch(() => {}); return closing;
    }
  };
  return bridge;
}
