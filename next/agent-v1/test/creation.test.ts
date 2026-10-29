import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreationService } from '../src/creation.ts';
import type { AssetReference, CreationAction, CreationAuthority, CreationDependencies, CreationWork, FinalManifest, TrustedAsset } from '../src/creation.ts';
import { SqliteStateStore } from '../src/store.ts';
import type { SqliteDatabase } from '../../conversation-v1/src/contracts.ts';

// Real SQLite; synthetic asset-registry attestations only. No media is produced or played.
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  const store = new SqliteStateStore(db as unknown as SqliteDatabase, { namespace: 'test', initialize: true });
  t.after(() => { store.close(); db.close(); });
  let now = 1000;
  const authority: CreationAuthority = { policyRevision: 2, accountRevision: 3, publishAllowed: true,
    sources: [{ id: 'source-1', revision: 4, personLinkRevision: 5, publishAllowed: true }] };
  const registry = new Map<string, TrustedAsset>();
  for (const [ref, kind] of [['video', 'video'], ['audio', 'audio'], ['subtitles', 'subtitles'], ['cover', 'image']] as const)
    registry.set(ref, { ref, kind, sha256: 'a'.repeat(64), previewRef: `preview_${ref}`, ready: true });
  const deps: CreationDependencies = { now: () => now, authorizeHuman: principal => principal === 'host-human',
    resolveAsset: ref => registry.get(ref) ?? null, currentAuthority: () => structuredClone(authority) };
  const service = new CreationService(store, deps);
  const source = [{ id: 'source-1', revision: 4, personLinkRevision: 5 }];
  const input = (action: CreationAction = 'bili.video') => ({ id: 'work-1', action, intention: 'Synthetic creative intention', accountId: 'account-1',
    target: { objectId: action === 'bili.comment' || action === 'bili.reply' ? 'video-target' : null,
      parentId: action === 'bili.reply' ? 'parent-comment' : null, visibility: 'public', category: action === 'bili.video' ? 'synthetic-category' : null }, sources: source });
  const reference = (ref: string): AssetReference => { const item = registry.get(ref)!; return { ref, sha256: item.sha256, previewRef: item.previewRef }; };
  const manifest = (action: CreationAction = 'bili.video'): FinalManifest => ({ accountId: 'account-1', target: input(action).target,
    title: 'Synthetic final title', description: 'Synthetic description', tags: ['synthetic'], text: 'Synthetic public text',
    video: action === 'bili.video' ? reference('video') : null, audio: action === 'bili.video' ? [reference('audio')] : [],
    subtitles: action === 'bili.video' ? [reference('subtitles')] : [], cover: action === 'bili.video' ? reference('cover') : null, attachments: [] });
  const ready = (action: CreationAction = 'bili.video') => { const created = service.create(input(action)); return service.prepareFinal(created.value.id, created.revision, manifest(action)); };
  return { db, store, service, deps, authority, registry, input, reference, manifest, ready, setNow: (value: number) => { now = value; } };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;

test('intention, brief, script and assets persist but script approval never becomes video submission', t => {
  const f = fixture(t); let work = f.service.create(f.input());
  assert.equal(work.value.stage, 'intention');
  work = f.service.setBrief('work-1', work.revision, 'Synthetic brief'); assert.equal(work.value.stage, 'brief');
  work = f.service.setScript('work-1', work.revision, 'Synthetic script'); assert.equal(work.value.stage, 'script');
  assert.throws(() => f.service.approve('work-1', work.revision, 'host-human', 2000), code('CREATION_FINAL_REQUIRED'));
  work = f.service.setAssets('work-1', work.revision, [f.reference('video')]); assert.equal(work.value.stage, 'assets');
  assert.throws(() => f.service.prepareFinal('work-1', work.revision, { ...f.manifest(), video: null }), code('CREATION_FINAL_VIDEO_REQUIRED'));
  assert.throws(() => f.service.submit('work-1', work.revision, () => { assert.fail('no outbox'); }), code('CREATION_APPROVAL_REQUIRED'));
  assert.equal(f.service.read('work-1')!.value.stage, 'assets');
});

