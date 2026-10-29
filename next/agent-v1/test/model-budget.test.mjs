import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../lib/agent-v1/src/store.js';
import { ModelBudget } from '../host/model-budget.js';
const code = expected => error => error?.code === expected;
const usage = total => ({ prompt_tokens: total - 1, completion_tokens: 1, total_tokens: total });
function fixture(t, dailyUnits = 100) {
  const parent = realpathSync(tmpdir()); const root = mkdtempSync(path.join(parent, 'juebot-model-budget-')); let db, store; const extras = [];
  const open = initialize => { db = new DatabaseSync(path.join(root, 'state.sqlite')); store = new SqliteStateStore(db, { namespace: 'synthetic-budget', initialize }); return store; };
  open(true); t.after(() => { for (const item of extras) { item.store.close(); item.db.close(); } store.close(); db.close(); assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('juebot-model-budget-')); rmSync(root, { recursive: true, force: true }); });
  let clock = Date.UTC(2026, 9, 28, 23, 59);
  const budget = () => new ModelBudget(store, { dailyUnits, now: () => clock });
  return { budget, advance: () => { clock += 120000; }, reopen: () => { store.close(); db.close(); open(false); },
    secondBudget() { const otherDb = new DatabaseSync(path.join(root, 'state.sqlite')); const otherStore = new SqliteStateStore(otherDb, { namespace: 'synthetic-budget' });
      extras.push({ db: otherDb, store: otherStore }); return new ModelBudget(otherStore, { dailyUnits, now: () => clock }); }, get store() { return store; } };
}
test('reserve commits before return; known usage settles once and budget survives DB reopen', t => {
  const f = fixture(t); let b = f.budget(); const ticket = b.reserve(70);
  assert.equal(f.store.read('model-budget:reservation:' + ticket.id).value.status, 'reserved');
  assert.equal(b.snapshot().chargedUnits, 70); f.reopen(); b = f.budget();
  assert.equal(b.snapshot().reservedUnits, 70); b.settle(ticket, { usage: usage(20), uncertain: false });
  b.settle(ticket, { usage: usage(20), uncertain: false }); assert.equal(b.snapshot().chargedUnits, 20);
  assert.throws(() => b.settle(ticket, { usage: usage(10), uncertain: false }), code('MODEL_BUDGET_SETTLEMENT_CONFLICT'));
  f.reopen(); assert.equal(f.budget().snapshot().settledUnits, 20);
});
test('unknown/uncertain results retain reserved units, known overrun is fully charged', t => {
  const f = fixture(t); const b = f.budget(); const ticket = b.reserve(70);
  b.settle(ticket, { usage: null, uncertain: true }); b.settle(ticket, { usage: null, uncertain: true });
  assert.equal(b.snapshot().chargedUnits, 70); assert.throws(() => b.reserve(31), code('MODEL_BUDGET_DENIED'));
  const other = b.reserve(30); b.settle(other, { usage: usage(40), uncertain: true });
  assert.equal(b.snapshot().chargedUnits, 110); assert.throws(() => b.reserve(1), code('MODEL_BUDGET_DENIED'));
});
test('parallel reservations and new budget objects share one atomic namespace cap', async t => {
  const f = fixture(t); const otherConnection = f.secondBudget();
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => (index % 2 ? otherConnection : f.budget()).reserve(10))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 10);
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'MODEL_BUDGET_DENIED').length, 10);
  assert.equal(f.budget().snapshot().chargedUnits, 100); f.reopen(); assert.throws(() => f.budget().reserve(1), code('MODEL_BUDGET_DENIED'));
});
test('known actual usage over the reservation is charged fully and prevents later calls', t => {
  const f = fixture(t); const b = f.budget(); const ticket = b.reserve(60);
  b.settle(ticket, { usage: usage(150), uncertain: false }); assert.equal(b.snapshot().chargedUnits, 150);
  assert.equal(b.snapshot().reservedUnits, 0); assert.throws(() => b.reserve(1), code('MODEL_BUDGET_DENIED'));
});
test('UTC rollover never erases unresolved prior-day reservations or refunds unknown tickets', t => {
  const f = fixture(t); const b = f.budget(); const ticket = b.reserve(100); const day = b.snapshot().day;
  f.advance(); assert.equal(b.snapshot().day, '2026-10-29'); assert.equal(b.snapshot().chargedUnits, 0); b.reserve(100);
  assert.equal(b.snapshot(day).reservedUnits, 100); f.reopen();
  const next = f.budget(); next.settle(ticket, { usage: null, uncertain: true }); assert.equal(next.snapshot(day).chargedUnits, 100);
  assert.throws(() => next.settle({ ...ticket, id: '00000000-0000-0000-0000-000000000000' }, { usage: null, uncertain: true }), code('MODEL_BUDGET_TICKET_INVALID'));
  assert.equal(next.snapshot().chargedUnits, 100);
});
