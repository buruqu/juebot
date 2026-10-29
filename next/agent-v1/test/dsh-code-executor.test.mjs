import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDshCodeExecutor } from '../host/dsh-code-executor.js';
import { syntheticDsh } from './support/dsh-code-sdk.mjs';
import { SqliteStateStore } from '../lib/agent-v1/src/store.js';
import { CodeTasks } from '../lib/agent-v1/src/code-jobs.js';

const model = { provider: 'synthetic-provider', model: 'synthetic-model', maxTokens: 1024 };
const conversationKey = JSON.stringify(['juebot-conversation-v1', 'bot', 'juejue', 'qq-official', 'test-issuer', 'account', 'direct', 'admin']);
const grant = { revision: 1, adminActor: 'admin', conversationKey, account: 'account', workspaceId: 'workspace', sessionId: 'logical-session',
  modelConfigured: true, budgetAvailable: true, sandboxVerified: true, toolsRestricted: true, allowedTools: ['read-file'], verified: true };
const task = (id = 'code-1') => ({ id, state: 'running', input: { eventId: `event-${id}`, actor: 'admin', conversationKey, account: 'account', plain: true, text: 'SYNTHETIC-CODE-REQUEST' },
  authorization: structuredClone(grant) });
const matches = expected => error => error?.code === expected && error.message === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, behavior, overrides = {}) {
  const base = process.env.JUEBOT_TEST_WORK_ROOT ?? tmpdir(); mkdirSync(base, { recursive: true });
  const workspace = mkdtempSync(join(base, 'juebot-code-'));
  const path = join(workspace, 'state.sqlite');
  const db = new DatabaseSync(path, { allowExtension: false });
  const store = new SqliteStateStore(db, { namespace: 'dsh-code-test', initialize: true });
  const sdk = syntheticDsh({ workspace, behavior, ...overrides.sdk });
  const notifications = [];
  const opts = { ctx: sdk.ctx, store, resolveWorkspace: () => workspace, model, timeoutMs: 5000, cleanupTimeoutMs: 100,
    onInteraction: message => notifications.push(message), ...overrides.options };
  const executor = createDshCodeExecutor(opts);
  const signal = new AbortController(); const gates = { tools: [], models: 0 };
  const context = (item = task()) => ({ task: item, signal: signal.signal,
    gateModel() { gates.models++; overrides.gateModel?.(); }, gateTool(tool) { gates.tools.push(tool); overrides.gateTool?.(tool); } });
  t.after(() => { store.close(); db.close(); rmSync(workspace, { recursive: true, force: true }); });
  return { sdk, opts, executor, store, db, path, workspace, notifications, context, signal, gates };
}
async function begin(run) {
  run.emit('turn/start', { turn: run.turn }); await run.model(); run.emit('user/message', run.message);
}

test('construction is inert and requires explicit SDK route/workspace dependencies', t => {
  const f = fixture(t); assert.equal(f.sdk.calls.length, 0);
  for (const patch of [{ ctx: {} }, { model: {} }, { model: { ...model, maxTokens: 0 } }, { timeoutMs: 0 }, { cleanupTimeoutMs: 0 }, { resolveWorkspace: undefined }])
    assert.throws(() => createDshCodeExecutor({ ...f.opts, ...patch }), matches('DSH_CODE_INVALID_CONFIG'));
});

test('strict final text excludes tool planning and reasoning; restrictions are scoped and disposed', async t => {
  const f = fixture(t, async run => {
    await begin(run);
    run.assistant(null, [{ type: 'reasoning', text: 'PRIVATE-REASONING' }, { type: 'tool-call', id: 't', name: 'read-file', arguments: '{}' }]);
    assert.equal(run.tool('read-file'), undefined);
    run.emit('tool/result', { turn: run.turn, step: 1, message: { role: 'tool', content: [] } });
    await run.model();
    run.assistant(null, [{ type: 'reasoning', text: 'DO-NOT-RETURN' }, { type: 'text', text: 'Done ' }, { type: 'text', text: 'safely' }]); run.end();
  });
  assert.equal(await f.executor(f.context()), 'Done safely');
  assert.deepEqual(f.gates.tools, ['read-file']); assert.ok(f.gates.models > 1);
  const call = f.sdk.calls[0]; assert.equal(call.kind, 'create'); assert.ok(call.options.sessionId.startsWith('juebot-code-'));
  assert.notEqual(call.options.sessionId, grant.sessionId); assert.equal(call.options.meta.cwd, f.workspace);
  assert.deepEqual(call.options.agentOptions, model); assert.equal(f.sdk.disposed, 1);
  assert.equal(f.sdk.runs[0].guards.length, 0); assert.equal(f.sdk.runs[0].restrictions.length, 0);
});

test('dedicated session mapping persists and resumes only registered idle sessions; old tasks never replay', async t => {
  const f = fixture(t); await f.executor(f.context());
  const second = createDshCodeExecutor(f.opts);
  await second(f.context(task('code-2')));
  assert.deepEqual(f.sdk.calls.map(call => call.kind), ['create', 'resume']);
  assert.equal(f.sdk.calls[1].options.resumeSessionId, f.sdk.calls[0].options.sessionId);
  assert.equal(Object.hasOwn(f.sdk.calls[1].options, 'sessionId'), false);
  await assert.rejects(second(f.context()), matches('DSH_CODE_ATTEMPT_ALREADY_EXISTS'));
  assert.equal(f.sdk.calls.length, 2);
  const changed = task('code-3'); changed.authorization.account = 'other-account';
  await second(f.context(changed)); assert.equal(f.sdk.calls[2].kind, 'create');
  assert.notEqual(f.sdk.calls[2].options.sessionId, f.sdk.calls[0].options.sessionId);
  assert.ok(readFileSync(f.path).length > 0);
});