test('all five action types require a complete final snapshot and verified human before approval', t => {
  for (const action of ['qqspace', 'bili.comment', 'bili.reply', 'bili.dynamic', 'bili.video'] as const) {
    const f = fixture(t); const ready = f.ready(action);
    assert.equal(ready.value.stage, 'final-review'); assert.match(ready.value.final!.manifestHash, /^[a-f0-9]{64}$/);
    assert.throws(() => f.service.approve('work-1', ready.revision, 'model-owner', 2000), code('CREATION_HUMAN_REQUIRED'));
    const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
    assert.equal(approved.value.stage, 'approved'); assert.equal(approved.value.approval!.snapshotHash, ready.value.final!.manifestHash);
  }
});

test('manual works bind active persona configuration separately from policy and account revisions', t => {
  for (const boundary of ['review', 'consume', 'queued']) {
    const f = fixture(t); f.authority.contextRevision = 7; const ready = f.ready('bili.comment');
    assert.equal(ready.value.final!.contextRevision, 7);
    let approved = ready, queued!: import('../src/creation.ts').SubmissionSnapshot;
    if (boundary !== 'review') approved = f.service.approve(ready.value.id, ready.revision, 'host-human', 10000);
    if (boundary === 'queued') f.service.submit(approved.value.id, approved.revision, (_tx, snapshot) => { queued = snapshot; return 'queued-manual'; });
    f.authority.contextRevision++;
    if (boundary === 'review') assert.throws(() => f.service.approve(ready.value.id, ready.revision, 'host-human', 10000), code('CREATION_AUTHORITY_CHANGED'));
    if (boundary === 'consume') assert.throws(() => f.service.submit(approved.value.id, approved.revision, () => { assert.fail('no queue insertion'); }), code('CREATION_AUTHORITY_CHANGED'));
    if (boundary === 'queued') assert.throws(() => f.service.validateSubmission(queued, 'queued-manual'), code('CREATION_AUTHORITY_CHANGED'));
  }
  const compatible = fixture(t).ready('bili.comment'); assert.equal(compatible.value.final!.contextRevision, 0);
});

test('final assets are attested by the registry; arbitrary paths/URLs, hashes and stale previews fail', t => {
  const f = fixture(t); const created = f.service.create(f.input());
  for (const patch of [{ ref: 'C:\\private\\video.mp4' }, { previewRef: 'https://example.invalid/video' },
    { sha256: 'b'.repeat(64) }, { previewRef: 'another_preview' }, { ref: 'missing' }])
    assert.throws(() => f.service.prepareFinal('work-1', created.revision, { ...f.manifest(), video: { ...f.reference('video'), ...patch } }));
  f.registry.get('video')!.ready = false;
  assert.throws(() => f.service.prepareFinal('work-1', created.revision, f.manifest()), code('CREATION_ASSET_NOT_READY'));
  assert.equal(f.service.read('work-1')!.revision, created.revision);
});

test('changing any final title/text/target/media list produces a new hash and clears approval', t => {
  for (const change of [ (m: FinalManifest) => { m.title += ' edit'; }, (m: FinalManifest) => { m.description += ' edit'; },
    (m: FinalManifest) => { m.tags.push('edited'); }, (m: FinalManifest) => { m.text += ' edit'; } ]) {
    const f = fixture(t); const ready = f.ready(); const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
    const manifest = f.manifest(); change(manifest);
    const changed = f.service.prepareFinal('work-1', approved.revision, manifest);
    assert.notEqual(changed.value.final!.manifestHash, ready.value.final!.manifestHash); assert.equal(changed.value.approval, null);
    assert.throws(() => f.service.submit('work-1', changed.revision, () => 'intent'), code('CREATION_APPROVAL_REQUIRED'));
    assert.throws(() => f.service.prepareFinal('work-1', changed.revision, { ...manifest, target: { ...manifest.target, objectId: 'different' } }), code('CREATION_TARGET_CHANGED'));
  }
});

test('a changed video frame/audio/subtitle/cover registry revision invalidates an already approved snapshot', t => {
  for (const media of ['video', 'audio', 'subtitles', 'cover']) {
    const f = fixture(t); const ready = f.ready(); const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
    f.registry.get(media)!.sha256 = 'b'.repeat(64);
    assert.throws(() => f.service.submit('work-1', approved.revision, () => 'intent'), code('CREATION_ASSET_NOT_READY'));
    assert.equal(f.store.read('outbox:intent'), null);
    const changed = f.service.prepareFinal('work-1', approved.revision, f.manifest());
    assert.notEqual(changed.value.final!.manifestHash, ready.value.final!.manifestHash);
    assert.equal(changed.value.approval, null);
  }
});

