import { createHash } from 'node:crypto';
import { realpath as nativeRealpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { initialControl, validateControl, cloneControl, freezeControl } from './lib/control.js';
import { CoreError } from './lib/contracts.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f]/u;
const MULTILINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function failure(code) {
  return new CoreError(code);
}

/** Real Zod schemas, not a structural substitute for a Zod object. */
function controlSchema(z, profileKey) {
  const revision = () => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  const text = (maximum, multiline = false) => z.string().max(maximum).refine(
    value => !(multiline ? MULTILINE_CONTROLS : SINGLE_LINE_CONTROLS).test(value),
    { message: 'Control text contains unsupported control characters' },
  );
  const nullablePath = () => text(4096).nullable();
  return z.strictObject({
    schemaVersion: z.literal(1),
    profileKey: z.literal(profileKey),
    revision: revision(),
    identity: z.strictObject({
      name: text(64).min(1).refine(value => value.trim() === value, { message: 'Identity name must be trimmed' }),
      mode: z.enum(['juejue', 'persona']),
      personaCard: text(8000, true).nullable(),
    }),
    admin: z.strictObject({
      qq: z.string().regex(/^[1-9][0-9]{0,19}$/u).nullable(),
      bindingEpoch: revision(),
      proofState: z.enum(['unconfigured', 'pending-proof']),
    }).refine(value => value.proofState === (value.qq === null ? 'unconfigured' : 'pending-proof'), {
      message: 'Configured administrators must remain pending proof',
    }),
    dataPath: z.strictObject({
      candidate: nullablePath().refine(value => value === null || value.trim().length > 0, {
        message: 'Data candidate must not be blank',
      }),
      confirmedCandidate: nullablePath(),
      approvedAt: text(40).nullable(),
      fingerprint: text(64).nullable(),
    }).refine(value => {
      if (value.confirmedCandidate === null) return value.approvedAt === null && value.fingerprint === null;
      return value.candidate === value.confirmedCandidate
        && value.approvedAt !== null && Number.isFinite(Date.parse(value.approvedAt))
        && new Date(value.approvedAt).toISOString() === value.approvedAt
        && value.fingerprint !== null && HASH_PATTERN.test(value.fingerprint);
    }, { message: 'Confirmation must bind the same candidate, an ISO timestamp, and its fingerprint' }),
  });
}

/**
 * Open one profile-namespaced control-config domain, not a business database.
 *
 * Production resolves the shipped SDK and Zod lazily through the Host's peer-aware
 * module resolver. Tests can inject those modules plus directory/hash functions;
 * they must use real Zod. No dependency is installed and no DSH home fallback exists.
 *
 * The caller owns close() and must register it with its own Cordis lifecycle.
 * CAS is process-local to this adapter. The backend's acknowledgement is the write
 * boundary; this does not promise cross-process locking or stronger crash/fsync
 * semantics than the configured storage backend supplies.
 *
 * @param {object} ctx Cordis context with profileContext and storageDomain services.
 * @param {object} [dependencies] Test-only module and filesystem/hash seams.
 * @returns {Promise<import('./lib/control.js').ControlPersistence>}
 */
export async function openControlDomain(ctx, dependencies = {}) {
  const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
  if (!profile || typeof profile.dir !== 'string' || !isAbsolute(profile.dir)) {
    throw failure('CONTROL_PROFILE_REQUIRED');
  }
  const facility = ctx.get('storageDomain');
  if (!facility || typeof facility.open !== 'function') throw failure('CONTROL_STORAGE_UNAVAILABLE');

  // realpath only resolves this directory's identity; it never reads profile config.
  const canonicalProfileDir = await (dependencies.realpath ?? nativeRealpath)(profile.dir);
  if (typeof canonicalProfileDir !== 'string' || !isAbsolute(canonicalProfileDir)) {
    throw failure('CONTROL_PROFILE_REQUIRED');
  }
  const profileKey = (dependencies.hash ?? (value => createHash('sha256').update(value, 'utf8').digest('hex')))(canonicalProfileDir);
  if (typeof profileKey !== 'string' || !HASH_PATTERN.test(profileKey)) throw failure('INVALID_PROFILE_KEY');

  const [defineDomain, z] = await Promise.all([
    dependencies.defineDomain ?? import('@deepseek-ai/dsh-storage-domain').then(module => module.defineDomain),
    dependencies.z ?? import('zod').then(module => module.z),
  ]);
  const schema = controlSchema(z, profileKey);
  const checked = value => {
    // Core also rejects accessors, symbols, and exotic prototypes before a schema
    // parser can normalize them away. Zod then independently checks every field.
    validateControl(value, profileKey);
    return validateControl(schema.parse(value), profileKey);
  };
  const spec = defineDomain({
    name: `juebot_control_${profileKey}`,
    version: 1,
    layout: 'single',
    tables: {},
    global: { schema, initial: freezeControl(checked(initialControl(profileKey))) },
  });
  const domain = await facility.open(spec);
  try {
    const stored = domain.global.get();
    checked(stored);
    // Domain reads/events share references. Protect the loaded reference as well as
    // every future value without writing defaults or replacing any persisted data.
    freezeControl(stored);
  } catch (error) {
    try { await domain.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'CONTROL_DOMAIN_OPEN_FAILED'); }
    throw error;
  }

  let closing = false;
  let tail = Promise.resolve();
  let disposal;
  const assertOpen = () => { if (closing) throw failure('CONTROL_CLOSED'); };
  return Object.freeze({
    read() {
      assertOpen();
      return cloneControl(checked(domain.global.get()));
    },
    async update(expectedRevision, change, signal) {
      assertOpen();
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure('INVALID_CONTROL_REVISION');
      if (typeof change !== 'function') throw failure('INVALID_CONTROL_CHANGE');
      const pending = tail.then(async () => {
        // Already admitted operations drain even after close() starts.
        signal?.throwIfAborted();
        const current = checked(domain.global.get());
        if (current.revision !== expectedRevision) throw failure('CONTROL_REVISION_CONFLICT');
        const proposed = change(cloneControl(current));
        signal?.throwIfAborted();
        if (proposed === undefined) return cloneControl(current);
        if (current.revision === Number.MAX_SAFE_INTEGER) throw failure('CONTROL_REVISION_EXHAUSTED');
        // Validate the reducer's raw object first so foreign profile keys, unknown
        // fields and accessors cannot disappear through spreading or Zod parsing.
        const rawNext = validateControl(proposed, profileKey);
        rawNext.revision = current.revision + 1; // The adapter, never the caller, owns revision.
        const next = freezeControl(checked(rawNext));
        signal?.throwIfAborted();
        await domain.global.set(next);
        // Do not throw for a late abort: acknowledgement already committed the write.
        // No adapter cache or revision was changed before the successful set().
        return cloneControl(next);
      });
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
    close() {
      if (disposal !== undefined) return disposal;
      closing = true; // Reject new reads/writes immediately, without cancelling accepted writes.
      disposal = tail.then(() => domain.close());
      return disposal;
    },
  });
}
