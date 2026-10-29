export const inject = ['connection'];
export const HOST_PRINCIPAL = 'juebot-host-owner';
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const ROUTES = Object.freeze({ health: ['GET'], status: ['GET'], conversations: ['GET'], events: ['GET'], body: ['GET'],
  settings: ['GET', 'POST'], memory: ['GET','POST'], self: ['GET'], creations: ['GET'], creation: ['GET'],
  review: ['POST'], submit: ['POST'], outbox: ['GET'], pause: ['POST'], code: ['GET', 'POST'], 'local-message': ['POST'],
  'creation-recovery':['POST'], reconcile:['POST'], trace:['GET'], 'expression-preview':['POST'],
  'summary-creation':['POST'], 'creation-start':['POST'], 'creation-intention':['POST'], 'bili-source':['GET','POST'],
  media: ['GET'], identity: ['GET', 'POST'], learning: ['GET', 'POST'], growth: ['GET', 'POST'] });
const unavailable = () => new Response('{"ok":false,"error":{"code":"AGENT_UNAVAILABLE"}}', { status: 503, headers: HEADERS });
const once = fn => { let result; return () => result ??= Promise.resolve().then(fn); };

/** Connection exact routes enforce owner admission. No WebServer, credentials, DB open or synthetic bootstrap. */
export async function installAgentPlane(ctx, config = {}, dependencies = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('AGENT_INVALID_CONFIGURATION');
  let entered = false, disposed = false, application, closeApplication;
  const registrations = [];
  const cleanup = once(async () => {
    disposed = true;
    let failed = false;
    await Promise.all(registrations.map(async dispose => { try { await dispose(); } catch { failed = true; } }));
    try { await closeApplication?.(); } catch { failed = true; }
    if (failed) throw new Error('AGENT_DISPOSAL_FAILED');
  });
  ctx.effect(() => { entered = true; return () => { disposed = true; return cleanup(); }; }, 'juebot: agent lifecycle');
  if (!entered || disposed) return;
  try {
    if (dependencies.openApplication) {
      try {
        const opened = await dependencies.openApplication(ctx, config, { principal: HOST_PRINCIPAL });
        if (opened && typeof opened.close === 'function') closeApplication = once(() => opened.close());
        if (disposed) { await closeApplication?.(); return; }
        if (opened && typeof opened.fetch === 'function' && typeof opened.close === 'function') application = opened;
        else await closeApplication?.();
      } catch {
        try { await closeApplication?.(); } catch { throw new Error('AGENT_DISPOSAL_FAILED'); }
        application = undefined;
      }
    }
    if (disposed) return;
    for (const [suffix, methods] of Object.entries(ROUTES)) {
      const release = ctx.connection.fetch.register({ path: '/api/juebot/agent/' + suffix, methods,
        requestBody: methods.includes('POST') ? 'streaming' : 'buffered',
        async fetch(request) {
          request.signal.throwIfAborted();
          if (disposed) return unavailable();
          // Connection still enforces owner admission. This proves route reachability,
          // not application readiness, and deliberately exposes no runtime state.
          if (suffix === 'health') return new Response('{"ok":true,"data":{"probe":1}}', { headers: HEADERS });
          if (!application) return unavailable();
          // Only reached after Connection's owner gate; the factory received our fixed Host principal.
          try { const response = await application.fetch(request); request.signal.throwIfAborted(); return disposed ? unavailable() : response; }
          catch { request.signal.throwIfAborted(); return unavailable(); }
        } });
      registrations.push(once(release));
    }
    console.info('[juebot-agent] registered fetch routes: %d', registrations.length);
  } catch (error) { await cleanup(); throw error; }
}
export async function apply(ctx, config = {}) { return installAgentPlane(ctx, config); }
