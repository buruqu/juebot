import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { DurableOutbox } from '../src/outbox.ts';
function setup(t) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); const store = new SqliteStateStore(db,{namespace:'test',initialize:true}); return {db,store,q:new DurableOutbox(store)}; }
const input = (id, change={}) => ({id,account:'qq:one',conversation:'group:1',kind:'social',body:'合成消息',payload:null,
  revisions:{binding:1,policy:1,memory:1,identity:1,expression:1},sourceRefs:[],createdAt:1,dueAt:10,expiresAt:1000,costUnits:2,...change});
const gate=()=>({allowed:true,reason:'NONE'}); const budget={id:'synthetic-day',limit:3};
test('store CAS, rollback, transaction handle lifetime and snapshots',t=>{const {store}=setup(t); let leaked;
  const a=store.atomic(tx=>{leaked=tx; return tx.write('a',0,{v:1});}); a.value.v=99; assert.equal(store.read('a').value.v,1);
  assert.throws(()=>store.atomic(tx=>{tx.write('a',1,{v:2}); tx.write('b',1,{});}),/CONFLICT/); assert.equal(store.read('a').value.v,1);
  assert.throws(()=>leaked.write('b',0,{}),/TRANSACTION_CLOSED/);
  assert.throws(()=>store.atomic(()=>Promise.resolve(1)),/ASYNC_TRANSACTION/);
  assert.throws(()=>store.atomic(tx=>tx.write('bad',0,{value:NaN})),/INVALID_INPUT/);
});
test('foreign database is rejected without changes',()=>{const db=new DatabaseSync(':memory:'); try {db.exec('CREATE TABLE private_data(a)'); assert.throws(()=>new SqliteStateStore(db,{namespace:'test',initialize:true}),/STORE_MISMATCH/); assert.equal(db.prepare('SELECT name FROM sqlite_schema').all()[0].name,'private_data');}finally{db.close();}});
test('owner and schema are exact; close does not close caller connection',t=>{const {db,store}=setup(t); assert.throws(()=>new SqliteStateStore(db,{namespace:'other'}),/STORE_MISMATCH/); store.close(); assert.throws(()=>store.read('x'),/STORE_CLOSED/); assert.equal(db.prepare('SELECT 1 AS n').get().n,1);});
test('outbox is paused by default, deduplicates exact intent and rejects conflicting replay',t=>{const {q}=setup(t); q.enqueue(input('a')); assert.equal(q.enqueue(input('a')),'a'); assert.throws(()=>q.enqueue(input('a',{body:'不同'})),/EVENT_CONFLICT/); assert.equal(q.claim('qq:one','w',10,20,budget,gate),null);});
test('repetition bypasses typing wait but never real in-flight send',t=>{const {q}=setup(t); q.enqueue(input('long',{dueAt:500})); q.enqueue(input('repeat',{kind:'repetition',dueAt:1})); q.setPause(q.state().revision,false); const c=q.claim('qq:one','w',2,20,budget,gate); assert.equal(c.id,'repeat'); assert.equal(q.claim('qq:one','other',501,20,budget,gate),null); assert.equal(q.list()[1].status,'unknown');});
test('single owner and global reservation prevent competing workers/accounts overspending',t=>{const {q}=setup(t); q.enqueue(input('a')); q.enqueue(input('b',{account:'bili:two'})); q.setPause(q.state().revision,false); const c=q.claim('qq:one','w',10,20,budget,gate); assert.ok(c); assert.equal(q.claim('qq:one','w2',10,20,budget,gate),null); assert.equal(q.claim('bili:two','w2',10,20,budget,gate),null); q.finish('a',c.claim,11,'failed','host:not-submitted','not-submitted'); assert.ok(q.claim('bili:two','w2',12,20,budget,gate));});
test('unknown consumes budget, blocks account and only explicit reconciliation clears',t=>{const {q}=setup(t);q.enqueue(input('a'));q.setPause(q.state().revision,false); const c=q.claim('qq:one','w',10,20,budget,gate);q.finish('a',c.claim,11,'unknown',null);q.enqueue(input('b'));assert.equal(q.claim('qq:one','w2',20,20,budget,gate),null);q.reconcile('a','failed','verified:not-submitted','not-submitted');assert.ok(q.claim('qq:one','w2',20,20,budget,gate));});
test('stale policy cancels social but holds Code result without deleting body',t=>{const {q}=setup(t);q.enqueue(input('a'));q.enqueue(input('code',{kind:'code-result'}));q.setPause(q.state().revision,false);q.claim('qq:one','w',10,20,budget,()=>({allowed:false,reason:'REVOKED'}));assert.equal(q.list()[0].status,'cancelled');assert.equal(q.list()[1].status,'held');assert.equal(q.list()[1].body,'合成消息');assert.throws(()=>q.cancel('code'),/INVALID_STATE/);});
test('restart keeps code and creations, cancels idle/social and never retries uncertain',t=>{const {q}=setup(t);q.enqueue(input('a'));q.enqueue(input('code',{kind:'code-result'}));q.enqueue(input('draft',{kind:'creation'}));q.setPause(q.state().revision,false);q.claim('qq:one','w',10,20,budget,gate);q.recover();assert.equal(q.list()[0].status,'unknown');assert.equal(q.list()[1].status,'queued');assert.equal(q.list()[2].status,'queued');assert.equal(q.state().paused,true);});
test('approval write and enqueue roll back together on failure',t=>{const {store,q}=setup(t); assert.throws(()=>store.atomic(tx=>{tx.write('approval',0,{consumed:true});q.enqueueIn(tx,input('a'));throw Error('injected');}),/STORAGE_FAILURE/);assert.equal(store.read('approval'),null);assert.equal(q.list().length,0);});
test('a failed request consumes quota unless non-submission is explicitly evidenced',t=>{const {q}=setup(t); q.enqueue(input('a'));q.enqueue(input('b',{account:'bili:two'}));q.setPause(q.state().revision,false);const c=q.claim('qq:one','w',10,20,budget,gate);q.finish('a',c.claim,11,'failed','platform:rejected');assert.equal(q.list()[0].charged,true);assert.equal(q.claim('bili:two','w',12,20,budget,gate),null);});


