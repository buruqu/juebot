import { createHash } from 'node:crypto';
import { requireBili as need, biliShape as shape, biliText as text } from './bili-read-source.js';
const copy = value => structuredClone(value);
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const validId = id => { text(id, 128); need(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id)); };
/** Immutable versions and a CAS head only. Saving public bytes grants no learning or publication rights. */
export function createBiliMaterials({ store, reader, authorize, now, namespace = 'default' }) {
  need(store && typeof reader?.read === 'function' && typeof authorize === 'function' && typeof now === 'function'); text(namespace, 128);
  const key = JSON.stringify(['bili-materials-v1', namespace]), snapshotKey = (id, revision) => JSON.stringify(['bili-snapshot-v1', namespace, id, revision]);
  let closed = false; const active = new Set(), controllers = new Set();
  const state = () => store.read(key) ?? { revision: 0, value: { sources: {} } };
  const time = () => { const result = now(); need(Number.isSafeInteger(result) && result >= 0); return result; };
  const permission = input => {
    need(!closed, 'BILI_CLOSED'); let result;
    try { result = authorize(copy(input)); } catch { need(false, 'BILI_NOT_AUTHORIZED'); }
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    need(!closed, 'BILI_CLOSED');
    need(result?.allowed === true && Number.isSafeInteger(result.revision) && result.revision >= 0 && typeof result.then !== 'function'
      && (result.expiresAt === null || (Number.isSafeInteger(result.expiresAt) && result.expiresAt > time())), 'BILI_NOT_AUTHORIZED');
    return { revision: result.revision, expiresAt: result.expiresAt };
  };
  const load = (id, revision, audit = false) => {
    validId(id); const current = state(); const head = Object.hasOwn(current.value.sources, id) ? current.value.sources[id] : null;
    need(head && Number.isSafeInteger(revision) && revision >= 1, 'BILI_SOURCE_NOT_FOUND');
    if (!audit) need(head.status === 'active' && head.revision === revision && (head.expiresAt === null || head.expiresAt > time()), 'BILI_SOURCE_CHANGED');
    const saved = store.read(snapshotKey(id, revision))?.value; need(saved && hash(saved.content) === saved.contentHash, 'BILI_SNAPSHOT_INVALID');
    need(canonical(saved.items) === canonical(project(id, saved.content)), 'BILI_SNAPSHOT_INVALID');
    return { revision, status: head.status, source: copy(head), snapshot: copy(saved) };
  };
  const get = (id, revision) => { validId(id); const head = state().value.sources[id]; need(head, 'BILI_SOURCE_NOT_FOUND');
    const version = revision ?? head.snapshotRevision ?? head.revision;
    permission({ operation: 'read', id, revision: version, target: null }); return load(id, version, true); };
  const capture = async (input, { signal, beforeCommit, beforePersist } = {}) => {
    shape(input, ['id', 'expectedRevision', 'request']); validId(input.id); need(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0);
    shape(input.request, ['account', 'bvid', 'page', 'limit', 'sort'], ['account', 'bvid']);
    // Freeze the request before any Host hook or transport can mutate caller-owned input.
    const request = copy(input); const grantInput = { operation: 'save', id: request.id, revision: request.expectedRevision, request: request.request, target: null };
    const grant = permission(grantInput); const prior = state(); const head = prior.value.sources[request.id];
    need((head?.revision ?? 0) === request.expectedRevision, 'BILI_REVISION_CONFLICT');
    need(head?.status !== 'revoked', 'BILI_SOURCE_REVOKED');
    if (head) need(head.account === request.request.account && head.bvid === request.request.bvid, 'BILI_SOURCE_CHANGED');
    const controller = new AbortController(); controllers.add(controller); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      need(!signal?.aborted, 'BILI_CANCELLED'); const raw = await reader.read(request.request, { signal: controller.signal });
      await beforeCommit?.();
      need(!signal?.aborted && !controller.signal.aborted, 'BILI_CANCELLED'); need(canonical(permission(grantInput)) === canonical(grant), 'BILI_ACCESS_CHANGED');
      shape(raw, ['account', 'bvid', 'aid', 'cid', 'title', 'description', 'author', 'comments', 'observedAt', 'page', 'sort', 'limit', 'truncated', 'coverage']);
      need(Number.isSafeInteger(raw.observedAt) && raw.observedAt >= 0 && raw.observedAt <= time(), 'BILI_INVALID_CLOCK');
      const { observedAt, ...content } = raw; need(content.account === request.request.account && content.bvid === request.request.bvid, 'BILI_SOURCE_CHANGED');
      const items = project(request.id, content); const revision = request.expectedRevision + 1;
      const snapshot = { id: request.id, revision, content, contentHash: hash(content), observedAt, items };
      need((state().value.sources[request.id]?.revision ?? 0) === request.expectedRevision, 'BILI_REVISION_CONFLICT');
      const persisted = beforePersist?.(); if (persisted?.then) Promise.resolve(persisted).catch(() => {}); need(!persisted?.then, 'BILI_ASYNC_GUARD');
      return store.atomic(tx => {
        const current = tx.read(key) ?? { revision: 0, value: { sources: {} } };
        need((current.value.sources[request.id]?.revision ?? 0) === request.expectedRevision, 'BILI_REVISION_CONFLICT');
        need(Object.keys(current.value.sources).length < 1024 || Object.hasOwn(current.value.sources, request.id), 'BILI_CAPACITY');
        need(canonical(permission(grantInput)) === canonical(grant), 'BILI_ACCESS_CHANGED');
        tx.write(snapshotKey(request.id, revision), 0, snapshot);
        current.value.sources[request.id] = { id: request.id, revision, snapshotRevision: revision, status: 'active', account: content.account, bvid: content.bvid, expiresAt: grant.expiresAt };
        tx.write(key, current.revision, current.value); return copy(snapshot);
      });
    } finally { signal?.removeEventListener('abort', abort); controller.abort(); controllers.delete(controller); }
  };
  const project = (id, content) => {
    const items = [{ id: id + ':video', text: `${content.bvid} / aid:${content.aid} / cid:${content.cid}\n作者:${content.author.id} ${content.author.name}\n${content.title}\n${content.description}\n覆盖:${content.coverage}；page:${content.page.number}；truncated:${content.truncated}` },
      ...content.comments.map(comment => ({ id: id + ':comment:' + comment.id, text: `评论:${comment.id} / 作者:${comment.author.id} ${comment.author.name}\n${comment.text}` }))];
    need(items.length <= 64 && items.reduce((sum, item) => sum + item.text.length, 0) <= 64000, 'BILI_MATERIALS_TOO_LARGE');
    for (const item of items) { text(item.id, 256); text(item.text, 4000); } return items;
  };
  const approved = (id, revision, operation, target) => { const loaded = load(id, revision); const authorization = permission({ operation, id, revision, target: copy(target), account: loaded.source.account, bvid: loaded.source.bvid }); load(id, revision); return { ...loaded, authorization }; };
  const materials = async (intention, target) => {
    need(Array.isArray(intention?.sources) && intention.sources.length > 0 && intention.sources.length <= 64);
    const seen = new Set(), sources = [], items = []; const current = state();
    for (const source of intention.sources) {
      need(!seen.has(source.eventId)); seen.add(source.eventId);
      const loaded = approved(source.eventId, source.revision, 'draft', target); approved(source.eventId, source.revision, 'publish', target);
      sources.push({ id: source.eventId, revision: source.revision, personLinkRevision: null }); items.push(...copy(loaded.snapshot.items));
    }
    need(items.length <= 64 && items.reduce((sum, item) => sum + item.text.length, 0) <= 64000, 'BILI_MATERIALS_TOO_LARGE');
    need(state().revision === current.revision, 'BILI_SOURCE_CHANGED'); return { revision: current.revision, sources, items };
  };
  const revoke = (input, { beforeCommit } = {}) => {
    shape(input, ['id', 'expectedRevision']); validId(input.id); need(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 1);
    const request = copy(input); permission({ operation: 'revoke', ...request, target: null });
    const prior = state().value.sources[request.id]; need(prior?.revision === request.expectedRevision && prior.status === 'active', 'BILI_REVISION_CONFLICT');
    const guarded = beforeCommit?.(); if (guarded?.then) Promise.resolve(guarded).catch(() => {}); need(!guarded?.then, 'BILI_ASYNC_GUARD');
    return store.atomic(tx => {
      const s = tx.read(key), head = s?.value.sources[request.id]; need(head?.revision === request.expectedRevision && head.status === 'active', 'BILI_REVISION_CONFLICT');
      permission({ operation: 'revoke', ...request, target: null }); head.status = 'revoked'; head.revision++; tx.write(key, s.revision, s.value); return copy(head);
    });
  };
  return { capture(...args) { const operation = capture(...args); active.add(operation); void operation.finally(() => active.delete(operation)).catch(() => {}); return operation; },
    refresh(...args) { return this.capture(...args); }, revoke, get, materials,
    validateSource(id,revision,target,purpose='publish') {
      need(['draft','publish','learn'].includes(purpose)); const loaded=approved(id,revision,purpose,target);
      return {id,revision,contentHash:loaded.snapshot.contentHash};
    },
    learningSource({ id, revision, conversationKey }) {
      text(conversationKey, 4096); const loaded = approved(id, revision, 'learn', conversationKey);
      const expiries = [loaded.source.expiresAt, loaded.authorization.expiresAt].filter(value => value !== null);
      return { requiresHumanApproval: true, candidate: { id, conversationKey, revision, domain: 'social', status: 'active', purposes: ['read', 'learn'], audiences: [conversationKey], expiresAt: expiries.length ? Math.min(...expiries) : null },
        contentHash: loaded.snapshot.contentHash, items: copy(loaded.snapshot.items), sharing: { approved: false, targets: [] } };
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); return Promise.allSettled([...active]).then(() => undefined); } };
}
