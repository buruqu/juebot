import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DshModelProvider } from '../host/dsh-model-provider.js';

// This small contract fixture isolates our adapter, not the DSH service. The
// optional source check below also feeds synthetic chunks to the SDK assembler.
class SyntheticAssembler {
  data = new Map(); usage; finish = { kind: 'stop' };
  push(chunk) {
    if (chunk.type === 'text-delta') this.data.set(chunk.index, (this.data.get(chunk.index) ?? '') + chunk.text);
    if (chunk.type === 'block-end') this.data.set(chunk.index, chunk.block.text);
    if (chunk.type === 'usage') this.usage = chunk.usage;
    if (chunk.type === 'finish') this.finish = chunk.reason;
  }
  blocks() { return [...this.data.values()].map(text => ({ type: 'text', text })); }
}
const request = () => ({ kind: 'reply', name: 'synthetic', roleCore: '', prompt: '', input: 'hello', memories: [], recent: [],
  affect: { valence: 0, intensity: 0 }, topic: '', expressionRules: [], styleContracts: [] });
const output = { text: 'synthetic answer', learning: [] };
const finish = { type: 'finish', reason: { kind: 'stop' } };
const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
const text = content => ({ type: 'text-delta', index: 0, text: typeof content === 'string' ? content : JSON.stringify(content) });
const code = expected => error => error?.code === expected && error.message === expected;
function fixture({ chunks = [text(output), usage, finish], stream, prepare, ...overrides } = {}) {
  const calls = []; const settlements = []; const reservations = [];
  const llm = { prepareCall: async (config, signal) => {
    calls.push({ config, signal });
    if (prepare) return prepare(config, signal);
    return { config: { ...config, reasoningEffort: 'synthetic-effort' }, retryPolicy: { mode: 'normal', maxRetries: 0,
      retryableCodes: ['RATE_LIMIT'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }, stream: options => {
      calls[0].options = options;
      return stream ? stream(options) : (async function* () { yield* chunks; })();
    } };
  } };
  const options = { id: 'synthetic-sdk-port', llm, BlockAssembler: SyntheticAssembler, provider: 'explicit-provider', model: 'explicit-model',
    budget: { reserve: async units => { reservations.push(units); return 'ticket'; }, settle: async (ticket, value) => { settlements.push(value); } },
    maxTokens: 512, timeoutMs: 500, ...overrides };
  return { provider: new DshModelProvider(options), calls, settlements, reservations };
}

test('native bridge requires explicit route, caps, budget and trusted SDK injection', () => {
  for (const invalid of [{ provider: '' }, { model: '' }, { maxTokens: undefined }, { timeoutMs: 0 }, { llm: {} }, { BlockAssembler: undefined }]) {
    assert.throws(() => fixture(invalid), code('MODEL_INVALID_INPUT'));
  }
  assert.throws(() => fixture({ budget: null }), code('MODEL_BUDGET_REQUIRED'));
  assert.throws(() => fixture({ credential: () => 'never' }), code('MODEL_INVALID_INPUT'));
});

test('native prompt carries reviewed tone and a bounded optional observation without additional model calls',async()=>{
  const observation={topic:'music',interestDelta:3,valence:20,intensity:30,relationshipDelta:1,feedback:'interest'};
  const f=fixture({chunks:[text({...output,observation}),usage,finish]});
  const input={...request(),adaptation:{warmth:60,curiosity:60,initiative:55},participation:0.5};
  assert.deepEqual((await f.provider.generate(input)).observation,observation);assert.equal(f.calls.length,1);
  assert.ok(f.calls[0].options.system.includes('never evidence of consciousness'));assert.ok(f.calls[0].options.system.includes('only the current input'));
  assert.deepEqual(JSON.parse(f.calls[0].options.messages[0].content[0].text).adaptation,input.adaptation);
});

test('native generation uses one prepared registration, SDK content blocks and exact prepared controls', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.provider.generate(request()), output);
  assert.equal(f.calls.length, 1); const call = f.calls[0];
  assert.deepEqual(call.config, { provider: 'explicit-provider', model: 'explicit-model', maxTokens: 512 });
  assert.equal(call.options.reasoningEffort, 'synthetic-effort');
  assert.deepEqual(call.options.messages, [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(request()) }] }]);
  assert.ok(call.options.system.includes('strict JSON')); assert.ok(!Object.hasOwn(call.options, 'tools'));
  assert.deepEqual(f.settlements, [{ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, uncertain: false }]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.provider)), { id: 'synthetic-sdk-port' });
});

