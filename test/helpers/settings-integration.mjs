import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openControlDomain } from '../../candidates/0.2.0-dev.1/bundle/settings-domain.js';
import { createControlService } from '../../candidates/0.2.0-dev.1/bundle/lib/control.js';

const require = createRequire(import.meta.url);
let manifest;
if (process.env.JUEBOT_TEST_ZOD_DIR) manifest = join(process.env.JUEBOT_TEST_ZOD_DIR, 'package.json');
else { try { manifest = require.resolve('zod/package.json'); }
  catch { manifest = join(process.env.APPDATA, 'npm/node_modules/openclaw/node_modules/zod/package.json'); } }
const pkg = JSON.parse(await readFile(manifest, 'utf8'));
assert.equal(pkg.version, '4.4.3');
export const { z } = await import(pathToFileURL(join(dirname(manifest), pkg.exports['.'].import)).href);
export const profileA = resolve('synthetic-profiles/http-alpha');
export const profileB = resolve('synthetic-profiles/http-beta');
export const deferred = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

// Deliberately a storage contract double; no claim of SDK execution/durability.
export class IntegrationStorage {
  records = new Map(); commits = []; beforeSet; fail;
  async open(spec) {
    let value = spec.global.schema.parse(this.records.get(spec.name) ?? spec.global.initial);
    return { global: { get: () => value, set: async next => {
      await this.beforeSet?.(next);
      if (this.fail) throw this.fail;
      this.records.set(spec.name, structuredClone(next)); this.commits.push(next); value = next;
    } }, close: async () => {} };
  }
}
export async function integration({ facility = new IntegrationStorage(), profile = profileA } = {}) {
  const ctx = { get: key => key === 'profileContext' ? { dir: profile } : key === 'storageDomain' ? facility : undefined };
  const port = await openControlDomain(ctx, { z, defineDomain: spec => spec, realpath: async path => path });
  const service = createControlService(port, { inspectPath: async path => ({ canonicalPath: path, fingerprint: 'f'.repeat(64), exists: false }),
    now: () => Date.parse('2026-10-28T00:00:00.000Z'), token: () => 'synthetic-token-00001' });
  return { facility, port, service };
}
