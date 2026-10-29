import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { SelfGrowthEngine } from '../src/self-growth.ts';
import { CreationService } from '../src/creation.ts';
import { CreativeWorkflow } from '../src/creative-workflow.ts';
import { PolicyMemory } from '../src/policy-memory.ts';
import { createBiliReadSource } from '../host/bili-read-source.js';
import { createBiliMaterials } from '../host/bili-materials.js';
const account = JSON.stringify(['bilibili', 'synthetic', 'account']);
const bvid = 'BV1xx411c7mD';
const target = { objectId: bvid, parentId: null, visibility: 'public', category: null };
const video = () => ({ bvid, aid: 123, cid: '456', title: 'Synthetic music', desc: 'Synthetic description', owner: { mid: '789', name: 'Synthetic author' } });
const replies = () => ({ page: { num: 1, size: 20, count: 2 }, replies: [{ oid: 123, rpid: 101, rpid_str: '101', member: { mid: '88', uname: 'Synthetic commenter' }, content: { message: 'Synthetic public comment' } }] });
const response = data => Response.json({ code: 0, data });
function fixture(t, settings = {}) {
  const db = new DatabaseSync(':memory:'), store = new SqliteStateStore(db, { namespace: 'bili-test', initialize: true });
  let clock = 1000, revision = 1, readAllowed = true, budgetAllowed = true, fetcher;
  const calls = [], operations = [], blocked = new Set(); let allowedTarget = JSON.stringify(target);
  fetcher = async url => response(url.includes('/view?') ? video() : replies());
  const reader = createBiliReadSource({ transport: (url, options) => { calls.push({ url, options }); return fetcher(url, options); },
    authorize: () => ({ allowed: readAllowed, revision }), budget: { consume: () => budgetAllowed }, now: () => clock, ...settings });
  const deps = { store, reader, now: () => clock, authorize: request => {
    operations.push(request);
    return { allowed: !blocked.has(request.operation) && (!['draft', 'publish'].includes(request.operation) || JSON.stringify(request.target) === allowedTarget), revision, expiresAt: 5000 };
  } };
  const materials = createBiliMaterials(deps);
  t.after(async () => { await materials.close(); await reader.close(); store.close(); db.close(); });
  const capture = expectedRevision => materials.capture({ id: 'bili-source', expectedRevision, request: { account, bvid } });
  return { db, store, reader, materials, deps, calls, operations, blocked, capture,
    transport(fn) { fetcher = fn; }, revokeRead() { readAllowed = false; }, permissionRevision() { revision++; }, denyBudget() { budgetAllowed = false; },
    time(value) { clock = value; }, target(value) { allowedTarget = JSON.stringify(value); } };
}

test('inert readers and true SQLite immutable snapshots produce stable bounded materials with explicit CAS refresh/revoke', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0); assert.equal(f.store.read(JSON.stringify(['bili-materials-v1', 'default'])), null);
  const first = await f.capture(0); assert.equal(f.calls.length, 2); assert.equal(first.content.aid, '123'); assert.equal(first.content.comments[0].id, '101');
  assert.equal(first.content.truncated, true); assert.equal(first.content.coverage, 'metadata-and-top-level-comments-only'); assert.equal(first.observedAt, 1000);
  const intention = { sources: [{ eventId: 'bili-source', revision: 1 }] };
  const a = await f.materials.materials(intention, target); f.time(2000); assert.deepEqual(await f.materials.materials(intention, target), a);
  assert.equal(f.calls.length, 2); assert.equal(a.sources[0].personLinkRevision, null); assert.ok(a.items.every(item => item.text.length <= 4000));
  assert.ok(a.items.reduce((sum, item) => sum + item.text.length, 0) <= 64000);
  const second = await f.capture(1); assert.equal(second.revision, 2); assert.equal(second.contentHash, first.contentHash);
  assert.deepEqual(f.materials.get('bili-source', 1).snapshot, first);
  await assert.rejects(f.materials.materials(intention, target), /BILI_SOURCE_CHANGED/);
  await assert.rejects(f.capture(0), /BILI_REVISION_CONFLICT/); assert.equal(f.calls.length, 4);
  f.materials.revoke({ id: 'bili-source', expectedRevision: 2 });
  assert.equal(f.materials.get('bili-source').status, 'revoked');
  await assert.rejects(f.materials.materials({ sources: [{ eventId: 'bili-source', revision: 2 }] }, target), /BILI_SOURCE_CHANGED/);
  assert.deepEqual(f.materials.get('bili-source', 1).snapshot, first);
});

