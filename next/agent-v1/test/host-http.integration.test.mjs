import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { realHost, raw } from './support/real-host-http.mjs';
const enabled = Boolean(process.env.JUEBOT_REAL_HOST_DEPS);
const options = { skip: enabled ? false : 'Needs existing real Host dependencies: JUEBOT_REAL_HOST_DEPS (no installation performed)' };
const candidateOptions = { skip: enabled && process.env.JUEBOT_REAL_HOST_CONNECTION_CANDIDATE ? false : 'Needs explicit isolated connection candidate path' };
const mixed = ['settings', 'memory', 'code', 'identity', 'learning', 'growth', 'bili-source'];

test('real Host TCP: dev.6 bridge reproduces streaming GET failure; same route buffered restores it', options, async t => {
  const f = await realHost(t, { baseline: true });
  const health = await f.owner('health'); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true, data: { probe: 1 } });
  const before = await f.owner('status'); const body = await before.text();
  assert.equal(before.status, 400); assert.equal(body, '');
  // One live listener, route callback, application and authenticated cookie. Only the
  // transport descriptor changes; restore it and require failure to return.
  const descriptor = f.ctx.connection.fetchRoutes.get('/api/juebot/agent/status');
  assert.equal(descriptor.requestBody, 'streaming'); descriptor.requestBody = 'buffered';
  const buffered = await f.owner('status'); assert.equal(buffered.status, 200); assert.equal((await buffered.json()).data.runtime, 'offline');
  descriptor.requestBody = 'streaming'; const restored = await f.owner('status'); assert.equal(restored.status, 400); await restored.text();
  t.diagnostic(JSON.stringify({ dev6Health: 200, dev6StreamingStatus: before.status, sameRouteBufferedStatus: buffered.status, restoredStreamingStatus: restored.status }));
});

async function admission(t, patched) {
  const f = await realHost(t, { patched });
  const status = await f.owner('status'); assert.equal(status.status, 200); const result = await status.json();
  assert.equal(result.ok, true); assert.equal(result.data.runtime, 'offline'); assert.equal(result.data.modelConfigured, false); assert.equal(result.data.paused, true); assert.equal(result.data.codeEnabled, false);
  const health = await f.owner('health'); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true, data: { probe: 1 } });
  for (const route of ['status', 'health']) {
    assert.ok([401, 403].includes((await fetch(f.origin + '/api/juebot/agent/' + route)).status));
    const foreign = await f.foreignCookie(); assert.equal((await fetch(f.origin + '/api/juebot/agent/' + route, { headers: { cookie: foreign } })).status, 403);
  }
  const noFraming = await raw(f, 'status', { method: 'GET' }); assert.equal(noFraming.status, 200); assert.equal(JSON.parse(noFraming.body).data.runtime, 'offline'); assert.deepEqual(noFraming.framing, { contentLength: false, transferEncoding: false });
  const key = f.app.runtime.conversations()[0].key;
  const outcomes = [];
  for (const route of mixed) {
    const suffix = route === 'memory' ? route + '?key=' + encodeURIComponent(key) : route;
    const response = await f.owner(suffix); const contentType = response.headers.get('content-type');
    outcomes.push({ route, status: response.status, contentType });
    if (!patched) { assert.equal(response.status, 400); assert.equal(contentType, null); await response.text(); }
    else {
      assert.match(contentType ?? '', /application\/json/u, `${route} must reach agent API`);
      const json = await response.json();
      if (route === 'bili-source') { assert.equal(response.status, 400); assert.equal(json.error.code, 'INVALID_INPUT'); }
      else { assert.equal(response.status, 200, JSON.stringify(json)); assert.equal(json.ok, true); }
    }
  }
  const self = await f.owner('self?key=' + encodeURIComponent(key)); assert.equal(self.status, 200); await self.json();
  if (patched) {
    const head = await f.owner('status', { method: 'HEAD' }); assert.equal(head.status, 404); assert.equal(await head.text(), '');
    const mixedHead = await f.owner('settings', { method: 'HEAD' }); assert.equal(mixedHead.status, 404); assert.equal(await mixedHead.text(), '');
  }
  t.diagnostic(JSON.stringify({ patched, status: result, noFramingGet: { status: noFraming.status, framing: noFraming.framing }, mixed: outcomes }));
}
test('real Host TCP: dev.7 original bridge restores pure GET, mixed GET still fails (expected control)', options, t => admission(t, false));
test('real Host TCP: dev.7 candidate bridge restores all GET and preserves owner gates and HEAD 404', candidateOptions, t => admission(t, true));

