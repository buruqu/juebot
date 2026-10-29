import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openControlDomain } from '../candidates/0.2.0-dev.1/bundle/settings-domain.js';
import { initialControl } from '../candidates/0.2.0-dev.1/bundle/lib/control.js';

// Only an already-installed real Zod is used. No installation or ASAR extraction.
// JUEBOT_TEST_ZOD_DIR lets another machine point at its existing Zod 4.4.3.
const require = createRequire(import.meta.url);
let zodManifest;
if (process.env.JUEBOT_TEST_ZOD_DIR) zodManifest = join(process.env.JUEBOT_TEST_ZOD_DIR, 'package.json');
else {
  try { zodManifest = require.resolve('zod/package.json'); }
  catch {
    if (!process.env.APPDATA) throw new Error('Provide JUEBOT_TEST_ZOD_DIR for an existing Zod 4.4.3 installation');
    zodManifest = join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'node_modules', 'zod', 'package.json');
  }
}
const zodPackage = JSON.parse(await readFile(zodManifest, 'utf8'));
assert.equal(zodPackage.name, 'zod');
assert.equal(zodPackage.version, '4.4.3', 'Test with the same real Zod version as the shipped runtime');
const { z } = await import(pathToFileURL(join(dirname(zodManifest), zodPackage.exports['.'].import)).href);

const PROFILE_A = resolve('synthetic-profiles', 'alpha');
const PROFILE_B = resolve('synthetic-profiles', 'beta');
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const domainName = canonical => `juebot_control_${digest(canonical)}`;
const code = expected => error => error?.code === expected;
const deferred = () => {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

/**
 * Contract double, not the SDK and not a filesystem backend. Reads deliberately
 * return the same reference; set publishes only after its simulated acknowledgement.
 * These tests prove adapter/schema behavior, NOT actual Host durability or SDK IO.
 */
class FakeStorage {
  stored = new Map();
  openSpecs = [];
  handles = [];
  active = new Map();
  attempts = [];
  commits = [];
  timeline = [];
  beforeCommit;
  failNext;
  closeError;
  rawOnOpen;

  async open(spec) {
    this.openSpecs.push(spec);
    if (this.active.has(spec.name)) throw Object.assign(new Error('already-open'), { code: 'already-open' });
    let value = this.stored.has(spec.name)
      ? spec.global.schema.parse(this.stored.get(spec.name))
      : spec.global.initial;
    if (this.rawOnOpen) value = this.rawOnOpen(value);
    let closed = false;
    const slot = {
      closeCalls: 0,
      value: () => value,
      global: {
        get: () => {
          if (closed) throw Object.assign(new Error('closed'), { code: 'closed' });
          return value;
        },
        set: async next => {
          if (closed) throw Object.assign(new Error('closed'), { code: 'closed' });
          this.attempts.push(next);
          await this.beforeCommit?.(next);
          if (this.failNext) {
            const error = this.failNext;
            this.failNext = undefined;
            throw error;
          }
          this.stored.set(spec.name, structuredClone(next));
          value = next;
          this.commits.push(next);
          this.timeline.push(`commit:${next.revision}`);
        },
      },
      close: async () => {
        slot.closeCalls += 1;
        this.timeline.push('close');
        if (this.closeError) throw this.closeError;
        closed = true;
        this.active.delete(spec.name);
      },
    };
    this.handles.push(slot);
    this.active.set(spec.name, slot);
    return slot;
  }
}

// Injection is intentional: the real helper's shape was established by Inspect
// and installed source. This declaration checker is not advertised as SDK execution.
function declareTestDomain(spec) {
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/u);
  assert.equal(spec.version, 1);
  assert.equal(spec.layout, 'single');
  assert.deepEqual(spec.tables, {});
  assert.equal(Object.hasOwn(spec, 'invalidRecords'), false);
  assert.ok(spec.global.schema instanceof z.ZodType);
  assert.equal(spec.global.schema.safeParse(null).success, false);
  return spec;
}
function context(facility, profile = { dir: PROFILE_A }) {
  return { get(name) { return name === 'profileContext' ? profile : name === 'storageDomain' ? facility : undefined; } };
}
function dependencies(canonical = PROFILE_A, extra = {}) {
  return { defineDomain: declareTestDomain, z, realpath: async () => canonical, ...extra };
}
async function fixture(options = {}) {
  const facility = options.facility ?? new FakeStorage();
  const dir = options.dir ?? PROFILE_A;
  const port = await openControlDomain(context(facility, { dir }), dependencies(options.canonical ?? dir, options.dependencies));
  return { facility, port, handle: facility.handles.at(-1), schema: facility.openSpecs.at(-1).global.schema };
}
const rename = name => state => { state.identity.name = name; return state; };