test('source/PersonLink/policy/account changes and expiry block consuming approval', t => {
  for (const fault of ['source', 'link', 'revoked', 'policy', 'account', 'publish', 'expiry']) {
    const f = fixture(t); const ready = f.ready(); const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
    if (fault === 'source') f.authority.sources[0]!.revision++;
    if (fault === 'link') f.authority.sources[0]!.personLinkRevision = 6;
    if (fault === 'revoked') f.authority.sources[0]!.publishAllowed = false;
    if (fault === 'policy') f.authority.policyRevision++;
    if (fault === 'account') f.authority.accountRevision++;
    if (fault === 'publish') f.authority.publishAllowed = false;
    if (fault === 'expiry') f.setNow(2000);
    let calls = 0;
    assert.throws(() => f.service.submit('work-1', approved.revision, () => { calls++; return 'intent'; }));
    assert.equal(calls, 0); assert.equal(f.service.read('work-1')!.value.submission, null);
  }
});

test('reviewer privilege revocation blocks submission even when authority revisions remain unchanged', t => {
  const f = fixture(t); const ready = f.ready();
  const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
  f.deps.authorizeHuman = () => false;
  assert.throws(() => f.service.submit('work-1', approved.revision, () => { assert.fail('revoked reviewer cannot enqueue'); }), code('CREATION_HUMAN_REQUIRED'));
  assert.equal(f.service.read('work-1')!.value.stage, 'approved');
  assert.equal(f.service.read('work-1')!.value.submission, null);
});

test('Outbox failure rolls back both its writes and approval consumption; repeated submit creates one intent', t => {
  const f = fixture(t); const ready = f.ready(); const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
  assert.throws(() => f.service.submit('work-1', approved.revision, (tx, final) => {
    tx.write('outbox:intent-1', 0, final); throw new Error('synthetic outbox failure');
  }));
  assert.equal(f.store.read('outbox:intent-1'), null);
  assert.equal(f.service.read('work-1')!.revision, approved.revision);
  assert.equal(f.service.read('work-1')!.value.stage, 'approved');
  let calls = 0;
  const first = f.service.submit('work-1', approved.revision, (tx, final) => { calls++; tx.write('outbox:intent-1', 0, final); return 'intent-1'; });
  const repeated = f.service.submit('work-1', approved.revision, () => { assert.fail('must not enqueue twice'); });
  assert.equal(first.duplicate, false); assert.equal(repeated.duplicate, true); assert.equal(calls, 1);
  assert.equal(first.intentId, repeated.intentId); assert.equal(first.work.value.approval, null);
  assert.equal((f.store.read('outbox:intent-1')!.value as { manifest: FinalManifest }).manifest.title, f.manifest().title);
});

test('reject/request changes cannot be approved or resubmitted unchanged; revocation clears prior permission', t => {
  for (const decision of ['reject', 'requestChanges', 'revoke'] as const) {
    const f = fixture(t); const ready = f.ready(); const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
    const rejected = f.service[decision]('work-1', approved.revision, 'host-human', 'Synthetic review reason');
    assert.equal(rejected.value.approval, null); assert.equal(rejected.value.review!.reason, 'Synthetic review reason');
    assert.throws(() => f.service.submit('work-1', rejected.revision, () => 'intent'), code('CREATION_APPROVAL_REQUIRED'));
    if (decision !== 'revoke') {
      assert.throws(() => f.service.approve('work-1', rejected.revision, 'host-human', 2000), code('CREATION_FINAL_REQUIRED'));
      assert.throws(() => f.service.prepareFinal('work-1', rejected.revision, f.manifest()), code('CREATION_REVISION_REQUIRED'));
      const modified = f.service.prepareFinal('work-1', rejected.revision, { ...f.manifest(), title: 'Reviewed replacement' });
      assert.equal(f.service.approve('work-1', modified.revision, 'host-human', 2000).value.stage, 'approved');
    }
  }
});

