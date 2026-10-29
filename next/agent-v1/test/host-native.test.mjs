import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { installAgentPlane, HOST_PRINCIPAL } from '../host/console-host.js';

// Explicit Connection/Cordis doubles. This is NOT real Host admission or browser acceptance.
function hostFixture(failAt = Infinity) {
  let disposed = false, registrations = 0;
  const effects = [], routes = new Map();
  const ctx = { effect(setup) {
    if (disposed) throw Error('inactive');
    const release = setup(); let done = false;
    const once = () => { if (!done) { done = true; return release?.(); } }; effects.push(once); return once;
  }, connection: { fetch: { register(route) {
    assert.equal(disposed, false); if (++registrations === failAt) throw Error('synthetic registration failure');
    return ctx.effect(() => { routes.set(route.path, route); return () => routes.delete(route.path); });
  } } } };
  return { ctx, routes, async dispose() { disposed = true; await Promise.all(effects.slice().reverse().map(fn => fn())); } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('unwired Host registers owner-route descriptors but never fabricates an application or opens storage', async () => {
  const f = hostFixture(); await installAgentPlane(f.ctx);
  assert.equal(f.routes.size, 28);
  for(const name of ['creation-start','creation-intention','summary-creation','expression-preview'])assert.deepEqual(f.routes.get('/api/juebot/agent/'+name).methods,['POST']);
  assert.deepEqual(f.routes.get('/api/juebot/agent/trace').methods,['GET']);assert.deepEqual(f.routes.get('/api/juebot/agent/bili-source').methods,['GET','POST']);
  assert.deepEqual(f.routes.get('/api/juebot/agent/creation-recovery').methods, ['POST']);
  assert.deepEqual(f.routes.get('/api/juebot/agent/reconcile').methods, ['POST']);
  for (const [path, route] of f.routes) { assert.ok(path.startsWith('/api/juebot/agent/')); assert.equal(route.requestBody, route.methods.includes('POST') ? 'streaming' : 'buffered'); }
  const health = await f.routes.get('/api/juebot/agent/health').fetch(new Request('http://offline.invalid/api/juebot/agent/health'));
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true, data: { probe: 1 } });
  const response = await f.routes.get('/api/juebot/agent/status').fetch(new Request('http://offline.invalid/api/juebot/agent/status'));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, error: { code: 'AGENT_UNAVAILABLE' } });
  await f.dispose(); assert.equal(f.routes.size, 0);
});

test('Host factory receives fixed principal; exact callback preserves request query and signal', async () => {
  const f = hostFixture(); let closes = 0, observed;
  await installAgentPlane(f.ctx, { synthetic: true }, { openApplication: async (ctx, config, authority) => {
    assert.equal(ctx, f.ctx); assert.equal(authority.principal, HOST_PRINCIPAL); assert.equal(config.synthetic, true);
    return { fetch: async request => { observed = request; return Response.json({ ok: true, data: { items: [] } }); }, close: async () => { closes++; } };
  } });
  const request = new Request('http://offline.invalid/api/juebot/agent/events?key=opaque', { headers: { 'x-owner': 'forged' } });
  assert.equal((await f.routes.get('/api/juebot/agent/events').fetch(request)).status, 200); assert.equal(observed, request);
  await f.dispose(); await f.dispose(); assert.equal(closes, 1); assert.equal(f.routes.size, 0);
});

test('disposal while factory opens closes its late application once without leaving routes', async () => {
  const f = hostFixture(), opening = deferred(); let closes = 0;
  const install = installAgentPlane(f.ctx, {}, { openApplication: () => opening.promise });
  await f.dispose(); opening.resolve({ fetch: async () => Response.json({}), close: async () => { closes++; } }); await install;
  await f.dispose(); assert.equal(closes, 1); assert.equal(f.routes.size, 0);
});

test('partial registration failure removes every owned route and closes once', async () => {
  const f = hostFixture(4); let closes = 0;
  await assert.rejects(installAgentPlane(f.ctx, {}, { openApplication: async () => ({ fetch: async () => Response.json({}), close: async () => { closes++; } }) }), /synthetic registration failure/);
  assert.equal(f.routes.size, 0); assert.equal(closes, 1); await f.dispose(); assert.equal(closes, 1);
});

test('a response finishing after Host disposal cannot reveal the former application payload', async () => {
  const f = hostFixture(), reading = deferred();
  await installAgentPlane(f.ctx, {}, { openApplication: async () => ({ fetch: () => reading.promise, close: async () => {} }) });
  const pending = f.routes.get('/api/juebot/agent/status').fetch(new Request('http://offline.invalid/api/juebot/agent/status'));
  await f.dispose(); reading.resolve(Response.json({ ok: true, data: { private: 'synthetic private stale state' } }));
  const response = await pending; assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'AGENT_UNAVAILABLE' } });
});

