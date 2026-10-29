import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ASSET_LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, assets: 256 });
const kinds = { video: ['video/mp4'], audio: ['audio/wav'], subtitles: ['text/vtt'], image: ['image/png', 'image/jpeg'] };
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const demand = (value, code = 'ASSET_INVALID_INPUT') => { if (!value) fail(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refValid = ref => typeof ref === 'string' && /^asset_[a-f0-9]{48}$/u.test(ref);
const previewValid = ref => typeof ref === 'string' && /^preview_[a-f0-9]{48}$/u.test(ref);
function within(root, target) { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function ancestors(target) {
  for (let current = target;;) {
    const info = lstatSync(current, { bigint: true }); demand(!info.isSymbolicLink(), 'ASSET_PATH_UNSAFE');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function signature(info) { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':'); }
function publicAsset(record) { return { ref: record.ref, previewRef: record.previewRef, sha256: record.sha256, kind: record.kind, ready: true }; }

/** Explicit approved root only. No profile lookup, arbitrary path imports, or database opening. */
export class AssetRegistry {
  constructor(store, { root }) {
    demand(store && typeof store.read === 'function' && typeof store.atomic === 'function');
    demand(typeof root === 'string' && path.isAbsolute(root) && !/[\u0000-\u001f]/u.test(root)
      && !root.startsWith('\\\\') && !root.startsWith('//') && path.resolve(root) !== path.parse(root).root);
    this.store = store;
    this.workAreas = new Map();
    try {
      ancestors(path.resolve(root)); this.root = realpathSync(root);
      const info = lstatSync(this.root, { bigint: true }); demand(info.isDirectory() && !info.isSymbolicLink(), 'ASSET_ROOT_UNSAFE');
      this.identity = `${info.dev}:${info.ino}`;
      this.key = `asset-registry:${hash(Buffer.from(this.root))}`;
    } catch (error) { if (error?.code?.startsWith('ASSET_')) throw error; fail('ASSET_ROOT_UNAVAILABLE'); }
  }
  checkRoot() {
    try {
      ancestors(this.root); const info = lstatSync(this.root, { bigint: true });
      demand(info.isDirectory() && !info.isSymbolicLink() && realpathSync(this.root) === this.root
        && `${info.dev}:${info.ino}` === this.identity, 'ASSET_ROOT_CHANGED');
    } catch (error) { if (error?.code?.startsWith('ASSET_')) throw error; fail('ASSET_ROOT_UNAVAILABLE'); }
  }
  state() { return this.store.read(this.key) ?? { revision: 0, value: { assets: {} } }; }
  register(bytes, { kind, mime }) {
    demand(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= ASSET_LIMITS.fileBytes);
    demand(Object.hasOwn(kinds, kind) && kinds[kind].includes(mime));
    this.checkRoot(); const data = Buffer.from(bytes);
    const ref = `asset_${randomBytes(24).toString('hex')}`; const previewRef = `preview_${randomBytes(24).toString('hex')}`;
    const filename = `${ref}.asset`; const destination = path.join(this.root, filename);
    const record = { ref, previewRef, sha256: hash(data), kind, mime, filename, size: data.length };
    let created = false; let descriptor;
    try {
      descriptor = openSync(destination, 'wx', 0o600); created = true;
      writeFileSync(descriptor, data); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      this.checkRoot();
      this.store.atomic(tx => {
        const state = tx.read(this.key) ?? { revision: 0, value: { assets: {} } };
        const records = Object.values(state.value.assets);
        demand(records.length < ASSET_LIMITS.assets && records.reduce((sum, item) => sum + item.size, 0) + data.length <= ASSET_LIMITS.totalBytes, 'ASSET_CAPACITY');
        demand(!Object.hasOwn(state.value.assets, ref), 'ASSET_CONFLICT');
        tx.write(this.key, state.revision, { assets: { ...state.value.assets, [ref]: record } });
      });
      return publicAsset(record);
    } catch (error) {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      // Remove only an uncommitted file this call created; uncertain committed
      // metadata is preserved rather than deleting a potentially referenced asset.
      if (created) try {
        this.checkRoot(); if (!this.state().value.assets[ref]) unlinkSync(destination);
      } catch {}
      if (error?.code?.startsWith('ASSET_')) throw error; fail('ASSET_STORAGE_FAILURE');
    }
  }
  read(previewRef) {
    demand(previewValid(previewRef)); this.checkRoot();
    const record = Object.values(this.state().value.assets).find(item => item.previewRef === previewRef);
    demand(record, 'ASSET_NOT_FOUND');
    demand(refValid(record.ref) && record.filename === `${record.ref}.asset` && /^[a-f0-9]{64}$/u.test(record.sha256)
      && Number.isSafeInteger(record.size) && record.size > 0 && record.size <= ASSET_LIMITS.fileBytes
      && Object.hasOwn(kinds, record.kind) && kinds[record.kind].includes(record.mime), 'ASSET_METADATA_INVALID');
    const filename = path.join(this.root, record.filename); let descriptor;
    try {
      const before = lstatSync(filename, { bigint: true });
      demand(within(this.root, filename) && !before.isSymbolicLink() && before.isFile() && before.nlink === 1n
        && before.size === BigInt(record.size) && realpathSync(filename) === filename, 'ASSET_PATH_UNSAFE');
      descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor, { bigint: true });
      demand(opened.isFile() && opened.nlink === 1n && signature(opened) === signature(before), 'ASSET_CHANGED');
      const buffer = Buffer.alloc(record.size + 1); let total = 0; let count;
      do { count = readSync(descriptor, buffer, total, buffer.length - total, null); total += count; } while (count && total < buffer.length);
      demand(total === record.size && signature(fstatSync(descriptor, { bigint: true })) === signature(opened), 'ASSET_CHANGED');
      const bytes = buffer.subarray(0, total); demand(hash(bytes) === record.sha256, 'ASSET_HASH_MISMATCH');
      closeSync(descriptor); descriptor = undefined;
      this.checkRoot();
      demand(signature(lstatSync(filename, { bigint: true })) === signature(before) && realpathSync(filename) === filename, 'ASSET_CHANGED');
      return { bytes, mime: record.mime, asset: publicAsset(record) };
    } catch (error) {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      if (error?.code?.startsWith('ASSET_')) throw error; fail('ASSET_READ_FAILED');
    }
  }
  resolve(ref) {
    demand(refValid(ref)); const record = this.state().value.assets[ref];
    return record ? this.read(record.previewRef).asset : null;
  }
  createWorkArea() {
    this.checkRoot();
    try {
      const directory = mkdtempSync(path.join(this.root, '.video-'));
      const info = lstatSync(directory, { bigint: true }); this.workAreas.set(directory, `${info.dev}:${info.ino}`); return directory;
    } catch { fail('ASSET_WORKAREA_UNAVAILABLE'); }
  }
  checkWorkArea(directory) {
    this.checkRoot();
    demand(this.workAreas.has(directory) && path.dirname(directory) === this.root && /^\.video-[a-zA-Z0-9]+$/u.test(path.basename(directory)), 'ASSET_PATH_UNSAFE');
    try {
      const info = lstatSync(directory, { bigint: true });
      demand(info.isDirectory() && !info.isSymbolicLink() && realpathSync(directory) === directory
        && `${info.dev}:${info.ino}` === this.workAreas.get(directory), 'ASSET_PATH_UNSAFE');
    } catch (error) { if (error?.code?.startsWith('ASSET_')) throw error; fail('ASSET_PATH_UNSAFE'); }
  }
  readWorkFile(directory, filename) {
    this.checkWorkArea(directory); demand(typeof filename === 'string' && /^[a-z0-9][a-z0-9.-]{0,80}$/u.test(filename));
    const fullPath = path.join(directory, filename); let descriptor;
    try {
      const before = lstatSync(fullPath, { bigint: true });
      demand(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n
        && before.size <= BigInt(ASSET_LIMITS.fileBytes) && realpathSync(fullPath) === fullPath, 'ASSET_PATH_UNSAFE');
      descriptor = openSync(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      demand(signature(fstatSync(descriptor, { bigint: true })) === signature(before), 'ASSET_CHANGED');
      const buffer = Buffer.alloc(Number(before.size) + 1); let total = 0; let count;
      do { count = readSync(descriptor, buffer, total, buffer.length - total, null); total += count; } while (count && total < buffer.length);
      demand(total === Number(before.size) && signature(fstatSync(descriptor, { bigint: true })) === signature(before), 'ASSET_CHANGED');
      closeSync(descriptor); descriptor = undefined; this.checkWorkArea(directory);
      demand(signature(lstatSync(fullPath, { bigint: true })) === signature(before) && realpathSync(fullPath) === fullPath, 'ASSET_CHANGED');
      return buffer.subarray(0, total);
    } catch (error) {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      if (error?.code?.startsWith('ASSET_')) throw error; fail('ASSET_READ_FAILED');
    }
  }
  removeWorkArea(directory) {
    this.checkWorkArea(directory);
    try { rmSync(directory, { recursive: true, force: true }); } catch { fail('ASSET_WORKAREA_CLEANUP_FAILED'); }
    this.workAreas.delete(directory);
  }
}