test('uses genuine Zod 4.4.3 and opens an unpersisted, single-layout global config', async () => {
  assert.equal(zodPackage.version, '4.4.3');
  const { facility, port, handle } = await fixture();
  assert.deepEqual(port.read(), initialControl(digest(PROFILE_A)));
  assert.equal(facility.openSpecs[0].name, domainName(PROFILE_A));
  assert.equal(facility.stored.size, 0, 'Opening does not save defaults');
  assert.equal(facility.attempts.length, 0);
  assert.ok(Object.isFrozen(handle.value()));
  assert.ok(Object.isFrozen(handle.value().identity));
  await port.close();
});

test('different canonical profile directories use separate domains in a shared backend', async () => {
  const facility = new FakeStorage();
  const first = await fixture({ facility, dir: PROFILE_A });
  const second = await fixture({ facility, dir: PROFILE_B });
  await first.port.update(0, rename('alpha'));
  await second.port.update(0, rename('beta'));
  assert.notEqual(first.port.read().profileKey, second.port.read().profileKey);
  assert.equal(first.port.read().identity.name, 'alpha');
  assert.equal(second.port.read().identity.name, 'beta');
  assert.equal(facility.stored.size, 2);
  await Promise.all([first.port.close(), second.port.close()]);
});

test('realpath aliases resolve to the same profile domain and reopen the saved snapshot', async () => {
  const facility = new FakeStorage();
  const first = await fixture({ facility, dir: PROFILE_A });
  await first.port.update(0, rename('persisted'));
  await first.port.close();
  const alias = await fixture({ facility, dir: PROFILE_B, canonical: PROFILE_A });
  assert.equal(alias.port.read().revision, 1);
  assert.equal(alias.port.read().identity.name, 'persisted');
  assert.equal(facility.openSpecs[0].name, facility.openSpecs[1].name);
  assert.equal(facility.stored.size, 1);
  await alias.port.close();
});

test('profile/service/realpath/hash failures fail closed without an open or home fallback', async () => {
  const facility = new FakeStorage();
  for (const profile of [undefined, {}, { dir: '' }, { dir: 'relative-profile' }]) {
    await assert.rejects(openControlDomain(context(facility, profile ?? null), dependencies()), code('CONTROL_PROFILE_REQUIRED'));
  }
  await assert.rejects(openControlDomain(context(undefined), dependencies()), code('CONTROL_STORAGE_UNAVAILABLE'));
  const inaccessible = new Error('directory inaccessible');
  await assert.rejects(openControlDomain(context(facility), dependencies(PROFILE_A, {
    realpath: async () => { throw inaccessible; },
  })), error => error === inaccessible);
  await assert.rejects(openControlDomain(context(facility), dependencies('relative-canonical')), code('CONTROL_PROFILE_REQUIRED'));
  await assert.rejects(openControlDomain(context(facility), dependencies(PROFILE_A, { hash: () => 'not-a-hash' })), code('INVALID_PROFILE_KEY'));
  assert.equal(facility.openSpecs.length, 0);
});

test('read, reducer, caller result, and stored references cannot alias each other', async () => {
  const { facility, port, handle } = await fixture();
  const read = port.read();
  read.identity.name = 'outside';
  read.admin.qq = '111';
  assert.equal(port.read().identity.name, '撅撅');
  let draft;
  const saved = await port.update(0, current => {
    draft = current;
    current.identity.name = 'detached';
    current.revision = 37;
    return current;
  });
  assert.equal(saved.revision, 1, 'Adapter, not reducer, assigns the next revision');
  assert.notEqual(draft, handle.value());
  assert.notEqual(saved, handle.value());
  draft.identity.name = 'late draft mutation';
  saved.identity.name = 'late result mutation';
  assert.equal(port.read().identity.name, 'detached');
  assert.equal(facility.stored.values().next().value.identity.name, 'detached');
  assert.throws(() => { handle.value().identity.name = 'internal mutation'; }, TypeError);
  await port.close();
});