test('factory/fetch failures are bounded and cancelled requests cannot become success', async () => {
  const f = hostFixture(); await installAgentPlane(f.ctx, {}, { openApplication: async () => { throw Error('SECRET /private/path'); } });
  const route = f.routes.get('/api/juebot/agent/status');
  assert.equal((await route.fetch(new Request('http://offline.invalid/api/juebot/agent/status'))).status, 503);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(route.fetch(new Request('http://offline.invalid/api/juebot/agent/status', { signal: abort.signal })), { name: 'AbortError' });
  await f.dispose();
});

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

test('VM mounts one native panel/sidebar without replacing conversation or creating another React root', async () => {
  const calls = [];
  const f = nativeFixture(async (url, options) => { calls.push({ url, options }); return responses(url); });
  assert.equal(f.slots.get('main').meta.key, 'juebot'); assert.equal(f.slots.get('sidebar.panellist').meta.id, 'juebot');
  f.render(); await f.settle(); let tree = f.render();
  for (const label of ['会话列表', '消息', '轨迹', '记忆', '当前会话设置', '撅撅状态', '创作审核', 'Code 状态', '出站日志']) assert.ok(content(tree).includes(label), label);
  assert.ok(content(tree).includes('[合成]')); assert.ok(content(tree).includes('未配置'));
  button(tree, '[合成] 本地合成流 · offline').props.onClick(); f.render(); await f.settle(); tree = f.render();
  assert.ok(button(tree, '发送本地测试').props.disabled);
  assert.ok(calls.some(item => item.url.includes('settings?key=local')));
  assert.ok(calls.every(item => item.options.credentials === 'same-origin'));
  assert.equal(walk(tree).some(node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML')), false);
  assert.doesNotMatch(source, /createRoot|ReactDOM|host\.call|localStorage|Authorization\s*:|Cookie\s*:/);
  f.unmount();
});

test('VM media approval stays disabled without actual preview', async () => {
  const f = nativeFixture(async url => {
    if (url.endsWith('/creations')) return ok({ items: [{ id: 'video-1', action: 'bili.video', stage: 'final-review', version: 1 }] });
    if (url.includes('/creation?')) return ok({ revision: 2, value: { id: 'video-1', action: 'bili.video', stage: 'final-review', version: 1, sources: [],
      final: { manifestHash: 'a'.repeat(64), manifest: { title: 'Synthetic video', video: { previewRef: 'safe_ref', sha256: 'a'.repeat(64) }, audio: [], subtitles: [], attachments: [] } } } });
    return responses(url);
  });
  f.render(); await f.settle(); let tree = f.render();
  button(tree, 'video-1 · bili.video · final-review · v1').props.onClick(); await f.settle(); tree = f.render();
  assert.ok(button(tree, '批准最终作品（有效30分钟）').props.disabled);
  assert.ok(content(tree).includes('媒体类型或受控预览不可用')); assert.equal(walk(tree).some(node => ['video', 'audio', 'iframe'].includes(node.type)), false);
  f.unmount();
});

test('VM human creation recovery requires a reason, posts exact revision, refreshes audit and still requires final review', async () => {
  const writes = []; let recovered = false;
  const f = nativeFixture(async (url, options) => {
    if (options.method === 'POST') { writes.push({ route: url.split('/').at(-1), body: JSON.parse(options.body) }); recovered = true; return ok({ status: 'ready' }); }
    if (url.endsWith('/creations')) return ok({ items: [{ id: 'work-1', action: 'bili.comment', stage: recovered ? 'final-review' : 'intention', version: 1 }] });
    if (url.includes('/creation?')) return ok({ revision: recovered ? 8 : 5, recoveryAudit: recovered ? [{ decision: 'recover', reason: 'Explicit recovery' }] : [],
      value: { id: 'work-1', action: 'bili.comment', stage: recovered ? 'final-review' : 'intention', version: recovered ? 2 : 1,
        workflow: { phase: recovered ? 'ready' : 'planning', reasonCode: null }, sources: [], approval: null, submission: null,
        final: recovered ? { manifest: { text: 'Recovered final', video: null, cover: null, audio: [], subtitles: [], attachments: [] } } : null } });
    return responses(url);
  });
  f.render(); await f.settle(); let tree = f.render();
  button(tree, 'work-1 · bili.comment · intention · v1').props.onClick(); await f.settle(); tree = f.render();
  assert.equal(button(tree, '人工恢复并重做本地准备').props.disabled, true);
  assert.equal(button(tree, '放弃本次创作（不可恢复）').props.disabled, true);
  walk(tree).find(node => node.props['aria-label'] === '审核理由').props.onChange({ target: { value: 'Explicit recovery' } }); tree = f.render();
  assert.equal(button(tree, '人工恢复并重做本地准备').props.disabled, false);
  button(tree, '人工恢复并重做本地准备').props.onClick(); await f.settle(); tree = f.render();
  assert.deepEqual(writes, [{ route: 'creation-recovery', body: { id: 'work-1', expectedRevision: 5, action: 'recover', reason: 'Explicit recovery' } }]);
  assert.ok(content(tree).includes('Recovered final')); assert.ok(content(tree).includes('Explicit recovery'));
  assert.equal(button(tree, '人工恢复并重做本地准备'), undefined);
  assert.equal(button(tree, '提交已批准作品').props.disabled, true);
  f.unmount();
});

test('VM abandon sends an explicit human decision and unknown reconciliation has no retry/proof controls', async () => {
  const writes = []; let abandoned = false, reconciled = false;
  const f = nativeFixture(async (url, options) => {
    if (options.method === 'POST') { const route = url.split('/').at(-1); writes.push({ route, body: JSON.parse(options.body) }); if (route === 'creation-recovery') abandoned = true; else reconciled = true; return ok({}); }
    if (url.endsWith('/creations')) return ok({ items: [{ id: 'work-1', action: 'bili.video', stage: 'script', version: 1 }] });
    if (url.includes('/creation?')) return ok({ revision: abandoned ? 7 : 6, value: { id: 'work-1', action: 'bili.video', stage: 'script', version: 1,
      workflow: { phase: abandoned ? 'failed' : 'producing', reasonCode: abandoned ? 'HUMAN_ABANDONED' : null }, sources: [], final: null, approval: null, submission: null } });
    if (url.endsWith('/outbox')) return ok({ revision: 12, items: [{ id: 'unknown-1', status: reconciled ? 'confirmed' : 'unknown' }, { id: 'queued-2', status: 'queued' }] });
    return responses(url);
  });
  f.render(); await f.settle(); let tree = f.render();
  assert.equal(walk(tree).filter(node => node.type === 'button' && content(node) === '核对发送结果').length, 1);
  button(tree, '核对发送结果').props.onClick(); await f.settle(); tree = f.render();
  assert.deepEqual(writes[0], { route: 'reconcile', body: { id: 'unknown-1', expectedRevision: 12 } });
  assert.equal(button(tree, '核对发送结果'), undefined);
  button(tree, 'work-1 · bili.video · script · v1').props.onClick(); await f.settle(); tree = f.render();
  walk(tree).find(node => node.props['aria-label'] === '审核理由').props.onChange({ target: { value: 'Human discard' } }); tree = f.render();
  button(tree, '放弃本次创作（不可恢复）').props.onClick(); await f.settle(); tree = f.render();
  assert.deepEqual(writes[1], { route: 'creation-recovery', body: { id: 'work-1', expectedRevision: 6, action: 'abandon', reason: 'Human discard' } });
  assert.equal(button(tree, '人工恢复并重做本地准备'), undefined); assert.ok(content(tree).includes('HUMAN_ABANDONED'));
  f.unmount();
});

test('VM conversation switching rejects late payloads from the previously selected stream', async () => {
  const old = deferred();
  const f = nativeFixture(async url => {
    if (url.endsWith('/conversations')) return ok({ items: [{ key: 'first', label: 'First', connector: 'local-test', status: 'offline' },
      { key: 'second', label: 'Second', connector: 'local-test', status: 'offline' }] });
    if (url.includes('/events?key=first')) return old.promise;
    if (url.includes('/events?key=second')) return ok({ items: [{ sequence: 2, eventType: 'NEW_EVENT', reasonCode: 'NONE', occurredAt: 1, bodyRef: null }], nextCursor: null });
    return responses(url);
  });
  f.render(); await f.settle(); let tree = f.render();
  button(tree, 'First · offline').props.onClick(); tree = f.render();
  button(tree, 'Second · offline').props.onClick(); f.render(); await f.settle(); tree = f.render();
  assert.ok(content(tree).includes('NEW_EVENT'));
  old.resolve(ok({ items: [{ sequence: 1, eventType: 'OLD_PRIVATE_EVENT', reasonCode: 'NONE', occurredAt: 1, bodyRef: null }], nextCursor: null }));
  await f.settle(); tree = f.render();
  assert.equal(content(tree).includes('OLD_PRIVATE_EVENT'), false); assert.ok(content(tree).includes('NEW_EVENT'));
  f.unmount();
});

test('VM mutation failure shows controlled uncertainty without echoing backend text or retrying', async () => {
  const calls = [];
  const f = nativeFixture(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return new Response(JSON.stringify({ ok: false, error: { code: 'UNTRUSTED', detail: 'SECRET private path' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    return responses(url);
  });
  f.render(); await f.settle(); let tree = f.render();
  button(tree, '开启新 Code 任务').props.onClick(); await f.settle(); tree = f.render();
  assert.equal(calls.filter(item => item.options.method === 'POST').length, 1);
  assert.ok(content(tree).includes('不会自动重试')); assert.equal(content(tree).includes('SECRET'), false);
  f.unmount();
});

test('VM unmount aborts outstanding reads; late completions never update the component', async () => {
  const pending = deferred(), signals = [];
  const f = nativeFixture(async (_url, options) => { signals.push(options.signal); return pending.promise; });
  f.render(); f.unmount(); assert.ok(signals.every(signal => signal.aborted)); pending.resolve(ok({ items: [] })); await f.settle();
  assert.equal(signals.length, 7);
});

test('VM media approval requires every controlled preview load; simulated native load events unlock exact version only', async () => {
  const f = nativeFixture(async url => {
    if (url.endsWith('/creations')) return ok({ items: [{ id: 'video-1', action: 'bili.video', stage: 'final-review', version: 1 }] });
    if (url.includes('/creation?')) return ok({ revision: 2, assetKinds: { video_ref: 'video', cover_ref: 'image', caption_ref: 'subtitles' },
      value: { id: 'video-1', action: 'bili.video', stage: 'final-review', version: 1, sources: [], final: { manifestHash: 'a'.repeat(64),
        manifest: { title: 'Synthetic video', video: { previewRef: 'video_ref', sha256: 'a'.repeat(64) }, cover: { previewRef: 'cover_ref', sha256: 'b'.repeat(64) },
          audio: [], subtitles: [{ previewRef: 'caption_ref', sha256: 'c'.repeat(64) }], attachments: [] } } } });
    if (url.includes('/media?')) return new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic caption\n', { headers: { 'content-type': 'text/vtt' } });
    return responses(url);
  });
  f.render(); await f.settle(); let tree = f.render();
  button(tree, 'video-1 · bili.video · final-review · v1').props.onClick(); await f.settle(); tree = f.render(); await f.settle(); tree = f.render();
  assert.ok(button(tree, '批准最终作品（有效30分钟）').props.disabled);
  const video = walk(tree).find(node => node.type === 'video'), cover = walk(tree).find(node => node.type === 'img');
  assert.equal(video.props.src, 'api/juebot/agent/media?ref=video_ref'); assert.equal(cover.props.src, 'api/juebot/agent/media?ref=cover_ref');
  assert.ok(walk(tree).find(node => node.type === 'track').props.src.endsWith('ref=caption_ref'));
  video.props.onLoadedMetadata(); tree = f.render(); assert.ok(button(tree, '批准最终作品（有效30分钟）').props.disabled);
  cover.props.onLoad(); tree = f.render(); assert.equal(button(tree, '批准最终作品（有效30分钟）').props.disabled, false);
  cover.props.onError(); tree = f.render(); assert.ok(button(tree, '批准最终作品（有效30分钟）').props.disabled);
  f.unmount();
});

test('VM identity controls and learning decisions use explicit Host endpoints without account/model activation', async () => {
  const calls = [];
  const f = nativeFixture(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return ok({});
    if (url.endsWith('/identity')) return ok({ revision: 7, profile: { name: '撅撅', mode: 'juejue', roleCore: 'Synthetic core' } });
    if (url.endsWith('/learning')) return ok({ items: [{ id: 'candidate-1', status: 'pending', text: 'Synthetic candidate' }] });
    return responses(url);
  });
  f.render(); await f.settle(); let tree = f.render();
  assert.ok(content(tree).includes('身份与角色核心')); button(tree, '保存身份').props.onClick(); await f.settle(); tree = f.render();
  let posted = calls.filter(item => item.options.method === 'POST');
  assert.equal(posted[0].url, 'api/juebot/agent/identity'); assert.equal(JSON.parse(posted[0].options.body).expectedRevision, 7);
  button(tree, '接受学习候选 candidate-1').props.onClick(); await f.settle();
  posted = calls.filter(item => item.options.method === 'POST');
  assert.deepEqual(JSON.parse(posted[1].options.body), { id: 'candidate-1', accepted: true });
  assert.equal(posted.some(item => /account|model/.test(item.url)), false);
  f.unmount();
});

test('VM mode switching loads saved target cores locally and requires explicit save', async () => {
  const calls = [], juejue = { botId: 'bot', personaId: 'juejue', mode: 'juejue', name: '撅撅', roleCore: 'Original saved core' },
    persona = { botId: 'bot', personaId: 'persona', mode: 'persona', name: 'Persona', roleCore: 'Separate saved persona core' };
  const f = nativeFixture(async (url, options) => { calls.push({ url, options }); if (options.method === 'POST') return ok({});
    if (url.endsWith('/identity')) return ok({ revision: 4, profile: juejue, profiles: { juejue, persona } }); return responses(url); });
  f.render(); await f.settle(); let tree = f.render(); const count = calls.length;
  walk(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'persona' } }); tree = f.render();
  assert.equal(calls.length, count); assert.ok(content(tree).includes('点击保存身份后才切换'));
  assert.ok(walk(tree).some(node => node.type === 'textarea' && node.props.value === persona.roleCore));
  button(tree, '保存身份').props.onClick(); await f.settle(); const posted = calls.find(item => item.options.method === 'POST');
  assert.deepEqual(JSON.parse(posted.options.body), { expectedRevision: 4, profile: persona }); f.unmount();
  const g = nativeFixture(async url => url.endsWith('/identity') ? ok({ revision: 1, profile: juejue, profiles: { juejue } }) : responses(url));
  g.render(); await g.settle(); tree = g.render(); walk(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'persona' } }); tree = g.render();
  assert.ok(content(tree).includes('当前内容仅作草稿')); assert.ok(walk(tree).some(node => node.type === 'textarea' && node.props.value === juejue.roleCore)); g.unmount();
});