test('unknown submission retains its intent and cannot be changed into a new-account retry', t => {
  const f = fixture(t); const ready = f.ready(); const approved = f.service.approve('work-1', ready.revision, 'host-human', 2000);
  const sent = f.service.submit('work-1', approved.revision, () => 'intent-1');
  const unknown = f.service.recordOutcome('work-1', sent.work.revision, 'unknown', null);
  assert.equal(unknown.value.submission!.state, 'unknown');
  const again = f.service.submit('work-1', 0, () => { assert.fail('unknown must not resend'); });
  assert.equal(again.intentId, 'intent-1'); assert.equal(again.duplicate, true);
  const { id: _id, ...revision } = f.input();
  assert.throws(() => f.service.revise('work-1', unknown.revision, { ...revision, accountId: 'different-account' }), code('CREATION_ALREADY_SUBMITTED'));
  assert.throws(() => f.service.recordOutcome('work-1', unknown.revision, 'queued', null));
  assert.equal(f.service.recordOutcome('work-1', unknown.revision, 'pending-review', 'platform-object').value.submission!.state, 'pending-review');
});

test('unconfigured production refuses; actual provider result must still satisfy registry and latest revision', async t => {
  const f = fixture(t); const created = f.service.create(f.input());
  await assert.rejects(f.service.produce('work-1', created.revision), code('CREATION_PROVIDER_MISSING'));
  let resolve!: (value: FinalManifest) => void;
  f.deps.productionProvider = { produce: async () => new Promise<FinalManifest>(done => { resolve = done; }) };
  const producing = f.service.produce('work-1', created.revision);
  const rejection = assert.rejects(producing, code('CREATION_REVISION_CONFLICT'));
  f.service.setBrief('work-1', created.revision, 'New brief while rendering'); resolve(f.manifest()); await rejection;
  f.deps.productionProvider = { produce: async () => ({ ...f.manifest(), video: null }) };
  await assert.rejects(f.service.produce('work-1', f.service.read('work-1')!.revision), code('CREATION_FINAL_VIDEO_REQUIRED'));
});

test('SQLite disk reopen preserves review/approval and atomic submission idempotency', t => {
  const parent = realpathSync(tmpdir()); const directory = realpathSync(mkdtempSync(path.join(parent, 'juebot-creation-test-')));
  t.after(() => { assert.equal(path.dirname(realpathSync(directory)), parent); rmSync(directory, { recursive: true }); });
  const f = fixture(t); const filename = path.join(directory, 'synthetic.sqlite');
  let db = new DatabaseSync(filename, { allowExtension: false });
  let store = new SqliteStateStore(db as unknown as SqliteDatabase, { namespace: 'test', initialize: true });
  let service = new CreationService(store, f.deps);
  const created = service.create(f.input()); const ready = service.prepareFinal('work-1', created.revision, f.manifest());
  const approved = service.approve('work-1', ready.revision, 'host-human', 2000);
  store.close(); db.close();
  db = new DatabaseSync(filename, { allowExtension: false }); store = new SqliteStateStore(db as unknown as SqliteDatabase, { namespace: 'test' }); service = new CreationService(store, f.deps);
  assert.equal(service.read('work-1')!.value.stage, 'approved');
  service.submit('work-1', approved.revision, (tx, final) => { tx.write('outbox:intent-1', 0, final); return 'intent-1'; });
  store.close(); db.close();
  db = new DatabaseSync(filename, { allowExtension: false }); store = new SqliteStateStore(db as unknown as SqliteDatabase, { namespace: 'test' }); service = new CreationService(store, f.deps);
  assert.equal(service.submit('work-1', approved.revision, () => { assert.fail('reopen must not reenqueue'); }).intentId, 'intent-1');
  assert.equal((store.read('outbox:intent-1')!.value as { workId: string }).workId, 'work-1');
  store.close(); db.close();
});

