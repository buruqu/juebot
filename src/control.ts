import { CoreError, isQQId } from './contracts.ts';

export type IdentitySettings = { name: string; mode: 'juejue' | 'persona'; personaCard: string | null };
export type ControlState = {
  schemaVersion: 1;
  profileKey: string;
  revision: number;
  identity: IdentitySettings;
  admin: { qq: string | null; bindingEpoch: number; proofState: 'unconfigured' | 'pending-proof' };
  dataPath: { candidate: string | null; confirmedCandidate: string | null; approvedAt: string | null; fingerprint: string | null };
};
export interface ControlPersistence {
  read(): ControlState;
  update(expectedRevision: number, change: (current: ControlState) => ControlState | undefined, signal?: AbortSignal): Promise<ControlState>;
  close(): Promise<void>;
}
export type PathObservation = { canonicalPath: string; fingerprint: string; exists: boolean };
export type ControlSummary = {
  revision: number;
  identity: { name: string; mode: 'juejue' | 'persona'; personaCardConfigured: boolean; personaCardLength: number };
  adminConfigured: boolean; adminProofState: 'unconfigured' | 'pending-proof'; bindingEpoch: number;
  dataPathConfigured: boolean; dataPathConfirmed: boolean; businessEnabled: false;
};
const fail = (code: string): never => { throw new CoreError(code); };
function requireValue(value: unknown, code: string): asserts value { if (!value) fail(code); }
function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_CONTROL_INPUT');
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null, 'INVALID_CONTROL_INPUT');
  const keys = Reflect.ownKeys(value);
  requireValue(keys.every(key => typeof key === 'string' && allowed.includes(key)), 'UNKNOWN_CONTROL_FIELD');
  requireValue(required.every(key => Object.hasOwn(value, key)), 'MISSING_CONTROL_FIELD');
  requireValue(keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && !d.get && !d.set; }), 'INVALID_CONTROL_INPUT');
  return value as Record<string, unknown>;
}
export function controlRevision(value: unknown): number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= 0, 'INVALID_CONTROL_REVISION');
  return value as number;
}
function text(value: unknown, limit: number, multiline = false): string {
  requireValue(typeof value === 'string' && value.length <= limit, 'INVALID_CONTROL_TEXT');
  requireValue(!(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value), 'INVALID_CONTROL_TEXT');
  return value;
}
function nullableText(value: unknown, limit: number): string | null { return value === null ? null : text(value, limit); }
export function freezeControl<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeControl(child);
    Object.freeze(value);
  }
  return value;
}
export function cloneControl<T>(value: T): T { return structuredClone(value); }
export function initialControl(profileKey: string): ControlState {
  return validateControl({ schemaVersion: 1, profileKey, revision: 0,
    identity: { name: '撅撅', mode: 'juejue', personaCard: null },
    admin: { qq: null, bindingEpoch: 0, proofState: 'unconfigured' },
    dataPath: { candidate: null, confirmedCandidate: null, approvedAt: null, fingerprint: null } }, profileKey);
}
export function validateControl(input: unknown, profileKey: string): ControlState {
  requireValue(/^[0-9a-f]{64}$/u.test(profileKey), 'INVALID_PROFILE_KEY');
  const state = object(input, ['schemaVersion', 'profileKey', 'revision', 'identity', 'admin', 'dataPath']);
  requireValue(state.schemaVersion === 1 && state.profileKey === profileKey, 'CONTROL_SCHEMA_MISMATCH');
  const identity = object(state.identity, ['name', 'mode', 'personaCard']);
  const name = text(identity.name, 64);
  requireValue(name.trim() === name && name.length > 0, 'INVALID_IDENTITY_NAME');
  requireValue(identity.mode === 'juejue' || identity.mode === 'persona', 'INVALID_IDENTITY_MODE');
  const personaCard = identity.personaCard === null ? null : text(identity.personaCard, 8000, true);
  const admin = object(state.admin, ['qq', 'bindingEpoch', 'proofState']);
  requireValue(admin.qq === null || isQQId(admin.qq), 'INVALID_ADMIN_QQ');
  requireValue(admin.proofState === (admin.qq === null ? 'unconfigured' : 'pending-proof'), 'UNVERIFIED_ADMIN_REQUIRED');
  const data = object(state.dataPath, ['candidate', 'confirmedCandidate', 'approvedAt', 'fingerprint']);
  const candidate = nullableText(data.candidate, 4096);
  const confirmedCandidate = nullableText(data.confirmedCandidate, 4096);
  const approvedAt = nullableText(data.approvedAt, 40);
  const fingerprint = nullableText(data.fingerprint, 64);
  requireValue(candidate === null || candidate.trim().length > 0, 'INVALID_DATA_CANDIDATE');
  if (confirmedCandidate === null) requireValue(approvedAt === null && fingerprint === null, 'INVALID_DATA_CONFIRMATION');
  else requireValue(candidate === confirmedCandidate && approvedAt !== null && Number.isFinite(Date.parse(approvedAt))
    && new Date(approvedAt).toISOString() === approvedAt && fingerprint !== null && /^[0-9a-f]{64}$/u.test(fingerprint), 'INVALID_DATA_CONFIRMATION');
  return { schemaVersion: 1, profileKey, revision: controlRevision(state.revision),
    identity: { name, mode: identity.mode, personaCard },
    admin: { qq: admin.qq as string | null, bindingEpoch: controlRevision(admin.bindingEpoch), proofState: admin.proofState as ControlState['admin']['proofState'] },
    dataPath: { candidate, confirmedCandidate, approvedAt, fingerprint } };
}
export function publicControl(state: ControlState): ControlSummary {
  return { revision: state.revision,
    identity: { name: state.identity.name, mode: state.identity.mode, personaCardConfigured: state.identity.personaCard !== null,
      personaCardLength: state.identity.personaCard?.length ?? 0 },
    adminConfigured: state.admin.qq !== null, adminProofState: state.admin.proofState, bindingEpoch: state.admin.bindingEpoch,
    dataPathConfigured: state.dataPath.candidate !== null, dataPathConfirmed: state.dataPath.confirmedCandidate !== null,
    businessEnabled: false };
}
export function parseIdentityUpdate(input: unknown): { expectedRevision: number; patch: Partial<IdentitySettings> } {
  const value = object(input, ['expectedRevision', 'patch']);
  const patch = object(value.patch, ['name', 'mode', 'personaCard'], []);
  requireValue(Object.keys(patch).length > 0, 'EMPTY_IDENTITY_PATCH');
  const result: Partial<IdentitySettings> = {};
  if (Object.hasOwn(patch, 'name')) {
    const name = text(patch.name, 64).trim();
    requireValue(name.length > 0, 'INVALID_IDENTITY_NAME'); result.name = name;
  }
  if (Object.hasOwn(patch, 'mode')) {
    requireValue(patch.mode === 'juejue' || patch.mode === 'persona', 'INVALID_IDENTITY_MODE'); result.mode = patch.mode;
  }
  if (Object.hasOwn(patch, 'personaCard')) {
    result.personaCard = patch.personaCard === null ? null : text(patch.personaCard, 8000, true);
    if (result.personaCard?.trim() === '') result.personaCard = null;
  }
  return { expectedRevision: controlRevision(value.expectedRevision), patch: result };
}