test('VM edits only local prompt, explicitly sets global permissions and refreshes selected domains', async () => {
  const calls = []; let generation = 1;
  const f = nativeFixture(async (url, options) => { calls.push({ url, options }); if (options.method === 'POST') return ok({});
    if (url.includes('/settings?')) return ok({ revision: generation, canManage: true, global: { permissions: { receive: false }, prompt: 'G' }, local: { prompt: 'L' }, effective: { prompt: 'G\nL', permissions: {}, typing: {} } });
    if (url.includes('/growth?')) return ok({ revision: generation, value: { growthVersion: 'selected-growth-' + generation } }); return responses(url); });
  f.render(); await f.settle(); let tree = f.render(); button(tree, '[合成] 本地合成流 · offline').props.onClick(); f.render(); await f.settle(); tree = f.render();
  assert.ok(walk(tree).some(node => node.type === 'textarea' && node.props.value === 'L')); assert.ok(content(tree).includes('G\nL'));
  button(tree, '保存本会话 Prompt').props.onClick(); await f.settle(); tree = f.render();
  const local = calls.find(item => item.options.method === 'POST'); assert.deepEqual(JSON.parse(local.options.body).patch, { prompt: 'L' });
  walk(tree).find(node => node.props['aria-label'] === '全局权限 receive').props.onChange({ target: { checked: true } }); await f.settle();
  const global = calls.filter(item => item.options.method === 'POST').at(-1); const body = JSON.parse(global.options.body); assert.equal(Object.hasOwn(body, 'key'), false); assert.deepEqual(body.patch, { permissions: { receive: true } });
  generation = 2; const start = calls.length; tree = f.render(); button(tree, '刷新').props.onClick(); await f.settle(); tree = f.render();
  for (const name of ['settings', 'events', 'memory', 'self', 'growth']) assert.ok(calls.slice(start).some(item => item.url.endsWith(name + '?key=local')));
  assert.equal(calls.some(item => item.url.endsWith('/growth')), false); assert.ok(content(tree).includes('selected-growth-2')); f.unmount();
});