const archiveOptions = (q, patch = {}) => ({ expectedRevision: q.state().revision, reviewer: 'managed-host', reason: 'Verified terminal dependencies', now: 100, authorize: () => true, ...patch });
function confirmed(q, id = 'archive-a') {
  q.enqueue(input(id)); q.setPause(q.state().revision, false);
  const claim = q.claim('qq:one', 'owner', 10, 20, { id: 'accounting', limit: 100 }, gate);
  q.finish(id, claim.claim, 11, 'confirmed', 'platform-receipt'); q.setPause(q.state().revision, true);
  return q.get(id);
}

test('Outbox archive preserves full original, receipt, accounting and permanent same-id no-replay', t => {
  const { q, store } = setup(t); const original = confirmed(q);
  assert.equal(original.claim, null); assert.equal(original.leaseUntil, null);
  const before = store.read('outbox:v1').value; const inspect = q.inspectArchive([original.id]); assert.equal(inspect.revision, q.state().revision);
  const metadata = q.archive([original.id], archiveOptions(q));
  assert.equal(q.list().length, 0); assert.deepEqual(q.get(original.id), original); assert.equal(metadata[0].hash.length, 64);
  assert.deepEqual(q.readArchive(original.id).delivery, original); assert.deepEqual(q.listArchives(), metadata);
  const after = store.read('outbox:v1').value; assert.deepEqual(after.budgets, before.budgets); assert.equal(after.serial, before.serial);
  assert.equal(q.enqueue(input(original.id)), original.id); assert.equal(q.list().length, 0);
  assert.throws(() => q.enqueue(input(original.id, { body: 'conflict' })), /EVENT_CONFLICT/);
  q.enqueue(input('new')); assert.equal(q.get('new').sequence, original.sequence + 1);
  q.setPause(q.state().revision, false);
  assert.equal(q.claim('qq:one', 'owner2', 12, 20, { id: 'accounting', limit: 3 }, gate), null, 'archival must not refund spent budget');
  for (const mutate of [() => q.cancel(original.id), () => q.finish(original.id, 'stale', 12, 'failed', null),
    () => q.reconcile(original.id, 'failed', 'proof')]) assert.throws(mutate);
});

