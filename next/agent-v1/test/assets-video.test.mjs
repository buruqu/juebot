import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../src/store.ts';
import { AssetRegistry, ASSET_LIMITS } from '../host/assets.js';
import { VideoProducer, FFMPEG } from '../host/video-producer.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const code = expected => failure => failure?.code === expected || failure?.message === expected;
function fixture(t) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'juebot-assets-video-')); const root = path.join(temporary, 'assets'); mkdirSync(root);
  const db = new DatabaseSync(':memory:', { allowExtension: false }); const store = new SqliteStateStore(db, { namespace: 'test', initialize: true });
  t.after(() => { store.close(); db.close(); rmSync(temporary, { recursive: true, force: true }); });
  const registry = new AssetRegistry(store, { root }); return { temporary, root, db, store, registry };
}
function work() {
  return { id: 'work-synthetic', action: 'bili.video', script: 'Synthetic storyboard only', accountId: 'synthetic-account',
    target: { objectId: null, parentId: null, visibility: 'public', category: 'synthetic-category' } };
}
function plan() { return { title: 'Synthetic 2 second fixture', description: 'Local text cards and silent audio; no AI generation.', tags: ['synthetic'],
  scenes: [{ text: '本地合成测试 星空', duration: 1 }, { text: '第二张文字卡 %{not-an-expression}', duration: 1 }] }; }