test('idle without a completed own turn never succeeds and blocks automatic session reuse', async t => {
  const f = fixture(t, async () => {});
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_TURN_INCOMPLETE'));
  await assert.rejects(f.executor(f.context(task('code-2'))), matches('DSH_CODE_SESSION_NEEDS_REVIEW'));
  assert.equal(f.sdk.calls.length, 1);
});

test('aborted, blocked, max-token, interrupted and other-user turns never become public results', async t => {
  for (const kind of ['aborted', 'blocked', 'max-tokens', 'error', 'interrupted']) {
    const f = fixture(t, async run => { await begin(run); run.assistant('PARTIAL'); run.end(kind); });
    await assert.rejects(f.executor(f.context()), matches('DSH_CODE_TURN_INCOMPLETE'));
  }
  const f = fixture(t, async run => { await begin(run); run.emit('user/message', { ...run.message, id: 'other-input' }); run.assistant(); run.end(); });
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_TURN_AMBIGUOUS'));
  const interrupted = fixture(t, async run => {
    await begin(run); run.emit('assistant/message', { turn: run.turn, interrupted: true, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'PARTIAL' }] } }); run.end();
  });
  await assert.rejects(interrupted.executor(interrupted.context()), matches('DSH_CODE_RESULT_INVALID'));
});

test('reasoning-only, pending tool-call and oversized final messages fail closed', async t => {
  for (const blocks of [[{ type: 'reasoning', text: 'PRIVATE' }], [{ type: 'tool-call', name: 'read-file' }], [{ type: 'text', text: 'x'.repeat(16001) }]]) {
    const f = fixture(t, async run => { await begin(run); run.assistant(null, blocks); run.end(); });
    await assert.rejects(f.executor(f.context()), matches('DSH_CODE_RESULT_INVALID'));
  }
});

test('approval and question requests require review, never invoke a permissive downstream answerer', async t => {
  for (const kind of ['approval', 'question']) {
    let fallbackCalls = 0; let outcome;
    const f = fixture(t, async run => {
      await begin(run);
      outcome = await run.hook(kind === 'approval' ? 'approval/request' : 'user-questions/request',
        { agent: run.agent, toolName: 'read-file', reason: 'SECRET', questions: [{ question: 'SECRET-QUESTION' }] },
        async () => { fallbackCalls++; return 'allowed-once'; });
      run.assistant('pretended success'); run.end();
    });
    await assert.rejects(f.executor(f.context()), matches(kind === 'approval' ? 'DSH_CODE_NEEDS_APPROVAL' : 'DSH_CODE_NEEDS_INPUT'));
    assert.equal(fallbackCalls, 0); if (kind === 'approval') assert.equal(outcome, 'unavailable');
    assert.equal(f.notifications[0].state, 'needs-review'); assert.equal(f.notifications[0].kind, kind);
    assert.ok(!JSON.stringify(f.notifications).includes('SECRET')); assert.equal(f.sdk.disposed, 1);
  }
});

test('effective full-access or wrong workspace policy is rejected before followup', async t => {
  const full = fixture(t, undefined, { sdk: { mode: 'danger-full-access' } });
  await assert.rejects(full.executor(full.context()), matches('DSH_CODE_SANDBOX_UNSAFE'));
  assert.equal(full.sdk.runs.length, 0);
  const wrong = fixture(t); wrong.sdk.workspace = tmpdir();
  await assert.rejects(wrong.executor(wrong.context()), matches('DSH_CODE_SANDBOX_UNSAFE'));
  assert.equal(wrong.sdk.runs.length, 0);
});

test('unknown tools and run_code without explicit grant are denied even if scoped registrations bypass restrict', async t => {
  for (const name of ['network-send', 'run_code']) {
    let denial;
    const f = fixture(t, async run => { await begin(run); denial = run.tool(name); run.assistant('pretended success'); run.end(); });
    await assert.rejects(f.executor(f.context()), matches('DSH_CODE_TOOL_DENIED'));
    assert.equal(denial, 'DSH_CODE_TOOL_DENIED'); assert.deepEqual(f.gates.tools, []);
  }
  const f = fixture(t, async run => {
    await begin(run); assert.deepEqual(run.restrictions, [{ allow: ['read-file'] }]);
    assert.equal(run.tool('run_code'), undefined); assert.equal(run.tool('read-file'), undefined); run.assistant(); run.end();
  });
  const item = task(); item.authorization.allowedTools.push('run_code');
  await f.executor(f.context(item)); assert.deepEqual(f.gates.tools, ['run_code', 'read-file']);
});

test('grant revocation and session policy changes stop subsequent model/tool work', async t => {
  let revoked = false;
  const f = fixture(t, async run => { await begin(run); revoked = true; run.tool('read-file'); run.assistant(); run.end(); },
    { gateModel: () => { if (revoked) throw new Error('RAW-SECRET-GRANT-ERROR'); } });
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_GATE_REVOKED'));
  const changed = fixture(t, async (run, sdk) => { await begin(run); sdk.mode = 'danger-full-access'; run.emit('sandbox/mode', { mode: sdk.mode }); run.assistant(); run.end(); });
  await assert.rejects(changed.executor(changed.context()), matches('DSH_CODE_SANDBOX_UNSAFE'));
});

