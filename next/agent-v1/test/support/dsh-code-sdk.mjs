// Deliberately synthetic in-process contract service. No DSH plugins, model,
// filesystem tools, QQ accounts or external connections are started here.
export function syntheticDsh({ workspace, behavior, mode = 'workspace-write', beforeCreate, dispose } = {}) {
  const calls = []; const persisted = new Map(); const runs = [];
  const fixture = { calls, runs, persisted, mode, workspace, disposed: 0, cancelled: 0 };
  async function open(kind, options) {
    calls.push({ kind, options });
    if (beforeCreate) await beforeCreate(kind, options);
    const id = kind === 'create' ? options.sessionId : options.resumeSessionId;
    const events = kind === 'create' ? [] : [...(persisted.get(id) ?? [])];
    if (kind === 'resume' && !persisted.has(id)) throw new Error('SYNTHETIC_SESSION_MISSING');
    const listeners = new Map(); const guards = []; const restrictions = [];
    const hooks = {
      on(name, fn, flags) {
        const values = listeners.get(name) ?? []; flags?.prepend ? values.unshift(fn) : values.push(fn); listeners.set(name, values);
        return () => { const at = values.indexOf(fn); if (at >= 0) values.splice(at, 1); };
      },
      tools: {
        restrict(value) { restrictions.push(value); return () => { const at = restrictions.indexOf(value); if (at >= 0) restrictions.splice(at, 1); }; },
        guard(value) { guards.push(value); return () => { const at = guards.indexOf(value); if (at >= 0) guards.splice(at, 1); }; }
      }
    };
    const session = {
      id, header: { id, cwd: kind === 'create' ? options.meta.cwd : fixture.workspace },
      get seq() { return events.length; }, snapshotEvents(start = 0) { return structuredClone(events.slice(start)); }
    };
    const emit = (type, data) => {
      const event = { type, data, seq: events.length, time: events.length }; events.push(event);
      for (const listener of [...(listeners.get('session/event') ?? [])]) listener(session, event);
      return event;
    };
    const hook = async (name, payload, final = async () => undefined) => {
      const fns = [...(listeners.get(name) ?? [])];
      const invoke = index => index === fns.length ? final() : fns[index](payload, () => invoke(index + 1));
      return invoke(0);
    };
    let pending = Promise.resolve();
    const agent = {
      id, session, ctx: hooks, options: { ...options.agentOptions }, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      cancel() { fixture.cancelled++; },
      followup(message) {
        agent.status = 'running';
        pending = Promise.resolve().then(async () => {
          const turn = events.filter(event => event.type === 'turn/start').length + 1;
          const run = { agent, session, options, message, turn, emit, hook, guards, restrictions, listeners,
            async model(config = options.agentOptions) {
              const proposed = await hook('agent/request', { agent, turn, step: 1, signal: options.signal }, async () => config);
              emit('request/header', { header: { config: proposed } }); options.signal.throwIfAborted(); return proposed;
            },
            tool(name) { return guards.map(guard => guard({ agent, name })).find(reason => reason !== undefined); },
            async approvedTool(name, args, { callId = `call-${events.length}`, beforeAnswer, afterAnswer } = {}) {
              const exec = { agent, name, arguments: structuredClone(args), callId, token: {}, signal: options.signal };
              const decision = await hook('tools/pre-execute', exec, async () => ({ kind: 'ask', reason: 'synthetic tool permission' }));
              options.signal.throwIfAborted();
              const id = `approval-${events.length}`;
              emit('approval/asked', { id, toolName: name, callId, reason: decision.reason });
              const request = { agent, toolName: name, callId, reason: decision.reason, signal: options.signal };
              beforeAnswer?.(exec, request);
              const outcome = await hook('approval/request', request, async () => 'unavailable');
              afterAnswer?.(exec, request);
              emit('approval/decided', { id, outcome }); options.signal.throwIfAborted();
              if (outcome !== 'allowed-once') {
                await hook('tools/result', exec); return { outcome, executed: false, exec };
              }
              const denial = guards.map(guard => guard(exec)).find(reason => reason !== undefined);
              options.signal.throwIfAborted(); await hook('tools/result', exec); return { outcome, executed: denial === undefined, exec };
            },
            assistant(text = 'SYNTHETIC-CODE-RESULT', content) { emit('assistant/message', { turn, step: 1,
              message: { id: 'assistant-result', role: 'assistant', source: { kind: 'model' }, content: content ?? [{ type: 'text', text }] }, stream: [] }); },
            end(kind = 'completed') { emit('turn/end', { turn, reason: { kind } }); }
          };
          runs.push(run);
          if (behavior) await behavior(run, fixture);
          else { emit('turn/start', { turn }); await run.model(); emit('user/message', message); run.assistant(); run.end(); }
        }).finally(() => { agent.status = 'idle'; });
        pending.catch(() => {});
      },
      whenIdle() { return pending; }
    };
    await options.setup(hooks, agent);
    persisted.set(id, events);
    return { agent, async dispose() { fixture.disposed++; if (dispose) await dispose(agent); persisted.set(id, events); } };
  }
  fixture.ctx = {
    agents: { create: options => open('create', options), resume: options => open('resume', options) },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: fixture.mode, workspaceRoot: fixture.workspace, sessionId: session.id }) }
  };
  return fixture;
}
