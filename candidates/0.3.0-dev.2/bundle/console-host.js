import { randomBytes } from 'node:crypto';
import { probeHostOnce, createStatusService, STATUS_INPUT_SCHEMA, STATUS_SCHEMA } from './diagnostics.js';
import { createControlService } from './lib/control.js';
import { openControlDomain } from './settings-domain.js';
import { inspectSettingsPath } from './settings-path.js';
import { controlRoutes } from './settings-http.js';
import { createIdentityTool, PUBLIC_CONTROL_SCHEMA } from './settings-tool.js';

export const inject = ['cordisInspect', 'connection', 'storageDomain', 'profileContext', 'tools', 'sandboxPolicy'];
function empty(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)) throw new Error('JUEBOT_STATUS_INPUT_NOT_SUPPORTED');
}
const SUMMARY_SCHEMA = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['available','summary'], properties: { available: { type: 'boolean', enum: [true] }, summary: PUBLIC_CONTROL_SCHEMA } },
  { type: 'object', additionalProperties: false, required: ['available','error'], properties: { available: { type: 'boolean', enum: [false] }, error: { type: 'string', enum: ['CONTROL_UNAVAILABLE'] } } },
] };

/** Module factories are injectable for offline tests; production always uses the shipped SDK adapter. */
export async function installControlPlane(ctx, config = {}, dependencies = {}) {
  empty(config);
  let control;
  let closeResource;
  let disposed = false;
  let entered = false;
  const registered = [];
  const once = action => {
    let result;
    return () => result ??= Promise.resolve().then(action);
  };
  const cleanup = once(async () => {
    disposed = true;
    let failure;
    for (const dispose of registered.reverse()) {
      try { await dispose(); } catch (error) { failure ??= error; }
    }
    try { await closeResource?.(); } catch (error) { failure ??= error; }
    if (failure) throw new Error('CONTROL_DISPOSAL_FAILED');
  });
  // Acquire lifecycle ownership BEFORE the first await. Cordis 4.0.5 rejects
  // effects on inactive contexts; entered also fails closed for a skipped setup.
  ctx.effect(() => {
    entered = true;
    return () => { disposed = true; return cleanup(); };
  }, 'juebot: control plane lifecycle');
  if (!entered || disposed) return;
  const register = disposer => registered.push(once(disposer));
  try {
    const snapshot = await (dependencies.probeHostOnce ?? probeHostOnce)();
    if (disposed) return;
    const status = createStatusService(snapshot);
    try {
      const port = await (dependencies.openControlDomain ?? openControlDomain)(ctx);
      closeResource = once(() => port.close());
      // Cleanup may already have finished while open was pending. Take explicit
      // ownership of the late handle rather than adding an effect to a dead ctx.
      if (disposed) { await closeResource(); return; }
      const profile = ctx.get('profileContext');
      control = createControlService(port, {
        inspectPath: (candidate, signal) => (dependencies.inspectPath ?? inspectSettingsPath)(candidate, signal, { excludedRoots: [profile.dir] }),
        token: dependencies.token ?? (() => randomBytes(24).toString('base64url')),
        now: dependencies.now ?? (() => Date.now()),
      });
      const ownedControl = control;
      closeResource = once(() => ownedControl.close());
    } catch {
      // Invalid or unavailable configuration is not reset or replaced by defaults.
      try {
        await closeResource?.();
      } catch { throw new Error('CONTROL_DISPOSAL_FAILED'); }
      control = undefined;
    }
    if (disposed) return;
    const summary = () => {
      if (!control) return { available: false, error: 'CONTROL_UNAVAILABLE' };
      try { return { available: true, summary: control.readSummary() }; }
      catch { return { available: false, error: 'CONTROL_UNAVAILABLE' }; }
    };
    register(ctx.cordisInspect.register({
      manifest: { id: 'JuebotStatus', description: 'Read captured Host diagnostics and a non-sensitive setup summary; no private QQ, paths or authority writes.', methods: [
        { name: 'getStatus', description: 'Read the activation-time memory-only diagnostic snapshot; does not probe again.', inputSchema: STATUS_INPUT_SCHEMA, outputSchema: STATUS_SCHEMA },
        { name: 'getSetupSummary', description: 'Read current setup revision, public identity and pending states; does not reveal private configuration values.', inputSchema: STATUS_INPUT_SCHEMA, outputSchema: SUMMARY_SCHEMA },
      ] },
      query(method, input, { signal }) {
        empty(input); signal.throwIfAborted();
        if (method === 'getStatus') return status.getStatus();
        if (method === 'getSetupSummary') return summary();
        throw new Error('JUEBOT_STATUS_METHOD_NOT_SUPPORTED');
      },
    }));
    register(ctx.tools.register(createIdentityTool(() => control, ctx)));
    register(ctx.connection.fetch.register({
      path: '/api/juebot/status', methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        request.signal.throwIfAborted();
        const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
        if (request.method !== 'GET' || new URL(request.url).search) return new Response('{"error":"INVALID_REQUEST"}', { status: 400, headers });
        return new Response(JSON.stringify(status.getStatus()), { headers });
      },
    }));
    for (const route of controlRoutes(() => control)) register(ctx.connection.fetch.register(route));
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function apply(ctx, config = {}) { await installControlPlane(ctx, config); }