test('proposed and SDK-resolved model route changes are rejected; model call cap is enforced', async t => {
  const proposed = fixture(t, async run => { run.emit('turn/start', { turn: run.turn }); await run.model({ ...model, model: 'different' }); });
  await assert.rejects(proposed.executor(proposed.context()), matches('DSH_CODE_MODEL_ROUTE_CHANGED'));
  const resolved = fixture(t, async run => {
    await begin(run); run.emit('request/header', { header: { config: { ...model, provider: 'other' } } }); run.assistant(); run.end();
  });
  await assert.rejects(resolved.executor(resolved.context()), matches('DSH_CODE_MODEL_ROUTE_CHANGED'));
  const capped = fixture(t, async run => { await begin(run); await run.model(); run.assistant(); run.end(); }, { options: { maxModelCalls: 1 } });
  await assert.rejects(capped.executor(capped.context()), matches('DSH_CODE_MODEL_LIMIT'));
});

test('failed assistant attempts and request-error hooks cancel before retry middleware', async t => {
  for (const eventFirst of [true, false]) {
    let retried = false;
    const f = fixture(t, async run => {
      await begin(run);
      if (eventFirst) run.emit('assistant/attempt', { turn: run.turn, step: 1, stream: [] });
      await run.hook('agent/request-error', { agent: run.agent, turn: run.turn, step: 1,
        retryPolicy: { mode: 'always', maxRetries: 5 } }, async () => { retried = true; return { kind: 'retry' }; });
      assert.equal(run.options.signal.aborted, true); run.assistant(); run.end();
    });
    await assert.rejects(f.executor(f.context()), matches('DSH_CODE_MODEL_FAILED')); assert.equal(retried, false);
  }
});

test('atomic session reservation rejects overlap before a second SDK create', async t => {
  const started = deferred(); const release = deferred();
  const f = fixture(t, async run => { await begin(run); started.resolve(); await release.promise; run.assistant(); run.end(); });
  const first = f.executor(f.context()); await started.promise;
  await assert.rejects(createDshCodeExecutor(f.opts)(f.context(task('code-2'))), matches('DSH_CODE_SESSION_NEEDS_REVIEW'));
  release.resolve(); await first; assert.equal(f.sdk.calls.length, 1);
});

test('abort and timeout cancel/dispose owned Agents with late whenIdle safely ignored', async t => {
  for (const cancellation of ['abort', 'timeout']) {
    const started = deferred(); const release = deferred();
    const f = fixture(t, async run => { await begin(run); started.resolve(); await release.promise; run.assistant(); run.end(); },
      { options: { timeoutMs: cancellation === 'timeout' ? 30 : 5000 } });
    const operation = f.executor(f.context()); const rejected = assert.rejects(operation, matches(cancellation === 'timeout' ? 'DSH_CODE_TIMEOUT' : 'DSH_CODE_ABORTED'));
    await started.promise; if (cancellation === 'abort') f.signal.abort(); await rejected;
    assert.equal(f.sdk.disposed, 1); assert.ok(f.sdk.cancelled >= 1); release.resolve();
  }
});

test('a factory returning an Agent after abort is disposed and never receives the QQ request', async t => {
  const f = fixture(t); const entered = deferred(); const release = deferred(); const original = f.sdk.ctx.agents.create;
  f.sdk.ctx.agents.create = async opts => { const handle = await original(opts); entered.resolve(); await release.promise; return handle; };
  const operation = f.executor(f.context()); const rejected = assert.rejects(operation, matches('DSH_CODE_ABORTED'));
  await entered.promise; f.signal.abort(); await rejected; assert.equal(f.sdk.runs.length, 0);
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sdk.disposed, 1);
});

test('hanging disposal is bounded and keeps revoked guards installed', async t => {
  const hanging = deferred(); const f = fixture(t, undefined, { sdk: { dispose: () => hanging.promise }, options: { cleanupTimeoutMs: 20 } });
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_CLEANUP_PENDING'));
  assert.equal(f.sdk.runs[0].tool('read-file'), 'DSH_CODE_TOOL_DENIED');
  hanging.resolve(); await new Promise(resolve => setImmediate(resolve));
});

test('real CodeTasks OFF blocks new admission while the DSH task already running finishes', async t => {
  const started = deferred(); const release = deferred();
  const f = fixture(t, async run => { await begin(run); started.resolve(); await release.promise; assert.equal(run.tool('read-file'), undefined); run.assistant(); run.end(); });
  const jobs = new CodeTasks(f.store, { getAuthorization: () => grant }); jobs.enable(1);
  const input = task().input; const admitted = jobs.admit(input, 2).task;
  const operation = jobs.execute(admitted.id, f.executor, { now: () => 5 }); await started.promise;
  jobs.disable(3); assert.throws(() => jobs.admit({ ...input, eventId: 'new-event' }, 4), /CODE_DISABLED/u);
  release.resolve(); const completed = await operation;
  assert.equal(completed.state, 'completed'); assert.equal(completed.result, 'SYNTHETIC-CODE-RESULT');
});

const questions = [{ id: 'target', question: 'Which file?', header: 'Target', options: [{ label: 'one.js', description: 'first' }, { label: 'two.js' }], multiSelect: false }];
const answers = { answers: [{ id: 'target', selected: ['one.js'] }] };

test('human question answer continues the original waiting Agent without replay or another followup', async t => {
  const requested = deferred(); const response = deferred(); let received;
  const f = fixture(t, async run => {
    await begin(run);
    received = await run.hook('user-questions/request', { agent: run.agent, questions, signal: run.options.signal, wait: { callId: 'question-call' } });
    await run.model(); run.assistant(`Selected ${received.answers[0].selected[0]}`); run.end();
  }, { options: { interactions: { request(payload, controls) { requested.resolve({ payload, controls }); return response.promise; } } } });
  const execution = f.executor(f.context()); const pending = await requested.promise;
  assert.equal(pending.payload.kind, 'question'); assert.equal(pending.payload.taskId, 'code-1');
  assert.equal(pending.payload.callId, 'question-call'); assert.deepEqual(pending.payload.questions, questions);
  assert.equal(f.sdk.runs[0].agent.status, 'running'); assert.equal(f.sdk.cancelled, 0);
  pending.controls.check(); response.resolve(answers);
  assert.equal(await execution, 'Selected one.js'); assert.equal(f.sdk.calls.length, 1); assert.equal(f.sdk.runs.length, 1);
  assert.deepEqual(received, answers); assert.equal(f.notifications.length, 0);
});

