import { JsonModelProvider, MODEL_LIMITS } from './model-provider.js';

// Contract source: @deepseek-ai/dsh-llm 0.2.1-rc.3 lib/typert.host.js
// (GenerateOptions, PreparedLlmCall, StreamChunk, TokenUsage), lib/types/assembler.js.
// The trusted Host injects ctx.llm and the SDK-exported BlockAssembler constructor.
// Merely importing or constructing this adapter performs no model or network I/O.
const fail = code => Object.assign(new Error(code), { code });
const requireValue = (ok, code = 'MODEL_INVALID_INPUT') => { if (!ok) throw fail(code); };
const encoder = new TextEncoder();
const validString = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
function wait(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function tokenUsage(value) {
  if (value === undefined) return null;
  requireValue(value && typeof value === 'object', 'MODEL_USAGE_INVALID');
  for (const key of ['inputTokens', 'outputTokens']) requireValue(Number.isSafeInteger(value[key]) && value[key] >= 0, 'MODEL_USAGE_INVALID');
  const total = value.inputTokens + value.outputTokens;
  requireValue(Number.isSafeInteger(total) && (value.totalTokens === undefined || value.totalTokens === total), 'MODEL_USAGE_INVALID');
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    requireValue(value[key] === undefined || (Number.isSafeInteger(value[key]) && value[key] >= 0
      && value[key] <= (key === 'reasoningTokens' ? value.outputTokens : value.inputTokens)), 'MODEL_USAGE_INVALID');
  }
  return { prompt_tokens: value.inputTokens, completion_tokens: value.outputTokens, total_tokens: total };
}

async function sdkResponse(llm, BlockAssembler, route, body, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) throw signal.reason;
  signal.addEventListener('abort', abort, { once: true });
  try { return await readSdkResponse(llm, BlockAssembler, route, body, controller.signal); }
  finally {
    // Parser/tool/limit failures must also cancel the underlying SDK request.
    // Waiting for iterator.return alone cannot stop a pending network read.
    controller.abort(fail('MODEL_CANCELLED'));
    signal.removeEventListener('abort', abort);
  }
}