test('Outbox archive rejects unknown, sending, queued, held and residual legacy leases as complete batches', t => {
  const { q, store } = setup(t); const done = confirmed(q); q.enqueue(input('queued'));
  const before = store.read('outbox:v1');
  assert.throws(() => q.archive([done.id, 'queued'], archiveOptions(q)), /ARCHIVE_NOT_TERMINAL/);
  assert.throws(() => q.archive([done.id, done.id], archiveOptions(q)), /INVALID_INPUT/);
  assert.equal(q.listArchives().length, 0); assert.deepEqual(store.read('outbox:v1'), before);
  for (const status of ['unknown', 'sending', 'held']) {
    store.atomic(tx => { const row = tx.read('outbox:v1'); row.value.items[0].status = status; tx.write('outbox:v1', row.revision, row.value); });
    assert.throws(() => q.archive([done.id], archiveOptions(q)), /ARCHIVE_NOT_TERMINAL/);
  }
  store.atomic(tx => { const row = tx.read('outbox:v1'); Object.assign(row.value.items[0], done, { claim: 'old-owner', leaseUntil: 20 }); tx.write('outbox:v1', row.revision, row.value); });
  assert.throws(() => q.archive([done.id], archiveOptions(q)), /ARCHIVE_NOT_TERMINAL/);
});

test('Outbox archive leaves unrelated unknown account locks and quota reservations unchanged', t => {
  const { q, store } = setup(t); const done = confirmed(q);
  q.enqueue(input('uncertain')); q.setPause(q.state().revision, false);
  const claim = q.claim('qq:one', 'owner', 12, 20, { id: 'accounting', limit: 100 }, gate);
  q.finish('uncertain', claim.claim, 13, 'unknown', null); q.setPause(q.state().revision, true);
  const budgetBefore = store.read('outbox:v1').value.budgets; const uncertainBefore = q.get('uncertain');
  q.archive([done.id], archiveOptions(q)); assert.deepEqual(q.get('uncertain'), uncertainBefore);
  assert.deepEqual(store.read('outbox:v1').value.budgets, budgetBefore);
  q.enqueue(input('new')); q.setPause(q.state().revision, false);
  assert.equal(q.claim('qq:one', 'other', 14, 20, { id: 'accounting', limit: 100 }, gate), null);
});

test('Outbox archive requires CAS, pause, frozen proof and positive current synchronous authority', t => {
  const { q } = setup(t); const done = confirmed(q); const before = q.state();
  assert.throws(() => q.archive([done.id], archiveOptions(q, { expectedRevision: before.revision - 1 })), /CONFLICT/);
  for (const patch of [{ authorize: undefined }, { authorize: () => false }, { authorize: () => Promise.resolve(true) },
    { reviewer: ' ' }, { reason: '' }, { now: 0 }]) assert.throws(() => q.archive([done.id], archiveOptions(q, patch)));
  let calls = 0; assert.throws(() => q.archive([done.id], archiveOptions(q, { authorize: () => ++calls === 1 })), /ARCHIVE_NOT_AUTHORIZED/);
  const ids = [done.id]; const options = archiveOptions(q); options.authorize = proof => {
    assert.ok(Object.isFrozen(proof.items[0].revisions)); assert.equal(proof.hashes[0].length, 64);
    assert.throws(() => { proof.items[0].body = 'changed'; }, TypeError); ids[0] = 'different'; options.reviewer = 'changed'; return true;
  };
  q.archive(ids, options); assert.equal(q.readArchive(done.id).audit.reviewer, 'managed-host');
  assert.equal(q.listArchives({ limit: 1 }).length, 1); assert.throws(() => q.listArchives({ limit: 101 }), /INVALID_INPUT/);
});

test('Outbox archive atomically rolls back cross-domain rejection and real SQLite failures', t => {
  const { q, store, db } = setup(t); const done = confirmed(q); const before = db.prepare('SELECT * FROM agent_state ORDER BY key').all();
  assert.throws(() => store.atomic(tx => { q.archiveIn(tx, [done.id], archiveOptions(q)); tx.write('other-domain', 0, { archived: true }); throw Error('fault'); }));
  assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before);
  db.exec(`CREATE TEMP TRIGGER reject_archive BEFORE INSERT ON agent_state WHEN NEW.key LIKE '%outbox-delivery-archive-v1%' BEGIN SELECT RAISE(FAIL, 'fault'); END`);
  assert.throws(() => q.archive([done.id], archiveOptions(q))); assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before);
  db.exec('DROP TRIGGER reject_archive'); q.archive([done.id], archiveOptions(q));
  const reopened = new DurableOutbox(store); assert.deepEqual(reopened.get(done.id), done); assert.equal(reopened.list().length, 0);
});