test('approval carries concrete tool input and only allowed-once executes the pending call', async t => {
  for (const response of ['allowed-once', 'rejected']) {
    const requested = deferred(); const reply = deferred(); let toolResult;
    const f = fixture(t, async run => {
      await begin(run); toolResult = await run.approvedTool('read-file', { path: 'one.js', encoding: 'utf8' });
      run.assistant(toolResult.executed ? 'Read completed' : 'User declined'); run.end();
    }, { options: { interactions: { request(payload, controls) { requested.resolve({ payload, controls }); return reply.promise; } } } });
    const execution = f.executor(f.context()); const pending = await requested.promise;
    assert.equal(pending.payload.kind, 'approval'); assert.deepEqual(pending.payload.approval.args, { path: 'one.js', encoding: 'utf8' });
    assert.equal(pending.payload.approval.toolName, 'read-file'); assert.equal(f.sdk.cancelled, 0);
    pending.controls.check(); reply.resolve(response);
    assert.equal(await execution, response === 'allowed-once' ? 'Read completed' : 'User declined');
    assert.equal(toolResult.executed, response === 'allowed-once'); assert.equal(f.sdk.runs.length, 1);
  }
});

test('approval without a bound concrete ToolExecution cannot request human permission', async t => {
  let requests = 0;
  const f = fixture(t, async run => {
    await begin(run); run.emit('approval/asked', { id: 'approval', callId: 'missing', toolName: 'read-file' });
    await run.hook('approval/request', { agent: run.agent, callId: 'missing', toolName: 'read-file', signal: run.options.signal });
  }, { options: { interactions: { request() { requests++; return 'allowed-once'; } } } });
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_APPROVAL_UNBOUND')); assert.equal(requests, 0);
});

test('tool input changes while waiting or after approval cannot execute', async t => {
  for (const moment of ['during', 'after']) {
    const requested = deferred(); const reply = deferred(); let exec;
    const f = fixture(t, async run => {
      await begin(run);
      await run.approvedTool('read-file', { path: 'one.js' }, { beforeAnswer: value => { exec = value; },
        afterAnswer: value => { if (moment === 'after') value.arguments = { path: 'two.js' }; } });
      run.assistant('MUST-NOT-COMPLETE'); run.end();
    }, { options: { interactions: { request(payload, controls) { requested.resolve(controls); return reply.promise; } } } });
    const execution = f.executor(f.context()); const rejected = assert.rejects(execution,
      matches(moment === 'during' ? 'DSH_CODE_APPROVAL_INPUT_CHANGED' : 'DSH_CODE_GATE_REVOKED'));
    await requested.promise; if (moment === 'during') exec.arguments = { path: 'two.js' }; reply.resolve('allowed-once');
    await rejected; assert.equal(f.sdk.runs.length, 1);
  }
});

test('permanent approval tokens and malformed answers never pass through to SDK', async t => {
  for (const value of ['allowed-always', true, { approval: 'allowed-once' }]) {
    const f = fixture(t, async run => { await begin(run); await run.approvedTool('read-file', { path: 'one.js' }); },
      { options: { interactions: { request: async () => value } } });
    await assert.rejects(f.executor(f.context()), matches('DSH_CODE_ANSWER_INVALID'));
  }
  for (const value of [{ answers: [] }, { answers: [{ id: 'wrong', selected: ['one.js'] }] },
    { answers: [{ id: 'target', selected: ['unknown'] }] }, { answers: [{ id: 'target', selected: ['one.js', 'two.js'] }] },
    { answers: [{ id: 'target', selected: [] }] }, { answers: [{ id: 'target', selected: ['one.js'], injected: true }] }]) {
    const f = fixture(t, async run => { await begin(run); await run.hook('user-questions/request', { agent: run.agent, questions, signal: run.options.signal }); },
      { options: { interactions: { request: async () => value } } });
    await assert.rejects(f.executor(f.context()), matches('DSH_CODE_ANSWER_INVALID'));
  }
});

test('custom and multiple choice answers preserve SDK shape and independent questions', async t => {
  const batch = [...questions, { id: 'flags', question: 'Which flags?', multiSelect: true, options: [{ label: 'fast' }, { label: 'quiet' }] }];
  const response = { answers: [{ id: 'target', selected: [], custom: 'custom.js' }, { id: 'flags', selected: ['fast', 'quiet'] }] };
  const f = fixture(t, async run => {
    await begin(run); assert.deepEqual(await run.hook('user-questions/request', { agent: run.agent, questions: batch, signal: run.options.signal }), response);
    run.assistant(); run.end();
  }, { options: { interactions: { request: async () => response } } });
  assert.equal(await f.executor(f.context()), 'SYNTHETIC-CODE-RESULT');
});

test('human wait shares total timeout and late replies never resume an abandoned Agent', async t => {
  for (const mode of ['timeout', 'abort', 'sdk-abort']) {
    const requested = deferred(); const response = deferred(); const sdkAbort = new AbortController();
    const f = fixture(t, async run => {
      await begin(run); await run.hook('user-questions/request', { agent: run.agent, questions, signal: sdkAbort.signal });
      await run.model(); run.assistant('LATE'); run.end();
    }, { options: { timeoutMs: mode === 'timeout' ? 50 : 5000,
      interactions: { request(payload, controls) { requested.resolve(controls); return response.promise; } } } });
    const execution = f.executor(f.context()); const rejected = assert.rejects(execution,
      matches(mode === 'timeout' ? 'DSH_CODE_TIMEOUT' : mode === 'abort' ? 'DSH_CODE_ABORTED' : 'DSH_CODE_INTERACTION_CANCELLED'));
    const controls = await requested.promise;
    if (mode === 'abort') f.signal.abort(); if (mode === 'sdk-abort') sdkAbort.abort();
    await rejected; assert.equal(controls.signal.aborted, true); response.resolve(answers);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sdk.disposed, 1); assert.equal(f.sdk.runs.length, 1);
  }
});

