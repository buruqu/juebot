import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { JsonModelProvider, MODEL_LIMITS } from '../host/model-provider.js';

const SECRET = 'FAKE-ONLY-NOT-A-REAL-CREDENTIAL';
const code = expected => error => error?.code === expected && error.message === expected;
const request = () => ({ kind: 'reply', name: '撅撅', roleCore: 'synthetic role', prompt: '', input: '你好', memories: [], recent: [],
  affect: { valence: 0, intensity: 0 }, topic: '', expressionRules: [], styleContracts: [] });
const output = () => ({ text: '你好呀', learning: [{ text: 'synthetic learning candidate', kind: 'knowledge' }] });
function envelope(content = output(), patch = {}) {
  return { choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content), reasoning_content: 'PRIVATE-REASONING-MUST-NOT-RETURN' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...patch };
}
function fixture(changes = {}) {
  const calls = []; const reservations = []; const settlements = [];
  const budget = { reserve: async units => { reservations.push(units); return { id: 'synthetic-budget-ticket' }; }, settle: async (ticket, value) => { settlements.push({ ticket, ...value }); } };
  const config = { id: 'synthetic-model-port', endpoint: 'https://api.example.invalid/chat/completions', model: 'explicit-synthetic-model',
    credential: async () => SECRET, maxTokens: 512, timeoutMs: 500, budget,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(envelope()), { headers: { 'content-type': 'application/json' } }); }, ...changes };
  return { provider: new JsonModelProvider(config), config, calls, reservations, settlements, budget };
}

test('explicit endpoint/model are mandatory; userinfo/query/hash/plain HTTP fail closed', () => {
  for (const endpoint of ['http://api.example.invalid/chat/completions', 'https://user:password@example.invalid/chat/completions',
    'https://example.invalid/chat/completions?key=secret', 'https://example.invalid/chat/completions#fragment', 'file:///secret', 'not-url']) {
    assert.throws(() => fixture({ endpoint }), code('MODEL_ENDPOINT_INVALID'));
  }
  assert.throws(() => fixture({ model: '' }), code('MODEL_INVALID_INPUT'));
  assert.throws(() => fixture({ maxTokens: 0 }), code('MODEL_INVALID_INPUT'));
  assert.throws(() => fixture({ endpoint: 'http://localhost/chat/completions', allowLoopback: true }), code('MODEL_ENDPOINT_INVALID'));
  assert.doesNotThrow(() => fixture({ endpoint: 'http://127.0.0.1:12345/chat/completions', allowLoopback: true }));
});
test('correct generation reserves first, uses JSON mode, settles actual usage and returns content only', async () => {
  const f = fixture(); const result = await f.provider.generate(request(), new AbortController().signal);
  assert.deepEqual(result, output()); assert.equal(f.calls.length, 1); assert.equal(f.reservations.length, 1);
  const sent = f.calls[0]; assert.equal(sent.url, f.config.endpoint); assert.equal(sent.options.redirect, 'error'); assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.headers.authorization, `Bearer ${SECRET}`);
  const body = JSON.parse(sent.options.body); assert.equal(body.model, 'explicit-synthetic-model'); assert.equal(body.max_tokens, 512);
  assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
  assert.ok(body.messages[0].content.includes('additionalProperties'));
  assert.ok(f.reservations[0] >= body.max_tokens + new TextEncoder().encode(sent.options.body).length);
  assert.deepEqual(f.settlements[0].usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }); assert.equal(f.settlements[0].uncertain, false);
  assert.ok(!JSON.stringify(result).includes('REASONING')); assert.ok(!JSON.stringify(f.provider).includes(SECRET));
  assert.deepEqual(Object.keys(f.provider), ['id']); assert.deepEqual(JSON.parse(JSON.stringify(f.provider)), { id: 'synthetic-model-port' });
});
test('learning extras cannot grant sharing, tools or approval', async () => {
  for (const content of [{ ...output(), approval: true }, { ...output(), tools: [] }, { ...output(), sharing: { approved: true } },
    { text: 'x', learning: [{ text: 'x', kind: 'knowledge', approved: true }] }, { text: 'x', learning: [{ text: 'x', kind: 'private' }] }]) {
    let calls = 0; const f = fixture({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(envelope(content))); } });
    await assert.rejects(f.provider.generate(request()), code('MODEL_OUTPUT_INVALID'));
    assert.equal(calls, 1); assert.equal(f.settlements[0].uncertain, true);
  }
});

