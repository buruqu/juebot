import { probeHostOnce, createStatusService, STATUS_INPUT_SCHEMA, STATUS_SCHEMA } from './diagnostics.js';

export const inject = ['cordisInspect', 'connection'];

function requireEmptyInput(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0)) {
    throw new Error('JUEBOT_STATUS_INPUT_NOT_SUPPORTED');
  }
}

/** Install-time Host activation only; callers of the read surface never run another probe. */
export async function apply(ctx, config = {}) {
  requireEmptyInput(config);
  const service = createStatusService(await probeHostOnce());
  const body = JSON.stringify(service.getStatus());
  const disposeInspect = ctx.effect(() => ctx.cordisInspect.register({
    manifest: {
      id: 'JuebotStatus',
      description: 'Read bounded juebot Host diagnostics captured at activation; no private data or business activation.',
      methods: [{
        name: 'getStatus',
        description: 'Return the captured Host runtime and memory-only SQLite checks without probing again or starting the bot.',
        inputSchema: STATUS_INPUT_SCHEMA,
        outputSchema: STATUS_SCHEMA,
      }],
    },
    query(method, input, { signal }) {
      if (method !== 'getStatus') throw new Error('JUEBOT_STATUS_METHOD_NOT_SUPPORTED');
      requireEmptyInput(input);
      signal.throwIfAborted();
      return service.getStatus();
    },
  }), 'juebot: readonly status inspect');
  try {
    // Connection owns lifecycle, Host/Origin/auth admission and the owner-Peer gate.
    ctx.connection.fetch.register({
      path: '/api/juebot/status', methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        request.signal.throwIfAborted();
        const headers = {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        };
        if (request.method !== 'GET') return new Response('{"error":"METHOD_NOT_ALLOWED"}', { status: 405, headers });
        if (new URL(request.url).search) return new Response('{"error":"PARAMETERS_NOT_ACCEPTED"}', { status: 400, headers });
        return new Response(body, { status: 200, headers });
      },
    });
  } catch (error) {
    // Do not leave half of the diagnostic surface if exact-route registration fails.
    await disposeInspect();
    throw error;
  }
}