test('authorization revocation while waiting cancels pending without needing a human reply', async t => {
  const requested = deferred(); let revoked = false;
  const f = fixture(t, async run => {
    await begin(run); await run.hook('user-questions/request', { agent: run.agent, questions, signal: run.options.signal });
  }, { gateModel: () => { if (revoked) throw new Error('REVOKED'); },
    options: { interactions: { request(payload, controls) { requested.resolve(controls); return new Promise(() => {}); } } } });
  const execution = f.executor(f.context()); const rejected = assert.rejects(execution, matches('DSH_CODE_GATE_REVOKED'));
  const controls = await requested.promise; revoked = true; await rejected; assert.equal(controls.signal.aborted, true);
});

test('model and question mutation while waiting invalidate the original answer', async t => {
  for (const change of ['model', 'question']) {
    const requested = deferred(); const reply = deferred(); const batch = structuredClone(questions);
    const f = fixture(t, async run => {
      await begin(run); await run.hook('user-questions/request', { agent: run.agent, questions: batch, signal: run.options.signal });
      run.assistant(); run.end();
    }, { options: { interactions: { request() { requested.resolve(); return reply.promise; } } } });
    const execution = f.executor(f.context()); const rejected = assert.rejects(execution,
      matches(change === 'model' ? 'DSH_CODE_MODEL_ROUTE_CHANGED' : 'DSH_CODE_INTERACTION_CHANGED'));
    await requested.promise;
    if (change === 'model') f.sdk.runs[0].agent.options.model = 'another'; else batch[0].question = 'Different question';
    reply.resolve(answers); await rejected;
  }
});

test('OFF during a human question still permits answering and completing that running Code task', async t => {
  const requested = deferred(); const reply = deferred();
  const f = fixture(t, async run => {
    await begin(run); await run.hook('user-questions/request', { agent: run.agent, questions, signal: run.options.signal });
    run.assistant('Answered after OFF'); run.end();
  }, { options: { interactions: { request() { requested.resolve(); return reply.promise; } } } });
  const jobs = new CodeTasks(f.store, { getAuthorization: () => grant }); jobs.enable(1);
  const item = jobs.admit(task().input, 2).task; const execution = jobs.execute(item.id, f.executor, { now: () => 5 });
  await requested.promise; jobs.disable(3); reply.resolve(answers);
  const completed = await execution; assert.equal(completed.state, 'completed'); assert.equal(completed.result, 'Answered after OFF');
});

test('outer answer middleware cannot bypass the human broker or upgrade a rejection', async t => {
  for (const bypass of [true, false]) {
    const f = fixture(t, async run => {
      await begin(run);
      run.listeners.get('approval/request').unshift(async (_request, next) => {
        if (!bypass) await next(); return 'allowed-once';
      });
      await run.approvedTool('read-file', { path: 'one.js' }); run.assistant('MUST-NOT-COMPLETE'); run.end();
    }, { options: { interactions: { request: async () => 'rejected' } } });
    await assert.rejects(f.executor(f.context()), matches('DSH_CODE_APPROVAL_UNBOUND'));
  }
});

test('an ended tool execution cannot be reused as the target of another approval', async t => {
  let requests = 0;
  const f = fixture(t, async run => {
    await begin(run); const completed = await run.approvedTool('read-file', { path: 'one.js' });
    run.emit('approval/asked', { id: 'reused-approval', callId: completed.exec.callId, toolName: 'read-file' });
    await run.hook('approval/request', { agent: run.agent, callId: completed.exec.callId, toolName: 'read-file', signal: run.options.signal });
    run.assistant(); run.end();
  }, { options: { interactions: { request: async () => { requests++; return 'allowed-once'; } } } });
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_APPROVAL_UNBOUND')); assert.equal(requests, 1);
});

test('unawaited questions cannot become a successful result and approval detail is never truncated', async t => {
  const hanging = fixture(t, async run => {
    await begin(run);
    void run.hook('user-questions/request', { agent: run.agent, questions, signal: run.options.signal }).catch(() => {});
    run.assistant('MUST-NOT-COMPLETE'); run.end();
  }, { options: { interactions: { request: () => new Promise(() => {}) } } });
  await assert.rejects(hanging.executor(hanging.context()), matches('DSH_CODE_INTERACTION_PENDING'));
  let requests = 0;
  const oversized = fixture(t, async run => { await begin(run); await run.approvedTool('read-file', { path: 'x'.repeat(12001) }); },
    { options: { interactions: { request: () => { requests++; return 'allowed-once'; } } } });
  await assert.rejects(oversized.executor(oversized.context()), matches('DSH_CODE_INTERACTION_INVALID')); assert.equal(requests, 0);
});