test('fixed GET endpoints omit credentials and reject redirects, response limits, unsafe IDs, mismatched video/comment and duplicate comments', async t => {
  for (const fault of ['redirect', 'limit', 'unsafe', 'bvid', 'oid', 'duplicate', 'page', 'platform']) {
    const f = fixture(t); f.transport(async url => {
      if (fault === 'redirect') return new Response('', { status: 302, headers: { location: 'https://evil.invalid' } });
      if (fault === 'limit') return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '99999999' } });
      if (url.includes('/view?')) { const v = video(); if (fault === 'unsafe') v.aid = Number.MAX_SAFE_INTEGER + 1; if (fault === 'bvid') v.bvid = 'BV1xx411c7mE'; return response(v); }
      const r = replies(); if (fault === 'oid') r.replies[0].oid = 999; if (fault === 'duplicate') r.replies.push(structuredClone(r.replies[0]));
      if (fault === 'page') r.page.num = 2; return fault === 'platform' ? Response.json({ code: -412, message: 'PRIVATE raw platform response' }) : response(r);
    });
    await assert.rejects(f.capture(0)); assert.equal(f.store.read(JSON.stringify(['bili-materials-v1', 'default'])), null);
    for (const call of f.calls) { assert.ok(call.url.startsWith('https://api.bilibili.com/x/')); assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error'); }
  }
});

test('timeout, budget denial, pre-read and after-await permission changes fail closed with no saved snapshot', async t => {
  for (const fault of ['timeout', 'budget', 'revoked', 'during', 'revision']) {
    const f = fixture(t, { timeoutMs: 10 });
    if (fault === 'timeout') f.transport(async () => new Promise(() => {}));
    if (fault === 'budget') f.denyBudget(); if (fault === 'revoked') f.revokeRead();
    if (['during', 'revision'].includes(fault)) f.transport(async () => { if (fault === 'during') f.revokeRead(); else f.permissionRevision(); return response(video()); });
    await assert.rejects(f.capture(0)); assert.equal(f.store.read(JSON.stringify(['bili-materials-v1', 'default'])), null);
    if (['budget', 'revoked'].includes(fault)) assert.equal(f.calls.length, 0);
    if (fault === 'timeout') assert.equal(f.calls[0].options.signal.aborted, true);
  }
});

test('readability alone grants no draft, publish or learning; each material target, source revision and expiry is rechecked', async t => {
  const f = fixture(t); await f.capture(0); const intention = { sources: [{ eventId: 'bili-source', revision: 1 }] };
  for (const purpose of ['draft', 'publish']) { f.blocked.add(purpose); await assert.rejects(f.materials.materials(intention, target), /BILI_NOT_AUTHORIZED/); f.blocked.delete(purpose); }
  await assert.rejects(f.materials.materials(intention, { ...target, objectId: 'other-video' }), /BILI_NOT_AUTHORIZED/);
  const conversationKey = JSON.stringify(['juebot-conversation-v1', 'bot', 'persona', 'bilibili', 'synthetic', 'account', 'thread', bvid]);
  f.blocked.add('learn'); assert.throws(() => f.materials.learningSource({ id: 'bili-source', revision: 1, conversationKey }), /BILI_NOT_AUTHORIZED/);
  f.blocked.delete('learn'); const candidate = f.materials.learningSource({ id: 'bili-source', revision: 1, conversationKey });
  assert.equal(candidate.requiresHumanApproval, true); assert.equal(candidate.sharing.approved, false); assert.deepEqual(candidate.candidate.purposes, ['read', 'learn']);
  const memory = new PolicyMemory(f.store, { botId: 'bot', personaId: 'persona' }); assert.equal(Object.keys(memory.readPolicy().value.sources).length, 0);
  memory.putSource(0, candidate.candidate); assert.equal(memory.readPolicy().value.sources['bili-source'].purposes.includes('publish'), false);
  await f.capture(1); assert.throws(() => f.materials.learningSource({ id: 'bili-source', revision: 1, conversationKey }), /BILI_SOURCE_CHANGED/);
  f.time(5000); await assert.rejects(f.materials.materials({ sources: [{ eventId: 'bili-source', revision: 2 }] }, target));
});