async function readSdkResponse(llm, BlockAssembler, route, body, signal) {
  // The in-process transport receives only our existing bounded contract request.
  // The SDK has a separate `system` field and content-block request messages.
  const prepared = await wait(Promise.resolve().then(() => llm.prepareCall({ ...route }, signal)), signal);
  requireValue(prepared && typeof prepared.stream === 'function' && prepared.config
    && prepared.config.provider === route.provider && prepared.config.model === route.model
    && prepared.config.maxTokens === route.maxTokens, 'MODEL_RESPONSE_INVALID');
  // rc.3 PreparedLlmCall.retryPolicy belongs to the captured provider route.
  // GenerateOptions has no per-call retry override. Core streaming passes
  // through llm/stream middleware; the optional retry plugin consumes this
  // policy at the agent failed-step boundary. Refuse any route permitting
  // retries rather than mutating global configuration or assuming a single
  // prepared.stream invocation proves a single paid network request.
  requireValue(prepared.retryPolicy?.mode === 'normal' && prepared.retryPolicy.maxRetries === 0, 'MODEL_RETRY_POLICY_UNSAFE');
  const config = prepared.config;
  requireValue(Object.keys(config).every(key => ['provider', 'model', 'maxTokens', 'reasoningEffort', 'temperature', 'stop'].includes(key)), 'MODEL_RESPONSE_INVALID');
  // Use the exact prepared controls: SDK validation/default materialization and
  // dispatch stay on the same registration; never call llm.stream or retry.
  const stream = prepared.stream({ ...config, system: body.messages[0].content,
    messages: [{ role: 'user', content: [{ type: 'text', text: body.messages[1].content }] }], signal });
  requireValue(stream && typeof stream[Symbol.asyncIterator] === 'function', 'MODEL_RESPONSE_INVALID');
  const iterator = stream[Symbol.asyncIterator](); const assembler = new BlockAssembler();
  let chunks = 0; let bytes = 0; let seenFinish = false; let complete = false; const closed = new Set(); const kinds = new Map();
  try {
    while (true) {
      const step = await wait(Promise.resolve().then(() => iterator.next()), signal);
      if (step.done) { complete = true; break; }
      const chunk = step.value;
      requireValue(chunk && typeof chunk === 'object' && !seenFinish, 'MODEL_RESPONSE_INVALID');
      bytes += encoder.encode(JSON.stringify(chunk)).byteLength;
      requireValue(++chunks <= 4096 && bytes <= MODEL_LIMITS.responseBytes, 'MODEL_RESPONSE_TOO_LARGE');
      if (['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'].includes(chunk.type)) {
        requireValue(Number.isSafeInteger(chunk.index) && chunk.index >= 0 && chunk.index < 128 && !closed.has(chunk.index), 'MODEL_RESPONSE_INVALID');
        const kind = chunk.type === 'block-start' ? chunk.blockType : chunk.type === 'block-end' ? chunk.block?.type
          : chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call';
        requireValue(kind !== 'tool-call' && kind !== 'tool-result', 'MODEL_UNEXPECTED_TOOLS');
        requireValue(['text', 'reasoning'].includes(kind) && (!kinds.has(chunk.index) || kinds.get(chunk.index) === kind), 'MODEL_RESPONSE_INVALID');
        if (chunk.type === 'block-start') requireValue(!kinds.has(chunk.index), 'MODEL_RESPONSE_INVALID');
        kinds.set(chunk.index, kind);
        if (chunk.type.endsWith('-delta')) requireValue(typeof chunk.text === 'string', 'MODEL_RESPONSE_INVALID');
        if (chunk.type === 'block-end') { requireValue(typeof chunk.block.text === 'string', 'MODEL_RESPONSE_INVALID'); closed.add(chunk.index); }
        // Reasoning is bounded above but never assembled, returned, logged or
        // placed into any subsequent prompt. Tools are rejected before assembly.
        if (kind === 'text') assembler.push(chunk);
      } else if (chunk.type === 'usage') {
        tokenUsage(chunk.usage); assembler.push(chunk);
      } else if (chunk.type === 'finish') {
        seenFinish = true;
        if (chunk.reason?.kind === 'aborted') throw fail('MODEL_CANCELLED');
        if (chunk.reason?.kind === 'error') throw fail('MODEL_REQUEST_FAILED');
        requireValue(chunk.reason?.kind === 'stop', 'MODEL_INCOMPLETE'); assembler.push(chunk);
      } else throw fail('MODEL_RESPONSE_INVALID');
    }
    // BlockAssembler.finish defaults to stop when no terminal chunk was received.
    requireValue(seenFinish && assembler.finish.kind === 'stop', 'MODEL_INCOMPLETE');
    const blocks = assembler.blocks();
    requireValue(blocks.length > 0 && blocks.every(block => block.type === 'text' && typeof block.text === 'string'), 'MODEL_RESPONSE_INVALID');
    const content = blocks.map(block => block.text).join('');
    requireValue(content.length <= MODEL_LIMITS.contextChars, 'MODEL_OUTPUT_TOO_LARGE');
    const usage = tokenUsage(assembler.usage);
    const encoded = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage });
    requireValue(encoder.encode(encoded).byteLength <= MODEL_LIMITS.responseBytes, 'MODEL_RESPONSE_TOO_LARGE');
    return new Response(encoded, { headers: { 'content-type': 'application/json' } });
  } finally {
    // A malicious/stalled iterator must not extend the outer timeout. Its late
    // rejection is observed; abort remains the provider's cancellation contract.
    if (!complete && typeof iterator.return === 'function') void Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
}

/** Strict JSON contract bridge to an explicitly injected DSH LlmService. */
export class DshModelProvider {
  #json;
  constructor(options) {
    requireValue(options && typeof options === 'object' && !Array.isArray(options));
    const keys = ['id', 'llm', 'BlockAssembler', 'provider', 'model', 'budget', 'maxTokens', 'timeoutMs'];
    requireValue(Reflect.ownKeys(options).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(options, key)));
    requireValue(validString(options.provider) && validString(options.model) && options.llm && typeof options.llm.prepareCall === 'function'
      && typeof options.BlockAssembler === 'function');
    const { llm, BlockAssembler } = options;
    const route = Object.freeze({ provider: options.provider, model: options.model, maxTokens: options.maxTokens });
    // Reuse the existing strict schemas, context/output bounds and budget ledger.
    // This URL and marker never leave the process: fetchImpl is mandatory here
    // and does no HTTP. No default model, credential source or fallback exists.
    this.#json = new JsonModelProvider({ id: options.id, endpoint: 'https://dsh-in-process.invalid/chat/completions', model: options.model,
      credential: () => 'in-process-no-credential', budget: options.budget, maxTokens: options.maxTokens, timeoutMs: options.timeoutMs,
      fetchImpl: (_url, init) => sdkResponse(llm, BlockAssembler, route, JSON.parse(init.body), init.signal) });
    Object.defineProperty(this, 'id', { value: options.id, enumerable: true });
  }
  toJSON() { return { id: this.id }; }
  generate(request, signal) { return this.#json.generate(request, signal); }
  reviewStyle(request, signal) { return this.#json.reviewStyle(request, signal); }
  planCreation(request, signal) { return this.#json.planCreation(request, signal); }
  planVideo(request, signal) { return this.#json.planVideo(request, signal); }
}