test('external errors cannot forge DSH_CODE reasons or persist private error text', async t => {
  const forged = () => Object.assign(new Error('PRIVATE-ERROR-SECRET'), { code: 'DSH_CODE_PRIVATE-ERROR-SECRET' });
  const port = fixture(t, async run => {
    await begin(run); await run.hook('user-questions/request', { agent: run.agent, questions, signal: run.options.signal });
  }, { options: { interactions: { request: async () => { throw forged(); } } } });
  await assert.rejects(port.executor(port.context()), matches('DSH_CODE_INTERACTION_FAILED'));
  assert.ok(!JSON.stringify(port.db.prepare('SELECT value FROM agent_state').all()).includes('PRIVATE-ERROR-SECRET'));
  const sdk = fixture(t); sdk.sdk.ctx.agents.create = async () => { throw forged(); };
  await assert.rejects(sdk.executor(sdk.context()), matches('DSH_CODE_EXECUTION_FAILED'));
  assert.ok(!JSON.stringify(sdk.db.prepare('SELECT value FROM agent_state').all()).includes('PRIVATE-ERROR-SECRET'));
});

const reviewTask = (id = 'code-1') => ({ ...task(id), state: 'needs-review', resultDelivery: 'none' });
const recoveryOptions = (f, item = reviewTask(), patch = {}) => ({ expectedRevision: f.executor.inspectRecovery(item).revision,
  reviewer: 'synthetic-reviewer', reason: 'Host confirmed session stopped', now: 1793200000000, verifyStopped: () => true, ...patch });
function recoveryRejects(f, item, options, code) {
  let cause;
  assert.throws(() => f.store.atomic(tx => {
    try { return f.executor.recoverIn(tx, item, options); } catch (error) { cause = error; throw error; }
  }));
  assert.equal(cause?.code, code);
}
async function failedSession(f) {
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_TURN_INCOMPLETE'));
  return reviewTask();
}

test('recovery inspection is inert and derives the mapping only from actual workspace/grant/model', async t => {
  const f = fixture(t, async () => {}); const item = reviewTask();
  assert.equal(f.executor.inspectRecovery(item), null); assert.equal(f.sdk.calls.length, 0);
  await failedSession(f);
  const info = f.executor.inspectRecovery(item);
  assert.equal(info.phase, 'needs-review'); assert.equal(info.taskId, item.id); assert.equal(info.generation, 0);
  assert.equal(info.attempt.phase, 'needs-review'); assert.equal(info.attempt.sessionId, info.sessionId);
  info.attempt.phase = 'completed'; assert.equal(f.executor.inspectRecovery(item).attempt.phase, 'needs-review');
  const wrong = reviewTask(); wrong.authorization.modelConfigured = false;
  // Non-binding presentation flags cannot redirect inspection to arbitrary keys.
  assert.equal(f.executor.inspectRecovery(wrong).sessionId, info.sessionId);
  wrong.authorization.allowedTools.push('other-tool'); assert.equal(f.executor.inspectRecovery(wrong), null);
  assert.equal(f.sdk.calls.length, 1);
});

test('manual recovery preserves old evidence, never replays old tasks, and creates a new generation for a different task', async t => {
  let fail = true;
  const f = fixture(t, async run => { if (fail) return; await begin(run); run.assistant('fresh result'); run.end(); });
  const item = await failedSession(f); const before = f.executor.inspectRecovery(item);
  const options = recoveryOptions(f); let verification;
  const after = f.store.atomic(tx => f.executor.recoverIn(tx, item, { ...options, verifyStopped: detail => { verification = detail; return true; } }));
  assert.deepEqual(verification, { sessionId: before.sessionId, taskId: item.id, mappingRevision: before.revision });
  assert.equal(after.phase, 'fresh'); assert.equal(after.generation, 1); assert.equal(after.sessionId, `${before.sessionId}-g1`);
  assert.equal(after.attempt.phase, 'abandoned'); assert.equal(f.sdk.calls.length, 1);
  const audits = f.db.prepare("SELECT value FROM agent_state WHERE key LIKE '%dsh-code-recovery-v1%'").all().map(row => JSON.parse(row.value));
  assert.equal(audits.length, 1); assert.equal(audits[0].mapping.value.sessionId, before.sessionId);
  assert.equal(audits[0].attempt.value.phase, 'needs-review');
  assert.deepEqual(audits[0].recovery, { reviewer: options.reviewer, reason: options.reason, at: options.now });
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_ATTEMPT_ALREADY_EXISTS'));
  recoveryRejects(f, item, { ...options, expectedRevision: after.revision }, 'DSH_CODE_RECOVERY_INVALID');
  fail = false; await f.executor(f.context(task('new-task')));
  assert.equal(f.sdk.calls[1].kind, 'create'); assert.equal(f.sdk.calls[1].options.sessionId, after.sessionId);
  await f.executor(f.context(task('next-task'))); assert.equal(f.sdk.calls[2].kind, 'resume');
});

test('legacy mappings without generation recover after a stopped Host confirmation and still reject the old task', async t => {
  const f = fixture(t, async () => {}); const item = await failedSession(f);
  f.store.atomic(tx => {
    const row = f.db.prepare("SELECT key FROM agent_state WHERE key LIKE '%dsh-code-session-v1%'").get();
    const mapping = tx.read(row.key); const { generation, ...legacy } = mapping.value;
    tx.write(row.key, mapping.revision, { ...legacy, phase: 'active' });
  });
  assert.equal(f.executor.inspectRecovery(item).generation, 0);
  const result = f.store.atomic(tx => f.executor.recoverIn(tx, item, recoveryOptions(f)));
  assert.equal(result.generation, 1); assert.equal(result.phase, 'fresh');
  await assert.rejects(f.executor(f.context()), matches('DSH_CODE_ATTEMPT_ALREADY_EXISTS'));
});