test('VM exposes scoped source metadata and sends only explicit revoke command; processed learning is disabled', async () => {
  const calls = [];
  const f = nativeFixture(async (url, options) => { calls.push({ url, options }); if (options.method === 'POST') return ok({});
    if (url.includes('/memory?')) return ok({ policyRevision: 6, canManageSources: true, items: [], sources: [{ id: 'source-1', revision: 2, domain: 'social', status: 'active', purposes: ['read'], expiresAt: null }] });
    if (url.endsWith('/learning')) return ok({ items: [{ id: 'processed', status: 'accepted', text: 'Synthetic accepted memory' }] }); return responses(url); });
  f.render(); await f.settle(); let tree = f.render(); assert.ok(button(tree, '接受学习候选 processed').props.disabled);
  button(tree, '[合成] 本地合成流 · offline').props.onClick(); f.render(); await f.settle(); tree = f.render(); button(tree, '记忆').props.onClick(); tree = f.render();
  assert.ok(content(tree).includes('source-1 · v2 · social · active')); button(tree, '撤销来源 source-1').props.onClick(); await f.settle();
  const posted = calls.find(item => item.options.method === 'POST'); assert.equal(posted.url, 'api/juebot/agent/memory');
  assert.deepEqual(JSON.parse(posted.options.body), { key: 'local', action: 'revoke-source', sourceId: 'source-1', expectedPolicyRevision: 6, nextSourceRevision: 3 }); f.unmount();
});

