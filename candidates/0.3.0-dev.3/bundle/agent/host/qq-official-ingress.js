import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const need = (ok, code = 'QQ_INGRESS_INVALID') => { if (!ok) throw fail(code); };
const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(s);
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(s);
const stable = x => Array.isArray(x) ? '[' + x.map(stable).join(',') + ']'
  : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}' : JSON.stringify(x);
const hash = x => createHash('sha256').update(stable(x)).digest('hex');
const actorFor = (issuer, appId, openid) => JSON.stringify(['qq-official', issuer, appId, 'user', openid]);
const empty = value => value === undefined || (Array.isArray(value) && value.length === 0);

/** A thin adapter for @tencent-connect/qqbot-nodejs 1.0.5 message(ctx,msg).
 * Host supplies an ALREADY authenticated SDK and current policy callbacks.
 * No WS, webhook, credentials, token refresh, login or default reply handler.
 * Never expose subscribeSDK/authenticateEvent or SDK instances to HTTP clients.
 */
export function createQQOfficialIngress(options = {}) {
  const { appId, issuer, botId, personaId, stateStore, authenticateEvent, resolveBinding,
    authorizeReply, getAdminGrant, codeTasks, onSocial, groupSocialEnabled = () => false, now = Date.now,
    authTimeoutMs = 10000 } = options;
  need(id(appId) && text(issuer) && text(botId) && text(personaId), 'QQ_INGRESS_NOT_CONFIGURED');
  need(Number.isSafeInteger(authTimeoutMs) && authTimeoutMs >= 1 && authTimeoutMs <= 10000, 'QQ_INGRESS_NOT_CONFIGURED');
  for (const fn of [authenticateEvent, resolveBinding, authorizeReply, getAdminGrant, groupSocialEnabled, now])
    need(typeof fn === 'function', 'QQ_INGRESS_NOT_CONFIGURED');
  need(typeof stateStore?.atomic === 'function' && typeof stateStore?.read === 'function'
    && typeof codeTasks?.admit === 'function' && typeof codeTasks?.get === 'function'
    && typeof onSocial === 'function', 'QQ_INGRESS_NOT_CONFIGURED');
  const account = JSON.stringify(['qq-official', issuer, appId]);
  const tokens = new WeakMap(); const subscriptions = new WeakSet(); const pending = new Set();
  const clock = () => { const n = now(); need(Number.isSafeInteger(n) && n >= 0); return n; };
  const eventKey = eventId => 'qq-official:ingress:' + hash([account, eventId]);
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
    // Fail closed for quoted/merged/media/markdown inputs, even when sanitizer
    // left an apparent Code prefix. Read raw content, never a merged envelope.
    need(typeof raw.content === 'string' && raw.content.trim().length > 0 && raw.content.length <= 16000
      && !/[\u0000\uD800-\uDFFF]/u.test(raw.content)
      && empty(raw.attachments) && empty(raw.msg_elements) && empty(m.attachments) && empty(m.msgElements)
      && (raw.message_type === undefined || raw.message_type === 0)
      && (m.msgType === undefined || m.msgType === 0) && !m.refMsgIdx
      && (kind !== 'direct' || m.content === raw.content)
      && !/\[CQ:|<qqbot-|<file>|<image>|<video>|<audio>/iu.test(raw.content)
      && !raw.message_scene?.ext?.some(x => typeof x !== 'string' || x.startsWith('ref_msg_idx='))
      && ['markdown', 'ark', 'embed', 'media', 'message_reference', 'keyboard', 'forward', 'file', 'image', 'video', 'audio'].every(k => raw[k] === undefined),
    'QQ_PLAIN_TEXT_REQUIRED');
    const identity = identityFor(kind, target); const b = binding(identity);
    const envelope = { ...b, eventId: raw.id, actor: actorFor(issuer, appId, sender), actorKind: 'human',
      plain: true, text: raw.content, observedAt: timestamp };
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
    need(!command || proof.kind === 'direct', 'QQ_CODE_PRIVATE_REQUIRED');
    const route = proof.kind === 'direct' ? 'code' : 'social';
    if (route === 'code') admin(proof);
    if (route === 'social' && groupSocialEnabled(proof.envelope.key) !== true) return { accepted: false, code: 'QQ_GROUP_DISABLED' };
    const sourceId = hash([proof.envelope.key, proof.envelope.bindingRevision, proof.envelope.eventId]);
    const fingerprint = hash(proof);
    const duplicate = stateStore.atomic(tx => {
      const old = tx.read(eventKey(proof.messageId));
      if (old) return old.value.fingerprint === fingerprint ? 'duplicate' : 'conflict';
      const capacityKey = 'qq-official:ingress-capacity:' + hash(account);
      const capacity = tx.read(capacityKey);
      if ((capacity?.value.count ?? 0) >= 2048) return 'capacity';
      tx.write(eventKey(proof.messageId), 0, { fingerprint, proof });
      tx.write(sourceKey(sourceId), 0, { eventId: proof.messageId });
      tx.write(capacityKey, capacity?.revision ?? 0, { count: (capacity?.value.count ?? 0) + 1 });
      return 'new';
    });
    need(duplicate !== 'conflict', 'QQ_EVENT_CONFLICT'); need(duplicate !== 'capacity', 'QQ_INGRESS_CAPACITY');
    if (duplicate === 'duplicate') return { accepted: false, code: 'QQ_EVENT_REPLAY' };
    // Admission errors deliberately leave the event consumed; retry/recovery is
    // a Host operator decision, never an automatic second task or social leak.
    if (route === 'code') {
      current(proof); admin(proof);
      // Reserved control commands bypass the model FIFO. They still require
      // authenticated original plain text, current private admin and durable
      // event dedup. Missing control is never a fallback into a Code task.
      if (command) {
        need(typeof codeTasks.control === 'function', 'NOT_CONFIGURED');
        return { accepted: true, route: 'code-control', command, result: codeTasks.control(command, clock()) };
      }
      const input = { eventId: proof.messageId, actor: proof.envelope.actor, conversationKey: proof.envelope.key,
        account: appId, plain: true, text: proof.envelope.text };
      need(input.text.trim().length > 0, 'QQ_CODE_EMPTY');
      return { accepted: true, route, result: await codeTasks.admit(input, clock()) };
    }
    return { accepted: true, route, result: await onSocial(structuredClone(proof.envelope)) };
  }
  function acceptIngress(envelope, identity) {
    try {
      const proof = stateStore.read(eventKey(envelope.eventId))?.value.proof;
      need(proof && proof.kind === 'group' && groupSocialEnabled(proof.envelope.key) === true);
      current(proof);
      return hash(envelope) === hash(proof.envelope) && keyFor(identity) === keyFor(proof.identity);
    } catch { return false; }
  }
  async function resolveReplyContext(delivery, { signal } = {}) {
    signal?.throwIfAborted(); const d = structuredClone(delivery);
    need(d.account === account && ['social', 'repetition', 'code-result'].includes(d.kind), 'QQ_REPLY_DENIED');
    let eventId;
    if (d.kind === 'code-result') {
      const task = codeTasks.get(d.payload?.taskId);
      need(task && task.input.conversationKey === d.conversation && task.input.account === appId
        && d.id === `${task.id}:result` && task.result !== null
        && d.body === (task.result || '任务已结束，结果为空。'), 'QQ_REPLY_DENIED');
      eventId = task.input.eventId;
    } else {
      const refs = d.payload?.rawSources;
      need(Array.isArray(refs) && refs.length > 0, 'QQ_REPLY_SOURCE_REQUIRED');
      // Only already attested sources from this exact conversation are eligible.
      const proofs = refs.map(ref => {
        const saved = stateStore.read(sourceKey(ref.sourceId));
        const p = saved && stateStore.read(eventKey(saved.value.eventId))?.value.proof;
        need(p && p.kind === 'group' && p.envelope.key === d.conversation, 'QQ_REPLY_DENIED'); return p;
      });
      eventId = proofs.sort((a,b) => b.eventTimestamp-a.eventTimestamp)[0].messageId;
    }
    const proof = stateStore.read(eventKey(eventId))?.value.proof;
    need(proof && proof.envelope.key === d.conversation && proof.account === account, 'QQ_REPLY_DENIED');
    current(proof);
    if (d.kind === 'code-result') admin(proof);
    else need(groupSocialEnabled(d.conversation) === true, 'QQ_GROUP_DISABLED');
    need(proof.eventTimestamp <= clock() && clock() < proof.eventTimestamp + 300000, 'QQ_EVENT_EXPIRED');
    need(await authorizeReply(structuredClone(d), structuredClone(proof), { signal }) === true, 'QQ_REPLY_DENIED');
    signal?.throwIfAborted(); current(proof);
    if (d.kind === 'code-result') admin(proof);
    else need(groupSocialEnabled(d.conversation) === true, 'QQ_GROUP_DISABLED');
    return { authorized: true, deliveryId: d.id, body: d.body, appId, issuer, account, conversation: d.conversation,
      kind: proof.kind, targetOpenId: proof.targetOpenId, messageId: proof.messageId,
      eventType: proof.eventType, eventTimestamp: proof.eventTimestamp };
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
  return Object.freeze({ account, subscribeSDK, receive, acceptIngress, resolveReplyContext, idle });
}