test('recovery requires a failed executed task, CAS, valid audit fields and synchronous positive Host confirmation', async t => {
  const f = fixture(t, async () => {}); const item = await failedSession(f); const before = f.executor.inspectRecovery(item);
  for (const patch of [{ expectedRevision: before.revision - 1 }, { reviewer: '' }, { reviewer: ' ' }, { reason: '' }, { reason: 'x\nprivate' },
    { now: '2026-10-29' }, { now: -1 }, { verifyStopped: undefined }, { arbitraryMappingKey: 'external' }]) {
    recoveryRejects(f, item, recoveryOptions(f, item, patch), patch.expectedRevision ? 'DSH_CODE_RECOVERY_CONFLICT' : 'DSH_CODE_RECOVERY_INVALID');
  }
  for (const verifyStopped of [() => false, () => undefined, () => Promise.resolve(true), () => Promise.reject(Error('PRIVATE')), () => { throw Error('PRIVATE'); }])
    recoveryRejects(f, item, recoveryOptions(f, item, { verifyStopped }), 'DSH_CODE_RECOVERY_NOT_STOPPED');
  for (const patch of [{ state: 'completed' }, { state: 'queued' }, { result: 'done' }, { resultDelivery: 'pending' }, { id: 'different-task' }])
    recoveryRejects(f, { ...item, ...patch }, recoveryOptions(f), 'DSH_CODE_RECOVERY_INVALID');
  assert.deepEqual(f.executor.inspectRecovery(item), before);
  const idle = fixture(t); await idle.executor(idle.context());
  recoveryRejects(idle, item, recoveryOptions(idle), 'DSH_CODE_RECOVERY_INVALID');
});

test('recovery rolls mapping, attempt and permanent audit back with its callers transaction', async t => {
  const f = fixture(t, async () => {}); const item = await failedSession(f);
  const before = f.db.prepare('SELECT key, revision, value FROM agent_state ORDER BY key').all();
  assert.throws(() => f.store.atomic(tx => { f.executor.recoverIn(tx, item, recoveryOptions(f)); throw Error('caller rejection'); }));
  assert.deepEqual(f.db.prepare('SELECT key, revision, value FROM agent_state ORDER BY key').all(), before);
  f.store.atomic(tx => f.executor.recoverIn(tx, item, recoveryOptions(f)));
  assert.equal(f.executor.inspectRecovery(item).phase, 'fresh');
});

test('recovery refuses active executions across executor instances and releases the live marker on failure', async t => {
  const started = deferred(); const release = deferred();
  const f = fixture(t, async run => { await begin(run); started.resolve(); await release.promise; });
  const operation = f.executor(f.context()); await started.promise;
  const other = createDshCodeExecutor(f.opts); const item = reviewTask(); let stoppedCalls = 0;
  const original = f.executor; f.executor = other;
  recoveryRejects(f, item, recoveryOptions(f, item, { verifyStopped: () => { stoppedCalls++; return true; } }), 'DSH_CODE_RECOVERY_ACTIVE');
  assert.equal(stoppedCalls, 0); release.resolve(); await assert.rejects(operation, matches('DSH_CODE_TURN_INCOMPLETE'));
  f.store.atomic(tx => other.recoverIn(tx, item, recoveryOptions(f))); assert.equal(other.inspectRecovery(item).phase, 'fresh');
  assert.equal(original.inspectRecovery(item).phase, 'fresh');
});

test('recovery rechecks mappings, attempt and actual workspace after the trusted Host check', async t => {
  const f = fixture(t, async () => {}); const item = await failedSession(f); const before = f.executor.inspectRecovery(item);
  for (const kind of ['mapping', 'attempt']) {
    let cause;
    assert.throws(() => f.store.atomic(tx => {
      try {
        f.executor.recoverIn(tx, item, recoveryOptions(f, item, { verifyStopped: () => {
          const row = f.db.prepare(`SELECT key FROM agent_state WHERE key LIKE '%dsh-code-${kind === 'mapping' ? 'session' : 'attempt'}-v1%'`).get();
          const current = tx.read(row.key); tx.write(row.key, current.revision, { ...current.value, reason: 'changed' }); return true;
        } }));
      } catch (error) { cause = error; throw error; }
    }));
    assert.equal(cause?.code, 'DSH_CODE_RECOVERY_CONFLICT'); assert.deepEqual(f.executor.inspectRecovery(item), before);
  }
  const otherWorkspace = join(f.workspace, 'different'); mkdirSync(otherWorkspace);
  let current = f.workspace; const executor = createDshCodeExecutor({ ...f.opts, resolveWorkspace: () => current });
  let cause;
  assert.throws(() => f.store.atomic(tx => {
    try { executor.recoverIn(tx, item, recoveryOptions(f, item, { verifyStopped: () => { current = otherWorkspace; return true; } })); }
    catch (error) { cause = error; throw error; }
  }));
  assert.equal(cause?.code, 'DSH_CODE_RECOVERY_CONFLICT'); assert.deepEqual(f.executor.inspectRecovery(item), before);
});

test('failed terminal state persistence clears process liveness while requiring explicit Host recovery', async t => {
  const f = fixture(t, async () => {}); const atomic = f.store.atomic.bind(f.store); let calls = 0;
  f.store.atomic = work => { if (++calls === 2) throw Error('synthetic persistence failure'); return atomic(work); };
  await assert.rejects(f.executor(f.context())); f.store.atomic = atomic;
  const item = reviewTask(); assert.equal(f.executor.inspectRecovery(item).phase, 'active');
  f.store.atomic(tx => f.executor.recoverIn(tx, item, recoveryOptions(f)));
  assert.equal(f.executor.inspectRecovery(item).phase, 'fresh'); assert.equal(f.sdk.calls.length, 1);
});