test('capture freezes caller input, rolls back real SQLite failures and cannot write late results after close', async t => {
  const f = fixture(t); const input = { id: 'bili-source', expectedRevision: 0, request: { account, bvid } };
  const original = f.deps.authorize; const mutable = createBiliMaterials({ ...f.deps, authorize: request => { input.id = 'changed'; input.request.bvid = 'BV1xx411c7mE'; return original(request); } });
  t.after(() => mutable.close()); const saved = await mutable.capture(input); assert.equal(saved.id, 'bili-source'); assert.equal(saved.content.bvid, bvid);
  const g = fixture(t); g.db.exec('PRAGMA query_only=ON'); await assert.rejects(g.capture(0)); g.db.exec('PRAGMA query_only=OFF');
  assert.equal(g.store.read(JSON.stringify(['bili-materials-v1', 'default'])), null);
  const h = fixture(t); let finish; h.transport(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.capture(0); const rejected = assert.rejects(pending); await Promise.resolve(); await h.materials.close(); await rejected;
  finish(response(video())); await Promise.resolve(); assert.equal(h.store.read(JSON.stringify(['bili-materials-v1', 'default'])), null);
  await assert.rejects(h.capture(0), /BILI_CLOSED/); assert.throws(() => h.materials.revoke({ id: 'bili-source', expectedRevision: 1 }), /BILI_CLOSED/);
});

test('saved Bili material composes with actual CreativeWorkflow and still stops at final human review', async t => {
  const f = fixture(t); await f.capture(0); const scope = { botId: 'bot', personaId: 'persona', scope: 'synthetic' };
  const self = new SelfGrowthEngine(f.store, { clock: () => 1000 });
  self.initialize({ ...scope, name: 'Synthetic', mode: 'juejue', roleCore: 'Synthetic core', modelVersion: 'synthetic' });
  self.observe(scope, { eventId: 'bili-source', revision: 1, kind: 'external', topic: 'music', interestDelta: 10, feedback: 'interest' });
  const intention = self.decide(scope, { target: 'public', topic: 'music', action: 'idle-topic', policy: { enabled: true, allowedTargets: ['public'], deniedTargets: [],
    timeZoneOffsetMinutes: 0, windows: [{ startMinute: 0, endMinute: 1440 }], cooldownMs: 0, dailyLimit: 2, unansweredLimit: 2 } }).intention;
  assert.ok(intention);
  const creation = new CreationService(f.store, { now: () => 1000, authorizeHuman: principal => principal === 'human', resolveAsset: () => null,
    validateWorkflow: () => true, currentAuthority: () => ({ policyRevision: 1, accountRevision: 1, publishAllowed: true,
      sources: [{ id: 'bili-source', revision: f.materials.get('bili-source').source.revision, personLinkRevision: null, publishAllowed: !f.blocked.has('publish') }] }) });
  const workflow = new CreativeWorkflow({ self, creation, scope, now: () => 1000, policy: () => ({ revision: 1, allowedAccounts: ['public-account'], allowedActions: ['bili.comment'] }),
    materials: (intent, destination) => f.materials.materials(intent, destination), plan: async ({ materials }) => {
      assert.ok(materials.items.some(item => item.text.includes('Synthetic public comment')));
      return { brief: 'Synthetic brief', script: null, title: '', description: '', tags: [], text: 'Synthetic final comment' };
    } });
  const result = await workflow.start(intention.id, { action: 'bili.comment', accountId: 'public-account', target });
  assert.equal(result.status, 'ready'); assert.equal(result.work.value.stage, 'final-review'); assert.equal(result.work.value.approval, null); assert.equal(result.work.value.submission, null);
  assert.equal(f.calls.length, 2); const revision = result.work.revision;
  f.blocked.add('publish'); assert.throws(() => creation.approve(result.work.value.id, revision, 'human', 5000));
});

test('async Host authority/budget callbacks, invalid BV and unsafe account namespaces never cause transport or snapshot writes', async t => {
  for (const overrides of [{ authorize: async () => ({ allowed: true, revision: 1 }) },
    { authorize: () => Promise.reject(Error('PRIVATE')) }, { budget: { consume: async () => true } }, { budget: { consume: () => Promise.reject(Error('PRIVATE')) } }]) {
    const f = fixture(t, overrides); await assert.rejects(f.capture(0)); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  for (const request of [{ account, bvid: 'https://evil.invalid' }, { account: 'account', bvid }, { account: JSON.stringify(['qq-personal', 'synthetic', 'account']), bvid },
    { account, bvid, page: 0 }, { account, bvid, limit: 51 }, { account, bvid, credential: 'forged' }]) await assert.rejects(f.materials.capture({ id: 'bili-source', expectedRevision: 0, request }));
  assert.equal(f.calls.length, 0);
  const g = createBiliMaterials({ ...f.deps, authorize: async () => ({ allowed: true, revision: 1, expiresAt: null }) }); t.after(() => g.close());
  await assert.rejects(g.capture({ id: 'bili-source', expectedRevision: 0, request: { account, bvid } })); assert.equal(f.calls.length, 0);
});

test('actual streamed byte limit, invalid UTF8, unsafe comment IDs and total material budget fail closed', async t => {
  for (const fault of ['stream', 'encoding', 'comment-id', 'total']) {
    const f = fixture(t, fault === 'stream' ? { maxResponseBytes: 128 } : {});
    f.transport(async url => {
      if (fault === 'stream') return new Response('x'.repeat(129), { headers: { 'content-type': 'application/json' } });
      if (fault === 'encoding') return new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } });
      if (url.includes('/view?')) return response(video()); const r = replies();
      if (fault === 'comment-id') r.replies[0].rpid = Number.MAX_SAFE_INTEGER + 1;
      else { r.page.count = 20; r.replies = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(r.replies[0]), rpid: i + 1, rpid_str: String(i + 1), content: { message: 'x'.repeat(3600) } })); }
      return response(r);
    });
    await assert.rejects(f.capture(0)); assert.equal(f.store.read(JSON.stringify(['bili-materials-v1', 'default'])), null);
  }
});

