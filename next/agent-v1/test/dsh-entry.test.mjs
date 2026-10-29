import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { inject, installDshAgent } from '../host/dsh-entry.js';

const enabled = { enabled: true, dshModel: { enabled: true } };
async function eventually(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'Cordis lifecycle did not settle within 500ms');
}
async function harness(t, config, open) {
  const { Context } = await import(pathToFileURL(process.env.JUEBOT_DSH_CORDIS_MODULE));
  const ctx = new Context(); const routes = new Map(); const errors = [];
  // This is the actual installed Cordis engine with synthetic connection and
  // application boundaries only. No DSH Host, model provider or networking.
  ctx.on('internal/error', error => errors.push(error));
  const connection = { fetch: { register(route) {
    assert.ok(!routes.has(route.path), 'Duplicate route during dependency rebuild'); routes.set(route.path, route);
    return () => { assert.equal(routes.get(route.path), route); routes.delete(route.path); };
  } } };
  const connectionProvider = ctx.plugin({ apply(providerCtx) { providerCtx.provide('connection', connection); } }); await connectionProvider;
  let child;
  const plugin = { inject, apply(parent) {
    if (config.enabled === true && config.dshModel?.enabled === true) { child = installDshAgent(parent, config, { openApplication: open }); return; }
    return installDshAgent(parent, config, { openApplication: open });
  } };
  const parent = ctx.plugin(plugin); await parent;
  t.after(async () => { await parent.dispose(); await ctx.fiber.dispose(); assert.deepEqual(errors, []); });
  return { ctx, routes, parent, async provideLlm(value) { const provider = ctx.plugin({ apply(providerCtx) { providerCtx.provide('llm', value); } }); await provider; return () => provider.dispose(); },
    get child() { return child; }, status: () => routes.get('/api/juebot/agent/status')?.fetch(new Request('http://localhost/api/juebot/agent/status')) };
}

test('entry declares connection only; model-disabled installation never reads llm', { skip: !process.env.JUEBOT_DSH_CORDIS_MODULE }, async t => {
  assert.deepEqual(inject, ['connection']); let opened = 0; let closed = 0;
  const h = await harness(t, { enabled: false }, async () => { opened++; return { fetch: async () => new Response('disabled'), close() { closed++; } }; });
  assert.equal(opened, 1); assert.equal(await (await h.status()).text(), 'disabled');
  await h.parent.dispose(); assert.equal(closed, 1); assert.equal(h.routes.size, 0);
});

test('real Cordis waits for llm, rebuilds child on replacement and disposes on dependency/parent removal', { skip: !process.env.JUEBOT_DSH_CORDIS_MODULE }, async t => {
  const opened = []; const closed = [];
  const h = await harness(t, enabled, async child => {
    const llm = child.llm; opened.push(llm.tag);
    // Reading connection here also proves the child retains its parent's grant.
    assert.equal(typeof child.connection.fetch.register, 'function');
    return { fetch: async () => new Response(llm.tag), close() { closed.push(llm.tag); } };
  });
  assert.equal(opened.length, 0); assert.equal(h.routes.size, 0);
  let remove = await h.provideLlm({ tag: 'one', prepareCall() { assert.fail('model invocation forbidden'); } });
  await eventually(() => h.routes.size > 0); assert.equal(await (await h.status()).text(), 'one');
  await remove(); await eventually(() => h.routes.size === 0); assert.deepEqual(closed, ['one']);
  remove = await h.provideLlm({ tag: 'two', prepareCall() { assert.fail('model invocation forbidden'); } });
  await eventually(() => h.routes.size > 0); assert.equal(await (await h.status()).text(), 'two'); assert.deepEqual(opened, ['one', 'two']);
  await h.parent.dispose(); assert.deepEqual(closed, ['one', 'two']); assert.equal(h.routes.size, 0);
  await remove();
  await h.provideLlm({ tag: 'three' }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(opened, ['one', 'two']);
});

test('real Cordis enforces that a connection-only parent cannot read llm directly', { skip: !process.env.JUEBOT_DSH_CORDIS_MODULE }, async t => {
  const { Context } = await import(pathToFileURL(process.env.JUEBOT_DSH_CORDIS_MODULE)); const ctx = new Context();
  ctx.provide('connection', {}); const provider = ctx.plugin({ apply(serviceCtx) { serviceCtx.provide('llm', { tag: 'hidden' }); } }); await provider; let checked = false;
  const parent = ctx.plugin({ inject, apply(parentCtx) { assert.throws(() => parentCtx.llm, /llm|inject/); checked = true; } });
  await parent; assert.equal(checked, true); t.after(async () => { await parent.dispose(); await ctx.fiber.dispose(); });
});

test('real Cordis dependency removal closes a late application without leaking its routes', { skip: !process.env.JUEBOT_DSH_CORDIS_MODULE }, async t => {
  let release; let closed = 0;
  const h = await harness(t, enabled, async child => {
    assert.equal(child.llm.tag, 'slow');
    return new Promise(resolve => { release = () => resolve({ fetch: async () => new Response('stale'), close() { closed++; } }); });
  });
  const remove = await h.provideLlm({ tag: 'slow' }); await eventually(() => typeof release === 'function');
  const removal = remove(); release(); await removal;
  await eventually(() => closed === 1); assert.equal(h.routes.size, 0);
});
