import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../candidates/0.2.0-dev.1/bundle/client.js', import.meta.url), 'utf8');
// Execute the actual request callback and its validators in isolation. This is
// behavioral unit evidence, not a React renderer, browser or DSH visual check.
const helpers = source.slice(source.indexOf('    const REQUEST_TIMEOUT_MS'), source.indexOf('    const STYLES'));
const callback = source.slice(source.indexOf('async (operation, body = null, options = {}) => {'), source.indexOf('}, [update]);') + 1);
async function reject(response) {
  const state = { schemaVersion: 1, profileKey: 'desktop', revision: 3,
    identity: { name: 'juebot', mode: 'juejue', personaCard: null },
    admin: { qq: null, bindingEpoch: 0, proofState: 'unconfigured' },
    dataPath: { candidate: null, confirmedCandidate: null, approvedAt: null, fingerprint: null } };
  const calls = [];
  const sandbox = { Date, AbortController, setTimeout, clearTimeout, response, state, calls,
    fetch: async (url, options) => { calls.push({ url, options }); return response; } };
  await runInNewContext(`${helpers}
    const current = { current: initialView() };
    current.current = acceptState(current.current, state, true, [], null);
    current.current.draft.name = 'unsaved name';
    current.current.check = { token: 'old-token' };
    current.current.checkInput = 'old path';
    current.current.ack.path = true;
    const mounted = { current: true }, sequence = { current: 0 }, request = { current: null }, deadline = { current: null };
    const update = fn => { current.current = fn(current.current); };
    const send = ${callback};
    send('confirm', { expectedRevision: 3, token: 'old-token', acknowledge: true }).then(() => { globalThis.result = current.current; });`, sandbox);
  return { view: sandbox.result, calls };
}
function response(code, extra = {}) {
  return { status: 409, ok: false, headers: { get: () => 'application/json' },
    json: async () => ({ ok: false, error: { code }, ...extra }) };
}
for (const code of ['CONTROL_REVISION_CONFLICT', 'PATH_CHECK_REQUIRED', 'PATH_CHANGED_RECHECK']) {
  test(`409 ${code} preserves drafts and invalidates the path token`, async () => {
    const { view, calls } = await reject(response(code));
    assert.equal(view.error, code === 'CONTROL_REVISION_CONFLICT' ? 'error.conflict' : 'error.recheck');
    assert.equal(view.fresh, code !== 'CONTROL_REVISION_CONFLICT');
    assert.equal(view.draft.name, 'unsaved name');
    assert.equal(view.saved.revision, 3);
    assert.equal(view.check, null);
    assert.equal(view.checkInput, null);
    assert.equal(view.ack.path, false);
    assert.equal(view.notice, null);
    assert.equal(view.busy, null);
    assert.equal(calls.length, 1);
  });
}
for (const [name, value] of [
  ['unknown code', response('UNKNOWN_CONFLICT')],
  ['extra envelope field', response('CONTROL_REVISION_CONFLICT', { injected: true })],
  ['non-JSON', { ...response('CONTROL_REVISION_CONFLICT'), headers: { get: () => 'text/html' }, json: async () => { throw Error('must not parse'); } }],
  ['broken JSON', { ...response('CONTROL_REVISION_CONFLICT'), json: async () => { throw SyntaxError('broken'); } }],
  ['extra error field', { ...response('CONTROL_REVISION_CONFLICT'), json: async () => ({ ok: false, error: { code: 'CONTROL_REVISION_CONFLICT', detail: 'untrusted' } }) }],
]) {
  test(`409 ${name} safely falls back without claiming a revision conflict`, async () => {
    const { view } = await reject(value);
    assert.ok(['error.invalid', 'error.http'].includes(view.error));
    assert.equal(view.notice, 'page.mutationUnknown');
    assert.equal(view.fresh, false);
    assert.equal(view.draft.name, 'unsaved name');
    assert.equal(view.saved.revision, 3);
    assert.equal(view.check, null);
    assert.equal(view.busy, null);
  });
}
