import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// Reuse the native client React-hook VM fixture pattern from host-native.test.mjs.
// These are behavior checks, not browser or Desktop visual acceptance.
const source = readFileSync(new URL('../host/client.js', import.meta.url), 'utf8');
function nativeFixture(fetch) {
  let module;
  const hooks = [], effects = [], cleanups = [], slots = new Map(); let cursor = 0;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(setup, deps) { const i = cursor++; const old = hooks[i]; if (!old || deps.some((v, n) => v !== old[n])) { hooks[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = setup(); }); } } };
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { module = value; } } }, fetch, AbortController,
    URLSearchParams, TextDecoder, setTimeout, clearTimeout, Date, console: { log: () => assert.fail('no client logging') } });
  const body = module.factory(name => { assert.equal(name, 'react'); return React; });
  const ctx = { effect: fn => { const release = fn(); if (release) cleanups.push(release); },
    locale: { register: () => () => {}, bind: () => key => ({ title: '撅撅 · 会话与审核', empty: '暂无已授权数据', unconfigured: '尚未配置或当前服务不可用', refresh: '刷新' })[key] ?? key },
    layout: { selectPanel: id => { assert.equal(id, 'conversation'); } }, slots: {
      inject: (_name, setup) => setup(), register: (meta, component) => { slots.set(meta.name, { meta, component }); return () => slots.delete(meta.name); } } };
  body.apply(ctx);
  const render = () => { cursor = 0; const tree = slots.get('main').component({}); while (effects.length) effects.shift()(); return tree; };
  return { slots, render, async settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); },
    unmount() { for (const cleanup of cleanups) cleanup?.(); } };
}
const walk = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(walk)];
const content = tree => !tree || typeof tree !== 'object' ? String(tree ?? '') : tree.children.map(content).join('');
const button = (tree, label) => walk(tree).find(node => node.type === 'button' && content(node) === label);
const ok = data => new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } });
function responses(url) {
  const resource = url.split('/').at(-1).split('?')[0];
  const data = { status: { name: '撅撅', mode: 'juejue', runtime: 'offline', modelConfigured: false, paused: false, pauseRevision: 3, codeEnabled: false, capabilities: [] },
    conversations: { items: [{ key: 'local', label: '本地合成流', kind: 'group', connector: 'local-test', status: 'offline', synthetic: true }] },
    creations: { items: [] }, outbox: { items: [] }, code: { enabled: false, tasks: [] }, events: { items: [], nextCursor: null },
    memory: { items: [] }, self: { revision: 1, value: { name: '撅撅', interests: [], intents: [] } },
    settings: { revision: 2, global: {}, local: null, effective: { prompt: '', participation: 0.5, permissions: {}, typing: { enabled: true, charsPerSecond: 12 } } } };
  return ok(data[resource] ?? {});
}


const secret = 'SECRET_body_token_private_path';
const failure = (status, code) => new Response(JSON.stringify({ ok: false, error: { code, message: secret }, body: secret }),
  { status, headers: { 'content-type': 'application/json' } });
async function checkFailure(makeResponse, expected, prefix = '请求未完成，请刷新核对。') {
  let calls = 0;
  const f = nativeFixture(async url => { calls++; return url.endsWith('/status') ? makeResponse() : responses(url); });
  try {
    f.render(); await f.settle(); const tree = f.render();
    const alert = walk(tree).find(node => node.props.role === 'alert');
    assert.equal(content(alert), prefix + expected);
    assert.ok(!content(tree).includes(secret));
    assert.equal(calls, 7, 'one initial request per resource, no retries');
  } finally { f.unmount(); }
}
test('HTTP 401 non-JSON keeps status without reading or displaying body', async () => {
  await checkFailure(() => ({ status: 401, ok: false, headers: { get: () => 'text/html' },
    json: () => assert.fail('non-JSON body must not be read'), text: () => assert.fail('body must not be read') }),
  '（HTTP 401 · INVALID_RESPONSE）');
});
test('HTTP 409 exposes bounded server code without message or body', async () => {
  await checkFailure(() => failure(409, 'REVISION_CONFLICT'), '（HTTP 409 · REVISION_CONFLICT）');
});
test('HTTP 503 retains unavailable semantics and diagnostic code', async () => {
  await checkFailure(() => failure(503, 'AGENT_UNAVAILABLE'), '（HTTP 503 · AGENT_UNAVAILABLE）', '尚未配置或当前服务不可用');
});
for (const [label, response] of [
  ['non-JSON', () => new Response(secret, { headers: { 'content-type': 'text/html' } })],
  ['broken JSON', () => new Response(secret, { headers: { 'content-type': 'application/json' } })],
  ['invalid shape', () => new Response(JSON.stringify({ private: secret }), { headers: { 'content-type': 'application/json' } })],
]) test('HTTP 200 ' + label + ' is INVALID_RESPONSE', async () => {
  await checkFailure(response, '（HTTP 200 · INVALID_RESPONSE）');
});
test('network rejection never projects error.message even when it resembles a business code', async () => {
  await checkFailure(() => { throw Error('AGENT_UNAVAILABLE ' + secret); }, '（REQUEST_FAILED）');
});
for (const code of ['<script>' + secret, 'BAD\nCODE', 'BAD_CODE\n', 'BAD_CODE\r', 'A'.repeat(81), 123, { token: secret }]) {
  test('unsafe code is rejected: ' + JSON.stringify(code).slice(0, 35), async () => {
    await checkFailure(() => failure(409, code), '（HTTP 409 · REQUEST_FAILED）');
  });
}
test('recovery business message is preserved with appended safe diagnostics', async () => {
  await checkFailure(() => failure(409, 'INTENTION_UNAVAILABLE'), '（HTTP 409 · INTENTION_UNAVAILABLE）',
    '原意愿已过期或其依据已失效，不能恢复；需形成新的有效意愿。');
});
test('failed mutation retains unknown-write notice, sends once and does not refresh', async () => {
  const writes = [], reads = [];
  const f = nativeFixture(async (url, options) => {
    if (options.method === 'POST') { writes.push({ url, body: JSON.parse(options.body) }); return failure(409, 'POLICY_CHANGED'); }
    reads.push(url); return responses(url);
  });
  try {
    f.render(); await f.settle(); button(f.render(), '暂停全部出站').props.onClick(); await f.settle();
    const tree = f.render();
    assert.equal(content(walk(tree).find(node => node.props.role === 'alert')),
      '来源、身份或权限已变化，恢复被拒绝。请核对当前授权。（HTTP 409 · POLICY_CHANGED）');
    assert.ok(content(tree).includes('写入结果未确认；不会自动重试。'));
    assert.ok(!content(tree).includes(secret));
    assert.deepEqual(writes, [{ url: 'api/juebot/agent/pause', body: { expectedRevision: 3, paused: true } }]);
    assert.equal(reads.length, 7);
  } finally { f.unmount(); }
});
