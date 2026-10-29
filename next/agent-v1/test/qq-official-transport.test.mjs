import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../src/store.ts';
import { QQOfficialTextTransport } from '../host/qq-official-transport.js';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(t, overrides = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const stateStore = new SqliteStateStore(db, { namespace: 'qq-test', initialize: true });
  const account = JSON.stringify(['qq-official', 'test-issuer', 'synthetic-app']);
  const conversation = JSON.stringify(['juebot-conversation-v1', 'bot', 'persona', 'qq-official', 'test-issuer', 'synthetic-app', 'group', 'group-openid']);
  const delivery = { id: 'delivery-1', account, conversation, kind: 'social', body: '合成被动回复', expiresAt: 400000, payload: {} };
  const context = { authorized: true, deliveryId: delivery.id, body: delivery.body, account, conversation,
    appId: 'synthetic-app', issuer: 'test-issuer', kind: 'group', targetOpenId: 'group-openid', messageId: 'synthetic-message',
    eventType: 'GROUP_AT_MESSAGE_CREATE', eventTimestamp: 1000 };
  const calls = [];
  const options = { appId: context.appId, issuer: context.issuer, account, stateStore, now: () => 2000,
    getCredentials: async () => ({ clientSecret: 'SYNTHETIC-SECRET' }),
    resolveReplyContext: async () => context,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, body: JSON.parse(init.body) });
      return url.endsWith('getAppAccessToken') ? json({ access_token: 'SYNTHETIC-TOKEN', expires_in: '7200' }) : json({ id: 'response-message-id' });
    }, ...overrides };
  return { delivery, context, calls, options, transport: new QQOfficialTextTransport(options), stateStore };
}
test('constructor is inert; group reply uses current official protocol and a real response ID', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.transport.send(f.delivery), { status: 'confirmed', receipt: 'response-message-id' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(f.calls[0].body, { appId: 'synthetic-app', clientSecret: 'SYNTHETIC-SECRET' });
  assert.equal(f.calls[1].url, 'https://api.bot.qq.com/v2/groups/group-openid/messages');
  assert.equal(f.calls[1].headers.Authorization, 'QQBot SYNTHETIC-TOKEN');
  assert.equal(f.calls[1].redirect, 'error');
  assert.deepEqual(f.calls[1].body, { msg_type: 0, content: f.delivery.body, msg_id: 'synthetic-message', msg_seq: 1 });
});
test('direct replies use users endpoint, with four replies maximum', async t => {
  const f = fixture(t); const tuple = JSON.parse(f.delivery.conversation); tuple[6] = 'direct'; tuple[7] = 'user-openid';
  f.delivery.conversation = f.context.conversation = JSON.stringify(tuple);
  Object.assign(f.context, { kind: 'direct', targetOpenId: 'user-openid', eventType: 'C2C_MESSAGE_CREATE' });
  for (let i = 1; i <= 5; i++) {
    f.delivery.id = f.context.deliveryId = `direct-${i}`;
    assert.equal((await f.transport.send(f.delivery)).status, i <= 4 ? 'confirmed' : 'failed');
  }
  assert.equal(f.calls.length, 8); assert.ok(f.calls[1].url.includes('/users/user-openid/'));
  assert.deepEqual(f.calls.filter(c => c.body.msg_seq).map(c => c.body.msg_seq), [1, 2, 3, 4]);
});
test('concurrent duplicates are not submitted again; distinct group replies consume five unique sequences', async t => {
  const f = fixture(t);
  const outcomes = await Promise.all([f.transport.send(f.delivery), f.transport.send(f.delivery)]);
  assert.equal(outcomes.filter(x => x.status === 'confirmed').length, 1); assert.equal(f.calls.length, 2);
  for (let i = 2; i <= 6; i++) {
    f.delivery.id = f.context.deliveryId = `delivery-${i}`;
    assert.equal((await f.transport.send(f.delivery)).status, i <= 5 ? 'confirmed' : 'failed');
  }
  assert.deepEqual(f.calls.filter(c => c.body.msg_seq).map(c => c.body.msg_seq), [1, 2, 3, 4, 5]);
});
for (const change of ['account', 'issuer', 'appId', 'targetOpenId', 'kind', 'conversation', 'body', 'deliveryId', 'authorized', 'eventType']) {
  test(`reject mismatched/unattested ${change} before HTTP`, async t => {
    const f = fixture(t); f.context[change] = change === 'authorized' ? false : 'forged';
    assert.equal((await f.transport.send(f.delivery)).status, 'failed'); assert.equal(f.calls.length, 0);
  });
}
test('raw OpenID account, personal QQ, creation and over-limit text are rejected', async t => {
  const f = fixture(t);
  for (const patch of [{ account: 'group-openid' }, { kind: 'creation' }, { conversation: JSON.stringify(['qq-personal']) }, { body: '字'.repeat(6000) }]) {
    assert.equal((await f.transport.send({ ...f.delivery, ...patch })).status, 'failed');
  }
  assert.equal(f.calls.length, 0);
});
test('event and delivery expiry/future timestamps fail closed (direct uses conservative five minutes)', async t => {
  const f = fixture(t);
  for (const eventTimestamp of [-300000, 3000]) {
    f.context.eventTimestamp = eventTimestamp; assert.equal((await f.transport.send(f.delivery)).status, 'failed');
  }
  f.context.eventTimestamp = 1000;
  assert.equal((await f.transport.send({ ...f.delivery, expiresAt: 2000 })).status, 'failed'); assert.equal(f.calls.length, 0);
});
for (const variant of ['network', 'missing-id', 'malformed', 'oversize', 'server-error', 'redirect']) {
  test(`${variant} after submission is unknown, no automatic retry or sequence reuse`, async t => {
    const f = fixture(t); const base = f.options.fetchImpl;
    f.options.fetchImpl = async (url, init) => {
      if (url.endsWith('getAppAccessToken')) return base(url, init);
      f.calls.push({ url, ...init, body: JSON.parse(init.body) });
      if (variant === 'network') throw new Error('SYNTHETIC-TOKEN-do-not-leak');
      if (variant === 'missing-id') return json({});
      if (variant === 'malformed') return new Response('{');
      if (variant === 'oversize') return json({ id: 'x'.repeat(70000) });
      if (variant === 'redirect') return new Response('', { status: 302, headers: { location: 'http://invalid.example/' } });
      return json({ code: 50055001 }, 500);
    };
    const tr = new QQOfficialTextTransport(f.options);
    assert.deepEqual(await tr.send(f.delivery), { status: 'unknown', receipt: null });
    assert.deepEqual(await tr.send(f.delivery), { status: 'unknown', receipt: null }); assert.equal(f.calls.length, 2);
  });
}
test('explicit platform rejection fails without exposing server text or credentials', async t => {
  const f = fixture(t); const base = f.options.fetchImpl;
  f.options.fetchImpl = (url, init) => url.endsWith('getAppAccessToken') ? base(url, init) : json({ code: 40034024, message: 'private' }, 400);
  assert.deepEqual(await new QQOfficialTextTransport(f.options).send(f.delivery), { status: 'failed', receipt: null });
});
test('timeout and external cancellation abort a pending send and return unknown', async t => {
  const f = fixture(t); const base = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) => {
    if (url.endsWith('getAppAccessToken')) return base(url, init);
    f.calls.push(init); return new Promise(() => {});
  };
  const tr = new QQOfficialTextTransport({ ...f.options, timeoutMs: 20 });
  assert.equal((await tr.send(f.delivery)).status, 'unknown'); assert.equal(f.calls.at(-1).signal.aborted, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await tr.send({ ...f.delivery, id: 'cancelled' }, controller.signal)).status, 'failed');
});
test('persistent SQLite survives reopen: duplicate delivery and failed attempt never resend; next seq increments', async t => {
  const f = fixture(t); const dir = mkdtempSync(join(tmpdir(), 'juebot-qq-offline-')); const path = join(dir, 'state.sqlite');
  let db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let stateStore = new SqliteStateStore(db, { namespace: 'durable-qq', initialize: true });
  await new QQOfficialTextTransport({ ...f.options, stateStore }).send(f.delivery); db.close();
  db = new DatabaseSync(path);
  stateStore = new SqliteStateStore(db, { namespace: 'durable-qq' });
  const tr = new QQOfficialTextTransport({ ...f.options, stateStore });
  assert.equal((await tr.send(f.delivery)).status, 'confirmed'); assert.equal(f.calls.length, 2);
  f.delivery.id = f.context.deliveryId = 'next-delivery';
  await tr.send(f.delivery); assert.equal(f.calls.at(-1).body.msg_seq, 2);
  const serialized = JSON.stringify(db.prepare('SELECT value FROM agent_state').all());
  assert.ok(!serialized.includes('SYNTHETIC-SECRET')); assert.ok(!serialized.includes('SYNTHETIC-TOKEN')); assert.ok(!serialized.includes(f.delivery.body));
});
test('failed attempt consumes sequence; local persona change cannot reset QQ quota', async t => {
  const f = fixture(t); let reject = true; const base = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) => {
    if (url.endsWith('getAppAccessToken')) return base(url, init);
    f.calls.push({ url, body: JSON.parse(init.body) });
    if (reject) throw new Error('uncertain');
    return json({ id: 'later-id' });
  };
  const tr = new QQOfficialTextTransport(f.options);
  assert.equal((await tr.send(f.delivery)).status, 'unknown'); reject = false;
  for (let i = 2; i <= 6; i++) {
    f.delivery.id = f.context.deliveryId = `persona-${i}`;
    const tuple = JSON.parse(f.delivery.conversation); tuple[2] = `persona-${i}`;
    f.delivery.conversation = f.context.conversation = JSON.stringify(tuple);
    assert.equal((await tr.send(f.delivery)).status, i <= 5 ? 'confirmed' : 'failed');
  }
  assert.deepEqual(f.calls.filter(c => c.body.msg_seq).map(c => c.body.msg_seq), [1, 2, 3, 4, 5]);
});
test('token rejection never calls message endpoint or retries; expiry rechecked after auth', async t => {
  const f = fixture(t); const base = f.options.fetchImpl;
  const tr = new QQOfficialTextTransport({ ...f.options, fetchImpl: async (url, init) => {
    f.calls.push({ url }); return json({ code: 123 }, 401);
  } });
  assert.equal((await tr.send(f.delivery)).status, 'failed'); assert.equal(f.calls.length, 1);
  let clock = 2000;
  const g = fixture(t, { now: () => clock }); const original = g.options.fetchImpl;
  g.options.fetchImpl = async (url, init) => { clock = 301000; return original(url, init); };
  assert.equal((await new QQOfficialTextTransport(g.options).send(g.delivery)).status, 'failed'); assert.equal(g.calls.length, 1);
});
for (const changed of ['authorized', 'deliveryId', 'body', 'appId', 'issuer', 'account', 'conversation', 'kind', 'targetOpenId', 'messageId', 'eventType', 'eventTimestamp']) {
  test(`revalidate ${changed} after token await; changed authorization/event sends no message`, async t => {
    const f = fixture(t); const base = f.options.fetchImpl; let resolves = 0;
    const tr = new QQOfficialTextTransport({ ...f.options,
      resolveReplyContext: async () => { resolves++; return f.context; },
      fetchImpl: async (url, init) => {
        const response = await base(url, init);
        if (url.endsWith('getAppAccessToken')) f.context[changed] = changed === 'authorized' ? false : changed === 'eventTimestamp' ? 1001 : 'changed-after-token';
        return response;
      },
    });
    assert.deepEqual(await tr.send(f.delivery), { status: 'failed', receipt: null });
    assert.equal(resolves, 2); assert.equal(f.calls.filter(c => c.url.includes('/messages')).length, 0);
  });
}
test('recheck send deadline after the second resolver await', async t => {
  let clock = 2000; let resolves = 0;
  const f = fixture(t, { now: () => clock });
  const tr = new QQOfficialTextTransport({ ...f.options, resolveReplyContext: async () => {
    resolves++; if (resolves === 2) clock = 301000; return f.context;
  } });
  assert.deepEqual(await tr.send(f.delivery), { status: 'failed', receipt: null });
  assert.equal(resolves, 2); assert.equal(f.calls.filter(c => c.url.includes('/messages')).length, 0);
});