test('SQLite disk reopen preserves recovery CAS and the human decision audit; abandon stays terminal', t => {
  const parent = realpathSync(tmpdir()); const directory = realpathSync(mkdtempSync(path.join(parent, 'juebot-recovery-test-')));
  t.after(() => { assert.equal(path.dirname(realpathSync(directory)), parent); rmSync(directory, { recursive: true }); });
  const f = fixture(t); f.deps.validateWorkflow = () => true;
  const filename = path.join(directory, 'synthetic.sqlite');
  let db = new DatabaseSync(filename, { allowExtension: false });
  let store = new SqliteStateStore(db as unknown as SqliteDatabase, { namespace: 'recovery-test', initialize: true });
  let service = new CreationService(store, f.deps);
  const created = service.create(f.input());
  let work = service.setWorkflow(created.value.id, created.revision, { intentId: 'intent-1', phase: 'producing', reasonCode: null,
    selfScope: { botId: 'bot', personaId: 'persona', scope: 'synthetic' }, intentionSources: [{ eventId: 'source-1', revision: 4 }],
    identityRevision: 1, growthVersion: 'v1', modelVersion: 'synthetic', mode: 'juejue', policyRevision: 2, materialsRevision: 1, publication: null });
  work = service.setBrief(work.value.id, work.revision, 'Preserved brief');
  store.close(); db.close();
  db = new DatabaseSync(filename, { allowExtension: false }); store = new SqliteStateStore(db as unknown as SqliteDatabase, { namespace: 'recovery-test' }); service = new CreationService(store, f.deps);
  const recovered = service.recoverWorkflow(work.value.id, work.revision, 'host-human', 'Resume local production');
  assert.equal(recovered.value.id, work.value.id); assert.equal(recovered.value.brief, 'Preserved brief');
  assert.equal(recovered.value.final, null); assert.equal(recovered.value.approval, null);
  assert.throws(() => service.recoverWorkflow(work.value.id, work.revision, 'host-human', 'stale'), code('CREATION_REVISION_CONFLICT'));
  store.close(); db.close();
  db = new DatabaseSync(filename, { allowExtension: false }); store = new SqliteStateStore(db as unknown as SqliteDatabase, { namespace: 'recovery-test' }); service = new CreationService(store, f.deps);
  assert.deepEqual(service.recoveryAudit(work.value.id), [{ decision: 'recover', principal: 'host-human', reason: 'Resume local production', at: 1000, fromRevision: work.revision, phase: 'producing' }]);
  const abandoned = service.abandonWorkflow(work.value.id, recovered.revision, 'host-human', 'Stop this attempt');
  assert.equal(service.recoveryAudit(work.value.id).length, 2);
  assert.throws(() => service.recoverWorkflow(work.value.id, abandoned.revision, 'host-human', 'cannot revive'), code('CREATION_RECOVERY_NOT_ALLOWED'));
  assert.equal(service.recoveryAudit(work.value.id).length, 2);
  store.close(); db.close();
});

test('boundary validation refuses forged fields, invalid expiry and malformed action targets without saving', t => {
  const f = fixture(t);
  assert.throws(() => f.service.create({ ...f.input(), approved: true } as unknown as ReturnType<typeof f.input>));
  assert.throws(() => f.service.create({ ...f.input('bili.reply'), target: { ...f.input('bili.reply').target, parentId: null } }));
  assert.equal(f.service.read('work-1'), null);
  const ready = f.ready();
  for (const expiresAt of [1000, -1, NaN, Infinity]) assert.throws(() => f.service.approve('work-1', ready.revision, 'host-human', expiresAt));
  const snapshot = f.service.read('work-1')!; snapshot.value.final!.manifest.title = 'outside mutation';
  assert.notEqual(f.service.read('work-1')!.value.final!.manifest.title, 'outside mutation');
});

test('bounded creation index and metadata list commit together and do not disclose private work fields', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER synthetic_index_failure BEFORE INSERT ON agent_state WHEN NEW.key='creation:index' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  assert.throws(() => f.service.create(f.input()));
  assert.equal(f.service.read('work-1'), null); assert.deepEqual(f.service.list(), []);
  f.db.exec('DROP TRIGGER synthetic_index_failure');
  f.ready();
  const summaries = f.service.list(1);
  assert.equal(summaries.length, 1); assert.equal(summaries[0]!.readyForReview, true);
  assert.deepEqual(Object.keys(summaries[0]!).sort(), ['action', 'id', 'readyForReview', 'revision', 'stage', 'version']);
  assert.equal(JSON.stringify(summaries).includes('Synthetic public text'), false);
  assert.equal(JSON.stringify(summaries).includes('source-1'), false);
  assert.equal(JSON.stringify(summaries).includes('account-1'), false);
  assert.throws(() => f.service.create(f.input())); assert.equal(f.service.list().length, 1);
  for (const limit of [0, 101, Infinity, 1.5]) assert.throws(() => f.service.list(limit));
});
