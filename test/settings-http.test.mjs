import test from 'node:test';
import assert from 'node:assert/strict';
import { controlRoutes, readControlJson } from '../candidates/0.2.0-dev.1/bundle/settings-http.js';
import { integration, z } from './helpers/settings-integration.mjs';

const code = expected => error => error?.code === expected;
const encoder = new TextEncoder();
const request = (body, options = {}) => new Request('http://synthetic.invalid/api/juebot/settings/identity', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...options });
const identity = (revision, name) => ({ expectedRevision: revision, patch: { name } });
const route = service => controlRoutes(() => service).find(item => item.path.endsWith('/identity')).fetch;

test('HTTP + real adapter/Zod: same revision competition returns 409 and retains winner', async () => {
  const { service, facility } = await integration();
  try {
    const fetch = route(service);
    const responses = await Promise.all([fetch(request(identity(0, 'winner'))), fetch(request(identity(0, 'loser')))]);
    assert.deepEqual(responses.map(r => r.status), [200, 409]);
    assert.deepEqual(await responses[1].json(), { ok: false, error: { code: 'CONTROL_REVISION_CONFLICT' } });
    assert.equal(service.readOwner().identity.name, 'winner');
    assert.equal(service.readOwner().revision, 1);
    assert.equal(facility.commits.length, 1);
  } finally { await service.close(); }
});

test('HTTP rejects unknown fields and redacts private SDK/Zod failure details', async () => {
  const { service, facility } = await integration();
  try {
    const secret = 'synthetic-private-QQ-123456-path-persona';
    await service.updateIdentity({ expectedRevision: 0, patch: { personaCard: secret } });
    await service.owner.setAdmin({ expectedRevision: 1, qq: '123456', acknowledgeReset: true });
    const fetch = route(service);
    for (const input of [{ ...identity(2, 'x'), role: 'owner' }, { expectedRevision: 2, patch: { admin: { qq: '1' } } }]) {
      const result = await fetch(request(input));
      assert.equal(result.status, 400); assert.equal((await result.json()).error.code, 'UNKNOWN_CONTROL_FIELD');
    }
    facility.fail = new Error(secret);
    const result = await fetch(request(identity(2, 'fails')));
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { ok: false, error: { code: 'CONTROL_OPERATION_FAILED' } });
    assert.equal(service.readOwner().revision, 2);
    assert.equal(service.readOwner().identity.personaCard, secret);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    facility.fail = new z.ZodError([{ code: 'custom', path: ['synthetic-private-path'], message: secret }]);
    const schemaFailure = await fetch(request(identity(2, 'schema-fails')));
    assert.equal(schemaFailure.status, 503);
    assert.deepEqual(await schemaFailure.json(), { ok: false, error: { code: 'CONTROL_OPERATION_FAILED' } });
  } finally { await service.close(); }
});

test('streamed JSON enforces exact 64KiB limit even with lying/missing Content-Length', async () => {
  for (const length of [undefined, '2']) {
    let cancelled = 0;
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(' '.repeat(32768))); c.enqueue(encoder.encode(' '.repeat(32769))); }, cancel() { cancelled++; } });
    const headers = { 'content-type': 'application/json', ...(length ? { 'content-length': length } : {}) };
    await assert.rejects(readControlJson(request('', { body, duplex: 'half', headers })), code('CONTROL_BODY_TOO_LARGE'));
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
  }
  assert.equal(await readControlJson(request('"' + 'x'.repeat(65534) + '"')), 'x'.repeat(65534));
});

test('stream timeout and abort cancel/release a stalled body without awaiting hostile cancel', async () => {
  for (const aborting of [false, true]) {
    let cancelled = 0;
    const controller = new AbortController();
    const body = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } });
    const pending = readControlJson(request('', { body, duplex: 'half', signal: controller.signal }), { timeoutMs: 15 });
    if (aborting) controller.abort();
    await assert.rejects(pending, code(aborting ? 'CONTROL_REQUEST_ABORTED' : 'CONTROL_BODY_TIMEOUT'));
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
  }
});

test('JSON intake rejects bad UTF8, JSON, media types, query strings and encoding', async () => {
  const cases = [
    [request('', { body: new Uint8Array([0x22, 0xc0, 0xaf, 0x22]) }), 'INVALID_CONTROL_JSON'],
    [request('{broken'), 'INVALID_CONTROL_JSON'],
    [request('{}', { headers: { 'content-type': 'text/json' } }), 'JSON_CONTENT_TYPE_REQUIRED'],
    [request('{}', { headers: { 'content-type': 'application/json;charset=latin1' } }), 'JSON_CONTENT_TYPE_REQUIRED'],
    [request('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), 'CONTENT_ENCODING_NOT_SUPPORTED'],
    [new Request('http://synthetic.invalid/api?role=owner', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), 'INVALID_CONTROL_REQUEST'],
    [request('{}', { headers: { 'content-type': 'application/json', 'content-length': '65537' } }), 'CONTROL_BODY_TOO_LARGE'],
  ];
  for (const [input, expected] of cases) await assert.rejects(readControlJson(input), code(expected));
});

test('HTTP maps bad UTF8/media type/oversize to safe envelopes; streamed UTF8 can span chunks', async () => {
  const { service, facility } = await integration();
  try {
    const fetch = route(service);
    for (const [input, status, expected] of [
      [request('', { body: new Uint8Array([0xff]) }), 400, 'INVALID_CONTROL_JSON'],
      [request('{}', { headers: { 'content-type': 'text/plain' } }), 415, 'JSON_CONTENT_TYPE_REQUIRED'],
      [request(' '.repeat(65537)), 413, 'CONTROL_BODY_TOO_LARGE'],
    ]) {
      const response = await fetch(input);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { ok: false, error: { code: expected } });
    }
    assert.equal(facility.commits.length, 0);
    const bytes = encoder.encode(JSON.stringify(identity(0, '测试')));
    const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    assert.equal((await fetch(request('', { body, duplex: 'half' }))).status, 200);
    assert.equal(service.readOwner().identity.name, '测试');
  } finally { await service.close(); }
});

test('route rejects unavailable service, GET query and already aborted writes without mutation', async () => {
  const unavailable = await route(undefined)(request(identity(0, 'x')));
  assert.equal(unavailable.status, 503);
  const { service, facility } = await integration();
  try {
    const get = controlRoutes(() => service)[0].fetch;
    assert.equal((await get(new Request('http://synthetic.invalid/api/juebot/settings?x=1'))).status, 400);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(route(service)(request(identity(0, 'x'), { signal: abort.signal })));
    assert.equal(facility.commits.length, 0);
  } finally { await service.close(); }
});