test('registered immutable bytes have opaque handles, verified hashes and no path metadata', t => {
  const f = fixture(t); const bytes = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsynthetic\n');
  const asset = f.registry.register(bytes, { kind: 'subtitles', mime: 'text/vtt' });
  assert.match(asset.ref, /^asset_[a-f0-9]{48}$/); assert.match(asset.previewRef, /^preview_[a-f0-9]{48}$/);
  assert.equal(asset.sha256, hash(bytes)); assert.equal(asset.ready, true);
  const read = f.registry.read(asset.previewRef); assert.deepEqual(read.bytes, bytes); assert.equal(read.mime, 'text/vtt');
  assert.deepEqual(f.registry.resolve(asset.ref), asset);
  assert.ok(!JSON.stringify(asset).includes(f.root));
  const metadata = f.db.prepare('SELECT value FROM agent_state').all(); assert.ok(!JSON.stringify(metadata).includes(f.root.replaceAll('\\', '\\\\')));
  bytes[0] = 0; assert.notEqual(f.registry.read(asset.previewRef).bytes[0], 0);
});
test('registry rejects URL/path handles, invalid kinds/mime, empty and oversized bytes', t => {
  const f = fixture(t);
  for (const ref of ['https://example.invalid/a', 'file:///C:/private', '../escape', f.root, 'asset_123']) assert.throws(() => f.registry.read(ref), code('ASSET_INVALID_INPUT'));
  assert.throws(() => f.registry.register(Buffer.alloc(0), { kind: 'image', mime: 'image/png' }));
  assert.throws(() => f.registry.register(Buffer.alloc(ASSET_LIMITS.fileBytes + 1), { kind: 'image', mime: 'image/png' }));
  assert.throws(() => f.registry.register(Buffer.from('x'), { kind: 'image', mime: 'text/html' }));
  assert.deepEqual(readdirSync(f.root), []);
});
test('tampered registered bytes are rejected on preview and resolve', t => {
  const f = fixture(t); const asset = f.registry.register(Buffer.from('synthetic-a'), { kind: 'image', mime: 'image/png' });
  writeFileSync(path.join(f.root, `${asset.ref}.asset`), 'synthetic-b');
  assert.throws(() => f.registry.read(asset.previewRef), code('ASSET_HASH_MISMATCH'));
  assert.throws(() => f.registry.resolve(asset.ref), code('ASSET_HASH_MISMATCH'));
});
test('leaf symlink escape and hardlink aliases are rejected', t => {
  const f = fixture(t); const asset = f.registry.register(Buffer.from('synthetic'), { kind: 'image', mime: 'image/png' });
  const fullPath = path.join(f.root, `${asset.ref}.asset`); const outside = path.join(f.temporary, 'outside.bin'); writeFileSync(outside, 'synthetic');
  unlinkSync(fullPath);
  symlinkSync(outside, fullPath, 'file'); assert.throws(() => f.registry.read(asset.previewRef), code('ASSET_PATH_UNSAFE'));
  unlinkSync(fullPath); linkSync(outside, fullPath); assert.throws(() => f.registry.read(asset.previewRef), code('ASSET_PATH_UNSAFE'));
  assert.equal(readFileSync(outside, 'utf8'), 'synthetic');
});
test('directory junction roots and replaced roots are rejected', t => {
  const f = fixture(t); const outside = path.join(f.temporary, 'outside'); mkdirSync(outside);
  const alias = path.join(f.temporary, 'alias'); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new AssetRegistry(f.store, { root: alias }), code('ASSET_PATH_UNSAFE'));
  rmdirSync(f.root); symlinkSync(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.registry.register(Buffer.from('no-write'), { kind: 'image', mime: 'image/png' }), code('ASSET_PATH_UNSAFE'));
  assert.deepEqual(readdirSync(outside), []);
});
test('failed metadata commit does not leave a visible or orphan asset', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_asset BEFORE INSERT ON agent_state BEGIN SELECT RAISE(ABORT,'PRIVATE-INTERNAL'); END");
  assert.throws(() => f.registry.register(Buffer.from('uncommitted'), { kind: 'image', mime: 'image/png' }), code('ASSET_STORAGE_FAILURE'));
  assert.deepEqual(readdirSync(f.root), []); assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_state').get().n, 0);
});
test('work areas are confined and reject external arbitrary cleanup/read requests', t => {
  const f = fixture(t); const area = f.registry.createWorkArea();
  writeFileSync(path.join(area, 'result.bin'), 'synthetic');
  assert.equal(f.registry.readWorkFile(area, 'result.bin').toString(), 'synthetic');
  assert.throws(() => f.registry.readWorkFile(area, '../outside'));
  assert.throws(() => f.registry.removeWorkArea(f.temporary), code('ASSET_PATH_UNSAFE'));
  f.registry.removeWorkArea(area); assert.equal(existsSync(area), false);
});
test('video production fails closed without provider/script or with invalid plans', async t => {
  const f = fixture(t);
  await assert.rejects(new VideoProducer(f.registry).produce(work()), code('NOT_CONFIGURED'));
  await assert.rejects(new VideoProducer(f.registry, { planProvider: async () => plan() }).produce({ ...work(), script: '' }), code('VIDEO_SCRIPT_REQUIRED'));
  for (const value of [null, { ...plan(), command: 'shell' }, { ...plan(), scenes: [{ text: 'x', duration: 61 }] }, { ...plan(), scenes: [{ text: 'x', duration: 1, imageRef: 'C:\\secret.png' }] }]) {
    await assert.rejects(new VideoProducer(f.registry, { planProvider: async () => value }).produce(work()), code('VIDEO_INVALID_PLAN'));
  }
  assert.deepEqual(readdirSync(f.root), []);
});
test('provider errors and indefinite planning are bounded and sanitized', async t => {
  const f = fixture(t);
  await assert.rejects(new VideoProducer(f.registry, { planProvider: async () => { throw new Error('SECRET-COOKIE-IN-EXCEPTION'); } }).produce(work()), code('VIDEO_PLAN_FAILED'));
  await assert.rejects(new VideoProducer(f.registry, { planProvider: () => new Promise(() => {}), timeoutMs: 1000 }).produce(work()), code('VIDEO_TIMEOUT'));
  assert.deepEqual(readdirSync(f.root), []);
});
test('existing ffmpeg creates a real 2-second synthetic MP4, cover, WAV and VTT', { timeout: 60000 }, async t => {
  assert.equal(existsSync(FFMPEG), true, 'uses the already installed ffmpeg, never installs or downloads');
  const f = fixture(t); let providerCalls = 0;
  const producer = new VideoProducer(f.registry, { planProvider: async received => { providerCalls++; assert.equal(received.script, work().script); return plan(); } });
  const manifest = await producer.produce(work()); assert.equal(providerCalls, 1);
  assert.equal(manifest.accountId, 'synthetic-account'); assert.deepEqual(manifest.target, work().target);
  const video = f.registry.read(manifest.video.previewRef); assert.equal(video.asset.kind, 'video');
  assert.equal(video.bytes.toString('ascii', 4, 8), 'ftyp'); assert.ok(video.bytes.length > 1000);
  const cover = f.registry.read(manifest.cover.previewRef); assert.deepEqual([...cover.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const audio = f.registry.read(manifest.audio[0].previewRef); assert.equal(audio.bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.bytes.toString('ascii', 8, 12), 'WAVE');
  assert.ok(audio.bytes.length >= 64000, 'real 2-second mono PCM track');
  const subtitle = f.registry.read(manifest.subtitles[0].previewRef).bytes.toString('utf8');
  assert.match(subtitle, /^WEBVTT/); assert.ok(subtitle.includes('00:00:01.000 --> 00:00:02.000'));
  assert.ok(subtitle.includes('%{not-an-expression}'), 'model text remains data without expression expansion');
  for (const reference of [manifest.video, manifest.cover, ...manifest.audio, ...manifest.subtitles]) {
    const media = f.registry.read(reference.previewRef); assert.equal(reference.sha256, hash(media.bytes));
  }
  assert.ok(readdirSync(f.root).every(name => /^asset_[a-f0-9]{48}\.asset$/u.test(name)), 'temporary renderer files removed');
  const imageProducer = new VideoProducer(f.registry, { planProvider: async () => ({ ...plan(), scenes: [{ text: 'Approved registered image background', duration: 2, imageRef: manifest.cover.ref }] }) });
  const withImage = await imageProducer.produce(work());
  assert.equal(f.registry.read(withImage.video.previewRef).bytes.toString('ascii', 4, 8), 'ftyp');
});