test('VM memory review previews exact scoped share, defaults to finite read learn draft and never includes private without explicit selection',async()=>{
  const writes=[];const f=nativeFixture(async(url,options)=>{
    if(options.method==='POST'){writes.push({route:url.split('/').at(-1),body:JSON.parse(options.body)});return ok({});}
    if(url.endsWith('/conversations'))return ok({items:[{key:'local',label:'Local',status:'offline'},{key:'target',label:'Target',status:'offline'}]});
    if(url.includes('/memory?'))return ok({policyRevision:8,canReviewMemory:true,items:[{id:'fact',revision:3,text:'Reviewed summary',kind:'knowledge',status:'active'}],sources:[],reviews:[]});return responses(url);
  });f.render();await f.settle();let tree=f.render();button(tree,'Local · offline').props.onClick();f.render();await f.settle();tree=f.render();button(tree,'记忆').props.onClick();tree=f.render();
  button(tree,'复核记忆 fact').props.onClick();tree=f.render();walk(tree).find(node=>node.props['aria-label']==='复核操作').props.onChange({target:{value:'share'}});tree=f.render();
  walk(tree).find(node=>node.type==='label'&&content(node)==='Target').children.find(node=>node.type==='input').props.onChange({target:{checked:true}});tree=f.render();
  walk(tree).find(node=>node.props['aria-label']==='记忆复核理由').props.onChange({target:{value:'Explicit scoped share'}});tree=f.render();
  button(tree,'预览记忆变更').props.onClick();tree=f.render();assert.equal(writes.length,0);assert.ok(content(tree).includes('确认以下具体变更'));
  button(tree,'确认提交记忆变更').props.onClick();await f.settle();assert.equal(writes.length,1);const body=writes[0].body;
  assert.equal(body.key,'local');assert.equal(body.expectedMemoryRevision,3);assert.equal(body.expectedPolicyRevision,8);assert.deepEqual(body.targets,['target']);
  assert.deepEqual(body.purposes,['read','learn','draft']);assert.ok(body.expiresAt>Date.now());assert.ok(body.expiresAt<=Date.now()+86400000);assert.equal(Object.hasOwn(body,'includePrivate'),false);f.unmount();
});

