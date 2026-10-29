import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreError, JuebotCore, memoryGate, normalizeMessage, snapshotPolicy } from '../src/index.ts';
import type {
  CodeAuthorization, Conversation, CorePolicy, InboundMessage, MemoryContext,
  MemoryRecord, Permissions, SharingGrant, TaskHandle,
} from '../src/index.ts';

// Synthetic identifiers only. Nothing connects to a real account, model, filesystem or DSH agent.
const ADMIN = '10001';
const USER = '10002';
const BOT = '90001';
const DM: Conversation = { kind: 'private', id: ADMIN };
const OTHER_DM: Conversation = { kind: 'private', id: USER };
const G1: Conversation = { kind: 'group', id: '20001' };
const G2: Conversation = { kind: 'group', id: '20002' };
const TRANSPORT = { connectionId: 'synthetic-connection', selfId: BOT };
const ALL: Permissions = { receive: true, save: true, learn: true, send: true };
const AUTH: CodeAuthorization = {
  id: 'synthetic-authorization', workspace: 'synthetic-workspace', sessionId: 'synthetic-session',
  modelConfigured: true, budgetAvailable: true, sandboxVerified: true, toolsRestricted: true,
};
function policy(adminPermissions: Permissions = ALL): CorePolicy {
  return { botId: BOT, connectionId: TRANSPORT.connectionId, channels: [DM, OTHER_DM, G1, G2].map(conversation => ({
    conversation, permissions: conversation === DM ? adminPermissions : { ...ALL },
  })) };
}
let serial = 0;
function message(text = 'synthetic input', changes: Partial<InboundMessage> = {}): InboundMessage {
  return { eventId: `event-${++serial}`, senderId: ADMIN, conversation: DM, text, form: 'plain', ...changes };
}
function core(permissions: Permissions = ALL, capacity = 10000): JuebotCore {
  const c = new JuebotCore(policy(permissions), capacity);
  c.configureAdmin(ADMIN, true);
  c.configureCode(AUTH);
  return c;
}
function start(c: JuebotCore): TaskHandle {
  assert.deepEqual(c.openAdmission(), { allowed: true });
  const route = c.route(TRANSPORT, message('synthetic development task'));
  assert.equal(route.kind, 'code-input');
  if (route.kind !== 'code-input') throw new Error('fixture did not produce an input ticket');
  return c.beginTask(route.ticket);
}
function errorCode(code: string): (e: unknown) => boolean {
  return e => e instanceof CoreError && e.code === code;
}

test('construction is OFF with no verified administrator or code authorization', () => {
  const c = new JuebotCore(policy());
  assert.equal(c.display, 'OFF');
  assert.equal(c.runningTaskCount, 0);
  assert.deepEqual(c.openAdmission(), { allowed: false, reason: 'ADMIN_NOT_VERIFIED' });
  assert.deepEqual(c.route(TRANSPORT, message()), { kind: 'rejected', reason: 'ADMIN_NOT_VERIFIED' });
  c.configureAdmin(ADMIN, false);
  assert.deepEqual(c.openAdmission(), { allowed: false, reason: 'ADMIN_NOT_VERIFIED' });
  c.configureAdmin(ADMIN, true);
  assert.deepEqual(c.openAdmission(), { allowed: false, reason: 'CODE_NOT_CONFIGURED' });
});

