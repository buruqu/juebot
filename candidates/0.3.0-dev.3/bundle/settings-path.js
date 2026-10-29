import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CoreError } from './lib/contracts.js';

const fail = code => { throw new CoreError(code); };
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function localAbsolute(candidate) {
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 4096
    && path.isAbsolute(candidate) && !/[\u0000-\u001f\u007f]/u.test(candidate)
    && !candidate.startsWith('\\\\') && !candidate.startsWith('//')
    && path.extname(candidate).toLowerCase() === '.sqlite';
}
function metadata(info) {
  return { dev: String(info.dev), ino: String(info.ino), mode: String(info.mode), nlink: String(info.nlink),
    size: String(info.size), mtime: String(info.mtimeNs ?? info.mtimeMs), ctime: String(info.ctimeNs ?? info.ctimeMs) };
}

/** Metadata-only path preview. No file content, database open, mkdir, or write probe. */
export async function inspectSettingsPath(candidate, signal, options = {}) {
  signal?.throwIfAborted();
  if (!localAbsolute(candidate)) fail('INVALID_DATA_PATH');
  const packageRoot = fileURLToPath(new URL('.', import.meta.url));
  const excluded = [packageRoot, ...(options.excludedRoots ?? [])];
  try {
    const requested = path.resolve(candidate);
    // Reject directory symlinks/junctions as well as linked leaves: confirmation
    // must refer to the path the owner checked, without a mutable alias chain.
    for (let ancestor = path.dirname(requested);;) {
      const info = await lstat(ancestor, { bigint: true });
      if (info.isSymbolicLink()) fail('DATA_PATH_NOT_REGULAR');
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    const parent = await realpath(path.dirname(requested));
    const parentInfo = await lstat(parent, { bigint: true });
    if (!parentInfo.isDirectory()) fail('DATA_PARENT_NOT_DIRECTORY');
    let canonical = path.join(parent, path.basename(requested));
    if (!localAbsolute(canonical)) fail('INVALID_DATA_PATH');
    if (canonical.split(path.sep).some(part => ['node_modules', '.git', '.install-backup'].includes(part.toLowerCase()))) fail('DATA_PATH_FORBIDDEN');
    for (const root of excluded) {
      const normalizedRoot = await realpath(root);
      if (within(normalizedRoot, requested) || within(normalizedRoot, canonical)) fail('DATA_PATH_FORBIDDEN');
    }
    let leaf;
    try { leaf = await lstat(canonical, { bigint: true }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (leaf) {
      if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1n) fail('DATA_PATH_NOT_REGULAR');
      canonical = await realpath(canonical);
      if (!localAbsolute(canonical)) fail('INVALID_DATA_PATH');
      for (const root of excluded) if (within(await realpath(root), canonical)) fail('DATA_PATH_FORBIDDEN');
    }
    signal?.throwIfAborted();
    const identity = { canonical, parent: { dev: String(parentInfo.dev), ino: String(parentInfo.ino), mode: String(parentInfo.mode) }, leaf: leaf ? metadata(leaf) : null };
    return Object.freeze({ canonicalPath: canonical, exists: !!leaf,
      fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex') });
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof CoreError) throw error;
    fail('DATA_PATH_INSPECTION_FAILED');
  }
}