test('mutating the reducer clone then returning undefined or throwing does not mutate current state', async () => {
  const { facility, port } = await fixture();
  const same = await port.update(0, state => { state.identity.name = 'discard'; return undefined; });
  assert.deepEqual(same, initialControl(digest(PROFILE_A)));
  const error = new Error('reducer failure');
  await assert.rejects(port.update(0, state => { state.identity.name = 'discard too'; throw error; }), reason => reason === error);
  assert.equal(facility.attempts.length, 0);
  assert.equal(port.read().identity.name, '撅撅');
  await port.close();
});

test('does not publish a revision or value before the durable acknowledgement', { timeout: 3000 }, async () => {
  const { facility, port } = await fixture();
  const entered = deferred();
  const release = deferred();
  facility.beforeCommit = async () => { entered.resolve(); await release.promise; };
  const pending = port.update(0, rename('after ack'));
  await entered.promise;
  assert.equal(port.read().revision, 0);
  assert.equal(port.read().identity.name, '撅撅');
  assert.equal(facility.stored.size, 0);
  assert.ok(Object.isFrozen(facility.attempts[0]));
  release.resolve();
  assert.equal((await pending).revision, 1);
  assert.equal(port.read().identity.name, 'after ack');
  await port.close();
});

test('backend failure rejects its own caller, retains revision, and does not poison the queue', async () => {
  const { facility, port } = await fixture();
  const failedWrite = Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
  facility.failNext = failedWrite;
  await assert.rejects(port.update(0, rename('not committed')), reason => reason === failedWrite);
  assert.equal(port.read().revision, 0);
  assert.equal(port.read().identity.name, '撅撅');
  assert.equal(facility.stored.size, 0);
  assert.equal((await port.update(0, rename('retry'))).revision, 1);
  assert.equal(port.read().identity.name, 'retry');
  await port.close();
});

test('CAS happens inside the serial queue and rejects a stale reducer before calling it', async () => {
  const { facility, port } = await fixture();
  let staleCalls = 0;
  const first = port.update(0, rename('winner'));
  const stale = port.update(0, state => { staleCalls += 1; return state; });
  const staleRejected = assert.rejects(stale, code('CONTROL_REVISION_CONFLICT'));
  assert.equal((await first).revision, 1);
  await staleRejected;
  assert.equal(staleCalls, 0);
  assert.equal(facility.commits.length, 1);
  assert.equal((await port.update(1, rename('next'))).revision, 2);
  await port.close();
});

test('close rejects new reads/writes immediately but drains every accepted queued write', { timeout: 3000 }, async () => {
  const { facility, port, handle } = await fixture();
  const entered = deferred();
  const release = deferred();
  facility.beforeCommit = async next => { if (next.revision === 1) { entered.resolve(); await release.promise; } };
  const first = port.update(0, rename('first'));
  const second = port.update(1, rename('second'));
  await entered.promise;
  const closing = port.close();
  assert.equal(port.close(), closing, 'Repeated close reuses the same promise');
  assert.throws(() => port.read(), code('CONTROL_CLOSED'));
  await assert.rejects(port.update(2, rename('too late')), code('CONTROL_CLOSED'));
  assert.equal(handle.closeCalls, 0);
  release.resolve();
  assert.equal((await first).revision, 1);
  assert.equal((await second).revision, 2);
  await closing;
  assert.deepEqual(facility.timeline, ['commit:1', 'commit:2', 'close']);
  assert.equal(handle.closeCalls, 1);
});

test('close drains rejected writes too, and a failed close is not silently retried', async () => {
  const { facility, port, handle } = await fixture();
  facility.failNext = new Error('write failed');
  const rejected = assert.rejects(port.update(0, rename('fail')), /write failed/u);
  const closeFailure = new Error('close failed');
  facility.closeError = closeFailure;
  const closing = port.close();
  await rejected;
  await assert.rejects(closing, error => error === closeFailure);
  assert.equal(port.close(), closing);
  assert.equal(handle.closeCalls, 1);
  assert.throws(() => port.read(), code('CONTROL_CLOSED'));
});

