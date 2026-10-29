import { AgentError, ensure, integer, stable, text } from './common.ts';
import { ConversationError } from '../../conversation-v1/src/contracts.ts';
import { ConversationReadService } from '../../conversation-v1/src/read-service.ts';
import type { BotRuntime, Profile } from './runtime.ts';
import type { CreationService, TrustedAsset, AssetReference } from './creation.ts';
import type { CodeTasks } from './code-jobs.ts';
import type { Adaptation, SourceRef, EvalSuite } from './self-growth.ts';
import type { CreativeRequest } from './creative-workflow.ts';
import type { PolicyPatch } from './policy-memory.ts';
export interface AgentAccess { revision: number; readKeys: string[]; bodyKeys: string[]; manage: boolean; review: boolean; bindingRevisions?: Record<string, number> }
export interface AgentApiDependencies {
  runtime: BotRuntime; creation: CreationService; code: CodeTasks;
  resolvePrincipal(request: Request): Promise<string | null>;
  access(principal: string): Promise<AgentAccess>;
  assets?: { read(previewRef: string): { bytes: Uint8Array; mime: string; asset: TrustedAsset }; resolve(ref: string): TrustedAsset | null };
  identity?: { read(): { revision: number; profile: Profile; profiles?: Partial<Record<Profile['mode'], Profile>> }; write(expectedRevision: number, profile: Profile): unknown };
  submitCreation(id: string, expectedRevision: number): unknown;
  recoverCreation?(id: string, expectedRevision: number, principal: string, reason: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
  reconcileDelivery?(id: string, expectedRevision: number, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
  startCreation?(key: string, intentionId: string, request: CreativeRequest, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
  prepareCreationIntention?(key: string, topic: string, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
  prepareSummaryCreation?(key: string, input: Record<string, unknown>, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
  evaluateGrowth?(input: { key: string; id: string; expectedRevision: number }, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
  biliSources?: {
    capture(input: Record<string, unknown>, principal: string, beforeCommit?: () => Promise<void>): Promise<unknown>;
    read(id: string, revision: number | undefined, principal: string): unknown;
    revoke(input: Record<string, unknown>, principal: string): unknown;
    learning(input: Record<string, unknown>, principal: string): unknown;
  };
  now?: () => number;
}
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const encodedSize = (value: string) => new TextEncoder().encode(value).byteLength;
async function wait<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let reject!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, no) => { reject = no; });
  const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([operation(), stopped]); } finally { signal.removeEventListener('abort', abort); }
}
function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  ensure(Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key)));
  ensure(required.every(key => Object.hasOwn(value, key)));
  ensure(Object.values(Object.getOwnPropertyDescriptors(value)).every(d => !d.get && !d.set));
}
function accessSnapshot(value: AgentAccess): AgentAccess {
  object(value, ['revision', 'readKeys', 'bodyKeys', 'manage', 'review', 'bindingRevisions'], ['revision', 'readKeys', 'bodyKeys', 'manage', 'review']); integer(value.revision);
  ensure(typeof value.manage === 'boolean' && typeof value.review === 'boolean');
  for (const list of [value.readKeys, value.bodyKeys]) {
    ensure(Array.isArray(list) && list.length <= 128 && new Set(list).size === list.length);
    for (const key of list) text(key, 4096);
  }
  ensure(value.bodyKeys.every(key => value.readKeys.includes(key)));
  const bindings: Record<string, number> = Object.create(null) as Record<string, number>;
  if (value.bindingRevisions !== undefined) {
    object(value.bindingRevisions, value.readKeys, []);
    for (const [key, revision] of Object.entries(value.bindingRevisions)) { integer(revision, 1); bindings[key] = revision; }
  }
  return { revision: value.revision, readKeys: [...value.readKeys].sort(), bodyKeys: [...value.bodyKeys].sort(), manage: value.manage, review: value.review, bindingRevisions: bindings };
}
function query(url: URL, allowed: string[], required: string[] = []): URLSearchParams {
  ensure(encodedSize(url.search) <= 32768); const seen = new Set<string>();
  for (const key of url.searchParams.keys()) { ensure(allowed.includes(key) && !seen.has(key)); seen.add(key); }
  ensure(required.every(key => seen.has(key)));
  for (const [key, value] of url.searchParams) { text(value, key === 'cursor' ? 8192 : key === 'key' ? 4096 : 256); ensure(!/[\u0000-\u001f\u007f]/u.test(value)); if (key === 'cursor') ensure(encodedSize(value) <= 8192); }
  return url.searchParams;
}
function positive(value: string, maximum = Number.MAX_SAFE_INTEGER): number { ensure(/^[1-9][0-9]*$/u.test(value)); const n = Number(value); integer(n, 1, maximum); return n; }
function pageOptions(params: URLSearchParams): { limit?: number; cursor?: string } {
  const result: { limit?: number; cursor?: string } = {};
  if (params.has('limit')) result.limit = positive(params.get('limit')!, 100);
  if (params.has('cursor')) result.cursor = params.get('cursor')!;
  return result;
}
function response(data: unknown): Response { return new Response(JSON.stringify({ ok: true, data }), { headers: HEADERS }); }
function synchronous(value: unknown): unknown {
  ensure(!value || typeof (value as { then?: unknown }).then !== 'function', 'ASYNC_OPERATION_UNSUPPORTED'); return value;
}
function failure(code: string, status: number): Response { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: HEADERS }); }
function errorResponse(error: unknown): Response {
  const code = error instanceof AgentError || error instanceof ConversationError ? error.code : 'AGENT_OPERATION_FAILED';
  if (['BILI_NOT_AUTHORIZED', 'BILI_BUDGET_DENIED', 'SUMMARY_MATERIAL_SCOPE_MISMATCH', 'SUMMARY_SOURCE_RESERVED'].includes(code)) return failure(code, 403);
  if (['BILI_SOURCE_NOT_FOUND'].includes(code)) return failure(code, 404);
  if (['BILI_INVALID_INPUT', 'BILI_ACCOUNT_INVALID', 'BILI_UNSAFE_ID', 'BILI_INVALID_CLOCK', 'SUMMARY_MATERIAL_EXPIRY', 'CONTACT_WINDOWS_TOO_COMPLEX'].includes(code)) return failure(code, 400);
  if (['BILI_LEARNING_RECAPTURE_REQUIRED', 'BILI_CAPACITY', 'SUMMARY_MATERIAL_STALE'].includes(code)) return failure(code, 409);
  if (['ACCESS_DENIED', 'ACCESS_CHANGED', 'CREATION_HUMAN_REQUIRED', 'UNTRUSTED_INGRESS', 'PRIVATE_SHARING_REQUIRES_CONFIRMATION', 'BILI_ACCESS_DENIED', 'BILI_ACCESS_CHANGED'].includes(code)) return failure(code, 403);
  if (['CONFLICT', 'REVISION_CONFLICT', 'BINDING_CONFLICT', 'EVENT_CONFLICT', 'SOURCE_CONFLICT', 'CREATION_REVISION_CONFLICT', 'MEMORY_CONFLICT', 'BILI_REVISION_CONFLICT'].includes(code)) return failure(code, 409);
  if (['NOT_FOUND', 'CONVERSATION_NOT_FOUND', 'SOURCE_NOT_FOUND', 'CREATION_NOT_FOUND', 'CODE_TASK_NOT_FOUND'].includes(code)) return failure(code, 404);
  if (['INVALID_INPUT', 'INVALID_CURSOR', 'CREATION_INVALID_INPUT', 'INVALID_CLOCK', 'BODY_TOO_LARGE', 'INVALID_JSON', 'INVALID_CONTENT_TYPE', 'BODY_TIMEOUT'].includes(code)) return failure(code, 400);
  if (['INTENTION_UNAVAILABLE', 'POLICY_CHANGED', 'CREATION_RECOVERY_NOT_ALLOWED', 'CREATION_RECOVERY_LIMIT', 'CREATION_ALREADY_SUBMITTED',
    'CREATION_WORKFLOW_INVALID', 'CREATION_SOURCE_REVOKED', 'CREATION_SOURCE_CHANGED', 'CREATION_PUBLISH_NOT_AUTHORIZED', 'RECONCILIATION_NOT_ALLOWED', 'SOURCE_NOT_ALLOWED', 'BILI_SOURCE_CHANGED', 'BILI_SOURCE_REVOKED', 'CREATIVE_INTENT_ALREADY_BOUND', 'STALE_EVALUATION'].includes(code)) return failure(code, 409);
  if (code === 'NOT_CONFIGURED') return failure(code, 503);
  return failure('AGENT_OPERATION_FAILED', 503);
}
/** Bounded JSON; no client actor/role/approval field is an authority source. */
async function json(request: Request): Promise<Record<string, unknown>> {
  ensure(/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('content-type') ?? ''), 'INVALID_CONTENT_TYPE');
  ensure(!request.headers.has('content-encoding') || request.headers.get('content-encoding') === 'identity', 'INVALID_CONTENT_TYPE');
  const length = request.headers.get('content-length');
  ensure(length === null || (/^\d+$/u.test(length) && Number(length) <= 65536), 'BODY_TOO_LARGE');
  ensure(request.body, 'INVALID_JSON'); const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  let reject!: (reason: unknown) => void;
  const stop = new Promise<never>((_, no) => { reject = no; });
  const abort = () => reject(new AgentError('CANCELLED')); request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => reject(new AgentError('BODY_TIMEOUT')), 10000);
  try {
    for (;;) {
      request.signal.throwIfAborted(); const part = await Promise.race([reader.read(), stop]); if (part.done) break;
      ensure(part.value instanceof Uint8Array, 'INVALID_JSON'); size += part.value.byteLength; ensure(size <= 65536, 'BODY_TOO_LARGE'); chunks.push(part.value);
    }
    const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { throw new AgentError('INVALID_JSON'); }
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
}
function refs(manifest: { video: AssetReference | null; cover: AssetReference | null; audio: AssetReference[]; subtitles: AssetReference[]; attachments: AssetReference[] }): AssetReference[] {
  return [manifest.video, manifest.cover, ...manifest.audio, ...manifest.subtitles, ...manifest.attachments].filter((v): v is AssetReference => v !== null);
}
function opaque(value: string): void { ensure(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)); }
/** Identity management never returns conversation grants, bodies, or provider-specific fields. */
function identityProfile(value: Profile): Profile {
  return { botId: value.botId, personaId: value.personaId, mode: value.mode, name: value.name, roleCore: value.roleCore };
}

