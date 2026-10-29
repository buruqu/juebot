import { createHash } from 'node:crypto';

// Protocol reviewed 2026-10-28; see RESEARCH-QQ-TRANSPORT.md. No import,
// constructor, timer or callback performs I/O until send() is explicitly called.
export const QQ_OFFICIAL_CAPABILITIES = Object.freeze({ connector: 'qq-official',
  passiveText: Object.freeze(['group', 'direct']), proactive: false, personalQQ: false,
  qzone: false, media: false, webhookVerification: false });
const BASE = 'https://api.bot.qq.com';
const encoder = new TextEncoder();
const valid = (s, max = 1024) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/u.test(s);
const check = ok => { if (!ok) throw new Error('QQ_TRANSPORT_INVALID'); };
const result = (status, receipt = null) => ({ status, receipt });
const digest = s => createHash('sha256').update(s).digest('hex');
const ATTESTED_FIELDS = Object.freeze(['authorized', 'deliveryId', 'body', 'appId', 'issuer', 'account',
  'conversation', 'kind', 'targetOpenId', 'messageId', 'eventType', 'eventTimestamp']);
function wait(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('QQ_TRANSPORT_ABORTED'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readJSON(response, signal) {
  check(response && !response.redirected && response.body?.getReader);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await wait(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength; check(bytes <= 65536); chunks.push(part.value);
    }
    const body = new Uint8Array(bytes); let at = 0;
    for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally { reader.cancel().catch(() => {}); }
}

/** Trusted Host only. Inject callbacks; never expose this constructor or the
 * resolver through an HTTP request body. stateStore must be a durable atomic
 * StateStore (SqliteStateStore is supported); memory-only stores aren't safe
 * across restarts. No credential, access token or message body is persisted.
 *
 * resolveReplyContext(delivery,{signal}) must attest the exact deliveryId/body,
 * appId/issuer/account/conversation, kind/targetOpenId, messageId, eventType and
 * eventTimestamp (original platform event time, NOT ingestion/replay time), plus
 * authorized:true after connector authentication AND send authorization checks.
 * Called again after token acquisition; it must consult current pause/identity/
 * binding/authorization state on every call, not replay a cached grant.
 * This adapter does not authenticate incoming webhook events itself.
 */
export class QQOfficialTextTransport {
  #options;
  constructor({ appId, issuer, account, getCredentials, resolveReplyContext, stateStore,
    fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 }) {
    check(valid(appId, 256) && valid(issuer, 256));
    check(account === JSON.stringify(['qq-official', issuer, appId]));
    check(typeof getCredentials === 'function' && typeof resolveReplyContext === 'function'
      && typeof fetchImpl === 'function' && typeof now === 'function' && typeof stateStore?.atomic === 'function');
    check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 25000);
    this.#options = { appId, issuer, account, getCredentials, resolveReplyContext, stateStore, fetchImpl, now, timeoutMs };
    this.capabilities = QQ_OFFICIAL_CAPABILITIES;
  }
  async send(input, signal) {
    const o = this.#options; const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) return result('failed');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, o.timeoutMs); let messageStarted = false; let reservation;
    const bounded = promise => wait(promise, controller.signal);
    const post = async (path, body, token) => {
      check(!controller.signal.aborted);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `QQBot ${token}`;
      const response = await bounded(o.fetchImpl(BASE + path, {
        method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal: controller.signal,
      }));
      const data = await readJSON(response, controller.signal);
      return { status: response.status, data };
    };
    try {
      // Snapshot before awaiting trusted callbacks so callers cannot change routing/text.
      const d = structuredClone(input);
      check(valid(d.id, 1024) && d.account === o.account && ['social', 'repetition', 'code-result', 'code-interaction'].includes(d.kind));
      check(typeof d.body === 'string' && d.body.trim().length > 0 && encoder.encode(d.body).byteLength <= 16000);
      const tuple = JSON.parse(d.conversation);
      check(Array.isArray(tuple) && tuple.length === 8 && JSON.stringify(tuple) === d.conversation
        && tuple[0] === 'juebot-conversation-v1' && tuple.slice(1).every(s => valid(s, 256))
        && tuple[3] === 'qq-official' && tuple[4] === o.issuer && tuple[5] === o.appId && ['group', 'direct'].includes(tuple[6]));
      check(Number.isSafeInteger(d.expiresAt) && o.now() < d.expiresAt);
      const c = structuredClone(await bounded(Promise.resolve().then(() => o.resolveReplyContext(structuredClone(d), { signal: controller.signal }))));
      check(c?.authorized === true && c.deliveryId === d.id && c.body === d.body
        && c.appId === o.appId && c.issuer === o.issuer && c.account === o.account && c.conversation === d.conversation
        && c.kind === tuple[6] && c.targetOpenId === tuple[7] && /^[A-Za-z0-9_-]{1,256}$/.test(c.targetOpenId)
        && valid(c.messageId) && c.eventType === (c.kind === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE'));
      const inWindow = () => Number.isSafeInteger(c.eventTimestamp) && c.eventTimestamp <= o.now()
        && o.now() < c.eventTimestamp + 300000 && o.now() < d.expiresAt;
      check(inWindow());
      const deliveryKey = 'qq-official:delivery:' + digest(JSON.stringify([o.account, d.id]));
      // QQ deduplicates within the app/platform target, independently of our
      // persona/bot IDs. Changing a local persona must not reset reply quota.
      const counterKey = 'qq-official:reply:' + digest(JSON.stringify([o.account, c.kind, c.targetOpenId, c.messageId]));
      const fingerprint = digest(JSON.stringify([d.conversation, d.kind, d.body, c.messageId]));
      reservation = o.stateStore.atomic(tx => {
        const previous = tx.read(deliveryKey);
        if (previous) { check(previous.value.fingerprint === fingerprint); return { existing: previous.value.outcome }; }
        const counter = tx.read(counterKey); const seq = (counter?.value.seq ?? 0) + 1;
        check(Number.isSafeInteger(seq) && seq <= (c.kind === 'group' ? 5 : 4));
        tx.write(counterKey, counter?.revision ?? 0, { seq });
        tx.write(deliveryKey, 0, { fingerprint, outcome: result('unknown') });
        return { deliveryKey, fingerprint, seq };
      });
      if (reservation.existing) return reservation.existing;
      const credential = await bounded(Promise.resolve().then(() => o.getCredentials({
        appId: o.appId, issuer: o.issuer, account: o.account, signal: controller.signal })));
      check(valid(credential?.clientSecret, 4096));
      const tokenResponse = await post('/app/getAppAccessToken', { appId: o.appId, clientSecret: credential.clientSecret });
      check(tokenResponse.status === 200 && valid(tokenResponse.data?.access_token, 8192)
        && Number.isFinite(Number(tokenResponse.data.expires_in)) && Number(tokenResponse.data.expires_in) > 0);
      // Token/credential I/O may outlive an authorization or binding. Re-attest
      // the exact original event and delivery, never follow a replacement route
      // or use a renewed event timestamp to extend the reply window.
      const latest = structuredClone(await bounded(Promise.resolve().then(() =>
        o.resolveReplyContext(structuredClone(d), { signal: controller.signal }))));
      check(latest?.authorized === true && ATTESTED_FIELDS.every(key => latest[key] === c[key]));
      check(inWindow() && !controller.signal.aborted);
      // A network exception or malformed success AFTER this point is uncertain;
      // its sequence remains consumed and this delivery is never auto-retried.
      messageStarted = true;
      const reply = await post(`/v2/${c.kind === 'group' ? 'groups' : 'users'}/${encodeURIComponent(c.targetOpenId)}/messages`,
        { msg_type: 0, content: d.body, msg_id: c.messageId, msg_seq: reservation.seq }, tokenResponse.data.access_token);
      let outcome = result('unknown');
      if (reply.status >= 200 && reply.status < 300 && valid(reply.data?.id) && (reply.data.code === undefined || reply.data.code === 0)) outcome = result('confirmed', reply.data.id);
      else if (reply.status >= 400 && reply.status < 500 && Number.isSafeInteger(reply.data?.code) && reply.data.code !== 0) outcome = result('failed');
      return this.#finish(reservation, outcome);
    } catch {
      const outcome = result(messageStarted ? 'unknown' : 'failed');
      try { return reservation?.deliveryKey ? this.#finish(reservation, outcome) : outcome; }
      catch { return result('unknown'); }
    } finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort); }
  }
  #finish(reservation, outcome) {
    return this.#options.stateStore.atomic(tx => {
      const old = tx.read(reservation.deliveryKey); check(old?.value.fingerprint === reservation.fingerprint);
      tx.write(reservation.deliveryKey, old.revision, { fingerprint: reservation.fingerprint, outcome }); return outcome;
    });
  }
}