test('invalid expected revisions, async reducers, and revision exhaustion are refused', async () => {
  const { facility, port } = await fixture();
  for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
    await assert.rejects(port.update(revision, rename('invalid')), code('INVALID_CONTROL_REVISION'));
  }
  await assert.rejects(port.update(0, null), code('INVALID_CONTROL_CHANGE'));
  await assert.rejects(port.update(0, async state => state));
  assert.equal(facility.attempts.length, 0);
  await port.close();
  const exhausted = initialControl(digest(PROFILE_A));
  exhausted.revision = Number.MAX_SAFE_INTEGER;
  facility.stored.set(domainName(PROFILE_A), exhausted);
  const reopened = (await fixture({ facility })).port;
  assert.equal((await reopened.update(Number.MAX_SAFE_INTEGER, () => undefined)).revision, Number.MAX_SAFE_INTEGER);
  await assert.rejects(reopened.update(Number.MAX_SAFE_INTEGER, rename('overflow')), code('CONTROL_REVISION_EXHAUSTED'));
  await reopened.close();
});

test('real strict Zod schema and core both reject forged/unknown/mismatched control state', async t => {
  const cases = [
    ['verified admin', state => { state.admin = { qq: '123456', bindingEpoch: 1, proofState: 'verified' }; }],
    ['unconfigured admin with QQ', state => { state.admin.qq = '123456'; }],
    ['pending proof without QQ', state => { state.admin.proofState = 'pending-proof'; }],
    ['unknown root field', state => { state.businessEnabled = true; }],
    ['unknown identity field', state => { state.identity.extra = 'no'; }],
    ['unknown admin field', state => { state.admin.isVerified = true; }],
    ['unknown path field', state => { state.dataPath.openDatabase = true; }],
    ['foreign profile key', state => { state.profileKey = digest(PROFILE_B); }],
    ['wrong schema version', state => { state.schemaVersion = 2; }],
    ['untrimmed name', state => { state.identity.name = ' padded '; }],
    ['long name', state => { state.identity.name = 'x'.repeat(65); }],
    ['long persona', state => { state.identity.personaCard = 'x'.repeat(8001); }],
    ['name control', state => { state.identity.name = 'bad\nname'; }],
    ['persona control', state => { state.identity.personaCard = 'bad\u0000card'; }],
    ['zero QQ', state => { state.admin = { qq: '0', bindingEpoch: 1, proofState: 'pending-proof' }; }],
    ['long QQ', state => { state.admin = { qq: '1'.repeat(21), bindingEpoch: 1, proofState: 'pending-proof' }; }],
    ['negative epoch', state => { state.admin.bindingEpoch = -1; }],
    ['blank candidate', state => { state.dataPath.candidate = '   '; }],
    ['long candidate', state => { state.dataPath.candidate = 'x'.repeat(4097); }],
    ['approval without confirmation', state => { state.dataPath.approvedAt = '2026-10-28T00:00:00.000Z'; }],
    ['mismatched confirmation', state => { state.dataPath = { candidate: 'a', confirmedCandidate: 'b', approvedAt: '2026-10-28T00:00:00.000Z', fingerprint: 'a'.repeat(64) }; }],
    ['noncanonical ISO', state => { state.dataPath = { candidate: 'a', confirmedCandidate: 'a', approvedAt: '2026-10-28', fingerprint: 'a'.repeat(64) }; }],
    ['bad fingerprint', state => { state.dataPath = { candidate: 'a', confirmedCandidate: 'a', approvedAt: '2026-10-28T00:00:00.000Z', fingerprint: 'z'.repeat(64) }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const { facility, port, schema } = await fixture();
    const invalid = port.read();
    mutate(invalid);
    assert.equal(schema.safeParse(invalid).success, false, 'Real Zod independently rejects the invalid state');
    await assert.rejects(port.update(0, () => invalid));
    assert.equal(facility.attempts.length, 0);
    assert.equal(port.read().revision, 0);
    await port.close();
  });
});

test('core rejects hidden fields, symbols, getters and foreign prototypes before Zod normalizes them', async () => {
  const { facility, port } = await fixture();
  const hidden = port.read();
  Object.defineProperty(hidden.identity, 'hidden', { value: true });
  await assert.rejects(port.update(0, () => hidden), code('UNKNOWN_CONTROL_FIELD'));
  const symbol = port.read();
  symbol.admin[Symbol('hidden')] = true;
  await assert.rejects(port.update(0, () => symbol), code('UNKNOWN_CONTROL_FIELD'));
  const accessor = port.read();
  let getterCalls = 0;
  Object.defineProperty(accessor.identity, 'name', { get() { getterCalls += 1; return 'getter'; }, enumerable: true });
  await assert.rejects(port.update(0, () => accessor), code('INVALID_CONTROL_INPUT'));
  assert.equal(getterCalls, 0);
  const prototype = port.read();
  Object.setPrototypeOf(prototype.identity, { inherited: true });
  await assert.rejects(port.update(0, () => prototype), code('INVALID_CONTROL_INPUT'));
  assert.equal(facility.attempts.length, 0);
  await port.close();
});

test('valid boundary fields and bound confirmation persist as control data only', async () => {
  const { facility, port, schema } = await fixture();
  const next = port.read();
  next.identity = { name: 'x'.repeat(64), mode: 'persona', personaCard: '\t\r\n' + 'x'.repeat(7997) };
  next.admin = { qq: '1'.repeat(20), bindingEpoch: 1, proofState: 'pending-proof' };
  next.dataPath = { candidate: 'x'.repeat(4096), confirmedCandidate: 'x'.repeat(4096),
    approvedAt: '2026-10-28T00:00:00.000Z', fingerprint: 'f'.repeat(64) };
  assert.equal(schema.safeParse(next).success, true);
  const result = await port.update(0, () => next);
  assert.equal(result.revision, 1);
  assert.equal(result.admin.proofState, 'pending-proof');
  assert.equal(facility.commits.length, 1);
  assert.deepEqual(result.dataPath, next.dataPath);
  await port.close();
});

test('invalid persisted snapshots fail closed without default reset or a write', async () => {
  const facility = new FakeStorage();
  const bad = initialControl(digest(PROFILE_A));
  bad.admin = { qq: '123', bindingEpoch: 1, proofState: 'verified' };
  facility.stored.set(domainName(PROFILE_A), structuredClone(bad));
  await assert.rejects(fixture({ facility }));
  assert.deepEqual(facility.stored.get(domainName(PROFILE_A)), bad);
  assert.equal(facility.attempts.length, 0);
  assert.equal(facility.handles.length, 0);
});

test('adapter releases an opened handle if its returned snapshot fails validation', async () => {
  const facility = new FakeStorage();
  facility.rawOnOpen = value => ({ ...value, profileKey: digest(PROFILE_B) });
  await assert.rejects(fixture({ facility }), code('CONTROL_SCHEMA_MISMATCH'));
  assert.equal(facility.handles[0].closeCalls, 1);
  assert.equal(facility.attempts.length, 0);
  assert.equal(facility.stored.size, 0);
});

test('aborted operations never write before admission or while waiting in the queue', { timeout: 3000 }, async () => {
  const { facility, port } = await fixture();
  const abort = new AbortController();
  const reason = new Error('cancelled');
  abort.abort(reason);
  await assert.rejects(port.update(0, rename('pre-abort'), abort.signal), error => error === reason);
  assert.equal(facility.attempts.length, 0);
  const entered = deferred();
  const release = deferred();
  facility.beforeCommit = async () => { entered.resolve(); await release.promise; };
  const first = port.update(0, rename('accepted'));
  const queuedAbort = new AbortController();
  let reducerCalls = 0;
  const second = port.update(1, state => { reducerCalls += 1; return state; }, queuedAbort.signal);
  const cancelled = assert.rejects(second, error => error === reason);
  await entered.promise;
  queuedAbort.abort(reason);
  release.resolve();
  await first;
  await cancelled;
  assert.equal(reducerCalls, 0);
  assert.equal(facility.commits.length, 1);
  await port.close();
});

test('an abort after set starts does not falsely report an already-acknowledged commit as cancelled', { timeout: 3000 }, async () => {
  const { facility, port } = await fixture();
  const entered = deferred();
  const release = deferred();
  facility.beforeCommit = async () => { entered.resolve(); await release.promise; };
  const controller = new AbortController();
  const saved = port.update(0, rename('committed'), controller.signal);
  await entered.promise;
  controller.abort(new Error('late disconnect'));
  release.resolve();
  assert.equal((await saved).revision, 1);
  assert.equal(port.read().identity.name, 'committed');
  await port.close();
});
