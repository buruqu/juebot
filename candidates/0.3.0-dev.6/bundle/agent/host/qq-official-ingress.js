import { createHash } from 'node:crypto';

const ownedFailures = new WeakSet();
const fail = code => { const error = Object.assign(new Error(code), { code }); ownedFailures.add(error); return error; };
const need = (ok, code = 'QQ_INGRESS_INVALID') => { if (!ok) throw fail(code); };
const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(s);
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(s);
const stable = x => Array.isArray(x) ? '[' + x.map(stable).join(',') + ']'
  : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}' : JSON.stringify(x);
const hash = x => createHash('sha256').update(stable(x)).digest('hex');
const actorFor = (issuer, appId, openid) => JSON.stringify(['qq-official', issuer, appId, 'user', openid]);
const empty = value => value === undefined || (Array.isArray(value) && value.length === 0);
const plain = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every(k => keys.includes(k));
function interactionCommand(body) {
  if (!body.startsWith('/code审批') && !body.startsWith('/code答复')) return null;
  const match = /^\/code(审批|答复) ([A-Za-z0-9_-]{1,128}) ([1-9][0-9]{0,15}) ([\s\S]+)$/u.exec(body);
  need(match && Number.isSafeInteger(Number(match[3])), 'QQ_CODE_COMMAND_INVALID');
  const base = { requestId: match[2], revision: Number(match[3]) };
  if (match[1] === '审批') {
    need(match[4] === '允许' || match[4] === '拒绝', 'QQ_CODE_COMMAND_INVALID');
    return { ...base, kind: 'approval', decision: match[4] === '允许' ? 'allowed-once' : 'rejected' };
  }
  let value;
  try { value = JSON.parse(match[4]); } catch { throw fail('QQ_CODE_COMMAND_INVALID'); }
  need(plain(value, ['answers']) && Array.isArray(value.answers) && value.answers.length >= 1
    && value.answers.length <= 32, 'QQ_CODE_COMMAND_INVALID');
  for (const answer of value.answers) {
    need(plain(answer, ['id', 'selected', 'custom']) && text(answer.id)
      && (answer.selected !== undefined || answer.custom !== undefined)
      && (answer.selected === undefined || (Array.isArray(answer.selected) && answer.selected.length <= 32
        && answer.selected.every(s => typeof s === 'string' && s.length > 0 && s.length <= 4096)))
      && (answer.custom === undefined || (typeof answer.custom === 'string' && answer.custom.length <= 8000)),
    'QQ_CODE_COMMAND_INVALID');
  }
  need(new Set(value.answers.map(a => a.id)).size === value.answers.length, 'QQ_CODE_COMMAND_INVALID');
  return { ...base, kind: 'question', answers: value.answers };
}

/** A thin adapter for @tencent-connect/qqbot-nodejs 1.0.5 message(ctx,msg).
 * Host supplies an ALREADY authenticated SDK and current policy callbacks.
 * No WS, webhook, credentials, token refresh, login or default reply handler.
 * Never expose subscribeSDK/authenticateEvent or SDK instances to HTTP clients.
 */