test('material grant revocation during callback and reader close prevent late persistence; snapshots detect content/item tampering', async t => {
  const f = fixture(t); await f.capture(0);
  const unsafe = createBiliMaterials({ ...f.deps, authorize: request => {
    const granted = f.deps.authorize(request);
    if (request.operation === 'learn') f.materials.revoke({ id: 'bili-source', expectedRevision: 1 });
    return granted;
  } }); t.after(() => unsafe.close());
  assert.throws(() => unsafe.learningSource({ id: 'bili-source', revision: 1, conversationKey: 'explicit-learning-target' }), /BILI_SOURCE_CHANGED/);
  const g = fixture(t); await g.capture(0); const key = JSON.stringify(['bili-snapshot-v1', 'default', 'bili-source', 1]);
  g.store.atomic(tx => { const saved = tx.read(key); saved.value.items[0].text = 'Injected unapproved material'; tx.write(key, saved.revision, saved.value); });
  await assert.rejects(g.materials.materials({ sources: [{ eventId: 'bili-source', revision: 1 }] }, target), /BILI_SNAPSHOT_INVALID/);
  const h = fixture(t); let finish; h.transport(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.capture(0); const rejected = assert.rejects(pending); await Promise.resolve(); await h.reader.close(); await rejected;
  finish(response(video())); assert.equal(h.store.read(JSON.stringify(['bili-materials-v1', 'default'])), null);
});
