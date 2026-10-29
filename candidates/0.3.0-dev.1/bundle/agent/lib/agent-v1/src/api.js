import { AgentError, ensure, integer, stable, text } from "./common.js";
import { ConversationError } from "../../conversation-v1/src/contracts.js";
import { ConversationReadService } from "../../conversation-v1/src/read-service.js";
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const encodedSize = (value) => new TextEncoder().encode(value).byteLength;
async function wait(operation, signal) {
    signal.throwIfAborted();
    let reject;
    const stopped = new Promise((_, no) => { reject = no; });
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
        return await Promise.race([operation(), stopped]);
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
function object(value, allowed, required = allowed) {
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
    ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    ensure(Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key)));
    ensure(required.every(key => Object.hasOwn(value, key)));
    ensure(Object.values(Object.getOwnPropertyDescriptors(value)).every(d => !d.get && !d.set));
}
function accessSnapshot(value) {
    object(value, ['revision', 'readKeys', 'bodyKeys', 'manage', 'review', 'bindingRevisions'], ['revision', 'readKeys', 'bodyKeys', 'manage', 'review']);
    integer(value.revision);
    ensure(typeof value.manage === 'boolean' && typeof value.review === 'boolean');
    for (const list of [value.readKeys, value.bodyKeys]) {
        ensure(Array.isArray(list) && list.length <= 128 && new Set(list).size === list.length);
        for (const key of list)
            text(key, 4096);
    }
    ensure(value.bodyKeys.every(key => value.readKeys.includes(key)));
    const bindings = Object.create(null);
    if (value.bindingRevisions !== undefined) {
        object(value.bindingRevisions, value.readKeys, []);
        for (const [key, revision] of Object.entries(value.bindingRevisions)) {
            integer(revision, 1);
            bindings[key] = revision;
        }
    }
    return { revision: value.revision, readKeys: [...value.readKeys].sort(), bodyKeys: [...value.bodyKeys].sort(), manage: value.manage, review: value.review, bindingRevisions: bindings };
}
function query(url, allowed, required = []) {
    ensure(encodedSize(url.search) <= 32768);
    const seen = new Set();
    for (const key of url.searchParams.keys()) {
        ensure(allowed.includes(key) && !seen.has(key));
        seen.add(key);
    }
    ensure(required.every(key => seen.has(key)));
    for (const [key, value] of url.searchParams) {
        text(value, key === 'cursor' ? 8192 : key === 'key' ? 4096 : 256);
        ensure(!/[\u0000-\u001f\u007f]/u.test(value));
        if (key === 'cursor')
            ensure(encodedSize(value) <= 8192);
    }
    return url.searchParams;
}
function positive(value, maximum = Number.MAX_SAFE_INTEGER) { ensure(/^[1-9][0-9]*$/u.test(value)); const n = Number(value); integer(n, 1, maximum); return n; }
function pageOptions(params) {
    const result = {};
    if (params.has('limit'))
        result.limit = positive(params.get('limit'), 100);
    if (params.has('cursor'))
        result.cursor = params.get('cursor');
    return result;
}
function response(data) { return new Response(JSON.stringify({ ok: true, data }), { headers: HEADERS }); }
function synchronous(value) {
    ensure(!value || typeof value.then !== 'function', 'ASYNC_OPERATION_UNSUPPORTED');
    return value;
}
function failure(code, status) { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: HEADERS }); }
function errorResponse(error) {
    const code = error instanceof AgentError || error instanceof ConversationError ? error.code : 'AGENT_OPERATION_FAILED';
    if (['ACCESS_DENIED', 'ACCESS_CHANGED', 'CREATION_HUMAN_REQUIRED', 'UNTRUSTED_INGRESS'].includes(code))
        return failure(code, 403);
    if (['CONFLICT', 'REVISION_CONFLICT', 'BINDING_CONFLICT', 'EVENT_CONFLICT', 'SOURCE_CONFLICT', 'CREATION_REVISION_CONFLICT'].includes(code))
        return failure(code, 409);
    if (['NOT_FOUND', 'CONVERSATION_NOT_FOUND', 'SOURCE_NOT_FOUND', 'CREATION_NOT_FOUND', 'CODE_TASK_NOT_FOUND'].includes(code))
        return failure(code, 404);
    if (['INVALID_INPUT', 'INVALID_CURSOR', 'CREATION_INVALID_INPUT', 'INVALID_CLOCK', 'BODY_TOO_LARGE', 'INVALID_JSON', 'INVALID_CONTENT_TYPE', 'BODY_TIMEOUT'].includes(code))
        return failure(code, 400);
    return failure('AGENT_OPERATION_FAILED', 503);
}
/** Bounded JSON; no client actor/role/approval field is an authority source. */
async function json(request) {
    ensure(/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('content-type') ?? ''), 'INVALID_CONTENT_TYPE');
    ensure(!request.headers.has('content-encoding') || request.headers.get('content-encoding') === 'identity', 'INVALID_CONTENT_TYPE');
    const length = request.headers.get('content-length');
    ensure(length === null || (/^\d+$/u.test(length) && Number(length) <= 65536), 'BODY_TOO_LARGE');
    ensure(request.body, 'INVALID_JSON');
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    let reject;
    const stop = new Promise((_, no) => { reject = no; });
    const abort = () => reject(new AgentError('CANCELLED'));
    request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => reject(new AgentError('BODY_TIMEOUT')), 10000);
    try {
        for (;;) {
            request.signal.throwIfAborted();
            const part = await Promise.race([reader.read(), stop]);
            if (part.done)
                break;
            ensure(part.value instanceof Uint8Array, 'INVALID_JSON');
            size += part.value.byteLength;
            ensure(size <= 65536, 'BODY_TOO_LARGE');
            chunks.push(part.value);
        }
        const all = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.byteLength;
        }
        let value;
        try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
        }
        catch {
            throw new AgentError('INVALID_JSON');
        }
        ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
        return value;
    }
    finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => { });
        try {
            reader.releaseLock();
        }
        catch { }
    }
}
function refs(manifest) {
    return [manifest.video, manifest.cover, ...manifest.audio, ...manifest.subtitles, ...manifest.attachments].filter((v) => v !== null);
}
function opaque(value) { ensure(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)); }
/** Host facade only; no SDK, listener, account login, filesystem or credentials provider. */
export function createAgentApi(deps) {
    let serial = 0;
    const now = deps.now ?? Date.now;
    return async (request) => {
        try {
            request.signal.throwIfAborted();
            const principal = await wait(() => deps.resolvePrincipal(request), request.signal);
            request.signal.throwIfAborted();
            if (principal === null)
                return failure('UNAUTHENTICATED', 401);
            text(principal);
            const before = accessSnapshot(await wait(() => deps.access(principal), request.signal));
            request.signal.throwIfAborted();
            const usedBindings = new Set();
            const recheck = async () => {
                request.signal.throwIfAborted();
                const latest = accessSnapshot(await wait(() => deps.access(principal), request.signal));
                request.signal.throwIfAborted();
                ensure(stable(latest) === stable(before), 'ACCESS_CHANGED');
                for (const key of usedBindings)
                    readKey(key);
            };
            const manage = () => ensure(before.manage, 'ACCESS_DENIED');
            const review = () => { manage(); ensure(before.review, 'ACCESS_DENIED'); };
            const readKey = (key, body = false) => {
                text(key, 4096);
                ensure((body ? before.bodyKeys : before.readKeys).includes(key), 'ACCESS_DENIED');
                const binding = before.bindingRevisions?.[key];
                ensure(binding !== undefined && Object.hasOwn(before.bindingRevisions, key), 'ACCESS_DENIED');
                const current = deps.runtime.conversations().find(c => c.key === key);
                ensure(current && current.bindingRevision === binding && deps.runtime.ledger.getConversation(key)?.bindingRevision === binding, 'BINDING_CONFLICT');
                usedBindings.add(key);
            };
            const canRead = (key, body = false) => { try {
                readKey(key, body);
                return true;
            }
            catch {
                return false;
            } };
            const scope = (key) => {
                const item = deps.runtime.conversations().find(c => c.key === key);
                ensure(item, 'NOT_FOUND');
                ensure(deps.runtime.ledger.getConversation(key)?.bindingRevision === item.bindingRevision, 'BINDING_CONFLICT');
                const profile = deps.runtime.profile;
                return { botId: profile.botId, personaId: profile.personaId, scope: key };
            };
            const readService = () => new ConversationReadService(deps.runtime.ledger, async () => ({ revision: before.revision,
                grants: before.readKeys.filter(key => Object.hasOwn(before.bindingRevisions, key)).map(key => ({ key, bindingRevision: before.bindingRevisions[key], metadata: true, body: before.bodyKeys.includes(key) })) }));
            const url = new URL(request.url);
            ensure(url.pathname.startsWith('/api/juebot/agent/'));
            const route = url.pathname.slice('/api/juebot/agent/'.length);
            const managerRoutes = ['creations', 'creation', 'review', 'submit', 'outbox', 'code', 'pause', 'learning', 'growth', 'identity'];
            if (managerRoutes.includes(route))
                manage();
            if (route === 'review' || route === 'submit')
                review();
            if (route === 'media')
                ensure(before.manage || before.review, 'ACCESS_DENIED');
            const postRoutes = ['settings', 'memory', 'review', 'submit', 'pause', 'code', 'local-message', 'identity', 'learning', 'growth'];
            ensure(request.method === 'GET' || (request.method === 'POST' && postRoutes.includes(route)));
            let input = null;
            if (request.method === 'POST') {
                manage();
                query(url, []);
                input = await json(request);
                await recheck();
            }
            let data;
            switch (route) {
                case 'status': {
                    query(url, []);
                    const p = deps.runtime.profile, pause = deps.runtime.outbox.state();
                    data = { name: p.name, mode: p.mode, runtime: deps.runtime.modelConfigured ? 'configured' : 'offline', modelConfigured: deps.runtime.modelConfigured,
                        paused: pause.paused, pauseRevision: pause.revision, codeEnabled: deps.code.snapshot().value.enabled,
                        capabilities: ['conversation-ledger', 'source-scoped-memory', 'human-reviewed-creation', ...(deps.runtime.modelConfigured ? ['configured-model'] : [])] };
                    break;
                }
                case 'conversations': {
                    query(url, []);
                    // No catalogue read at all when the caller has no authorized streams.
                    data = { items: before.readKeys.length ? deps.runtime.conversations().filter(c => canRead(c.key)).map(c => ({ key: c.key, label: c.label,
                            kind: c.identity.kind, connector: c.identity.connector, status: 'registered', synthetic: c.identity.connector === 'local-test' })) : [] };
                    break;
                }
                case 'events': {
                    const p = query(url, ['key', 'limit', 'cursor'], ['key']);
                    const options = pageOptions(p);
                    const key = p.get('key');
                    readKey(key);
                    data = await readService().events(principal, key, options);
                    break;
                }
                case 'body': {
                    const p = query(url, ['key', 'sequence'], ['key', 'sequence']);
                    const sequence = positive(p.get('sequence'));
                    const key = p.get('key');
                    readKey(key, true);
                    const value = await readService().body(principal, key, sequence);
                    data = { body: value.text };
                    break;
                }
                case 'settings': {
                    let key;
                    if (input) {
                        object(input, ['key', 'expectedRevision', 'patch'], ['expectedRevision', 'patch']);
                        integer(input.expectedRevision);
                        if (input.key !== undefined) {
                            text(input.key, 4096);
                            key = input.key;
                            readKey(key, true);
                        }
                        object(input.patch, ['mode', 'memoryMode', 'permissions', 'prompt', 'typing', 'expressionRules', 'styleContracts', 'participation'], []);
                        deps.runtime.memory.configure(input.expectedRevision, input.patch, key);
                    }
                    else {
                        const p = query(url, ['key']);
                        key = p.get('key') ?? undefined;
                        if (key)
                            readKey(key, true);
                        else
                            manage();
                    }
                    const policy = deps.runtime.memory.readPolicy();
                    data = { revision: policy.revision, canManage: before.manage, global: { mode: policy.value.mode, ...policy.value.global },
                        local: key ? policy.value.locals[key] ?? null : null, effective: key ? deps.runtime.memory.effective(key) : policy.value.global };
                    break;
                }
                case 'memory': {
                    let key;
                    if (input) {
                        object(input, ['key', 'action', 'sourceId', 'expectedPolicyRevision', 'nextSourceRevision']);
                        text(input.key, 4096);
                        key = input.key;
                        readKey(key, true);
                        ensure(input.action === 'revoke-source');
                        text(input.sourceId);
                        integer(input.expectedPolicyRevision);
                        integer(input.nextSourceRevision, 1);
                        const current = deps.runtime.memory.readPolicy();
                        const source = Object.hasOwn(current.value.sources, input.sourceId) ? current.value.sources[input.sourceId] : undefined;
                        ensure(source && source.conversationKey === key, 'ACCESS_DENIED');
                        deps.runtime.revokeSource(input.sourceId, input.expectedPolicyRevision, input.nextSourceRevision);
                    }
                    else {
                        const p = query(url, ['key'], ['key']);
                        key = p.get('key');
                        readKey(key, true);
                    }
                    const policy = deps.runtime.memory.readPolicy();
                    data = { ...deps.runtime.memory.card(key, now()), policyRevision: policy.revision, canManageSources: before.manage,
                        sources: Object.values(policy.value.sources).filter(source => source.conversationKey === key).map(source => ({
                            id: source.id, revision: source.revision, domain: source.domain, status: source.status, purposes: [...source.purposes], expiresAt: source.expiresAt
                        })) };
                    break;
                }
                case 'self': {
                    const p = query(url, ['key'], ['key']);
                    const key = p.get('key');
                    readKey(key, true);
                    data = deps.runtime.self.get(scope(key));
                    break;
                }
                case 'creations':
                    query(url, []);
                    data = { items: deps.creation.list() };
                    break;
                case 'creation': {
                    const p = query(url, ['id'], ['id']);
                    const value = deps.creation.read(p.get('id'));
                    ensure(value, 'NOT_FOUND');
                    const assetKinds = {};
                    if (value.value.final)
                        for (const reference of refs(value.value.final.manifest)) {
                            opaque(reference.previewRef);
                            const actual = deps.assets?.resolve(reference.ref);
                            ensure(actual && actual.ready === true && actual.ref === reference.ref && actual.previewRef === reference.previewRef && actual.sha256 === reference.sha256, 'ASSET_CHANGED');
                            assetKinds[reference.previewRef] = actual.kind;
                        }
                    data = { ...value, assetKinds };
                    break;
                }
                case 'review': {
                    object(input, ['id', 'expectedRevision', 'action', 'expiresAt', 'reason'], ['id', 'expectedRevision', 'action']);
                    text(input.id);
                    integer(input.expectedRevision);
                    if (input.action === 'approve') {
                        integer(input.expiresAt);
                        ensure(input.reason === undefined);
                        data = deps.creation.approve(input.id, input.expectedRevision, principal, input.expiresAt);
                    }
                    else {
                        ensure(input.action === 'reject' || input.action === 'changes');
                        text(input.reason, 4000);
                        ensure(input.expiresAt === undefined);
                        data = input.action === 'reject' ? deps.creation.reject(input.id, input.expectedRevision, principal, input.reason) : deps.creation.requestChanges(input.id, input.expectedRevision, principal, input.reason);
                    }
                    break;
                }
                case 'submit':
                    object(input, ['id', 'expectedRevision']);
                    text(input.id);
                    integer(input.expectedRevision);
                    data = synchronous(deps.submitCreation(input.id, input.expectedRevision));
                    break;
                case 'pause':
                    object(input, ['expectedRevision', 'paused']);
                    integer(input.expectedRevision);
                    ensure(typeof input.paused === 'boolean');
                    deps.runtime.outbox.setPause(input.expectedRevision, input.paused);
                    data = deps.runtime.outbox.state();
                    break;
                case 'outbox': {
                    query(url, []);
                    data = { items: deps.runtime.outbox.list().filter(item => {
                            if (canRead(item.conversation))
                                return true;
                            if (item.kind !== 'creation' || !item.payload || typeof item.payload !== 'object')
                                return false;
                            const workId = item.payload.workId;
                            if (typeof workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(workId))
                                return false;
                            const work = deps.creation.read(workId);
                            return work?.value.submission?.intentId === item.id;
                        }).map(item => ({ id: item.id, sequence: item.sequence, kind: item.kind,
                            conversation: item.conversation, status: item.status, dueAt: item.dueAt, reason: /^[A-Z][A-Z0-9_]{0,79}$/u.test(item.reason) ? item.reason : 'UNAVAILABLE' })) };
                    break;
                }
                case 'code': {
                    if (input) {
                        object(input, ['enabled']);
                        ensure(typeof input.enabled === 'boolean');
                        if (input.enabled)
                            deps.code.enable(now());
                        else
                            deps.code.disable(now());
                    }
                    else
                        query(url, []);
                    data = { enabled: deps.code.snapshot().value.enabled, tasks: deps.code.list().filter(task => canRead(task.input.conversationKey)).map(task => ({ id: task.id, state: task.state,
                            resultDelivery: task.resultDelivery, createdAt: task.createdAt, updatedAt: task.updatedAt, reason: /^[A-Z][A-Z0-9_]{0,79}$/u.test(task.reason) ? task.reason : 'UNAVAILABLE' })) };
                    break;
                }
                case 'identity': {
                    ensure(deps.identity, 'IDENTITY_PROVIDER_MISSING');
                    if (input) {
                        object(input, ['expectedRevision', 'profile']);
                        integer(input.expectedRevision);
                        object(input.profile, ['botId', 'personaId', 'name', 'mode', 'roleCore']);
                        synchronous(deps.identity.write(input.expectedRevision, input.profile));
                    }
                    else
                        query(url, []);
                    data = deps.identity.read();
                    break;
                }
                case 'learning': {
                    if (input) {
                        object(input, ['id', 'accepted']);
                        text(input.id);
                        ensure(typeof input.accepted === 'boolean');
                        const item = deps.runtime.learning().find(p => p.id === input.id);
                        ensure(item, 'NOT_FOUND');
                        readKey(item.key, true);
                        deps.runtime.reviewLearning(input.id, input.accepted, principal);
                    }
                    else
                        query(url, []);
                    data = { items: before.bodyKeys.length ? deps.runtime.learning().filter(p => canRead(p.key, true)).map(p => ({ id: p.id, key: p.key, text: p.text, kind: p.kind, status: p.status, sourceId: p.sourceId })) : [] };
                    break;
                }
                case 'growth': {
                    if (!input) {
                        const p = query(url, ['key']);
                        const key = p.get('key');
                        if (!key)
                            data = { items: [], requiresConversation: true };
                        else {
                            readKey(key, true);
                            data = deps.runtime.self.get(scope(key));
                        }
                        break;
                    }
                    text(input.key, 4096);
                    readKey(input.key, true);
                    const s = scope(input.key);
                    const command = input.command;
                    if (command === 'propose') {
                        object(input, ['key', 'command', 'id', 'adaptation', 'sources']);
                        text(input.id);
                        data = deps.runtime.self.propose(s, { id: input.id, adaptation: input.adaptation, sources: input.sources });
                    }
                    else if (command === 'freeze') {
                        object(input, ['key', 'command', 'suite']);
                        data = deps.runtime.self.freezeSuite(s, input.suite);
                    }
                    else if (command === 'evaluate') {
                        object(input, ['key', 'command', 'id', 'expectedRevision', 'evaluation']);
                        text(input.id);
                        integer(input.expectedRevision);
                        data = deps.runtime.self.evaluate(s, input.id, input.expectedRevision, input.evaluation);
                    }
                    else if (command === 'review') {
                        review();
                        object(input, ['key', 'command', 'id', 'expectedRevision', 'accepted']);
                        text(input.id);
                        integer(input.expectedRevision);
                        ensure(typeof input.accepted === 'boolean');
                        data = deps.runtime.self.review(s, input.id, input.expectedRevision, { reviewer: principal, human: true, approve: input.accepted });
                    }
                    else if (command === 'activate') {
                        review();
                        object(input, ['key', 'command', 'id', 'expectedCandidateRevision', 'expectedStateRevision']);
                        text(input.id);
                        integer(input.expectedCandidateRevision);
                        integer(input.expectedStateRevision);
                        data = deps.runtime.self.activate(s, input.id, input.expectedCandidateRevision, input.expectedStateRevision);
                    }
                    else if (command === 'restore') {
                        review();
                        object(input, ['key', 'command', 'version', 'expectedStateRevision']);
                        text(input.version);
                        integer(input.expectedStateRevision);
                        data = deps.runtime.self.restore(s, input.version, input.expectedStateRevision, { reviewer: principal, human: true });
                    }
                    else
                        throw new AgentError('INVALID_INPUT');
                    break;
                }
                case 'local-message': {
                    object(input, ['key', 'text']);
                    text(input.key, 4096);
                    text(input.text, 16000);
                    readKey(input.key, true);
                    const c = deps.runtime.conversations().find(c => c.key === input.key);
                    ensure(c?.identity.connector === 'local-test', 'ACCESS_DENIED');
                    ensure(deps.runtime.modelConfigured, 'MODEL_NOT_CONFIGURED');
                    const time = now();
                    integer(time);
                    integer(serial, 0, Number.MAX_SAFE_INTEGER - 1);
                    const local = { key: input.key, bindingRevision: c.bindingRevision, eventId: `local-${time}-${++serial}`, actor: principal, actorKind: 'human', plain: true, text: input.text, observedAt: time };
                    data = await wait(() => deps.runtime.receive(local), request.signal);
                    break;
                }
                case 'media': {
                    const p = query(url, ['ref'], ['ref']);
                    const previewRef = p.get('ref');
                    opaque(previewRef);
                    ensure(deps.assets, 'ASSET_PROVIDER_MISSING');
                    const matching = [];
                    for (const item of deps.creation.list(100)) {
                        const work = deps.creation.read(item.id)?.value;
                        if (work?.final)
                            matching.push(...refs(work.final.manifest).filter(reference => reference.previewRef === previewRef));
                    }
                    ensure(matching.length, 'ACCESS_DENIED');
                    const resolved = deps.assets.read(previewRef);
                    ensure(resolved.bytes instanceof Uint8Array && resolved.asset.ready && resolved.asset.previewRef === previewRef, 'ASSET_CHANGED');
                    ensure(matching.some(reference => reference.ref === resolved.asset.ref && reference.sha256 === resolved.asset.sha256), 'ASSET_CHANGED');
                    const mime = resolved.mime.split(';')[0].trim().toLowerCase();
                    const types = { video: ['video/mp4', 'video/webm'], audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'], image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], subtitles: ['text/vtt'] };
                    ensure(types[resolved.asset.kind]?.includes(mime), 'ASSET_CHANGED');
                    const bytes = new Uint8Array(resolved.bytes);
                    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
                    const actualHash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
                    ensure(actualHash === resolved.asset.sha256, 'ASSET_CHANGED');
                    await recheck();
                    return new Response(bytes, { headers: { ...HEADERS, 'content-type': mime, 'content-length': String(bytes.byteLength), 'content-security-policy': "default-src 'none'; sandbox" } });
                }
                default: return failure('NOT_FOUND', 404);
            }
            await recheck();
            return response(data);
        }
        catch (error) {
            request.signal.throwIfAborted();
            return errorResponse(error);
        }
    };
}