test('VM expression list editing and deletion preserve scope, natural style and literal preview contract',async()=>{
  const writes=[];const f=nativeFixture(async(url,options)=>{if(options.method==='POST'){writes.push({route:url.split('/').at(-1),body:JSON.parse(options.body)});return ok({action:'allow'});}
    if(url.includes('/settings?'))return ok({revision:5,canManage:true,global:{expressionRules:[{ruleId:'global-rule',phrase:'blocked',action:'blocked',match:'contains'}]},local:{styleContracts:[{contractId:'style-one',policyText:'Natural sentences',counterexamples:['bad ending']}]},effective:{permissions:{},typing:{}}});return responses(url);});
  f.render();await f.settle();let tree=f.render();button(tree,'[合成] 本地合成流 · offline').props.onClick();f.render();await f.settle();tree=f.render();
  button(tree,'编辑 style-one').props.onClick();tree=f.render();walk(tree).find(node=>node.props['aria-label']==='规则内容').props.onChange({target:{value:'Short natural sentences'}});tree=f.render();
  button(tree,'保存表达规则').props.onClick();await f.settle();tree=f.render();assert.deepEqual(writes[0].body.patch.styleContracts,[{contractId:'style-one',policyText:'Short natural sentences',counterexamples:['bad ending']}]);assert.equal(writes[0].body.key,'local');
  button(tree,'删除 global-rule').props.onClick();await f.settle();tree=f.render();assert.equal(Object.hasOwn(writes[1].body,'key'),false);assert.deepEqual(writes[1].body.patch.expressionRules,[]);
  walk(tree).find(node=>node.props['aria-label']==='表达预览文本').props.onChange({target:{value:'ordinary sentence'}});tree=f.render();button(tree,'检查当前表达').props.onClick();await f.settle();
  assert.deepEqual(writes[2],{route:'expression-preview',body:{key:'local',text:'ordinary sentence',kind:'social'}});f.unmount();
});

test('VM growth candidates use trusted evaluation and explicit review activate endpoints, with no self-reported scores',async()=>{
  const writes=[];let state='proposed';const f=nativeFixture(async(url,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);writes.push(body);state=body.command==='evaluate'?'evaluated':body.command==='review'?'approved':state;return ok({});}
    if(url.includes('/growth?'))return ok({revision:9,evaluatorConfigured:true,value:{growthVersion:'initial',evidence:{proof:{revision:1,revoked:false}}},suites:[],versions:[{id:'initial'}],candidates:[{revision:2,value:{id:'candidate',status:state,adaptation:{warmth:55},sources:[{eventId:'proof',revision:1}],evaluation:state==='proposed'?null:{candidate:{privacy:'pass'}}}}]});return responses(url);});
  f.render();await f.settle();let tree=f.render();button(tree,'[合成] 本地合成流 · offline').props.onClick();f.render();await f.settle();tree=f.render();
  button(tree,'可信评测 candidate').props.onClick();await f.settle();tree=f.render();assert.deepEqual(writes[0],{key:'local',command:'evaluate',id:'candidate',expectedRevision:2});
  assert.equal(Object.hasOwn(writes[0],'evaluation'),false);button(tree,'批准成长 candidate').props.onClick();await f.settle();tree=f.render();button(tree,'启用成长 candidate').props.onClick();await f.settle();
  assert.deepEqual(writes[2],{key:'local',command:'activate',id:'candidate',expectedCandidateRevision:2,expectedStateRevision:9});f.unmount();
});