export function createQQOfficialIngress(options = {}) {
  const { appId, issuer, botId, personaId, stateStore, authenticateEvent, resolveBinding,
    authorizeReply, getAdminGrant, codeTasks, onSocial, groupSocialEnabled = () => false, directSocialEnabled = () => false, routeDirect,
    authorizeIngressMaintenance, now = Date.now,
    authTimeoutMs = 10000 } = options;
  need(id(appId) && text(issuer) && text(botId) && text(personaId), 'QQ_INGRESS_NOT_CONFIGURED');
  need(Number.isSafeInteger(authTimeoutMs) && authTimeoutMs >= 1 && authTimeoutMs <= 10000, 'QQ_INGRESS_NOT_CONFIGURED');
  for (const fn of [authenticateEvent, resolveBinding, authorizeReply, getAdminGrant, groupSocialEnabled, directSocialEnabled, now])
    need(typeof fn === 'function', 'QQ_INGRESS_NOT_CONFIGURED');
  need(typeof stateStore?.atomic === 'function' && typeof stateStore?.read === 'function'
    && typeof codeTasks?.admit === 'function' && typeof codeTasks?.get === 'function'
    && typeof onSocial === 'function', 'QQ_INGRESS_NOT_CONFIGURED');
  need(routeDirect === undefined || typeof routeDirect === 'function', 'QQ_INGRESS_NOT_CONFIGURED');
  const account = JSON.stringify(['qq-official', issuer, appId]);
  const tokens = new WeakMap(); const subscriptions = new WeakSet(); const pending = new Set();
  const clock = () => { const n = now(); need(Number.isSafeInteger(n) && n >= 0); return n; };
  const eventKey = eventId => 'qq-official:ingress:' + hash([account, eventId]);
  const capacityKey = 'qq-official:ingress-capacity:' + hash(account);
  const archiveIndexKey = 'qq-official:ingress-archives:' + hash(account);
  const coldKey = eventId => 'qq-official:ingress-archive:' + hash([account, eventId]);
  const sourceKey = sourceId => 'qq-official:source:' + hash([account, sourceId]);
  const identityFor = (kind, target) => ({ botId, personaId, connector: 'qq-official', issuer, accountId: appId, kind, remoteId: target });
  const keyFor = identity => JSON.stringify(['juebot-conversation-v1', identity.botId, identity.personaId,
    identity.connector, identity.issuer, identity.accountId, identity.kind, identity.remoteId]);
  function binding(identity) {
    const b = resolveBinding(structuredClone(identity));
    need(b && typeof b.then !== 'function' && b.key === keyFor(identity)
      && Number.isSafeInteger(b.bindingRevision) && b.bindingRevision >= 0, 'QQ_BINDING_UNAVAILABLE');
    return { key: b.key, bindingRevision: b.bindingRevision };
  }
  function current(proof) {
    const b = binding(proof.identity);
    need(b.key === proof.envelope.key && b.bindingRevision === proof.envelope.bindingRevision, 'QQ_BINDING_CHANGED');
    return b;
  }
  function admin(proof) {
    const grant = getAdminGrant();
    need(grant && typeof grant.then !== 'function' && grant.verified === true
      && (grant.status === undefined || grant.status === 'verified')
      && grant.adminActor === proof.envelope.actor && grant.account === appId
      && grant.conversationKey === proof.envelope.key, 'QQ_CODE_NOT_AUTHORIZED');
  }
  const socialRoute = proof => proof.route === 'social' || (proof.route === undefined && proof.kind === 'group');
  const routeMetadataFor = proof => Object.freeze({ identity: Object.freeze({ ...proof.identity }), actor: proof.envelope.actor,
    key: proof.envelope.key, account, appId, kind: proof.kind });
  function socialEnabled(proof) {
    if (proof.kind === 'group') return groupSocialEnabled(proof.envelope.key) === true;
    if (directSocialEnabled(proof.envelope.key) === true) return true;
    const route = routeDirect?.(routeMetadataFor(proof));
    if (route && typeof route.then === 'function') Promise.resolve(route).catch(() => {});
    return route === 'social';
  }
  function readEvent(eventId, read = stateStore.read.bind(stateStore)) {
    const row = read(eventKey(eventId)); if (!row || row.value.phase !== 'archived') return row;
    const record = read(coldKey(eventId));
    need(record?.revision === 1 && hash(record.value) === row.value.archiveHash
      && record.value.original.fingerprint === row.value.fingerprint && record.value.original.proof.messageId === eventId, 'QQ_ARCHIVE_CORRUPT');
    return { revision: row.revision, value: structuredClone(record.value.original) };
  }
  function markPhase(eventId, fingerprint, phase) {
    stateStore.atomic(tx => { const row = tx.read(eventKey(eventId));
      need(row?.value.phase === 'processing' && row.value.fingerprint === fingerprint, 'QQ_INGRESS_STATE_CHANGED');
      tx.write(eventKey(eventId), row.revision, { ...row.value, phase }); });
  }
  function normalize(message, authentication) {
    const m = message; const raw = m?.raw;
    need(raw && typeof raw === 'object' && raw.author && authentication?.authenticated === true
      && authentication.appId === appId && authentication.issuer === issuer && authentication.account === account,
    'QQ_UNTRUSTED_INGRESS');
    need(authentication.actorKind === 'human' && authentication.self === false
      && m.senderIsBot !== true && raw.author.bot !== true, 'QQ_NON_HUMAN');
    const kind = m.rawEventType === 'C2C_MESSAGE_CREATE' && m.kind === 'c2c' ? 'direct'
      : m.rawEventType === 'GROUP_AT_MESSAGE_CREATE' && m.kind === 'group' ? 'group' : null;
    need(kind, 'QQ_EVENT_UNSUPPORTED');
    const sender = kind === 'direct' ? raw.author.user_openid : raw.author.member_openid;
    const target = kind === 'direct' ? sender : raw.group_openid;
    need(id(sender) && id(target) && text(raw.id) && m.messageId === raw.id && m.senderId === sender
      && m.timestamp === raw.timestamp && (kind !== 'group' || m.groupOpenid === target)
      && m.replyTarget?.scope === (kind === 'direct' ? 'c2c' : 'group')
      && m.replyTarget.targetId === target && m.replyTarget.msgId === raw.id, 'QQ_EVENT_MISMATCH');
    // Original platform timestamp only. SDK receivedAt is not a reply-window clock.
    need(typeof raw.timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw.timestamp));
    const timestamp = Date.parse(raw.timestamp); const n = clock();
    need(Number.isSafeInteger(timestamp) && timestamp <= n && n < timestamp + 300000, 'QQ_EVENT_EXPIRED');
    // Read original plain raw text, never a merged/media/markdown envelope.
    // A supported explicit raw reference is retained for social only; Code
    // rejects it after the trusted route has been selected.
    need(typeof raw.content === 'string' && raw.content.trim().length > 0 && raw.content.length <= 16000
      && !/[\u0000\uD800-\uDFFF]/u.test(raw.content)
      && empty(raw.attachments) && empty(raw.msg_elements) && empty(m.attachments) && empty(m.msgElements)
      && (raw.message_type === undefined || raw.message_type === 0)
      && (m.msgType === undefined || m.msgType === 0) && !m.refMsgIdx
      && (kind !== 'direct' || m.content === raw.content)
      && !/\[CQ:|<qqbot-|<file>|<image>|<video>|<audio>/iu.test(raw.content)
      && !raw.message_scene?.ext?.some(x => typeof x !== 'string' || x.startsWith('ref_msg_idx='))
      && ['markdown', 'ark', 'embed', 'media', 'keyboard', 'forward', 'file', 'image', 'video', 'audio'].every(k => raw[k] === undefined),
    'QQ_PLAIN_TEXT_REQUIRED');
    let replyTo;
    if (raw.message_reference !== undefined) {
      const reference = raw.message_reference;
      need(plain(reference, ['message_id', 'ignore_get_message_error']) && text(reference.message_id)
        && (reference.ignore_get_message_error === undefined || typeof reference.ignore_get_message_error === 'boolean'), 'QQ_PLAIN_TEXT_REQUIRED');
      replyTo = reference.message_id;
    }
    const identity = identityFor(kind, target); const b = binding(identity);
    const envelope = { ...b, eventId: raw.id, actor: actorFor(issuer, appId, sender), actorKind: 'human',
      plain: true, text: raw.content, observedAt: timestamp, ...(replyTo === undefined ? {} : { replyTo }) };
    return { identity, envelope, account, appId, issuer, kind, targetOpenId: target, messageId: raw.id,
      eventType: m.rawEventType, eventTimestamp: timestamp, originalTimestamp: raw.timestamp };
  }
  async function receive(token) {
    const capture = token && tokens.get(token);
    need(capture, 'QQ_UNTRUSTED_INGRESS'); tokens.delete(token);
    const authController = new AbortController();
    const abort = () => authController.abort(fail('QQ_INGRESS_STOPPED'));
    capture.signal.addEventListener('abort', abort, { once: true });
    if (capture.signal.aborted) abort();
    const timer = setTimeout(() => authController.abort(fail('QQ_AUTH_TIMEOUT')), authTimeoutMs);
    let stop;
    const cancelled = new Promise((_, reject) => {
      stop = () => reject(authController.signal.reason);
      authController.signal.addEventListener('abort', stop, { once: true });
      if (authController.signal.aborted) stop();
    });
    let auth;
    try {
      // This callback may only read its trusted authentication source and return
      // a proof. It must not hold/write the juebot StateStore or runtime.
      auth = await Promise.race([Promise.resolve().then(() => authenticateEvent({ sdk: capture.sdk,
        context: capture.context, message: structuredClone(capture.message), appId, issuer, account,
        signal: authController.signal })), cancelled]);
    } finally {
      clearTimeout(timer); capture.signal.removeEventListener('abort', abort);
      authController.signal.removeEventListener('abort', stop);
      authController.abort();
    }
    need(capture.active(), 'QQ_INGRESS_STOPPED');
    const proof = normalize(capture.message, auth); current(proof);
    const command = ['/开启code', '/关闭code'].includes(proof.envelope.text) ? proof.envelope.text : null;
    const interaction = interactionCommand(proof.envelope.text);
    need((!command && !interaction) || proof.kind === 'direct', 'QQ_CODE_PRIVATE_REQUIRED');
    const routeMetadata = routeMetadataFor(proof);
    const route = proof.kind === 'group' ? 'social' : command || interaction ? 'code'
      : routeDirect ? routeDirect(routeMetadata) : directSocialEnabled(proof.envelope.key) === true ? 'social' : 'code';
    if (route && typeof route.then === 'function') Promise.resolve(route).catch(() => {});
    need(route === 'code' || route === 'social', 'QQ_ROUTE_INVALID');
    proof.route = route;
    if (route === 'code') need(proof.envelope.replyTo === undefined, 'QQ_PLAIN_TEXT_REQUIRED');
    if (route === 'code') admin(proof);
    if (route === 'social' && !socialEnabled(proof)) return { accepted: false, code: proof.kind === 'group' ? 'QQ_GROUP_DISABLED' : 'QQ_DIRECT_DISABLED' };
    const sourceId = hash([proof.envelope.key, proof.envelope.bindingRevision, proof.envelope.eventId]);
    const fingerprint = hash(proof);
    const duplicate = stateStore.atomic(tx => {
      const old = tx.read(eventKey(proof.messageId));
      if (old) return old.value.fingerprint === fingerprint ? 'duplicate' : 'conflict';
      const capacity = tx.read(capacityKey);
      if ((capacity?.value.count ?? 0) >= 2048) return 'capacity';
      tx.write(eventKey(proof.messageId), 0, { fingerprint, proof, phase: 'processing' });
      tx.write(sourceKey(sourceId), 0, { eventId: proof.messageId });
      tx.write(capacityKey, capacity?.revision ?? 0, { count: (capacity?.value.count ?? 0) + 1 });
      return 'new';
    });
    need(duplicate !== 'conflict', 'QQ_EVENT_CONFLICT'); need(duplicate !== 'capacity', 'QQ_INGRESS_CAPACITY');
    if (duplicate === 'duplicate') return { accepted: false, code: 'QQ_EVENT_REPLAY' };
    // Admission errors deliberately leave the event consumed; retry/recovery is
    // a Host operator decision, never an automatic second task or social leak.
    const dispatch = async () => {
      if (route === 'code') {
        current(proof); admin(proof);
        // Reserved control commands bypass the model FIFO. They still require
        // authenticated original plain text, current private admin and durable
        // event dedup. Missing control is never a fallback into a Code task.
        if (command) {
          need(typeof codeTasks.control === 'function', 'NOT_CONFIGURED');
          return { accepted: true, route: 'code-control', command, result: codeTasks.control(command, clock()) };
        }
        if (interaction) {
          need(typeof codeTasks.respondInteraction === 'function', 'NOT_CONFIGURED');
          const source = { eventId: proof.messageId, actor: proof.envelope.actor, conversationKey: proof.envelope.key,
            account: appId, plain: true, text: proof.envelope.text, observedAt: proof.eventTimestamp };
          return { accepted: true, route: 'code-interaction', result: await codeTasks.respondInteraction({ ...interaction, source }) };
        }
        const input = { eventId: proof.messageId, actor: proof.envelope.actor, conversationKey: proof.envelope.key,
          account: appId, plain: true, text: proof.envelope.text };
        need(input.text.trim().length > 0, 'QQ_CODE_EMPTY');
        return { accepted: true, route, result: await codeTasks.admit(input, clock()) };
      }
      current(proof); need(capture.active() && socialEnabled(proof), 'QQ_INGRESS_STOPPED');
      return { accepted: true, route, result: await onSocial(structuredClone(proof.envelope), Object.freeze({ signal: capture.signal })) };
    };
    try { const result = await dispatch(); markPhase(proof.messageId, fingerprint, 'completed'); return result; }
    catch (error) { try { markPhase(proof.messageId, fingerprint, 'unknown'); } catch { /* retain processing: never eligible for archive */ } throw error; }
  }

  function acceptIngress(envelope, identity) {
    try {
      const proof = readEvent(envelope.eventId)?.value.proof;
      need(proof && socialRoute(proof) && socialEnabled(proof));
      current(proof);
      return hash(envelope) === hash(proof.envelope) && keyFor(identity) === keyFor(proof.identity);
    } catch { return false; }
  }
  async function resolveReplyContext(delivery, { signal } = {}) {
    signal?.throwIfAborted(); const d = structuredClone(delivery);
    need(d.account === account && ['social', 'repetition', 'code-result', 'code-interaction'].includes(d.kind), 'QQ_REPLY_DENIED');
    const codeDelivery = d.kind === 'code-result' || d.kind === 'code-interaction';
    let eventId; let sourceActor;
    const verifyCodeDelivery = () => {
      const task = codeTasks.get(d.payload?.taskId);
      need(task && task.input.conversationKey === d.conversation && task.input.account === appId
        && task.authorization.conversationKey === d.conversation && task.authorization.account === appId
        && task.authorization.adminActor === task.input.actor, 'QQ_REPLY_DENIED');
      if (d.kind === 'code-result') need(d.id === `${task.id}:result` && task.result !== null
        && d.body === (task.result || '任务已结束，结果为空。'), 'QQ_REPLY_DENIED');
      else {
        need(typeof codeTasks.getInteraction === 'function', 'NOT_CONFIGURED');
        const row = codeTasks.getInteraction(d.payload?.requestId);
        need(row && row.id === d.payload.requestId && row.taskId === task.id && task.state === 'running'
          && row.status === 'pending' && row.revision === row.requestRevision && row.deadline > clock()
          && d.payload.requestRevision === row.requestRevision && d.id === `${row.id}:notice` && d.body === row.text
          && hash(row.authorization) === hash(task.authorization) && hash(row.input) === hash(task.input), 'QQ_REPLY_DENIED');
      }
      sourceActor = task.input.actor;
      return typeof codeTasks.replyEventId === 'function' ? codeTasks.replyEventId(task.id) : task.input.eventId;
    };
    if (codeDelivery) {
      eventId = verifyCodeDelivery();
    } else {
      const refs = d.payload?.rawSources;
      need(Array.isArray(refs) && refs.length > 0, 'QQ_REPLY_SOURCE_REQUIRED');
      // Only already attested sources from this exact conversation are eligible.
      const proofs = refs.map(ref => {
        const saved = stateStore.read(sourceKey(ref.sourceId));
        const p = saved && readEvent(saved.value.eventId)?.value.proof;
        need(p && socialRoute(p) && p.envelope.key === d.conversation, 'QQ_REPLY_DENIED'); return p;
      });
      eventId = proofs.sort((a,b) => b.eventTimestamp-a.eventTimestamp)[0].messageId;
    }
    const proof = readEvent(eventId)?.value.proof;
    need(proof && proof.envelope.key === d.conversation && proof.account === account
      && (!codeDelivery || (proof.kind === 'direct' && !socialRoute(proof) && proof.envelope.actor === sourceActor)), 'QQ_REPLY_DENIED');
    current(proof);
    if (codeDelivery) admin(proof);
    else need(socialRoute(proof) && socialEnabled(proof), proof.kind === 'group' ? 'QQ_GROUP_DISABLED' : 'QQ_DIRECT_DISABLED');
    need(proof.eventTimestamp <= clock() && clock() < proof.eventTimestamp + 300000, 'QQ_EVENT_EXPIRED');
    need(await authorizeReply(structuredClone(d), structuredClone(proof), { signal }) === true, 'QQ_REPLY_DENIED');
    signal?.throwIfAborted(); current(proof);
    if (codeDelivery) { need(verifyCodeDelivery() === eventId, 'QQ_REPLY_SOURCE_CHANGED'); admin(proof); }
    else need(socialRoute(proof) && socialEnabled(proof), proof.kind === 'group' ? 'QQ_GROUP_DISABLED' : 'QQ_DIRECT_DISABLED');
    return { authorized: true, deliveryId: d.id, body: d.body, appId, issuer, account, conversation: d.conversation,
      kind: proof.kind, targetOpenId: proof.targetOpenId, messageId: proof.messageId,
      eventType: proof.eventType, eventTimestamp: proof.eventTimestamp };
  }
  function strict(value, fields, required = fields) {
    need(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'QQ_MAINTENANCE_INVALID');
    need(Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.includes(key)
      && 'value' in Object.getOwnPropertyDescriptor(value, key)) && required.every(key => Object.hasOwn(value, key)), 'QQ_MAINTENANCE_INVALID');
  }
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  function maintenance(action, input, items = []) {
    need(text(input.reviewer) && input.reviewer.trim(), 'QQ_MAINTENANCE_INVALID');
    const proof = freeze({ action, account, reviewer: input.reviewer, reason: input.reason ?? null, at: input.at ?? clock(), items: structuredClone(items) });
    let allowed; try { allowed = authorizeIngressMaintenance?.(proof); } catch { throw fail('QQ_MAINTENANCE_DENIED'); }
    if (allowed && typeof allowed.then === 'function') Promise.resolve(allowed).catch(() => {});
    need(allowed === true, 'QQ_MAINTENANCE_DENIED');
  }
  function inspectIngress(input) {
    strict(input, ['ids', 'reviewer']); input = structuredClone(input);
    need(Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 32 && new Set(input.ids).size === input.ids.length, 'QQ_MAINTENANCE_INVALID');
    maintenance('inspect', input); const capacity = stateStore.read(capacityKey);
    const items = input.ids.map(eventId => { need(text(eventId)); const row = stateStore.read(eventKey(eventId)); need(row?.value.proof, 'QQ_EVENT_NOT_HOT');
      return { id: eventId, revision: row.revision, phase: row.value.phase ?? 'unknown', route: row.value.proof.route ?? (row.value.proof.kind === 'direct' ? 'code' : 'social') }; });
    maintenance('inspect', input, items); return { expectedRevision: capacity?.revision ?? 0, items };
  }
  function archiveIngress(input) {
    strict(input, ['ids', 'expectedRevision', 'reviewer', 'reason']);
    need(Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 32, 'QQ_MAINTENANCE_INVALID');
    input.ids.forEach(item => strict(item, ['id', 'revision'])); input = structuredClone(input);
    need(text(input.reason) && input.reason.trim() && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0
      && new Set(input.ids.map(item => item.id)).size === input.ids.length, 'QQ_MAINTENANCE_INVALID');
    const at = clock();
    let ownedError;
    try { return stateStore.atomic(tx => { try {
      const capacity = tx.read(capacityKey), index = tx.read(archiveIndexKey);
      need(capacity?.revision === input.expectedRevision, 'QQ_ARCHIVE_CONFLICT');
      need((index?.value.length ?? 0) + input.ids.length <= 4096, 'QQ_ARCHIVE_CAPACITY');
      const originals = input.ids.map(item => { need(text(item.id) && Number.isSafeInteger(item.revision) && item.revision > 0, 'QQ_MAINTENANCE_INVALID');
        const row = tx.read(eventKey(item.id)); need(row?.revision === item.revision && row.value.phase === 'completed'
          && row.value.proof && row.value.proof.messageId === item.id && row.value.fingerprint === hash(row.value.proof), 'QQ_EVENT_NOT_TERMINAL');
        need(tx.read(coldKey(item.id)) === null && !index?.value.some(old => old.id === item.id), 'QQ_ARCHIVE_CONFLICT');
        const sourceId = hash([row.value.proof.envelope.key, row.value.proof.envelope.bindingRevision, item.id]);
        const source = tx.read(sourceKey(sourceId)); need(source?.value.eventId === item.id, 'QQ_ARCHIVE_CORRUPT');
        return { id: item.id, row, sourceId, source };
      });
      const fingerprint = hash([capacity, index, originals]);
      const subjects = originals.map(({ id, row }) => ({ id, revision: row.revision, phase: row.value.phase,
        route: row.value.proof.route ?? (row.value.proof.kind === 'direct' ? 'code' : 'social'), fingerprint: row.value.fingerprint }));
      maintenance('archive', { ...input, at }, subjects); maintenance('archive', { ...input, at }, subjects);
      need(hash([tx.read(capacityKey), tx.read(archiveIndexKey), originals.map(old => ({ ...old, row: tx.read(eventKey(old.id)), source: tx.read(sourceKey(old.sourceId)) }))]) === fingerprint, 'QQ_ARCHIVE_CONFLICT');
      need(capacity.value.count >= originals.length, 'QQ_ARCHIVE_CORRUPT');
      const items = originals.map(({ id, row }) => {
        need(tx.read(coldKey(id)) === null, 'QQ_ARCHIVE_CONFLICT');
        const record = { original: row.value, audit: { reviewer: input.reviewer, reason: input.reason, at } };
        const archiveHash = hash(record); const proof = row.value.proof;
        const metadata = { id, hash: archiveHash, at, route: proof.route ?? (proof.kind === 'direct' ? 'code' : 'social'), kind: proof.kind };
        tx.write(coldKey(id), 0, record);
        // The hot row becomes a permanent tombstone. Source lookup remains
        // immutable and resolves through this row to its complete cold record.
        tx.write(eventKey(id), row.revision, { fingerprint: row.value.fingerprint, phase: 'archived', archiveHash });
        return metadata;
      });
      tx.write(archiveIndexKey, index?.revision ?? 0, [...(index?.value ?? []), ...items]);
      tx.write(capacityKey, capacity.revision, { count: capacity.value.count - items.length }); return items;
    } catch (error) { if (ownedFailures.has(error)) ownedError = error; throw error; } });
    } catch (error) { throw ownedError ?? error; }
  }
  function listArchivedIngress(input) {
    strict(input, ['reviewer', 'offset', 'limit'], ['reviewer']); input = structuredClone(input); maintenance('list', input);
    const offset = input.offset ?? 0, limit = input.limit ?? 20;
    need(Number.isSafeInteger(offset) && offset >= 0 && offset <= 4096 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'QQ_MAINTENANCE_INVALID');
    const rows = stateStore.read(archiveIndexKey)?.value ?? []; const items = rows.slice(offset, offset + limit);
    maintenance('list', input, items); return { total: rows.length, items };
  }
  function readArchivedIngress(input) {
    strict(input, ['eventId', 'reviewer']); input = structuredClone(input); need(text(input.eventId)); maintenance('read', input);
    const row = stateStore.read(eventKey(input.eventId)); need(row?.value.phase === 'archived', 'QQ_EVENT_NOT_ARCHIVED');
    readEvent(input.eventId); const record = stateStore.read(coldKey(input.eventId)).value;
    maintenance('read', input, [{ id: input.eventId, hash: row.value.archiveHash }]); return structuredClone(record);
  }
  function subscribeSDK(sdk) {
    // The Host must have verified provenance/transport of this SDK instance.
    // These public getters are account checks, not proof of a genuine class.
    need(sdk?.appId === appId && typeof sdk.on === 'function' && typeof sdk.off === 'function'
      && !subscriptions.has(sdk), 'QQ_SDK_INVALID');
    let active = true; const lifetime = new AbortController();
    const handle = async (context, message) => {
      need(active && context?.bot === sdk && context.message === message && !context.aborted
        && context.replyTarget === message?.replyTarget, 'QQ_UNTRUSTED_INGRESS');
      const token = Object.freeze({});
      tokens.set(token, { sdk, context, message: structuredClone(message), active: () => active, signal: lifetime.signal });
      return receive(token);
    };
    // SDK 1.0.5 QQBot.emit awaits each handler inside try/catch. Return the
    // rejection to that SDK boundary; no detached unhandled promise or body log.
    const handler = (context, message) => {
      const operation = handle(context, message);
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    sdk.on('message', handler); subscriptions.add(sdk);
    return () => { if (active) { active = false; lifetime.abort(); sdk.off('message', handler); subscriptions.delete(sdk); } };
  }
  const idle = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  return Object.freeze({ account, subscribeSDK, receive, acceptIngress, acceptSocialAttestation: acceptIngress, resolveReplyContext, idle,
    inspectIngress, archiveIngress, listArchivedIngress, readArchivedIngress });
}