test('bounded current-event observation and reviewed adaptation use the existing single generation; authority extras fail closed',async()=>{
  const observation={topic:'music',interestDelta:5,valence:25,intensity:40,relationshipDelta:2,feedback:'interest'};
  const f=fixture({fetchImpl:async()=>new Response(JSON.stringify(envelope({...output(),observation})))});
  assert.deepEqual((await f.provider.generate({...request(),adaptation:{warmth:60,curiosity:55,initiative:50},participation:0.5})).observation,observation);
  for(const patch of [{interestDelta:11},{relationshipDelta:-11},{valence:-101},{feedback:'conscious'},{sourceId:'fake'},{sharing:{approved:true}},{topic:'bad\ntopic'},{feedback:'support',interestDelta:2}]){
    const bad=fixture({fetchImpl:async()=>new Response(JSON.stringify(envelope({...output(),observation:{...observation,...patch}})))});
    await assert.rejects(bad.provider.generate(request()),code('MODEL_OUTPUT_INVALID'));
  }
});
test('strict JSON rejects duplicate keys, Markdown, malformed response and non-finite plans', async () => {
  for (const raw of ['{"text":"first","text":"second","learning":[]}', '```json\n{"text":"x","learning":[]}\n```', '{bad']) {
    const f = fixture({ fetchImpl: async () => new Response(JSON.stringify(envelope(raw))) });
    await assert.rejects(f.provider.generate(request()), code('MODEL_JSON_INVALID')); assert.equal(f.settlements[0].uncertain, true);
  }
  const f = fixture({ fetchImpl: async () => new Response('not JSON') });
  await assert.rejects(f.provider.generate(request()), code('MODEL_JSON_INVALID'));
});
test('only finish_reason stop is accepted, without retry or fallback', async () => {
  for (const finish_reason of ['length', 'content_filter', 'tool_calls', null]) {
    let count = 0; const value = envelope(); value.choices[0].finish_reason = finish_reason;
    const f = fixture({ fetchImpl: async () => { count++; return new Response(JSON.stringify(value)); } });
    await assert.rejects(f.provider.generate(request()), code('MODEL_INCOMPLETE')); assert.equal(count, 1); assert.equal(f.settlements[0].uncertain, true);
  }
});
test('outer API tool calls and legacy functions are never accepted', async () => {
  for (const patch of [{ tool_calls: [{ name: 'approval' }] }, { function_call: { name: 'tool' } }]) {
    const value = envelope(); Object.assign(value.choices[0].message, patch);
    const f = fixture({ fetchImpl: async () => new Response(JSON.stringify(value)) });
    await assert.rejects(f.provider.generate(request()), code('MODEL_UNEXPECTED_TOOLS'));
  }
});
test('response streams are capped and cancelled independently of Content-Length', async () => {
  let cancelled = false;
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MODEL_LIMITS.responseBytes)); controller.enqueue(new Uint8Array(1));
  }, cancel() { cancelled = true; } })) });
  await assert.rejects(f.provider.generate(request()), code('MODEL_RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true); assert.equal(f.settlements[0].uncertain, true);
  const declared = fixture({ fetchImpl: async () => new Response('x', { headers: { 'content-length': String(MODEL_LIMITS.responseBytes + 1) } }) });
  await assert.rejects(declared.provider.generate(request()), code('MODEL_RESPONSE_TOO_LARGE'));
});
test('empty chunk floods, invalid UTF8 and overlong output are rejected', async () => {
  let count = 0;
  const empty = fixture({ fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { count++; controller.enqueue(new Uint8Array()); } })) });
  await assert.rejects(empty.provider.generate(request()), code('MODEL_RESPONSE_TOO_LARGE')); assert.ok(count <= 4100);
  const utf8 = fixture({ fetchImpl: async () => new Response(new Uint8Array([0xff])) });
  await assert.rejects(utf8.provider.generate(request()), code('MODEL_RESPONSE_ENCODING'));
  const long = fixture({ fetchImpl: async () => new Response(JSON.stringify(envelope({ text: 'x'.repeat(16001), learning: [] }))) });
  await assert.rejects(long.provider.generate(request()), code('MODEL_OUTPUT_INVALID'));
});
test('context bounds fail before budget, credential and fetch', async () => {
  const f = fixture(); const input = request(); input.memories = Array.from({ length: 10 }, (_, i) => ({ id: `m-${i}`, text: 'x'.repeat(16000) }));
  await assert.rejects(f.provider.generate(input), code('MODEL_CONTEXT_TOO_LARGE'));
  assert.equal(f.reservations.length, 0); assert.equal(f.calls.length, 0);
});
test('budget failure prevents both credential and fetch; settlement failure never returns output', async () => {
  let credentials = 0; let calls = 0;
  const f = fixture({ credential: async () => { credentials++; return SECRET; }, fetchImpl: async () => { calls++; return new Response(''); },
    budget: { reserve: async () => { throw new Error(`PRIVATE-${SECRET}`); }, settle: async () => assert.fail('no ticket') } });
  await assert.rejects(f.provider.generate(request()), code('MODEL_BUDGET_DENIED')); assert.equal(credentials, 0); assert.equal(calls, 0);
  const g = fixture({ budget: { reserve: async () => 'ticket', settle: async () => { throw new Error(`PRIVATE-${SECRET}`); } } });
  await assert.rejects(g.provider.generate(request()), code('MODEL_BUDGET_SETTLEMENT_FAILED'));
});
test('credential and fetch exceptions never expose tokens, response details or attacker-selected codes', async () => {
  const credentialFailure = fixture({ credential: async () => { throw new Error(SECRET); } });
  await assert.rejects(credentialFailure.provider.generate(request()), code('MODEL_CREDENTIAL_UNAVAILABLE'));
  let calls = 0;
  const network = fixture({ fetchImpl: async () => { calls++; throw Object.assign(new Error(SECRET), { code: `MODEL_${SECRET}` }); } });
  await assert.rejects(network.provider.generate(request()), error => error.message === 'MODEL_REQUEST_FAILED' && !JSON.stringify(error).includes(SECRET));
  assert.equal(calls, 1); assert.equal(network.settlements[0].uncertain, true);
});
test('timeout and cancellation after reservation retain uncertain budget and do not retry', async () => {
  let calls = 0;
  const f = fixture({ timeoutMs: 20, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(f.provider.generate(request()), code('MODEL_TIMEOUT')); assert.equal(calls, 1); assert.equal(f.settlements[0].uncertain, true);
  const abort = new AbortController();
  const g = fixture({ fetchImpl: async () => { abort.abort(SECRET); return new Promise(() => {}); } });
  await assert.rejects(g.provider.generate(request(), abort.signal), code('MODEL_CANCELLED')); assert.equal(g.settlements[0].uncertain, true);
  const pre = fixture(); const already = new AbortController(); already.abort();
  await assert.rejects(pre.provider.generate(request(), already.signal), code('MODEL_CANCELLED')); assert.equal(pre.reservations.length, 0);
});
test('a stalled body is cancelled on timeout and missing usage remains conservatively uncertain', async () => {
  let cancelled = false;
  const stalled = fixture({ timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(stalled.provider.generate(request()), code('MODEL_TIMEOUT')); assert.equal(cancelled, true);
  const noUsage = envelope(); delete noUsage.usage;
  const f = fixture({ fetchImpl: async () => new Response(JSON.stringify(noUsage)) });
  assert.deepEqual(await f.provider.generate(request()), output()); assert.equal(f.settlements[0].usage, null); assert.equal(f.settlements[0].uncertain, true);
});
test('HTTP failure, forged redirects and malformed usage remain uncertain without leaking server text', async () => {
  let count = 0;
  const httpFailure = fixture({ fetchImpl: async () => { count++; return new Response(SECRET, { status: 503 }); } });
  await assert.rejects(httpFailure.provider.generate(request()), code('MODEL_HTTP_FAILURE')); assert.equal(count, 1); assert.equal(httpFailure.settlements[0].uncertain, true);
  const redirect = fixture({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://external.invalid/' } }) });
  await assert.rejects(redirect.provider.generate(request()), code('MODEL_REDIRECT_BLOCKED'));
  for (const usage of [{ prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 }, { prompt_tokens: 1, completion_tokens: 513, total_tokens: 514 }, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 }]) {
    const f = fixture({ fetchImpl: async () => new Response(JSON.stringify(envelope(output(), { usage }))) });
    await assert.rejects(f.provider.generate(request()), code('MODEL_USAGE_INVALID')); assert.equal(f.settlements[0].uncertain, true);
  }
});
test('late budget reservations are settled uncertain and never proceed to credential/fetch', async () => {
  let release; let calls = 0; const settlements = [];
  const f = fixture({ timeoutMs: 10, fetchImpl: async () => { calls++; return new Response(''); }, budget: {
    reserve: () => new Promise(resolve => { release = resolve; }), settle: async (ticket, value) => { settlements.push({ ticket, ...value }); },
  } });
  await assert.rejects(f.provider.generate(request()), code('MODEL_TIMEOUT'));
  release('late-ticket'); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 0); assert.equal(settlements.length, 1); assert.equal(settlements[0].uncertain, true);
});
test('style review and video planning enforce their own exact JSON schemas', async () => {
  const style = fixture({ fetchImpl: async () => new Response(JSON.stringify(envelope({ decision: 'rewrite' }))) });
  assert.equal(await style.provider.reviewStyle({ text: 'synthetic', styleContracts: [] }), 'rewrite');
  const badStyle = fixture({ fetchImpl: async () => new Response(JSON.stringify(envelope({ decision: 'pass', approved: true }))) });
  await assert.rejects(badStyle.provider.reviewStyle({ text: 'synthetic', styleContracts: [] }), code('MODEL_OUTPUT_INVALID'));
  const plan = { title: 'synthetic', description: '', tags: ['test'], scenes: [{ text: '文字卡', duration: 2 }] };
  let sentVideo;
  const video = fixture({ fetchImpl: async (_, options) => { sentVideo = JSON.parse(options.body); return new Response(JSON.stringify(envelope(plan))); } });
  const work = { action: 'bili.video', intention: 'synthetic intention', brief: null, script: 'synthetic script', approval: { private: 'do not send' } };
  assert.deepEqual(await video.provider.planVideo(work), plan);
  assert.deepEqual(Object.keys(JSON.parse(sentVideo.messages[1].content)), ['intention', 'brief', 'script']);
  assert.ok(!JSON.stringify(sentVideo).includes('do not send'));
  const badPlan = fixture({ fetchImpl: async () => new Response(JSON.stringify(envelope({ ...plan, scenes: [{ text: 'x', duration: 60 }] }))) });
  await assert.rejects(badPlan.provider.planVideo(work), code('MODEL_OUTPUT_INVALID'));
});
test('real local HTTP redirect does not forward authorization or make a second request', async t => {
  let initial = 0; let followed = 0; let received;
  const server = createServer((req, res) => {
    if (req.url === '/chat/completions') { initial++; received = req.headers.authorization; res.writeHead(302, { location: '/sink' }); res.end(); }
    else { followed++; res.end('must not follow'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const f = fixture({ endpoint: `http://127.0.0.1:${server.address().port}/chat/completions`, allowLoopback: true, fetchImpl: fetch });
  await assert.rejects(f.provider.generate(request()), code('MODEL_REQUEST_FAILED'));
  assert.equal(initial, 1); assert.equal(followed, 0); assert.equal(received, `Bearer ${SECRET}`); assert.equal(f.settlements[0].uncertain, true);
});