for (const missing of ['modelConfigured', 'budgetAvailable', 'sandboxVerified', 'toolsRestricted'] as const) {
  test(`opening rejects missing ${missing}`, () => {
    const c = core();
    c.configureCode({ ...AUTH, [missing]: false });
    assert.equal(c.openAdmission().allowed, false);
    assert.equal(c.display, 'OFF');
    assert.equal(c.runningTaskCount, 0);
  });
}
for (const invalid of [{ ...AUTH, workspace: '' }, { ...AUTH, workspace: '   ' }, { ...AUTH, workspace: 'bad\npath' }, { ...AUTH, sessionId: '' }, { ...AUTH, id: '' }]) {
  test(`configuration rejects empty authorization field ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => core().configureCode(invalid), errorCode('INVALID_CODE_AUTHORIZATION'));
  });
}

test('transport identity is separate from sender claims in the payload', () => {
  const c = core();
  const raw = { ...message('/开启code', { senderId: USER, conversation: OTHER_DM }), nickname: ADMIN, isAdmin: true, trusted: true };
  assert.deepEqual(c.route(TRANSPORT, raw), { kind: 'rejected', reason: 'ADMIN_PRIVATE_ONLY' });
  for (const transport of [{ ...TRANSPORT, selfId: USER }, { ...TRANSPORT, connectionId: 'untrusted' }]) {
    assert.deepEqual(c.route(transport, message('/开启code')), { kind: 'rejected', reason: 'UNTRUSTED_TRANSPORT' });
  }
  assert.equal(c.display, 'OFF');
});

test('malformed messages, numeric QQ IDs, oversized text, mismatched private peers and self echoes fail closed', () => {
  const c = core();
  for (const bad of [null, {}, { ...message(), senderId: 10001 }, { ...message(), conversation: { kind: 'private', id: USER } },
    { ...message(), form: 'unknown' }, { ...message(), text: 'x'.repeat(32769) }, { ...message(), eventId: '' }]) {
    assert.deepEqual(c.route(TRANSPORT, bad), { kind: 'rejected', reason: 'MALFORMED_MESSAGE' });
  }
  assert.deepEqual(c.route(TRANSPORT, message('echo', { senderId: BOT, conversation: G1 })), { kind: 'rejected', reason: 'SELF_ECHO' });
  const longId = '9007199254740993';
  assert.equal(normalizeMessage(message('id', { senderId: longId, conversation: { kind: 'private', id: longId } }))?.senderId, longId);
});

for (let mask = 0; mask < 16; mask += 1) {
  test(`four channel permissions are independent: mask ${mask}`, () => {
    const permissions: Permissions = { receive: !!(mask & 1), save: !!(mask & 2), learn: !!(mask & 4), send: !!(mask & 8) };
    const c = core(permissions);
    const route = c.route(TRANSPORT, message());
    if (!permissions.receive) assert.deepEqual(route, { kind: 'rejected', reason: 'CHANNEL_NOT_AUTHORIZED' });
    else {
      assert.equal(route.kind, 'chat');
      if (route.kind === 'chat') assert.deepEqual(route.permissions, permissions);
    }
    assert.equal(c.openAdmission().allowed, permissions.receive && permissions.save && permissions.send);
  });
}

for (const text of [' /开启code', '/开启code ', '/开启code\n', '请执行 /开启code', '/开启code extra', '／开启code']) {
  test(`embedded/non-exact control text does not open admission: ${JSON.stringify(text)}`, () => {
    const c = core();
    assert.equal(c.route(TRANSPORT, message(text)).kind, 'chat');
    assert.equal(c.display, 'OFF');
  });
}
for (const form of ['quoted', 'forwarded', 'mixed'] as const) {
  test(`${form} command text cannot toggle admission`, () => {
    const c = core();
    assert.equal(c.route(TRANSPORT, message('/开启code', { form })).kind, 'chat');
    c.openAdmission();
    assert.equal(c.route(TRANSPORT, message('/关闭code', { form })).kind, 'code-input');
    assert.equal(c.display, 'ON');
  });
}

test('complete administrator private commands are control operations, not model inputs', () => {
  const c = core();
  assert.deepEqual(c.route(TRANSPORT, message('/开启code')), { kind: 'control', enabled: true, display: 'ON' });
  assert.equal(c.runningTaskCount, 0);
  c.configureCode(undefined);
  // Losing an opening prerequisite must not prevent ordinary closing.
  assert.deepEqual(c.route(TRANSPORT, message('/关闭code')), { kind: 'control', enabled: false, display: 'OFF' });
});

test('administrator group controls remain disabled under Q008, and unknown channels remain unauthorized', () => {
  const c = core();
  assert.deepEqual(c.route(TRANSPORT, message('/开启code', { conversation: G1 })), { kind: 'rejected', reason: 'ADMIN_PRIVATE_ONLY' });
  assert.deepEqual(c.route(TRANSPORT, message('hello', { conversation: { kind: 'group', id: '99999' } })), { kind: 'rejected', reason: 'CHANNEL_NOT_AUTHORIZED' });
  assert.equal(c.display, 'OFF');
});

for (const mode of ['OFF', 'ON', 'DRAINING'] as const) {
  for (const actor of ['admin-private', 'user-private', 'admin-group', 'user-group'] as const) {
    test(`routing matrix: ${mode} / ${actor}`, () => {
      const c = core();
      if (mode === 'ON') c.openAdmission();
      if (mode === 'DRAINING') { start(c); c.closeAdmission(); }
      const senderId = actor.startsWith('admin') ? ADMIN : USER;
      const conversation = actor.endsWith('group') ? G1 : senderId === ADMIN ? DM : OTHER_DM;
      const route = c.route(TRANSPORT, message('looks like casual chat', { senderId, conversation }));
      assert.equal(route.kind, mode === 'ON' && actor === 'admin-private' ? 'code-input' : 'chat');
      if (route.kind === 'code-input') assert.equal(route.learningAllowed, false);
      assert.equal(c.display, mode);
    });
  }
}

test('D008: closing preserves the running task, necessary execution and original result destination', () => {
  const c = core();
  const task = start(c);
  assert.equal(c.runningTaskCount, 1);
  assert.deepEqual(c.executionGate(task), { allowed: true });
  c.closeAdmission();
  c.closeAdmission();
  assert.equal(c.display, 'DRAINING');
  assert.equal(c.runningTaskCount, 1);
  assert.deepEqual(c.executionGate(task), { allowed: true });
  assert.equal(c.route(TRANSPORT, message('not a development follow-up')).kind, 'chat');
  c.setIdentityMode('persona');
  c.completeTask(task);
  c.completeTask(task);
  assert.equal(c.display, 'OFF');
  assert.equal(c.runningTaskCount, 0);
  assert.equal(c.executionGate(task).allowed, false);
  assert.deepEqual(c.resultDestination(task), { allowed: true, taskId: task.id, conversation: DM });
});

test('draining lasts until the last explicit running task finishes; reopening does not recreate old tasks', () => {
  const c = core();
  const a = start(c);
  const b = start(c);
  c.closeAdmission();
  c.completeTask(a);
  assert.equal(c.display, 'DRAINING');
  c.openAdmission();
  assert.equal(c.display, 'ON');
  assert.equal(c.runningTaskCount, 1);
  c.closeAdmission();
  c.completeTask(b);
  assert.equal(c.display, 'OFF');
  assert.equal(c.resultDestination(a).allowed, true);
  assert.equal(c.resultDestination(b).allowed, true);
});

test('replayed old ON cannot reopen after OFF, even with conflicting payload', () => {
  const c = core();
  const on = message('/开启code');
  const off = message('/关闭code');
  assert.equal(c.route(TRANSPORT, on).kind, 'control');
  assert.equal(c.route(TRANSPORT, on).kind, 'duplicate');
  assert.equal(c.route(TRANSPORT, off).kind, 'control');
  assert.equal(c.route(TRANSPORT, on).kind, 'duplicate');
  assert.equal(c.route(TRANSPORT, { ...off, text: '/开启code' }).kind, 'duplicate');
  assert.equal(c.display, 'OFF');
});

test('dedupe exhaustion closes admission without evicting old ids or cancelling running work', () => {
  const c = core(ALL, 2);
  const task = start(c); // event 1
  c.route(TRANSPORT, message('event 2', { senderId: USER, conversation: OTHER_DM }));
  assert.deepEqual(c.route(TRANSPORT, message('event 3')), { kind: 'rejected', reason: 'DEDUPE_CAPACITY' });
  assert.equal(c.display, 'DRAINING');
  assert.equal(c.executionGate(task).allowed, true);
  assert.equal(c.openAdmission().allowed, false);
});

test('QQ ON needs capacity after its own event; a trusted UI toggle does not consume an event', () => {
  const c = core(ALL, 1);
  assert.deepEqual(c.route(TRANSPORT, message('/开启code')), { kind: 'rejected', reason: 'DEDUPE_CAPACITY' });
  assert.equal(c.display, 'OFF');
  const viaManagement = core(ALL, 1);
  assert.equal(viaManagement.openAdmission().allowed, true);
  assert.equal(viaManagement.route(TRANSPORT, message()).kind, 'code-input');
});

test('authorization snapshots change only through explicit trusted configuration', () => {
  const c = core();
  const supplied = { ...AUTH };
  c.configureCode(supplied);
  const task = start(c);
  supplied.budgetAvailable = false;
  assert.equal(c.executionGate(task).allowed, true);
  c.configureCode(supplied);
  assert.deepEqual(c.executionGate(task), { allowed: false, reason: 'BUDGET_UNAVAILABLE' });
});

test('tickets are single-use capabilities, not copied ids, queued jobs or running tasks', () => {
  const c = core();
  c.openAdmission();
  const route = c.route(TRANSPORT, message());
  assert.equal(route.kind, 'code-input');
  if (route.kind !== 'code-input') return;
  assert.equal(c.runningTaskCount, 0);
  assert.throws(() => c.beginTask({ id: route.ticket.id }), errorCode('UNKNOWN_OR_CONSUMED_TICKET'));
  const task = c.beginTask(route.ticket);
  assert.throws(() => c.beginTask(route.ticket), errorCode('UNKNOWN_OR_CONSUMED_TICKET'));
  assert.deepEqual(c.executionGate({ id: task.id }), { allowed: false, reason: 'UNKNOWN_TASK' });
  assert.equal(core().executionGate(task).allowed, false);
});

test('closing then reopening does not revive a pre-close unstarted routing ticket', () => {
  const c = core();
  c.openAdmission();
  const route = c.route(TRANSPORT, message());
  if (route.kind !== 'code-input') throw new Error('missing ticket');
  c.closeAdmission();
  assert.equal(c.display, 'OFF');
  assert.throws(() => c.beginTask(route.ticket), errorCode('STALE_ADMISSION'));
  c.openAdmission();
  assert.throws(() => c.beginTask(route.ticket), errorCode('STALE_ADMISSION'));
  assert.equal(c.runningTaskCount, 0);
});

test('administrator rebinding revokes old execution and delivery even when the same QQ is rebound', () => {
  for (const nextAdmin of [ADMIN, USER, undefined]) {
    const c = core();
    const task = start(c);
    c.configureAdmin(nextAdmin, true);
    assert.equal(c.executionGate(task).allowed, false);
    c.completeTask(task);
    assert.equal(c.resultDestination(task).allowed, false);
  }
});

test('budget, authorization changes and explicit stop are separate from ordinary admission close', () => {
  const c = core();
  const task = start(c);
  c.closeAdmission();
  c.configureCode({ ...AUTH, budgetAvailable: false });
  assert.deepEqual(c.executionGate(task), { allowed: false, reason: 'BUDGET_UNAVAILABLE' });
  c.configureCode({ ...AUTH, id: 'different-authorization' });
  assert.deepEqual(c.executionGate(task), { allowed: false, reason: 'CODE_AUTHORIZATION_CHANGED' });
  c.configureCode(AUTH);
  assert.equal(c.executionGate(task).allowed, true);
  c.stopTask(task);
  assert.equal(c.executionGate(task).allowed, false);
  assert.throws(() => c.completeTask(task), errorCode('TASK_NOT_RUNNING'));
  assert.equal(c.resultDestination(task).allowed, false);
});

test('result routing does not require another model budget but does recheck send authorization', () => {
  const c = core();
  const task = start(c);
  assert.equal(c.resultDestination(task).allowed, false);
  c.closeAdmission();
  c.configureCode({ ...AUTH, budgetAvailable: false });
  c.completeTask(task);
  assert.equal(c.resultDestination(task).allowed, true);
  c.configureCode(undefined);
  assert.deepEqual(c.resultDestination(task), { allowed: false, reason: 'CODE_AUTHORIZATION_CHANGED' });
  c.configureCode({ ...AUTH, budgetAvailable: false });
  assert.equal(c.resultDestination(task).allowed, true);
  c.configureCode({ ...AUTH, id: 'another-authorization' });
  assert.equal(c.resultDestination(task).allowed, false);
  c.configureCode(AUTH);
  c.replacePolicy(policy({ ...ALL, send: false }));
  assert.equal(c.resultDestination(task).allowed, false);
});

test('identity modes affect ordinary routing but are independent of the Code switch', () => {
  const c = core();
  c.setIdentityMode('persona');
  const chat = c.route(TRANSPORT, message());
  assert.equal(chat.kind, 'chat');
  if (chat.kind === 'chat') assert.equal(chat.identityMode, 'persona');
  c.openAdmission();
  c.setIdentityMode('juejue');
  assert.equal(c.display, 'ON');
  assert.equal(c.route(TRANSPORT, message()).kind, 'code-input');
});

test('policy and input snapshots cannot be mutated through caller references', () => {
  const p = { ...ALL };
  const c = core(p);
  p.receive = false;
  const raw = { ...message(), conversation: { ...DM } };
  const route = c.route(TRANSPORT, raw);
  assert.equal(route.kind, 'chat');
  raw.conversation.id = USER;
  if (route.kind === 'chat') {
    assert.equal(route.message.conversation.id, ADMIN);
    assert.ok(Object.isFrozen(route.message.conversation));
    assert.ok(Object.isFrozen(route.permissions));
  }
  const duplicated = policy();
  assert.throws(() => snapshotPolicy({ ...duplicated, channels: [...duplicated.channels, duplicated.channels[0]!] }), errorCode('DUPLICATE_CHANNEL_RULE'));
});

function record(changes: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'fact-1', botId: BOT, domain: 'social', workspaceId: null, personaId: null,
    kind: 'fact', subjectId: ADMIN, adminBindingId: null, origin: DM,
    scope: { kind: 'private', userId: ADMIN }, deleted: false, derived: false, sourceIds: [], ...changes,
  };
}
function context(conversation: Conversation = G1, changes: Partial<MemoryContext> = {}): MemoryContext {
  return { botId: BOT, conversation, domain: 'social', workspaceId: null, personaId: 'juejue', adminId: ADMIN, adminBindingId: 'binding-1', ...changes };
}
function grant(changes: Partial<SharingGrant> = {}): SharingGrant {
  return { id: 'grant-1', memoryId: 'fact-1', botId: BOT, approvedBy: ADMIN, adminBindingId: 'binding-1', active: true, targets: [G1], ...changes };
}
function store(records: MemoryRecord[], grants: SharingGrant[] = []) {
  const memories = new Map(records.map(r => [r.id, r]));
  const permissions = new Map(grants.map(g => [g.id, g]));
  return { memories, permissions, record: (id: string) => memories.get(id), grant: (id: string) => permissions.get(id) };
}

test('private facts remain private despite global administrator recognition', () => {
  const db = store([record()]);
  assert.equal(memoryGate('fact-1', context(DM), policy(), db).allowed, true);
  for (const destination of [G1, G2, OTHER_DM]) assert.equal(memoryGate('fact-1', context(destination), policy(), db).allowed, false);
});

for (const kind of ['admin-identity', 'admin-relationship'] as const) {
  test(`${kind} is global only within authorized destinations and current binding`, () => {
    const db = store([record({ kind, adminBindingId: 'binding-1', scope: { kind: 'admin-global' } })]);
    for (const target of [DM, G1, G2]) assert.equal(memoryGate('fact-1', context(target), policy(), db).allowed, true);
    assert.equal(memoryGate('fact-1', context({ kind: 'group', id: '99999' }), policy(), db).allowed, false);
    assert.equal(memoryGate('fact-1', context(G1, { adminBindingId: 'binding-2' }), policy(), db).allowed, false);
    assert.equal(memoryGate('fact-1', context(G1, { adminId: USER }), policy(), db).allowed, false);
  });
}
for (const kind of ['preference', 'fact', 'summary', 'expression'] as const) {
  test(`${kind} cannot become public by using admin-global scope`, () => {
    const db = store([record({ kind, adminBindingId: 'binding-1', scope: { kind: 'admin-global' } })]);
    assert.equal(memoryGate('fact-1', context(), policy(), db).allowed, false);
  });
}

test('explicit sharing is target-limited; revocation preserves original lawful private access', () => {
  const db = store([record({ scope: { kind: 'grant', grantId: 'grant-1' } })], [grant()]);
  assert.equal(memoryGate('fact-1', context(G1), policy(), db).allowed, true);
  assert.equal(memoryGate('fact-1', context(G2), policy(), db).allowed, false);
  db.permissions.set('grant-1', grant({ active: false }));
  assert.equal(memoryGate('fact-1', context(G1), policy(), db).allowed, false);
  assert.equal(memoryGate('fact-1', context(DM), policy(), db).allowed, true);
  db.permissions.delete('grant-1');
  assert.equal(memoryGate('fact-1', context(G1), policy(), db).allowed, false);
  assert.equal(memoryGate('fact-1', context(DM), policy(), db).allowed, true);
});

const grantChanges: readonly Partial<SharingGrant>[] = [{ approvedBy: USER }, { adminBindingId: 'old-binding' }, { memoryId: 'wrong-memory' }, { botId: USER }];
for (const change of grantChanges) {
  test(`sharing rejects mismatched authority ${JSON.stringify(change)}`, () => {
    const db = store([record({ scope: { kind: 'grant', grantId: 'grant-1' } })], [grant(change)]);
    assert.equal(memoryGate('fact-1', context(), policy(), db).allowed, false);
  });
}

test('authorized-global sharing does not expand the connection allowlist', () => {
  const db = store([record({ scope: { kind: 'grant', grantId: 'grant-1' } })], [grant({ targets: 'authorized' })]);
  assert.equal(memoryGate('fact-1', context(G2), policy(), db).allowed, true);
  assert.equal(memoryGate('fact-1', context({ kind: 'group', id: '99999' }), policy(), db).allowed, false);
});

test('private origins cannot be relabelled as another conversation without a sharing grant', () => {
  const db = store([record({ scope: { kind: 'conversation', conversation: G1 } })]);
  assert.equal(memoryGate('fact-1', context(G1), policy(), db).allowed, false);
});

test('public summaries cannot launder private sources, and every ancestor is rechecked', () => {
  const parent = record();
  const child = record({ id: 'summary-1', kind: 'summary', derived: true, sourceIds: ['fact-1'], scope: { kind: 'grant', grantId: 'child-grant' } });
  const db = store([parent, child], [grant({ id: 'child-grant', memoryId: 'summary-1' })]);
  assert.equal(memoryGate('summary-1', context(G1), policy(), db).allowed, false);
  db.memories.set('fact-1', record({ scope: { kind: 'grant', grantId: 'grant-1' } }));
  db.permissions.set('grant-1', grant());
  assert.equal(memoryGate('summary-1', context(G1), policy(), db).allowed, true);
  db.permissions.set('grant-1', grant({ active: false }));
  assert.equal(memoryGate('summary-1', context(G1), policy(), db).allowed, false);
  assert.equal(memoryGate('summary-1', context(DM), policy(), db).allowed, true);
  db.permissions.set('grant-1', grant());
  db.memories.set('fact-1', { ...parent, deleted: true });
  assert.equal(memoryGate('summary-1', context(DM), policy(), db).allowed, false);
  db.memories.delete('fact-1');
  assert.equal(memoryGate('summary-1', context(DM), policy(), db).allowed, false);
});

test('mixed-source visibility is an intersection, not a union', () => {
  const a = record({ id: 'a', scope: { kind: 'grant', grantId: 'a-grant' } });
  const b = record({ id: 'b', scope: { kind: 'grant', grantId: 'b-grant' } });
  const summary = record({ id: 'summary', kind: 'summary', derived: true, sourceIds: ['a', 'b'], scope: { kind: 'grant', grantId: 's-grant' } });
  const db = store([a, b, summary], [grant({ id: 'a-grant', memoryId: 'a', targets: [G1] }), grant({ id: 'b-grant', memoryId: 'b', targets: [G2] }), grant({ id: 's-grant', memoryId: 'summary', targets: 'authorized' })]);
  for (const group of [G1, G2]) assert.equal(memoryGate('summary', context(group), policy(), db).allowed, false);
});

test('bot, persona and engineering domains remain isolated', () => {
  const codeMemory = record({ domain: 'code', workspaceId: 'project-a', kind: 'engineering' });
  const db = store([codeMemory]);
  assert.equal(memoryGate('fact-1', context(DM), policy(), db).allowed, false);
  assert.equal(memoryGate('fact-1', context(DM, { domain: 'code', workspaceId: 'project-a' }), policy(), db).allowed, true);
  assert.equal(memoryGate('fact-1', context(DM, { domain: 'code', workspaceId: 'project-b' }), policy(), db).allowed, false);
  assert.equal(memoryGate('fact-1', context(G1, { domain: 'code', workspaceId: 'project-a' }), policy(), db).allowed, false);
  assert.equal(memoryGate('fact-1', context(OTHER_DM, { domain: 'code', workspaceId: 'project-a' }), policy(), db).allowed, false);
  db.memories.set('fact-1', record({ botId: USER }));
  assert.equal(memoryGate('fact-1', context(DM), policy(), db).allowed, false);
  db.memories.set('fact-1', record({ personaId: 'persona-a' }));
  assert.equal(memoryGate('fact-1', context(DM), policy(), db).allowed, false);
  assert.equal(memoryGate('fact-1', context(DM, { personaId: 'persona-a' }), policy(), db).allowed, true);
});

test('a social descendant cannot import engineering memory through a source edge', () => {
  const parent = record({ id: 'code-parent', domain: 'code', workspaceId: 'project-a', kind: 'engineering' });
  const child = record({ id: 'social-child', kind: 'summary', derived: true, sourceIds: ['code-parent'] });
  assert.equal(memoryGate('social-child', context(DM), policy(), store([parent, child])).allowed, false);
});

test('source permission revocation blocks later use and cannot be bypassed by a sharing grant', () => {
  const db = store([record({ scope: { kind: 'grant', grantId: 'grant-1' } })], [grant()]);
  assert.equal(memoryGate('fact-1', context(), policy({ ...ALL, save: false }), db).allowed, false);
  assert.equal(memoryGate('fact-1', context(), policy({ ...ALL, receive: false }), db).allowed, false);
});

test('cyclic, missing, invalid or excessively deep source graphs fail closed', () => {
  const a = record({ id: 'a', derived: true, sourceIds: ['b'] });
  const b = record({ id: 'b', derived: true, sourceIds: ['a'] });
  const db = store([a, b]);
  assert.equal(memoryGate('a', context(DM), policy(), db).allowed, false);
  db.memories.delete('b');
  assert.equal(memoryGate('a', context(DM), policy(), db).allowed, false);
  db.memories.set('a', record({ id: 'a', derived: true, sourceIds: [] }));
  assert.equal(memoryGate('a', context(DM), policy(), db).allowed, false);
  const chain = Array.from({ length: 67 }, (_, n) => record({ id: `node-${n}`, derived: n < 66, sourceIds: n < 66 ? [`node-${n + 1}`] : [] }));
  assert.equal(memoryGate('node-0', context(DM), policy(), store(chain)).allowed, false);
});

test('engineering metadata cannot be mislabeled as social memory', () => {
  const db = store([record({ kind: 'engineering' })]);
  assert.deepEqual(memoryGate('fact-1', context(DM), policy(), db), { allowed: false, reason: 'ENGINEERING_REQUIRES_CODE_DOMAIN' });
});

test('memory permissions require actual booleans, not truthy malformed values', () => {
  const db = store([record()]);
  for (const field of ['receive', 'save', 'send'] as const) {
    const malformed = policy({ ...ALL, [field]: 'false' } as unknown as Permissions);
    assert.equal(memoryGate('fact-1', context(DM), malformed, db).allowed, false);
  }
});

test('lookup failures do not broaden visibility or expose underlying errors', () => {
  const lookup = { record: () => { throw new Error('synthetic secret diagnostic'); }, grant: () => undefined };
  assert.deepEqual(memoryGate('fact-1', context(), policy(), lookup), { allowed: false, reason: 'MEMORY_LOOKUP_FAILED' });
});