/** Shared application methods. Owner actions are passed only to authenticated owner-route code. */
export function createControlService(port: ControlPersistence, dependencies: {
  inspectPath(path: string, signal?: AbortSignal): Promise<PathObservation>;
  token(): string;
  now(): number;
}) {
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<string, { revision: number; observation: PathObservation; expiresAt: number }>();
  const assertOpen = () => requireValue(!closed, 'CONTROL_CLOSED');
  const current = () => { assertOpen(); return cloneControl(port.read()); };
  const checkedRevision = (expected: unknown) => {
    const revision = controlRevision(expected);
    requireValue(current().revision === revision, 'CONTROL_REVISION_CONFLICT');
    return revision;
  };
  const updateIdentity = async (input: unknown, signal?: AbortSignal, authorize?: () => void): Promise<ControlState> => {
    assertOpen(); signal?.throwIfAborted();
    const request = parseIdentityUpdate(input);
    const result = await port.update(request.expectedRevision, state => {
      authorize?.();
      const identity = { ...state.identity, ...request.patch };
      if (JSON.stringify(identity) === JSON.stringify(state.identity)) return undefined;
      return { ...state, identity };
    }, signal);
    return cloneControl(result);
  };
  const owner = Object.freeze({
    async setAdmin(input: unknown, signal?: AbortSignal) {
      assertOpen(); signal?.throwIfAborted();
      const value = object(input, ['expectedRevision', 'qq', 'acknowledgeReset']);
      requireValue(value.acknowledgeReset === true, 'USER_ACKNOWLEDGEMENT_REQUIRED');
      const qq = value.qq === null ? null : text(value.qq, 20).trim();
      requireValue(qq === null || isQQId(qq), 'INVALID_ADMIN_QQ');
      const result = await port.update(controlRevision(value.expectedRevision), state => {
        if (state.admin.qq === qq) return undefined;
        requireValue(state.admin.bindingEpoch < Number.MAX_SAFE_INTEGER, 'CONTROL_REVISION_EXHAUSTED');
        return { ...state, admin: { qq, bindingEpoch: state.admin.bindingEpoch + 1,
          proofState: qq === null ? 'unconfigured' : 'pending-proof' } };
      }, signal);
      return cloneControl(result);
    },
    async checkPath(input: unknown, signal?: AbortSignal) {
      assertOpen(); signal?.throwIfAborted();
      const value = object(input, ['expectedRevision', 'candidate']);
      const revision = checkedRevision(value.expectedRevision);
      const candidate = text(value.candidate, 4096).trim();
      requireValue(candidate.length > 0, 'INVALID_DATA_CANDIDATE');
      const observation = await dependencies.inspectPath(candidate, signal);
      assertOpen(); signal?.throwIfAborted(); checkedRevision(revision);
      requireValue(typeof observation.canonicalPath === 'string' && observation.canonicalPath.length <= 4096
        && /^[0-9a-f]{64}$/u.test(observation.fingerprint) && typeof observation.exists === 'boolean', 'INVALID_PATH_OBSERVATION');
      const now = dependencies.now();
      for (const [key, item] of pending) if (item.expiresAt <= now || item.revision !== revision) pending.delete(key);
      requireValue(pending.size < 8, 'PATH_CHECK_LIMIT');
      const token = dependencies.token();
      requireValue(typeof token === 'string' && token.length >= 16 && token.length <= 128 && !pending.has(token), 'INVALID_CONFIRMATION_TOKEN');
      const expiresAt = now + 300000;
      pending.set(token, { revision, observation: cloneControl(observation), expiresAt });
      return { revision, token, expiresAt: new Date(expiresAt).toISOString(), observation: cloneControl(observation), opensDatabase: false };
    },
    async confirmPath(input: unknown, signal?: AbortSignal) {
      assertOpen(); signal?.throwIfAborted();
      const value = object(input, ['expectedRevision', 'token', 'acknowledge']);
      requireValue(value.acknowledge === true, 'USER_ACKNOWLEDGEMENT_REQUIRED');
      const revision = checkedRevision(value.expectedRevision);
      const token = text(value.token, 128);
      const item = pending.get(token); pending.delete(token);
      requireValue(item && item.revision === revision && item.expiresAt > dependencies.now(), 'PATH_CHECK_REQUIRED');
      const latest = await dependencies.inspectPath(item.observation.canonicalPath, signal);
      assertOpen(); signal?.throwIfAborted();
      requireValue(item.expiresAt > dependencies.now() && latest.canonicalPath === item.observation.canonicalPath
        && latest.fingerprint === item.observation.fingerprint, 'PATH_CHANGED_RECHECK');
      const result = await port.update(revision, state => {
        requireValue(item.expiresAt > dependencies.now(), 'PATH_CHECK_REQUIRED');
        return { ...state, dataPath: { candidate: latest.canonicalPath, confirmedCandidate: latest.canonicalPath,
          approvedAt: new Date(dependencies.now()).toISOString(), fingerprint: latest.fingerprint } };
      }, signal);
      return cloneControl(result);
    },
    async clearPath(input: unknown, signal?: AbortSignal) {
      assertOpen(); signal?.throwIfAborted();
      const value = object(input, ['expectedRevision', 'acknowledge']);
      requireValue(value.acknowledge === true, 'USER_ACKNOWLEDGEMENT_REQUIRED');
      const result = await port.update(controlRevision(value.expectedRevision), state => {
        if (state.dataPath.candidate === null) return undefined;
        return { ...state, dataPath: { candidate: null, confirmedCandidate: null, approvedAt: null, fingerprint: null } };
      }, signal);
      pending.clear(); return cloneControl(result);
    },
  });
  return Object.freeze({
    readOwner: current,
    readSummary: () => publicControl(current()),
    updateIdentity,
    owner,
    async executeIdentityRequest(input: unknown, signal?: AbortSignal, authorize?: () => void) {
      const base = object(input, ['action', 'expectedRevision', 'patch'], ['action']);
      if (base.action === 'read_summary') {
        object(input, ['action']); signal?.throwIfAborted(); return publicControl(current());
      }
      requireValue(base.action === 'update_identity', 'UNSUPPORTED_IDENTITY_ACTION');
      object(input, ['action', 'expectedRevision', 'patch']);
      authorize?.();
      return publicControl(await updateIdentity({ expectedRevision: base.expectedRevision, patch: base.patch }, signal, authorize));
    },
    close() {
      if (!closePromise) { closed = true; pending.clear(); closePromise = Promise.resolve().then(() => port.close()); }
      return closePromise;
    },
  });
}
