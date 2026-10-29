import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { openDshApplication } from '../../host/dsh-application.js';

// Packages must already exist. This helper never installs dependencies or reads a profile.
export async function realHost(t, { baseline = false, unavailable = false, patched = false } = {}) {
  const dependencyRoot = process.env.JUEBOT_REAL_HOST_DEPS;
  assert.ok(dependencyRoot, 'Set JUEBOT_REAL_HOST_DEPS to existing extracted package root');
  const require = createRequire(path.join(path.resolve(dependencyRoot), 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { WebServer }, connection] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-host-webserver'), patched ? import(pathToFileURL(path.resolve(process.env.JUEBOT_REAL_HOST_CONNECTION_CANDIDATE)).href) : load('@deepseek-ai/dsh-client-connection')]);
  const ctx = new Context();
  const parent = realpathSync(tmpdir()); const root = mkdtempSync(path.join(parent, 'juebot-real-http-'));
  let app, record;
  const versions = Object.fromEntries(['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-connection'].map(name => {
    const entry = require.resolve(name); return [name, { version: JSON.parse(readFileSync(path.resolve(path.dirname(entry), '../package.json'))).version, entry }];
  }));
  if (process.env.JUEBOT_REAL_HOST_MANIFEST) {
    const manifest = JSON.parse(readFileSync(process.env.JUEBOT_REAL_HOST_MANIFEST, 'utf8').replace(/^\uFEFF/u, ''));
    for (const pkg of manifest.packages) assert.equal(createHash('sha256').update(readFileSync(pkg.entry)).digest('hex'), pkg.sha256);
    if (patched) { assert.equal(path.resolve(manifest.candidate.path), path.resolve(process.env.JUEBOT_REAL_HOST_CONNECTION_CANDIDATE)); assert.equal(createHash('sha256').update(readFileSync(manifest.candidate.path)).digest('hex'), manifest.candidate.sha256); }
    t.diagnostic(JSON.stringify({ manifest: process.env.JUEBOT_REAL_HOST_MANIFEST, sourceAsarSha256: manifest.source.sha256, candidateSha256: patched ? manifest.candidate.sha256 : null }));
  }
  t.diagnostic(JSON.stringify({ node: process.version, versions }));
  t.after(async () => {
    try { await ctx.fiber.dispose(); assert.equal(ctx.connection, undefined); }
    finally { await app?.close(); assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('juebot-real-http-')); rmSync(root, { recursive: true, force: true }); }
  });
  // Only a fresh memory record store is synthetic. BrowserAuth, cookies, admission, route
  // registry, HTTP bridge, Cordis lifetimes, application and SQLite are the real implementations.
  ctx.provide('credentials', { async modifyRecord(_key, update) { const next = await update(record); if (next !== undefined) record = next; return record; } });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(connection, {});
  const origin = ctx.webServer.getOrigin();
  let install;
  if (baseline) {
    const sourcePath = process.env.JUEBOT_REAL_HOST_BASELINE ?? path.resolve(import.meta.dirname, '../../../../candidates/0.3.0-dev.6/bundle/agent/host/console-host.js');
    let source = readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n');
    assert.ok(source.includes("requestBody: 'streaming'"));
    // Copy sealed dev.6 unchanged except one separate static buffered health route.
    source = source.replace('    if (disposed) return;\n    for (const [suffix, methods]', `    if (disposed) return;
    registrations.push(once(ctx.connection.fetch.register({ path: '/api/juebot/agent/health', methods: ['GET'], requestBody: 'buffered', fetch: () => new Response('{"ok":true,"data":{"probe":1}}', { headers: HEADERS }) })));
    for (const [suffix, methods]`);
    assert.ok(source.includes("path: '/api/juebot/agent/health'"));
    const fixturePath = path.join(root, 'dev6-console-health.mjs'); writeFileSync(fixturePath, source);
    if (process.env.JUEBOT_REAL_HOST_EVIDENCE) { const dir = process.env.JUEBOT_REAL_HOST_EVIDENCE; assert.ok(existsSync(dir)); writeFileSync(path.join(dir, 'dev6-console-health.mjs'), source); }
    install = (await import(pathToFileURL(fixturePath).href)).installAgentPlane;
  } else install = (await import('../../host/console-host.js')).installAgentPlane;
  await ctx.plugin({ inject: ['connection'], apply: async agentCtx => install(agentCtx,
    { enabled: true, dataRoot: root, namespace: 'synthetic-real-host', initializeEmpty: true, localChat: true, dshModel: { enabled: false } },
    { openApplication: unavailable ? async () => { throw Error('SYNTHETIC_NOT_READY'); } : async (...args) => (app = await openDshApplication(...args)) }) });
  t.diagnostic(JSON.stringify({ baseline, patched, routes: [...ctx.connection.fetchRoutes.keys()].sort() }));
  const auth = async () => {
    const url = ctx.connection.authenticatedUrl(new URL('/connect', origin).href);
    const response = await fetch(url, { redirect: 'manual' }); assert.equal(response.status, 302);
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); return cookie;
  };
  const cookie = await auth();
  const owner = async (suffix, options = {}) => fetch(origin + '/api/juebot/agent/' + suffix, { ...options, headers: { cookie, ...options.headers }, signal: options.signal ?? AbortSignal.timeout(15000) });
  return { ctx, app, root, origin, cookie, owner, auth, async foreignCookie() {
    const prior = new Set(ctx.connection.peers.keys()); const foreign = await auth();
    const id = [...ctx.connection.peers.keys()].find(id => !prior.has(id)); assert.ok(id);
    const entry = ctx.connection.peers.get(id); const original = entry.peer;
    entry.peer = ctx.connection.createPeer({ principal: { kind: 'synthetic-nonowner' } }); await original.dispose(); return foreign;
  } };
}
export function raw(f, suffix, { method = 'POST', body, stall = false, cancelAfter } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = http.request(f.origin + '/api/juebot/agent/' + suffix, { method, headers: { cookie: f.cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), elapsed: performance.now() - started, framing: { contentLength: /\r\ncontent-length:/iu.test(request._header ?? ''), transferEncoding: /\r\ntransfer-encoding:/iu.test(request._header ?? '') } }));
    });
    request.on('error', error => cancelAfter === undefined ? reject(error) : resolve({ cancelled: error.code, elapsed: performance.now() - started, framing: { contentLength: /\r\ncontent-length:/iu.test(request._header ?? ''), transferEncoding: /\r\ntransfer-encoding:/iu.test(request._header ?? '') } }));
    request.setTimeout(14000, () => request.destroy(Error('TEST_HTTP_TIMEOUT')));
    if (body !== undefined) request.write(body);
    if (stall) request.flushHeaders(); else request.end();
    if (cancelAfter !== undefined) setTimeout(() => request.destroy(Object.assign(Error('SYNTHETIC_CANCEL'), { code: 'SYNTHETIC_CANCEL' })), cancelAfter).unref();
  });
}