test('Outbox archive corrupt payload or audit fails closed for reads and duplicate enqueue', t => {
  const { q, db } = setup(t); const done = confirmed(q); q.archive([done.id], archiveOptions(q));
  const row = db.prepare("SELECT key,value FROM agent_state WHERE key LIKE '%outbox-delivery-archive-v1%'").get();
  const record = JSON.parse(row.value); record.audit.reason = 'tampered'; db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(record), row.key);
  assert.throws(() => q.get(done.id), /ARCHIVE_CORRUPT/); assert.throws(() => q.enqueue(input(done.id)), /ARCHIVE_CORRUPT/);
});

test('Outbox archive closed store and malformed options never invoke maintenance authorization', t => {
  const { q, store } = setup(t); const done = confirmed(q); let calls = 0; const options = archiveOptions(q, { authorize: () => { calls++; return true; } });
  const accessor = { ...options }; Object.defineProperty(accessor, 'reviewer', { enumerable: true, get() { throw Error('must not evaluate'); } });
  assert.throws(() => q.archive([done.id], accessor), /INVALID_INPUT/);
  assert.throws(() => q.archive([done.id], { ...options, [Symbol('extra')]: 1 }), /INVALID_INPUT/);
  store.close(); assert.throws(() => q.archive([done.id], options), /STORE_CLOSED/); assert.equal(calls, 0);
});

test('Outbox explicit archive frees a full hot queue while preserving sequence and the old outgoing ID', t => {
  const { q, store } = setup(t); q.enqueue(input('a')); q.cancel('a'); const item = q.get('a');
  store.atomic(tx => { const row = tx.read('outbox:v1'); row.value.items = Array.from({ length: 2000 }, (_, i) => ({ ...item, id: i ? `full-${i}` : 'a', sequence: i + 1 })); row.value.serial = 2000; tx.write('outbox:v1', row.revision, row.value); });
  assert.throws(() => q.enqueue(input('new')), /CAPACITY/); q.archive(['a'], archiveOptions(q));
  assert.equal(q.enqueue(input('a')), 'a'); assert.equal(q.list().length, 1999);
  q.enqueue(input('new')); assert.equal(q.get('new').sequence, 2001); assert.equal(q.list().length, 2000);
});

test('Outbox Host callback cannot change queue state then authorize removal using stale snapshots', t => {
  const { q, store } = setup(t); const done = confirmed(q); const before = store.read('outbox:v1');
  assert.throws(() => store.atomic(tx => q.archiveIn(tx, [done.id], archiveOptions(q, { authorize: () => {
    const row = tx.read('outbox:v1'); row.value.paused = false; tx.write('outbox:v1', row.revision, row.value); return true;
  } }))), /CONFLICT/);
  assert.deepEqual(store.read('outbox:v1'), before); assert.equal(q.listArchives().length, 0);
  q.setPause(q.state().revision, false); assert.throws(() => q.archive([done.id], archiveOptions(q)), /ARCHIVE_REQUIRES_PAUSE/);
});

test('Outbox missing cold index does not allow original outgoing ID to enqueue a second delivery', t => {
  const { q, db } = setup(t); const done = confirmed(q); q.archive([done.id], archiveOptions(q));
  db.prepare('DELETE FROM agent_state WHERE key=?').run('outbox:archives:v1');
  assert.throws(() => q.enqueue(input(done.id)), /ARCHIVE_CORRUPT/); assert.throws(() => q.get(done.id), /ARCHIVE_CORRUPT/);
});

test('Outbox archive cold index has a fixed bound and payload hashes detect alteration independently of audit', t => {
  const { q, store } = setup(t); const done = confirmed(q);
  store.atomic(tx => tx.write('outbox:archives:v1', 0, Array.from({ length: 4096 }, (_, i) => ({ id: `old-${i}`, hash: 'synthetic', status: 'confirmed', sequence: i, at: 1 }))));
  assert.throws(() => q.archive([done.id], archiveOptions(q)), /ARCHIVE_CAPACITY/); assert.deepEqual(q.get(done.id), done);
  const other = setup(t); const item = confirmed(other.q); other.q.archive([item.id], archiveOptions(other.q));
  const row = other.db.prepare("SELECT key,value FROM agent_state WHERE key LIKE '%outbox-delivery-archive-v1%'").get();
  const record = JSON.parse(row.value); record.delivery.body = 'altered body'; other.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(record), row.key);
  assert.throws(() => other.q.get(item.id), /ARCHIVE_CORRUPT/);
});