test('all four public operations retain their existing strict JSON output validators', async () => {
  assert.equal(await fixture({ chunks: [text({ decision: 'pass' }), finish] }).provider.reviewStyle({ text: 'x', styleContracts: [] }), 'pass');
  const plan = { brief: 'brief', script: 'script', title: 'title', description: '', tags: [], text: '' };
  assert.deepEqual(await fixture({ chunks: [text(plan), finish] }).provider.planCreation({ intention: { topic: 't', reason: 'r' }, action: 'bili.video',
    materials: { revision: 1, sources: [], items: [] } }), plan);
  const video = { title: 'title', description: '', tags: [], scenes: [{ text: 'caption', duration: 2 }] };
  assert.deepEqual(await fixture({ chunks: [text(video), finish] }).provider.planVideo({ action: 'bili.video', script: 'script', intention: 'intent', brief: null }), video);
  for (const result of ['{"text":"a","text":"b","learning":[]}', '```json\n{}\n```', { ...output, approved: true }]) {
    const f = fixture({ chunks: [text(result), finish] });
    await assert.rejects(f.provider.generate(request()), code(typeof result === 'string' ? 'MODEL_JSON_INVALID' : 'MODEL_OUTPUT_INVALID'));
    assert.equal(f.settlements[0].uncertain, true);
  }
});

test('reasoning never becomes answer content; tools and non-text content fail closed', async () => {
  const f = fixture({ chunks: [{ type: 'reasoning-delta', index: 1, text: 'PRIVATE-REASONING' }, text(output), usage, finish] });
  assert.deepEqual(await f.provider.generate(request()), output);
  for (const chunk of [{ type: 'tool-call-delta', index: 1, id: 'x', name: 'publish', argumentsDelta: '{}' },
    { type: 'block-start', index: 1, blockType: 'tool-call' }, { type: 'block-end', index: 1, block: { type: 'image' } }]) {
    const g = fixture({ chunks: [text(output), chunk, finish] });
    await assert.rejects(g.provider.generate(request()), code(chunk.block?.type === 'image' ? 'MODEL_RESPONSE_INVALID' : 'MODEL_UNEXPECTED_TOOLS'));
    assert.equal(g.settlements[0].uncertain, true);
    assert.equal(g.calls[0].options.signal.aborted, true);
  }
});

test('explicit terminal stop is required, SDK error/aborted are failures and never retry', async () => {
  for (const [terminal, expected] of [[undefined, 'MODEL_INCOMPLETE'], ['max-tokens', 'MODEL_INCOMPLETE'],
    ['tool-calls', 'MODEL_INCOMPLETE'], ['aborted', 'MODEL_CANCELLED'], ['error', 'MODEL_REQUEST_FAILED']]) {
    const f = fixture({ chunks: [text(output), ...(terminal ? [{ type: 'finish', reason: { kind: terminal, failure: { message: 'SECRET', code: 'SECRET' } } }] : [])] });
    await assert.rejects(f.provider.generate(request()), code(expected)); assert.equal(f.calls.length, 1); assert.equal(f.settlements[0].uncertain, true);
  }
  await assert.rejects(fixture({ chunks: [text(output), finish, finish] }).provider.generate(request()), code('MODEL_RESPONSE_INVALID'));
});

test('prepared route/cap changes reject before dispatch and SDK failures stay redacted', async () => {
  for (const patch of [{ provider: 'other' }, { model: 'other' }, { maxTokens: 999 }, { apiKey: 'SECRET' }]) {
    const f = fixture({ prepare: async config => ({ config: { ...config, ...patch }, retryPolicy: { mode: 'normal', maxRetries: 0 }, stream() { assert.fail('dispatch must be blocked'); } }) });
    await assert.rejects(f.provider.generate(request()), code('MODEL_RESPONSE_INVALID'));
  }
  for (const changes of [{ prepare() { throw new Error('SECRET'); } }, { stream: () => (async function* () { yield text(output); throw new Error('SECRET'); })() }]) {
    const f = fixture(changes); await assert.rejects(f.provider.generate(request()), code('MODEL_REQUEST_FAILED')); assert.equal(f.calls.length, 1);
  }
});

