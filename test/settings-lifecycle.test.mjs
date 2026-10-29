import test from 'node:test';
import assert from 'node:assert/strict';
import { installControlPlane } from '../candidates/0.2.0-dev.1/bundle/console-host.js';
import { initialControl } from '../candidates/0.2.0-dev.1/bundle/lib/control.js';

const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
// Contract mock of Cordis effect ownership (inactive effects throw in local 4.0.5;
// a separate conservative variant skips setup after disposal).
// and registration services. Not a real Host/SDK integration or database test.
// Read-only source check: D:/dsh/resources/app.asar/dsh/node_modules/
// @deepseek-ai/cordis/lib/index.js:1131-1145,1169-1171,1372-1383.
function fixture(failAt = '', skipInactive = false) {
  let dead = false;
  let registration = 0;
  let closes = 0;
  const effects = [];
  const active = { inspect: new Set(), tool: new Set(), route: new Set() };
  const ctx = {
    effect(setup) {
      if (dead) {
        if (skipInactive) return () => {};
        throw Object.assign(new Error('inactive effect'), { code: 'INACTIVE_EFFECT' });
      }
      const dispose = setup();
      let done = false;
      const once = () => { if (!done) { done = true; return dispose(); } };
      effects.push(once); return once;
    },
    get: () => ({ dir: 'synthetic-profile' }),
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  };
  const register = kind => value => {
    assert.equal(dead, false, 'must never register after ctx disposal');
    if (`${kind}:${++registration}` === failAt || kind === failAt) throw new Error('synthetic registration failure');
    return ctx.effect(() => {
      active[kind].add(value);
      return () => active[kind].delete(value);
    });
  };
  ctx.cordisInspect = { register: register('inspect') };
  ctx.tools = { register: register('tool') };
  ctx.connection = { fetch: { register: register('route') } };
  const port = { read: () => initialControl('a'.repeat(64)), close: async () => { closes++; } };
  return {
    ctx, port, active, get closes() { return closes; },
    async dispose() { dead = true; await Promise.all(effects.slice().reverse().map(release => release())); },
    assertEmpty() { for (const values of Object.values(active)) assert.equal(values.size, 0); },
  };
}
const dependencies = f => ({ probeHostOnce: async () => ({ synthetic: true }), openControlDomain: async () => f.port });

test('disposed context before install performs no probe, open or registrations', async () => {
  const f = fixture(); await f.dispose();
  await assert.rejects(installControlPlane(f.ctx, {}, { probeHostOnce: () => assert.fail('probe must not run') }), { code: 'INACTIVE_EFFECT' });
  f.assertEmpty(); assert.equal(f.closes, 0);
});
test('context variant skipping inactive effect setup also performs no work', async () => {
  const f = fixture('', true); await f.dispose();
  await installControlPlane(f.ctx, {}, { probeHostOnce: () => assert.fail('probe must not run') });
  f.assertEmpty(); assert.equal(f.closes, 0);
});
test('disposal during probe prevents domain open and every registration', async () => {
  const f = fixture(); const probe = deferred();
  const install = installControlPlane(f.ctx, {}, { probeHostOnce: () => probe.promise, openControlDomain: () => assert.fail('open after disposal') });
  await f.dispose(); probe.resolve({ synthetic: true }); await install;
  f.assertEmpty(); assert.equal(f.closes, 0);
});
test('disposal during domain open closes the late handle exactly once', async () => {
  const f = fixture(); const opening = deferred(); const started = deferred();
  const install = installControlPlane(f.ctx, {}, { ...dependencies(f), openControlDomain: () => { started.resolve(); return opening.promise; } });
  await started.promise; await f.dispose(); opening.resolve(f.port); await install;
  await f.dispose(); f.assertEmpty(); assert.equal(f.closes, 1);
});
test('normal unload releases every route, Tool, Inspect and closes once', async () => {
  const f = fixture(); await installControlPlane(f.ctx, {}, dependencies(f));
  assert.equal(f.active.inspect.size, 1); assert.equal(f.active.tool.size, 1); assert.ok(f.active.route.size > 1);
  await f.dispose(); await f.dispose(); f.assertEmpty(); assert.equal(f.closes, 1);
});
for (const failure of ['inspect', 'tool', 'route:3', 'route:5']) {
  test(`registration failure at ${failure} rolls back partial setup`, async () => {
    const f = fixture(failure);
    await assert.rejects(installControlPlane(f.ctx, {}, dependencies(f)), /synthetic registration failure/);
    f.assertEmpty(); assert.equal(f.closes, 1);
    await f.dispose(); assert.equal(f.closes, 1); f.assertEmpty();
  });
}
test('unavailable domain exposes bounded diagnostics and cleans registrations on unload', async () => {
  const f = fixture();
  await installControlPlane(f.ctx, {}, { ...dependencies(f), openControlDomain: async () => { throw new Error('synthetic unavailable'); } });
  const provider = [...f.active.inspect][0];
  assert.deepEqual(provider.query('getSetupSummary', {}, { signal: new AbortController().signal }), { available: false, error: 'CONTROL_UNAVAILABLE' });
  await f.dispose(); f.assertEmpty(); assert.equal(f.closes, 0);
});
test('failure after acquiring a domain releases it before registering unavailable summary', async () => {
  const f = fixture(); f.ctx.get = () => { throw new Error('synthetic profile disappeared'); };
  await installControlPlane(f.ctx, {}, dependencies(f));
  assert.equal(f.closes, 1);
  const provider = [...f.active.inspect][0];
  assert.equal(provider.query('getSetupSummary', {}, { signal: new AbortController().signal }).available, false);
  await f.dispose(); f.assertEmpty(); assert.equal(f.closes, 1);
});
test('late domain close failure is surfaced and never retried/double closed', async () => {
  const f = fixture(); const opening = deferred(); const started = deferred(); let attempts = 0;
  f.port.close = async () => { attempts++; throw new Error('synthetic close failure'); };
  const install = installControlPlane(f.ctx, {}, { ...dependencies(f), openControlDomain: () => { started.resolve(); return opening.promise; } });
  const failure = assert.rejects(install, /CONTROL_DISPOSAL_FAILED/);
  await started.promise; await f.dispose(); opening.resolve(f.port); await failure;
  f.assertEmpty(); assert.equal(attempts, 1);
});