test('VM conversation filtering pagination and trace use bounded scoped reads, while creation requires an explicit account and target',async()=>{
  const calls=[];const f=nativeFixture(async(url,options)=>{calls.push({url,options});if(options.method==='POST')return ok({});
    if(url.includes('/conversations'))return ok({total:25,nextOffset:20,items:[{key:'local',label:'Local',status:'offline'}]});
    if(url.includes('/self?'))return ok({revision:1,value:{intents:[{id:'intent',topic:'music',status:'pending',expiresAt:Date.now()+600000}]}});
    if(url.includes('/trace?'))return ok({turns:[{id:'turn',status:'skipped',reason:'PARTICIPATION_DISABLED',memoryIds:['memory-safe']}],deliveries:[{id:'d',kind:'social',status:'confirmed',reason:'NONE',waitMs:0,receipt:'receipt-safe'}]});return responses(url);});
  f.render();await f.settle();let tree=f.render();walk(tree).find(node=>node.props['aria-label']==='过滤会话').props.onChange({target:{value:'Local'}});tree=f.render();button(tree,'筛选会话').props.onClick();await f.settle();tree=f.render();
  assert.ok(calls.some(row=>row.url.includes('conversations?q=Local&offset=0&limit=20')));button(tree,'下一页会话').props.onClick();await f.settle();tree=f.render();assert.ok(calls.some(row=>row.url.includes('offset=20')));
  button(tree,'Local · offline').props.onClick();f.render();await f.settle();tree=f.render();button(tree,'轨迹').props.onClick();tree=f.render();assert.ok(content(tree).includes('PARTICIPATION_DISABLED'));assert.ok(content(tree).includes('receipt-safe'));
  assert.equal(button(tree,'准备创作草稿').props.disabled,true);walk(tree).find(node=>node.props['aria-label']==='创作意愿').props.onChange({target:{value:'intent'}});tree=f.render();
  for(const[label,value]of[['创作账号ID','explicit-account'],['目标对象ID','video-id']]){walk(tree).find(node=>node.props['aria-label']===label).props.onChange({target:{value}});tree=f.render();}
  button(tree,'准备创作草稿').props.onClick();await f.settle();const posted=calls.find(row=>row.options.method==='POST');assert.deepEqual(JSON.parse(posted.options.body),{key:'local',intentionId:'intent',action:'bili.comment',accountId:'explicit-account',target:{objectId:'video-id',parentId:null,visibility:'public',category:null}});f.unmount();
});

test('VM per-conversation contact limits preserve CAS, bounded hours and explicit reset without changing Host authority',async()=>{
  const writes=[];const f=nativeFixture(async(url,options)=>{if(options.method==='POST'){writes.push(JSON.parse(options.body));return ok({});}return responses(url);});
  f.render();await f.settle();let tree=f.render();button(tree,'[合成] 本地合成流 · offline').props.onClick();f.render();await f.settle();tree=f.render();
  walk(tree).find(node=>node.props['aria-label']==='每日主动额度').props.onChange({target:{value:'2'}});tree=f.render();
  button(tree,'保存本会话主动限制').props.onClick();await f.settle();tree=f.render();assert.deepEqual(writes[0],{key:'local',expectedRevision:2,patch:{contactPolicy:{timeZoneOffsetMinutes:480,windows:[{startMinute:480,endMinute:1320}],cooldownMs:3600000,dailyLimit:2,unansweredLimit:2}}});
  button(tree,'重置本会话主动限制').props.onClick();await f.settle();assert.deepEqual(writes[1],{key:'local',expectedRevision:2,patch:{contactPolicy:null}});f.unmount();
});

test('VM explicitly prepares a pending creation intention before starting a work and never invents a successful decision',async()=>{
  const writes=[];let prepared=false;const f=nativeFixture(async(url,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);writes.push({route:url.split('/').at(-1),body});prepared=true;return ok({choice:'reply',intention:{id:'prepared',status:'pending'}});}
    if(url.includes('/self?'))return ok({revision:1,value:{intents:prepared?[{id:'prepared',topic:'music',status:'pending',expiresAt:Date.now()+600000}]:[]}});return responses(url);});
  f.render();await f.settle();let tree=f.render();button(tree,'[合成] 本地合成流 · offline').props.onClick();f.render();await f.settle();tree=f.render();assert.equal(button(tree,'评估创作意愿').props.disabled,true);
  walk(tree).find(node=>node.props['aria-label']==='创作主题').props.onChange({target:{value:'music'}});tree=f.render();button(tree,'评估创作意愿').props.onClick();await f.settle();tree=f.render();
  assert.deepEqual(writes,[{route:'creation-intention',body:{key:'local',topic:'music'}}]);assert.ok(walk(tree).some(node=>node.type==='option'&&node.props.value==='prepared'));
  assert.equal(button(tree,'准备创作草稿').props.disabled,true);f.unmount();
});