test('rc.3 provider-owned retry policy must explicitly disallow retries before dispatch', async () => {
  // Exact rc.3 ResolvedRetryPolicy shape is flattened, not {backoff:{...}}.
  const backoff = { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 };
  for (const retryPolicy of [undefined, { mode: 'always', ...backoff },
    { mode: 'normal', maxRetries: 5, retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'], ...backoff },
    { mode: 'normal', maxRetries: '0', ...backoff }, { mode: 'normal', ...backoff }]) {
    let dispatched = false;
    const f = fixture({ prepare: async config => ({ config, retryPolicy, stream() { dispatched = true; assert.fail('unsafe retry route'); } }) });
    await assert.rejects(f.provider.generate(request()), code('MODEL_RETRY_POLICY_UNSAFE'));
    assert.equal(dispatched, false); assert.equal(f.settlements[0].uncertain, true);
  }
});

test('bounded context and denied reservation prevent SDK preparation', async () => {
  const f = fixture(); const input = request(); input.recent = Array.from({ length: 8 }, () => ({ actor: 'x', text: 'x'.repeat(16000) }));
  await assert.rejects(f.provider.generate(input), code('MODEL_CONTEXT_TOO_LARGE')); assert.equal(f.calls.length, 0); assert.equal(f.reservations.length, 0);
  const g = fixture({ budget: { reserve() { throw new Error('SECRET'); }, settle() { assert.fail(); } } });
  await assert.rejects(g.provider.generate(request()), code('MODEL_BUDGET_DENIED')); assert.equal(g.calls.length, 0);
});

test('usage totals and output caps are checked; missing usage conservatively keeps reservation uncertain', async () => {
  const f = fixture({ chunks: [text(output), finish] }); await f.provider.generate(request()); assert.deepEqual(f.settlements, [{ usage: null, uncertain: true }]);
  for (const data of [{ inputTokens: -1, outputTokens: 2 }, { inputTokens: 1, outputTokens: 1, totalTokens: 3 }, { inputTokens: 1, outputTokens: 513 }]) {
    const g = fixture({ chunks: [text(output), { type: 'usage', usage: data }, finish] });
    await assert.rejects(g.provider.generate(request()), code('MODEL_USAGE_INVALID')); assert.equal(g.settlements[0].uncertain, true);
  }
  const huge = fixture({ chunks: [{ type: 'reasoning-delta', index: 1, text: 'x'.repeat(1024 * 1024) }, text(output), finish] });
  await assert.rejects(huge.provider.generate(request()), code('MODEL_RESPONSE_TOO_LARGE'));
  const flood = fixture({ stream: () => (async function* () { for (let index = 0; index < 4097; index++) yield text(''); })() });
  await assert.rejects(flood.provider.generate(request()), code('MODEL_RESPONSE_TOO_LARGE'));
});

test('timeout/cancellation stop hung stream iteration without waiting for iterator.return', async () => {
  let returned = false;
  const stream = () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return() { returned = true; return new Promise(() => {}); } });
  const f = fixture({ stream, timeoutMs: 15 }); await assert.rejects(f.provider.generate(request()), code('MODEL_TIMEOUT'));
  await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(returned, true); assert.equal(f.settlements[0].uncertain, true);
  const controller = new AbortController(); const g = fixture({ stream }); const pending = g.provider.generate(request(), controller.signal);
  setTimeout(() => controller.abort(), 10); await assert.rejects(pending, code('MODEL_CANCELLED')); assert.equal(g.settlements[0].uncertain, true);
});

test('pre-cancel and late preparation never dispatch a model stream', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture();
  await assert.rejects(f.provider.generate(request(), controller.signal), code('MODEL_CANCELLED')); assert.equal(f.calls.length, 0);
  let release;
  const g = fixture({ timeoutMs: 10, prepare: config => new Promise(resolve => { release = () => resolve({ config, stream() { assert.fail('late dispatch'); } }); }) });
  await assert.rejects(g.provider.generate(request()), code('MODEL_TIMEOUT'));
  release(); await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(g.settlements[0].uncertain, true);
});

test('optional installed SDK assembler source over synthetic chunks (no LlmService/model calls)', { skip: !process.env.JUEBOT_DSH_ASSEMBLER_SOURCE }, async () => {
  const source = await readFile(process.env.JUEBOT_DSH_ASSEMBLER_SOURCE, 'utf8');
  const start = source.indexOf('export class BlockAssembler'); assert.ok(start >= 0, 'Expected SDK assembler module source');
  // Execute only the inspected pure assembler class, never SDK service/plugin code.
  const BlockAssembler = vm.runInNewContext(`${source.slice(start).replace('export class', 'class')}\nBlockAssembler`, {
    brandString: value => value, assertNever: () => { throw new Error('Unexpected chunk'); }
  });
  const f = fixture({ BlockAssembler, chunks: [{ type: 'block-start', index: 0, blockType: 'text' }, text(output),
    { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(output) } }, usage, finish] });
  assert.deepEqual(await f.provider.generate(request()), output);
});