/** Host facade only; no SDK, listener, account login, filesystem or credentials provider. */
export function createAgentApi(deps: AgentApiDependencies): (request: Request) => Promise<Response> {
  let serial = 0; const now = deps.now ?? Date.now;
  return async request => {
    try {
      request.signal.throwIfAborted(); const principal = await wait(() => deps.resolvePrincipal(request), request.signal); request.signal.throwIfAborted();
      if (principal === null) return failure('UNAUTHENTICATED', 401); text(principal);
      const before = accessSnapshot(await wait(() => deps.access(principal), request.signal)); request.signal.throwIfAborted();
      const usedBindings = new Set<string>();
      const recheck = async () => {
        request.signal.throwIfAborted(); const latest = accessSnapshot(await wait(() => deps.access(principal), request.signal)); request.signal.throwIfAborted();
        ensure(stable(latest) === stable(before), 'ACCESS_CHANGED');
        for (const key of usedBindings) readKey(key);
      };
      const manage = () => ensure(before.manage, 'ACCESS_DENIED');
      const review = () => { manage(); ensure(before.review, 'ACCESS_DENIED'); };
      const readKey = (key: string, body = false) => {
        text(key, 4096); ensure((body ? before.bodyKeys : before.readKeys).includes(key), 'ACCESS_DENIED');
        const binding = before.bindingRevisions?.[key]; ensure(binding !== undefined && Object.hasOwn(before.bindingRevisions!, key), 'ACCESS_DENIED');
        const current = deps.runtime.conversations().find(c => c.key === key);
        ensure(current && current.bindingRevision === binding && deps.runtime.ledger.getConversation(key)?.bindingRevision === binding, 'BINDING_CONFLICT');
        usedBindings.add(key);
      };
      const canRead = (key: string, body = false) => { try { readKey(key, body); return true; } catch { return false; } };
      const scope = (key: string) => {
        const item = deps.runtime.conversations().find(c => c.key === key); ensure(item, 'NOT_FOUND');
        ensure(deps.runtime.ledger.getConversation(key)?.bindingRevision === item.bindingRevision, 'BINDING_CONFLICT');
        const profile = deps.runtime.profile; return { botId: profile.botId, personaId: profile.personaId, scope: key };
      };
      const readService = () => new ConversationReadService(deps.runtime.ledger, async () => ({ revision: before.revision,
        grants: before.readKeys.filter(key => Object.hasOwn(before.bindingRevisions!, key)).map(key => ({ key, bindingRevision: before.bindingRevisions![key]!, metadata: true, body: before.bodyKeys.includes(key) })) }));
      const url = new URL(request.url); ensure(url.pathname.startsWith('/api/juebot/agent/'));
      const route = url.pathname.slice('/api/juebot/agent/'.length);
      const managerRoutes = ['creations', 'creation', 'review', 'submit', 'creation-recovery', 'reconcile', 'outbox', 'code', 'pause', 'learning', 'growth', 'identity', 'creation-start', 'creation-intention', 'summary-creation', 'bili-source'];
      if (managerRoutes.includes(route)) manage(); if (['review', 'submit', 'creation-recovery', 'reconcile', 'summary-creation'].includes(route)) review();
      if (route === 'media') ensure(before.manage || before.review, 'ACCESS_DENIED');
      const postRoutes = ['settings', 'memory', 'review', 'submit', 'creation-recovery', 'reconcile', 'pause', 'code', 'local-message', 'identity', 'learning', 'growth', 'creation-start', 'creation-intention', 'summary-creation', 'expression-preview', 'bili-source'];
      ensure(request.method === 'GET' || (request.method === 'POST' && postRoutes.includes(route)));
      let input: Record<string, unknown> | null = null;
      if (request.method === 'POST') {
        manage(); query(url, []); input = await json(request); await recheck();
      }
      let data: unknown;
      switch (route) {
        case 'status': {
          query(url, []); const p = deps.runtime.profile, pause = deps.runtime.outbox.state();
          data = { name: p.name, mode: p.mode, runtime: deps.runtime.modelConfigured ? 'configured' : 'offline', modelConfigured: deps.runtime.modelConfigured,
            paused: pause.paused, pauseRevision: pause.revision, codeEnabled: deps.code.snapshot().value.enabled,
            capabilities: ['conversation-ledger', 'source-scoped-memory', 'human-reviewed-creation', ...(deps.runtime.modelConfigured ? ['configured-model'] : [])] }; break;
        }
        case 'conversations': {
          const p = query(url, ['q', 'offset', 'limit']);
          const offset = p.has('offset') ? Number(p.get('offset')) : 0; integer(offset, 0, 128);
          if (p.has('offset')) ensure(/^(?:0|[1-9][0-9]*)$/u.test(p.get('offset')!));
          const limit = p.has('limit') ? positive(p.get('limit')!, 100) : 100;
          const term = (p.get('q') ?? '').normalize('NFKC').toLocaleLowerCase('en');
          const all = before.readKeys.length ? deps.runtime.conversations().filter(c => canRead(c.key)).map(c => ({ key: c.key, label: c.label,
            kind: c.identity.kind, connector: c.identity.connector, status: 'registered', synthetic: c.identity.connector === 'local-test' })) : [];
          const filtered = all.filter(c => !term || c.label.normalize('NFKC').toLocaleLowerCase('en').includes(term));
          data = { items: filtered.slice(offset, offset + limit), total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null }; break;
        }
        case 'trace': {
          const p = query(url, ['key'], ['key']); const key = p.get('key')!; readKey(key, true); data = deps.runtime.trace(key); break;
        }
        case 'expression-preview': {
          object(input, ['key', 'text', 'kind']); text(input.key, 4096); readKey(input.key, true); text(input.text, 16000);
          ensure(input.kind === 'social' || input.kind === 'repetition');
          data = deps.runtime.memory.checkExpression(input.key, input.text, input.kind); break;
        }
        case 'events': {
          const p = query(url, ['key', 'limit', 'cursor'], ['key']); const options = pageOptions(p); const key = p.get('key')!; readKey(key);
          data = await readService().events(principal, key, options); break;
        }
        case 'body': {
          const p = query(url, ['key', 'sequence'], ['key', 'sequence']); const sequence = positive(p.get('sequence')!); const key = p.get('key')!; readKey(key, true);
          const value = await readService().body(principal, key, sequence); data = { body: value.text }; break;
        }
        case 'settings': {
          let key: string | undefined;
          if (input) { object(input, ['key', 'expectedRevision', 'patch'], ['expectedRevision', 'patch']); integer(input.expectedRevision);
            if (input.key !== undefined) { text(input.key, 4096); key = input.key; readKey(key, true); }
            object(input.patch, ['mode', 'memoryMode', 'permissions', 'prompt', 'typing', 'expressionRules', 'styleContracts', 'participation', 'contactPolicy'], []);
            deps.runtime.memory.configure(input.expectedRevision, input.patch as PolicyPatch, key);
          } else { const p = query(url, ['key']); key = p.get('key') ?? undefined; if (key) readKey(key, true); else manage(); }
          const policy = deps.runtime.memory.readPolicy();
          data = { revision: policy.revision, canManage: before.manage, global: { mode: policy.value.mode, ...policy.value.global },
            local: key ? policy.value.locals[key] ?? null : null, effective: key ? deps.runtime.memory.effective(key) : policy.value.global }; break;
        }
        case 'memory': {
          let key: string;
          if (input) {
            if (input.action === 'revoke-source') {
              object(input, ['key', 'action', 'sourceId', 'expectedPolicyRevision', 'nextSourceRevision']);
              text(input.key, 4096); key = input.key; readKey(key, true);
              text(input.sourceId); integer(input.expectedPolicyRevision); integer(input.nextSourceRevision, 1);
              const current = deps.runtime.memory.readPolicy();
              const source = Object.hasOwn(current.value.sources, input.sourceId) ? current.value.sources[input.sourceId] : undefined;
              ensure(source && source.conversationKey === key, 'ACCESS_DENIED');
              deps.runtime.revokeSource(input.sourceId, input.expectedPolicyRevision, input.nextSourceRevision);
            } else {
              review(); object(input, ['key', 'action', 'id', 'expectedPolicyRevision', 'expectedMemoryRevision', 'reason', 'targets', 'purposes', 'expiresAt', 'text', 'includePrivate'],
                ['key', 'action', 'id', 'expectedPolicyRevision', 'expectedMemoryRevision', 'reason']);
              text(input.key, 4096); key = input.key; readKey(key, true); text(input.id); text(input.reason, 1000);
              integer(input.expectedPolicyRevision); integer(input.expectedMemoryRevision, 1);
              ensure(['share', 'unshare', 'correct', 'revoke'].includes(input.action as string));
              const current = deps.runtime.memory.readPolicy(); const item = current.value.memories[input.id];
              ensure(Object.hasOwn(current.value.memories, input.id) && item?.conversationKey === key, 'ACCESS_DENIED');
              if (input.targets !== undefined) { ensure(Array.isArray(input.targets) && input.targets.length <= 128); for (const target of input.targets) { text(target, 4096); readKey(target); } }
              const { key: ignoredKey, expectedPolicyRevision, ...fields } = input;
              deps.runtime.memory.reviewMemory(expectedPolicyRevision as number, { ...fields, principal } as Parameters<typeof deps.runtime.memory.reviewMemory>[1], now());
            }
          } else { const p = query(url, ['key'], ['key']); key = p.get('key')!; readKey(key, true); }
          const policy = deps.runtime.memory.readPolicy();
          data = { ...deps.runtime.memory.card(key, now()), policyRevision: policy.revision, canManageSources: before.manage, canReviewMemory: before.manage && before.review,
            reviews: (policy.value.memoryReviews ?? []).filter(item => policy.value.memories[item.id]?.conversationKey === key),
            sources: Object.values(policy.value.sources).filter(source => source.conversationKey === key).map(source => ({
              id: source.id, revision: source.revision, domain: source.domain, status: source.status, purposes: [...source.purposes], expiresAt: source.expiresAt })) };
          break;
        }
        case 'self': {
          const p = query(url, ['key'], ['key']); const key = p.get('key')!; readKey(key, true);
          data = deps.runtime.self.get(scope(key)); break;
        }
        case 'summary-creation': {
          object(input, ['key', 'memoryId', 'expectedMemoryRevision', 'expectedPolicyRevision', 'reason', 'expiresAt', 'includePrivate', 'request'],
            ['key', 'memoryId', 'expectedMemoryRevision', 'expectedPolicyRevision', 'reason', 'expiresAt', 'request']);
          text(input.key, 4096); readKey(input.key, true); text(input.memoryId); integer(input.expectedMemoryRevision, 1); integer(input.expectedPolicyRevision); text(input.reason, 1000); integer(input.expiresAt);
          ensure(input.includePrivate === undefined || typeof input.includePrivate === 'boolean');
          object(input.request, ['action', 'accountId', 'target']);
          const current = deps.runtime.memory.readPolicy().value.memories[input.memoryId];
          ensure(current && current.conversationKey === input.key, 'ACCESS_DENIED');
          ensure(deps.prepareSummaryCreation, 'NOT_CONFIGURED'); const { key, ...fields } = input;
          data = await wait(() => deps.prepareSummaryCreation!(key as string, fields, principal, recheck), request.signal); break;
        }
        case 'creation-intention': {
          object(input, ['key', 'topic']); text(input.key, 4096); text(input.topic, 128); readKey(input.key, true);
          ensure(deps.prepareCreationIntention, 'NOT_CONFIGURED');
          const { key, topic } = input; data = await wait(() => deps.prepareCreationIntention!(key as string, topic as string, principal, recheck), request.signal); break;
        }
        case 'creation-start': {
          object(input, ['key', 'intentionId', 'action', 'accountId', 'target']); text(input.key, 4096); text(input.intentionId); readKey(input.key, true);
          ensure(deps.startCreation, 'NOT_CONFIGURED'); text(input.accountId, 128);
          object(input.target, ['objectId', 'parentId', 'visibility', 'category']);
          ensure(['qqspace', 'bili.comment', 'bili.reply', 'bili.dynamic', 'bili.video'].includes(input.action as string));
          for (const field of ['objectId', 'parentId', 'category']) if (input.target[field] !== null) text(input.target[field], 256); text(input.target.visibility, 256);
          const { key, intentionId, action, accountId, target } = input;
          data = await wait(() => deps.startCreation!(key as string, intentionId as string, { action, accountId, target } as unknown as CreativeRequest, principal, recheck), request.signal); break;
        }
        case 'bili-source': {
          ensure(deps.biliSources, 'NOT_CONFIGURED');
          if (!input) { const p = query(url, ['id', 'revision'], ['id']); data = synchronous(deps.biliSources.read(p.get('id')!, p.has('revision') ? positive(p.get('revision')!) : undefined, principal)); }
          else if (input.action === 'capture') {
            object(input, ['action', 'id', 'expectedRevision', 'request']); text(input.id); integer(input.expectedRevision); object(input.request, ['account', 'bvid', 'page', 'limit', 'sort'], ['account', 'bvid']);
            const { action, ...fields } = input; data = await wait(() => deps.biliSources!.capture(fields, principal, recheck), request.signal);
          } else if (input.action === 'revoke') {
            review(); object(input, ['action', 'id', 'expectedRevision']); text(input.id); integer(input.expectedRevision, 1);
            data = synchronous(deps.biliSources.revoke({ id: input.id, expectedRevision: input.expectedRevision }, principal));
          } else {
            object(input, ['action', 'key', 'id', 'revision', 'itemId', 'proposalId'], ['action', 'key', 'id', 'revision', 'itemId', 'proposalId']);
            ensure(input.action === 'learning'); text(input.key, 4096); readKey(input.key, true); text(input.id); integer(input.revision, 1); text(input.itemId); text(input.proposalId);
            const { action, ...fields } = input; data = synchronous(deps.biliSources.learning(fields, principal));
          }
          break;
        }
        case 'creations': query(url, []); data = { items: deps.creation.list() }; break;
        case 'creation': {
          const p = query(url, ['id'], ['id']); const value = deps.creation.read(p.get('id')!); ensure(value, 'NOT_FOUND');
          const assetKinds: Record<string, string> = {};
          if (value.value.final) for (const reference of refs(value.value.final.manifest)) {
            opaque(reference.previewRef); const actual = deps.assets?.resolve(reference.ref);
            ensure(actual && actual.ready === true && actual.ref === reference.ref && actual.previewRef === reference.previewRef && actual.sha256 === reference.sha256, 'ASSET_CHANGED');
            assetKinds[reference.previewRef] = actual.kind;
          }
          data = { ...value, assetKinds, recoveryAudit: deps.creation.recoveryAudit(value.value.id) }; break;
        }
        case 'review': {
          object(input, ['id', 'expectedRevision', 'action', 'expiresAt', 'reason'], ['id', 'expectedRevision', 'action']);
          text(input.id); integer(input.expectedRevision);
          if (input.action === 'approve') { integer(input.expiresAt); ensure(input.reason === undefined); data = deps.creation.approve(input.id, input.expectedRevision, principal, input.expiresAt); }
          else { ensure(input.action === 'reject' || input.action === 'changes'); text(input.reason, 4000); ensure(input.expiresAt === undefined);
            data = input.action === 'reject' ? deps.creation.reject(input.id, input.expectedRevision, principal, input.reason) : deps.creation.requestChanges(input.id, input.expectedRevision, principal, input.reason); }
          break;
        }
        case 'submit': object(input, ['id', 'expectedRevision']); text(input.id); integer(input.expectedRevision); data = synchronous(deps.submitCreation(input.id, input.expectedRevision)); break;
        case 'creation-recovery': {
          ensure(input !== null, 'INVALID_INPUT'); object(input, ['id', 'expectedRevision', 'action', 'reason']);
          text(input.id); integer(input.expectedRevision); text(input.reason, 4000);
          ensure(input.action === 'recover' || input.action === 'abandon');
          if (input.action === 'abandon') data = deps.creation.abandonWorkflow(input.id, input.expectedRevision, principal, input.reason);
          else {
            ensure(deps.recoverCreation, 'NOT_CONFIGURED');
            const { id, expectedRevision, reason } = input;
            data = await wait(() => deps.recoverCreation!(id as string, expectedRevision as number, principal, reason as string, recheck), request.signal);
          }
          break;
        }
        case 'reconcile': {
          ensure(input !== null, 'INVALID_INPUT'); object(input, ['id', 'expectedRevision']); text(input.id); integer(input.expectedRevision);
          ensure(deps.reconcileDelivery, 'NOT_CONFIGURED');
          const item = deps.runtime.outbox.list().find(candidate => candidate.id === input.id); ensure(item, 'NOT_FOUND');
          let visible = canRead(item.conversation);
          if (!visible && item.kind === 'creation' && item.payload && typeof item.payload === 'object') {
            const workId = (item.payload as { workId?: unknown }).workId;
            if (typeof workId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(workId)) visible = deps.creation.read(workId)?.value.submission?.intentId === item.id;
          }
          ensure(visible, 'ACCESS_DENIED'); ensure(item.status === 'unknown', 'RECONCILIATION_NOT_ALLOWED');
          const { id, expectedRevision } = input;
          data = await wait(() => deps.reconcileDelivery!(id as string, expectedRevision as number, principal, recheck), request.signal);
          break;
        }
        case 'pause': object(input, ['expectedRevision', 'paused']); integer(input.expectedRevision); ensure(typeof input.paused === 'boolean'); deps.runtime.outbox.setPause(input.expectedRevision, input.paused); data = deps.runtime.outbox.state(); break;
        case 'outbox': {
          query(url, []);
          data = { revision: deps.runtime.outbox.state().revision, items: deps.runtime.outbox.list().filter(item => {
            if (canRead(item.conversation)) return true;
            if (item.kind !== 'creation' || !item.payload || typeof item.payload !== 'object') return false;
            const workId = (item.payload as { workId?: unknown }).workId;
            if (typeof workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(workId)) return false;
            const work = deps.creation.read(workId); return work?.value.submission?.intentId === item.id;
          }).map(item => ({ id: item.id, sequence: item.sequence, kind: item.kind,
            conversation: item.conversation, status: item.status, dueAt: item.dueAt, reason: /^[A-Z][A-Z0-9_]{0,79}$/u.test(item.reason) ? item.reason : 'UNAVAILABLE' })) }; break;
        }
        case 'code': {
          if (input) { object(input, ['enabled']); ensure(typeof input.enabled === 'boolean'); if (input.enabled) deps.code.enable(now()); else deps.code.disable(now()); } else query(url, []);
          data = { enabled: deps.code.snapshot().value.enabled, tasks: deps.code.list().filter(task => canRead(task.input.conversationKey)).map(task => ({ id: task.id, state: task.state,
            resultDelivery: task.resultDelivery, createdAt: task.createdAt, updatedAt: task.updatedAt, reason: /^[A-Z][A-Z0-9_]{0,79}$/u.test(task.reason) ? task.reason : 'UNAVAILABLE' })) }; break;
        }
        case 'identity': {
          ensure(deps.identity, 'IDENTITY_PROVIDER_MISSING');
          if (input) { object(input, ['expectedRevision', 'profile']); integer(input.expectedRevision); object(input.profile, ['botId', 'personaId', 'name', 'mode', 'roleCore']);
            synchronous(deps.identity.write(input.expectedRevision, input.profile as unknown as Profile)); } else query(url, []);
          const current = deps.identity.read();
          data = { revision: current.revision, profile: identityProfile(current.profile), ...(current.profiles ? { profiles: {
            ...(current.profiles.juejue ? { juejue: identityProfile(current.profiles.juejue) } : {}),
            ...(current.profiles.persona ? { persona: identityProfile(current.profiles.persona) } : {}),
          } } : {}) }; break;
        }
        case 'learning': {
          if (input) { object(input, ['id', 'accepted']); text(input.id); ensure(typeof input.accepted === 'boolean');
            const item = deps.runtime.learning().find(p => p.id === input.id); ensure(item, 'NOT_FOUND'); readKey(item.key, true); deps.runtime.reviewLearning(input.id, input.accepted, principal); } else query(url, []);
          data = { items: before.bodyKeys.length ? deps.runtime.learning().filter(p => canRead(p.key, true)).map(p => ({ id: p.id, key: p.key, text: p.text, kind: p.kind, status: p.status, sourceId: p.sourceId })) : [] }; break;
        }
        case 'growth': {
          if (!input) { const p = query(url, ['key']); const key = p.get('key');
            if (!key) data = { items: [], requiresConversation: true }; else { readKey(key, true); data = { ...deps.runtime.self.get(scope(key)), ...(deps.runtime.self.listGrowth?.(scope(key)) ?? {}), evaluatorConfigured: typeof deps.evaluateGrowth === 'function' }; } break; }
          text(input.key, 4096); readKey(input.key, true); const s = scope(input.key); const command = input.command;
          if (command === 'propose') { object(input, ['key', 'command', 'id', 'adaptation', 'sources']); text(input.id); data = deps.runtime.self.propose(s, { id: input.id, adaptation: input.adaptation as Adaptation, sources: input.sources as SourceRef[] }); }
          else if (command === 'freeze') { object(input, ['key', 'command', 'suite']); data = deps.runtime.self.freezeSuite(s, input.suite as EvalSuite); }
          else if (command === 'evaluate') { object(input, ['key', 'command', 'id', 'expectedRevision']); text(input.id); integer(input.expectedRevision); ensure(deps.evaluateGrowth, 'NOT_CONFIGURED'); data = await wait(() => deps.evaluateGrowth!({ key: input!.key as string, id: input!.id as string, expectedRevision: input!.expectedRevision as number }, principal, recheck), request.signal); }
          else if (command === 'review') { review(); object(input, ['key', 'command', 'id', 'expectedRevision', 'accepted']); text(input.id); integer(input.expectedRevision); ensure(typeof input.accepted === 'boolean'); data = deps.runtime.self.review(s, input.id, input.expectedRevision, { reviewer: principal, human: true, approve: input.accepted }); }
          else if (command === 'activate') { review(); object(input, ['key', 'command', 'id', 'expectedCandidateRevision', 'expectedStateRevision']); text(input.id); integer(input.expectedCandidateRevision); integer(input.expectedStateRevision); data = deps.runtime.self.activate(s, input.id, input.expectedCandidateRevision, input.expectedStateRevision); }
          else if (command === 'restore') { review(); object(input, ['key', 'command', 'version', 'expectedStateRevision']); text(input.version); integer(input.expectedStateRevision); data = deps.runtime.self.restore(s, input.version, input.expectedStateRevision, { reviewer: principal, human: true }); }
          else throw new AgentError('INVALID_INPUT'); break;
        }
        case 'local-message': {
          object(input, ['key', 'text']); text(input.key, 4096); text(input.text, 16000); readKey(input.key, true);
          const c = deps.runtime.conversations().find(c => c.key === input.key); ensure(c?.identity.connector === 'local-test', 'ACCESS_DENIED');
          ensure(deps.runtime.modelConfigured, 'MODEL_NOT_CONFIGURED'); const time = now(); integer(time); integer(serial, 0, Number.MAX_SAFE_INTEGER - 1);
          const local = { key: input.key, bindingRevision: c.bindingRevision, eventId: `local-${time}-${++serial}`, actor: principal, actorKind: 'human' as const, plain: true, text: input.text, observedAt: time };
          data = await wait(() => deps.runtime.receive(local), request.signal); break;
        }
        case 'media': {
          const p = query(url, ['ref'], ['ref']); const previewRef = p.get('ref')!; opaque(previewRef); ensure(deps.assets, 'ASSET_PROVIDER_MISSING');
          const matching: AssetReference[] = [];
          for (const item of deps.creation.list(100)) { const work = deps.creation.read(item.id)?.value; if (work?.final) matching.push(...refs(work.final.manifest).filter(reference => reference.previewRef === previewRef)); }
          ensure(matching.length, 'ACCESS_DENIED'); const resolved = deps.assets.read(previewRef);
          ensure(resolved.bytes instanceof Uint8Array && resolved.asset.ready && resolved.asset.previewRef === previewRef, 'ASSET_CHANGED');
          ensure(matching.some(reference => reference.ref === resolved.asset.ref && reference.sha256 === resolved.asset.sha256), 'ASSET_CHANGED');
          const mime = resolved.mime.split(';')[0]!.trim().toLowerCase(); const types: Record<TrustedAsset['kind'], string[]> = { video: ['video/mp4', 'video/webm'], audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'], image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], subtitles: ['text/vtt'] };
          ensure(types[resolved.asset.kind]?.includes(mime), 'ASSET_CHANGED'); const bytes = new Uint8Array(resolved.bytes);
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); const actualHash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
          ensure(actualHash === resolved.asset.sha256, 'ASSET_CHANGED'); await recheck();
          return new Response(bytes, { headers: { ...HEADERS, 'content-type': mime, 'content-length': String(bytes.byteLength), 'content-security-policy': "default-src 'none'; sandbox" } });
        }
        default: return failure('NOT_FOUND', 404);
      }
      if (route === 'identity' && input !== null) {
        // The synchronous, strictly authorized write can switch the active persona and
        // therefore its stream keys. Only the identity projection is returned here;
        // verify current management authority rather than requiring obsolete grants.
        request.signal.throwIfAborted();
        const latest = accessSnapshot(await wait(() => deps.access(principal), request.signal));
        request.signal.throwIfAborted(); ensure(latest.manage, 'ACCESS_CHANGED');
      } else await recheck();
      return response(data);
    } catch (error) { request.signal.throwIfAborted(); return errorResponse(error); }
  };
}