test('real Host TCP: health remains reachable if application initialization fails', options, async t => {
  const f = await realHost(t, { unavailable: true }); assert.equal((await f.owner('status')).status, 503);
  const health = await f.owner('health'); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true, data: { probe: 1 } });
});
function sqliteSnapshot(root) {
  return JSON.stringify(['agent.sqlite', 'events.sqlite'].map(name => {
    const db = new DatabaseSync(path.join(root, name), { readOnly: true });
    try { return [name, db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()])]; }
    finally { db.close(); }
  }));
}
for (const patched of [false, true]) test(`real Host TCP: ${patched ? 'candidate' : 'original'} bridge POST 64 KiB, 10s timeout and cancellation preserve SQLite`, { ...(patched ? candidateOptions : options), timeout: 30000 }, async t => {
  const f = await realHost(t, { patched }); const key = f.app.runtime.conversations()[0].key;
  f.app.runtime.memory.configure(0, { permissions: { receive: true, save: true, reply: false, learn: false, proactive: false } });
  const before = sqliteSnapshot(f.root); const json = JSON.stringify({ key, text: 'synthetic' });
  const padded = json + ' '.repeat(65536 - Buffer.byteLength(json));
  const boundary = await raw(f, 'local-message', { body: padded }); assert.equal(boundary.status, 503); assert.equal(JSON.parse(boundary.body).error.code, 'AGENT_OPERATION_FAILED');
  const over = await raw(f, 'local-message', { body: padded + ' ' }); assert.equal(over.status, 400); assert.equal(JSON.parse(over.body).error.code, 'BODY_TOO_LARGE');
  const timed = await raw(f, 'local-message', { body: '{', stall: true });
  assert.equal(timed.status, 400); assert.equal(JSON.parse(timed.body).error.code, 'BODY_TIMEOUT'); assert.ok(timed.elapsed >= 9500 && timed.elapsed < 14000);
  const cancelled = await raw(f, 'local-message', { body: '{', stall: true, cancelAfter: 100 }); assert.equal(cancelled.cancelled, 'SYNTHETIC_CANCEL');
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(sqliteSnapshot(f.root), before);
  assert.equal((await f.owner('health')).status, 200);
  t.diagnostic(JSON.stringify({ patched, boundaryBytes: Buffer.byteLength(padded), boundary, over, timed, cancelled, sqliteUnchanged: true }));
});



for (const patched of [false, true]) test(`real Host TCP: ${patched ? 'candidate' : 'original'} bridge explicitly registered streaming HEAD`, patched ? candidateOptions : options, async t => {
  const f = await realHost(t, { patched });
  // A test-only path in this fresh context reaches the bridge's streaming HEAD
  // branch. Product route methods remain unchanged (and still reject HEAD).
  f.ctx.connection.fetch.register({ path: '/api/juebot-test/streaming-head', methods: ['HEAD'], requestBody: 'streaming', fetch: () => new Response(null, { status: 200 }) });
  const response = await fetch(f.origin + '/api/juebot-test/streaming-head', { method: 'HEAD', headers: { cookie: f.cookie }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, patched ? 200 : 400); assert.equal(await response.text(), '');
  t.diagnostic(JSON.stringify({ patched, explicitStreamingHead: response.status }));
});