test('VM Bili material capture is explicit, revisions come from local snapshots and learning remains a pending proposal',async()=>{
  const calls=[];let revision=0,status='active';const f=nativeFixture(async(url,options)=>{calls.push({url,options});if(options.method==='POST'){
    const body=JSON.parse(options.body);if(body.action==='capture')revision++;if(body.action==='revoke'){revision++;status='revoked';}return ok({requiresHumanApproval:true});}
    if(url.includes('/bili-source?'))return ok({revision:status==='active'?revision:revision-1,status,source:{id:'material',revision,status},snapshot:{contentHash:'hash',content:{title:'Bounded source',coverage:'first page'},items:[{id:'material:video',text:'Public video material'}]}});return responses(url);});
  f.render();await f.settle();let tree=f.render();assert.equal(calls.some(row=>row.url.includes('bili-source')),false);
  button(tree,'[合成] 本地合成流 · offline').props.onClick();f.render();await f.settle();tree=f.render();
  for(const[label,value]of[['B站材料编号','material'],['B站账号规范键','["bili","account"]'],['B站BV号','BVsynthetic']]){walk(tree).find(node=>node.props['aria-label']===label).props.onChange({target:{value}});tree=f.render();}
  assert.equal(calls.some(row=>row.options.method==='POST'),false);button(tree,'明确捕获授权B站材料').props.onClick();await f.settle();tree=f.render();
  const posted=()=>calls.filter(row=>row.options.method==='POST').map(row=>JSON.parse(row.options.body));
  assert.deepEqual(posted()[0],{action:'capture',id:'material',expectedRevision:0,request:{account:'["bili","account"]',bvid:'BVsynthetic'}});assert.ok(content(tree).includes('Bounded source'));
  walk(tree).find(node=>node.props['aria-label']==='选择材料条目').props.onChange({target:{value:'material:video'}});tree=f.render();walk(tree).find(node=>node.props['aria-label']==='材料学习候选编号').props.onChange({target:{value:'proposal'}});tree=f.render();
  assert.ok(content(tree).includes('Public video material'));button(tree,'提出材料学习候选').props.onClick();await f.settle();tree=f.render();assert.deepEqual(posted()[1],{action:'learning',key:'local',id:'material',revision:1,itemId:'material:video',proposalId:'proposal'});
  button(tree,'撤销当前B站材料').props.onClick();await f.settle();tree=f.render();assert.deepEqual(posted()[2],{action:'revoke',id:'material',expectedRevision:1});assert.equal(button(tree,'提出材料学习候选').props.disabled,true);assert.equal(posted().filter(body=>body.action==='capture').length,1);f.unmount();
});

test('VM switching conversations clears inherited contact draft values from the former stream',async()=>{
  const f=nativeFixture(async url=>{if(url.endsWith('/conversations'))return ok({items:[{key:'a',label:'A',status:'offline'},{key:'b',label:'B',status:'offline'}]});
    if(url.includes('/settings?'))return ok({revision:1,global:{},effective:{permissions:{},typing:{}},local:url.includes('key=a')?{contactPolicy:{timeZoneOffsetMinutes:0,windows:[{startMinute:60,endMinute:120}],cooldownMs:120000,dailyLimit:1,unansweredLimit:1}}:null});return responses(url);});
  f.render();await f.settle();let tree=f.render();button(tree,'A · offline').props.onClick();f.render();await f.settle();tree=f.render();assert.equal(walk(tree).find(node=>node.props['aria-label']==='主动时段开始').props.value,'01:00');
  button(tree,'B · offline').props.onClick();f.render();await f.settle();tree=f.render();assert.equal(walk(tree).find(node=>node.props['aria-label']==='主动时段开始').props.value,'08:00');f.unmount();
});

test('VM summary creation requires concrete two-step review and posts exact IDs and target without preview-only text or route',async()=>{
  const writes=[];const f=nativeFixture(async(url,options)=>{if(options.method==='POST'){writes.push({route:url.split('/').at(-1),body:JSON.parse(options.body)});return ok({});}
    if(url.includes('/memory?'))return ok({policyRevision:6,canReviewMemory:true,items:[{id:'summary-card',revision:2,text:'Exact reviewed summary',kind:'knowledge',status:'active'}],sources:[],reviews:[]});return responses(url);});
  f.render();await f.settle();let tree=f.render();button(tree,'[合成] 本地合成流 · offline').props.onClick();f.render();await f.settle();tree=f.render();
  for(const[label,value]of[['创作账号ID','authorized-account'],['目标对象ID','video-object']]){walk(tree).find(node=>node.props['aria-label']===label).props.onChange({target:{value}});tree=f.render();}
  button(tree,'记忆').props.onClick();tree=f.render();button(tree,'复核记忆 summary-card').props.onClick();tree=f.render();
  walk(tree).find(node=>node.props['aria-label']==='复核操作').props.onChange({target:{value:'prepare-summary'}});tree=f.render();walk(tree).find(node=>node.props['aria-label']==='记忆复核理由').props.onChange({target:{value:'Only this summary for this target'}});tree=f.render();
  button(tree,'预览记忆变更').props.onClick();tree=f.render();assert.equal(writes.length,0);assert.ok(content(tree).includes('Exact reviewed summary'));assert.ok(content(tree).includes('authorized-account'));
  button(tree,'确认提交记忆变更').props.onClick();await f.settle();assert.equal(writes.length,1);const {expiresAt,...body}=writes[0].body;
  assert.equal(writes[0].route,'summary-creation');assert.deepEqual(body,{key:'local',memoryId:'summary-card',expectedMemoryRevision:2,expectedPolicyRevision:6,reason:'Only this summary for this target',request:{action:'bili.comment',accountId:'authorized-account',target:{objectId:'video-object',parentId:null,visibility:'public',category:null}}});
  assert.ok(expiresAt>Date.now()&&expiresAt<=Date.now()+86400000);assert.equal(Object.hasOwn(body,'summaryText'),false);assert.equal(Object.hasOwn(body,'route'),false);f.unmount();
});