test('a real SQLite write failure rolls back recovery audit and attempt before any SDK action', async t => {
  const f = fixture(t, async () => {}); const item = await failedSession(f);
  const before = f.db.prepare('SELECT key, revision, value FROM agent_state ORDER BY key').all();
  f.db.exec(`CREATE TEMP TRIGGER reject_recovery BEFORE UPDATE ON agent_state
    WHEN json_extract(NEW.value, '$.phase') = 'fresh' BEGIN SELECT RAISE(FAIL, 'synthetic fault'); END`);
  assert.throws(() => f.store.atomic(tx => f.executor.recoverIn(tx, item, recoveryOptions(f))));
  assert.deepEqual(f.db.prepare('SELECT key, revision, value FROM agent_state ORDER BY key').all(), before);
  assert.equal(f.sdk.calls.length, 1); f.db.exec('DROP TRIGGER reject_recovery');
  f.store.atomic(tx => f.executor.recoverIn(tx, item, recoveryOptions(f)));
  assert.equal(f.executor.inspectRecovery(item).phase, 'fresh');
});

test('successive failed tasks retain each recovery generation and never resume an abandoned session', async t => {
  const f = fixture(t, async () => {}); const first = await failedSession(f);
  f.store.atomic(tx => f.executor.recoverIn(tx, first, recoveryOptions(f)));
  await assert.rejects(f.executor(f.context(task('failed-second'))), matches('DSH_CODE_TURN_INCOMPLETE'));
  const second = reviewTask('failed-second'); const snapshot = f.executor.inspectRecovery(second);
  assert.equal(snapshot.generation, 1);
  f.store.atomic(tx => f.executor.recoverIn(tx, second, recoveryOptions(f, second)));
  assert.equal(f.executor.inspectRecovery(second).generation, 2);
  await assert.rejects(f.executor(f.context(task('third'))), matches('DSH_CODE_TURN_INCOMPLETE'));
  assert.deepEqual(f.sdk.calls.map(call => call.kind), ['create', 'create', 'create']);
  assert.ok(f.sdk.calls[2].options.sessionId.endsWith('-g2'));
  for (const id of ['code-1', 'failed-second'])
    await assert.rejects(f.executor(f.context(task(id))), matches('DSH_CODE_ATTEMPT_ALREADY_EXISTS'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_state WHERE key LIKE '%dsh-code-recovery-v1%'").get().n, 2);
});

test('recovery rejects accessors, symbols, hidden fields and non-plain options without invoking getters', async t => {
  const f = fixture(t, async () => {}); const item = await failedSession(f); const before = f.executor.inspectRecovery(item);
  const valid = recoveryOptions(f); let getterCalls = 0;
  const getter = { ...valid }; Object.defineProperty(getter, 'reviewer', { enumerable: true, get() { getterCalls++; return 'reviewer'; } });
  const hidden = { ...valid }; Object.defineProperty(hidden, 'hidden', { value: true });
  const nonEnumerableField = { ...valid }; Object.defineProperty(nonEnumerableField, 'reviewer', { value: valid.reviewer, enumerable: false });
  const inherited = Object.assign(Object.create({ inherited: true }), valid);
  const symbolic = { ...valid, [Symbol('hidden')]: true };
  const array = Object.assign([], valid);
  for (const options of [getter, hidden, nonEnumerableField, inherited, symbolic, array, new Date(), null, undefined])
    recoveryRejects(f, item, options, 'DSH_CODE_RECOVERY_INVALID');
  assert.equal(getterCalls, 0); assert.deepEqual(f.executor.inspectRecovery(item), before); assert.equal(f.sdk.calls.length, 1);
  for (const result of ['', false, 0])
    recoveryRejects(f, { ...item, result }, valid, 'DSH_CODE_RECOVERY_INVALID');
  f.store.atomic(tx => f.executor.recoverIn(tx, { ...item, result: null }, valid));
  assert.equal(f.executor.inspectRecovery(item).phase, 'fresh');
});

test('revision zero and long canonical conversation keys remain valid for execution and recovery', async t => {
  const f = fixture(t, async () => {}); const item = task();
  item.authorization.revision = 0;
  item.authorization.conversationKey = JSON.stringify(['juebot-conversation-v1', 'bot', 'juejue', 'qq-official',
    'issuer-' + 'i'.repeat(120), 'app-' + 'a'.repeat(120), 'direct', 'openid-' + 'o'.repeat(120)]);
  item.input.conversationKey = item.authorization.conversationKey;
  assert.ok(item.authorization.conversationKey.length > 256);
  await assert.rejects(f.executor(f.context(item)), matches('DSH_CODE_TURN_INCOMPLETE'));
  const review = { ...item, state: 'needs-review', result: null, resultDelivery: 'none' };
  const before = f.executor.inspectRecovery(review); assert.equal(before.phase, 'needs-review');
  const result = f.store.atomic(tx => f.executor.recoverIn(tx, review, recoveryOptions(f, review)));
  assert.equal(result.phase, 'fresh'); assert.equal(result.generation, 1); assert.equal(f.sdk.calls.length, 1);
  await assert.rejects(f.executor(f.context(item)), matches('DSH_CODE_ATTEMPT_ALREADY_EXISTS'));
  const next = { ...item, id: 'long-key-new-task' };
  await assert.rejects(f.executor(f.context(next)), matches('DSH_CODE_TURN_INCOMPLETE'));
  assert.equal(f.sdk.calls[1].kind, 'create'); assert.equal(f.sdk.calls[1].options.sessionId, result.sessionId);
  const invalid = { ...review, authorization: { ...review.authorization, conversationKey: 'x'.repeat(4097) } };
  assert.throws(() => f.executor.inspectRecovery(invalid), matches('DSH_CODE_CONTEXT_INVALID'));
  const controls = { ...review, authorization: { ...review.authorization, conversationKey: 'long\nkey' } };
  assert.throws(() => f.executor.inspectRecovery(controls), matches('DSH_CODE_CONTEXT_INVALID'));
});
