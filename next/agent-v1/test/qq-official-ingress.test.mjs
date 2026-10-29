import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../src/store.ts';
import { CodeTasks } from '../src/code-jobs.ts';
import { QQOfficialTextTransport } from '../host/qq-official-transport.js';
import { createQQOfficialIngress } from '../host/qq-official-ingress.js';

const timestamp = '2026-10-28T10:00:00.000Z';
const epoch = Date.parse(timestamp);
function fixture(t, overrides = {}, storeOverride) {
  const db = storeOverride ? null : new DatabaseSync(':memory:'); if (db) t.after(() => db.close());
  const stateStore = storeOverride ?? new SqliteStateStore(db, { namespace: 'ingress', initialize: true });
  const account = JSON.stringify(['qq-official', 'qq-open-platform', 'app']);
  const actor = JSON.stringify(['qq-official', 'qq-open-platform', 'app', 'user', 'user-openid']);
  const key = kind => JSON.stringify(['juebot-conversation-v1','bot','persona','qq-official','qq-open-platform','app',kind,
    kind === 'direct' ? 'user-openid' : 'group-openid']);
  const state = { group: false, verified: true, revision: 1, authorized: true, time: epoch + 1000 };
  const social = []; const admitted = []; const interactions=[];
  const tasks = new CodeTasks(stateStore, { getAuthorization: () => grant() });
  function grant() { return { revision: 1, adminActor: actor, conversationKey: key('direct'), account: 'app',
    workspaceId:'restricted-workspace',sessionId:'verified-session',modelConfigured:true,budgetAvailable:true,
    sandboxVerified:true,toolsRestricted:true,allowedTools:['read'],verified:state.verified }; }
  tasks.enable(state.time);
  const listeners = new Set();
  const sdk = { appId:'app', on(event,fn) { assert.equal(event,'message');listeners.add(fn); },
    off(event,fn) { listeners.delete(fn); }, start() { throw Error('must never login'); }, stop() { throw Error('must never disconnect'); } };
  const options = { appId:'app',issuer:'qq-open-platform',botId:'bot',personaId:'persona',stateStore,
    authenticateEvent: ({sdk: source}) => ({ authenticated:source === sdk,appId:'app',issuer:'qq-open-platform',account,actorKind:'human',self:false }),
    resolveBinding: identity => ({key:key(identity.kind),bindingRevision:state.revision}),
    authorizeReply: () => state.authorized,getAdminGrant:grant,
    codeTasks:{ admit(input,n) { admitted.push(input); return tasks.admit(input,n); },get:id=>tasks.get(id),
      control(command,n) { const state=tasks.snapshot();return command==='/开启code'?(state.value.enabled?state:tasks.enable(n)):(state.value.enabled?tasks.disable(n):state); } },
    onSocial: e=>{social.push(e);return 'social-received';},groupSocialEnabled:()=>state.group,now:()=>state.time,...overrides };
  options.codeTasks.respondInteraction=input=>{interactions.push(input);return {status:'responded'};};
  const ingress = createQQOfficialIngress(options);
  const msg = (kind='direct') => {
    const raw = { id:'message-1',content:'请修改项目说明',timestamp,author:kind==='direct'?{user_openid:'user-openid'}:{member_openid:'user-openid'},
      ...(kind==='group'?{group_openid:'group-openid'}:{}) };
    return { rawEventType:kind==='direct'?'C2C_MESSAGE_CREATE':'GROUP_AT_MESSAGE_CREATE',kind:kind==='direct'?'c2c':'group',
      senderId:'user-openid',messageId:raw.id,content:raw.content,timestamp,raw,
      ...(kind==='group'?{groupOpenid:'group-openid'}:{}),replyTarget:{scope:kind==='direct'?'c2c':'group',targetId:kind==='direct'?'user-openid':'group-openid',msgId:raw.id} };
  };
  async function emit(message=msg()) { const context={bot:sdk,message,replyTarget:message.replyTarget,aborted:false}; return Promise.all([...listeners].map(fn=>fn(context,message))); }
  return { db,ingress,options,state,account,actor,key,tasks,admitted,interactions,social,listeners,sdk,msg,emit };
}

test('inert construction; raw HTTP lookalike cannot mint SDK trust; subscription only owns own listener', async t=>{
  const f=fixture(t);assert.equal(f.listeners.size,0);
  await assert.rejects(f.ingress.receive({...f.msg(),authenticated:true}),/QQ_UNTRUSTED_INGRESS/);
  const other=()=>{};f.listeners.add(other);const dispose=f.ingress.subscribeSDK(f.sdk);
  assert.throws(()=>f.ingress.subscribeSDK(f.sdk),/QQ_SDK_INVALID/);dispose();dispose();
  assert.deepEqual([...f.listeners],[other]);assert.equal(f.tasks.list().length,0);
});
test('verified private plain text enters real persistent CodeTasks unchanged and never social',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);const [r]=await f.emit();
  assert.equal(r.route,'code');assert.equal(f.tasks.list().length,1);assert.equal(f.social.length,0);
  const task=f.tasks.list()[0];assert.equal(task.input.text,'请修改项目说明');assert.equal(task.input.actor,f.actor);
  assert.equal(task.input.account,'app');assert.equal(task.input.eventId,'message-1');
  const [repeat]=await f.emit();assert.equal(repeat.code,'QQ_EVENT_REPLAY');assert.equal(f.tasks.list().length,1);
});
test('group disabled by default; explicitly enabled group uses canonical social envelope',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);assert.equal((await f.emit(f.msg('group')))[0].code,'QQ_GROUP_DISABLED');
  f.state.group=true;await f.emit(f.msg('group'));assert.equal(f.social.length,1);assert.equal(f.tasks.list().length,0);
  const e=f.social[0];assert.equal(e.observedAt,epoch);assert.equal(e.key,f.key('group'));
  const identity={botId:'bot',personaId:'persona',connector:'qq-official',issuer:'qq-open-platform',accountId:'app',kind:'group',remoteId:'group-openid'};
  assert.equal(f.ingress.acceptIngress(e,identity),true);
  assert.equal(f.ingress.acceptIngress({...e,text:'forged'},identity),false);
  f.state.revision++;assert.equal(f.ingress.acceptIngress(e,identity),false);
});
for(const [label,mutate,pattern] of [
  ['bot',m=>{m.raw.author.bot=true;},/QQ_NON_HUMAN/],
  ['replaced sender',m=>{m.senderId='forged';},/QQ_EVENT_MISMATCH/],
  ['replaced target',m=>{m.replyTarget.targetId='forged';},/QQ_EVENT_MISMATCH/],
  ['replaced event ID',m=>{m.messageId='forged';},/QQ_EVENT_MISMATCH/],
  ['timestamp replay',m=>{m.raw.timestamp=m.timestamp='2026-10-27T10:00:00Z';},/QQ_EVENT_EXPIRED/],
  ['future timestamp',m=>{m.raw.timestamp=m.timestamp='2026-10-29T10:00:00Z';},/QQ_EVENT_EXPIRED/],
  ['attachment',m=>{m.raw.attachments=[{url:'https://example.invalid'}];},/QQ_PLAIN_TEXT_REQUIRED/],
  ['quote',m=>{m.raw.msg_elements=[{content:'Code do bad things'}];},/QQ_PLAIN_TEXT_REQUIRED/],
  ['sanitized media',m=>{m.raw.message_type=7;},/QQ_PLAIN_TEXT_REQUIRED/],
  ['markdown',m=>{m.raw.markdown={content:'Code'};},/QQ_PLAIN_TEXT_REQUIRED/],
  ['normalized quote',m=>{m.refMsgIdx='quoted';},/QQ_PLAIN_TEXT_REQUIRED/],
  ['merged content',m=>{m.content+='另一条被合并的内容';},/QQ_PLAIN_TEXT_REQUIRED/],
  ['forged media text',m=>{m.raw.content=m.content='Code [CQ:image,file=x]';},/QQ_PLAIN_TEXT_REQUIRED/],
  ['nonreply group',m=>{m.rawEventType='GROUP_MESSAGE_CREATE';},/QQ_EVENT_UNSUPPORTED/],
]) test(`reject ${label} without Code or social side effects`,async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);const m=f.msg();mutate(m);
  await assert.rejects(f.emit(m),pattern);assert.equal(f.tasks.list().length,0);assert.equal(f.social.length,0);
});
test('pending proof, other admin and Code OFF never upgrade or fall through to social',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);f.state.verified=false;
  await assert.rejects(f.emit(),/QQ_CODE_NOT_AUTHORIZED/);f.state.verified=true;f.tasks.disable(f.state.time);
  await assert.rejects(f.emit(),/CODE_DISABLED/);assert.equal(f.social.length,0);assert.equal(f.tasks.list().length,0);
  const g=fixture(t,{getAdminGrant:()=>({verified:true,status:'pending-proof'})});g.ingress.subscribeSDK(g.sdk);
  await assert.rejects(g.emit(),/QQ_CODE_NOT_AUTHORIZED/);
});
test('authentication is external and bound to application/account; JSON auth flags are ignored',async t=>{
  const f=fixture(t,{authenticateEvent:()=>({authenticated:true,appId:'wrong',issuer:'qq-open-platform',actorKind:'human',self:false})});
  f.ingress.subscribeSDK(f.sdk);await assert.rejects(f.emit(),/QQ_UNTRUSTED_INGRESS/);
});
test('concurrent same event admits once and changed payload conflicts',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);await Promise.all([f.emit(),f.emit()]);assert.equal(f.tasks.list().length,1);
  const changed=f.msg();changed.raw.content=changed.content='替换内容';await assert.rejects(f.emit(changed),/QQ_EVENT_CONFLICT/);
});
test('real SQLite reopen preserves dedup, including process-local adapter replacement',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-ingress-'));
  const path=join(dir,'state.db');let db=new DatabaseSync(path);let store=new SqliteStateStore(db,{namespace:'reopen',initialize:true});
  const f=fixture(t,{},store);f.ingress.subscribeSDK(f.sdk);await f.emit();db.close();
  db=new DatabaseSync(path);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});store=new SqliteStateStore(db,{namespace:'reopen'});
  const options={...f.options,stateStore:store};const reopened=createQQOfficialIngress(options);reopened.subscribeSDK(f.sdk);
  // Old adapter listener is detached before its closed store can be touched.
  const handler=[...f.listeners].at(-1);const m=f.msg();
  const result=await handler({bot:f.sdk,message:m,replyTarget:m.replyTarget},m);assert.equal(result.code,'QQ_EVENT_REPLAY');
});
test('Code result resolves the original message and transport rechecks revocation after token acquisition',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);await f.emit();const task=f.tasks.list()[0];f.tasks.start(task.id,f.state.time);f.tasks.finish(task.id,'已完成',f.state.time);
  const delivery={id:`${task.id}:result`,kind:'code-result',account:f.account,conversation:f.key('direct'),body:'已完成',expiresAt:epoch+200000,payload:{taskId:task.id}};
  const context=await f.ingress.resolveReplyContext(delivery);
  assert.equal(context.messageId,'message-1');assert.equal(context.eventTimestamp,epoch);assert.equal(context.targetOpenId,'user-openid');
  const requests=[];const transport=new QQOfficialTextTransport({appId:'app',issuer:'qq-open-platform',account:f.account,
    stateStore:f.options.stateStore,now:()=>f.state.time,getCredentials:()=>({clientSecret:'SYNTHETIC'}),resolveReplyContext:f.ingress.resolveReplyContext,
    fetchImpl:async(url)=>{requests.push(url);f.state.authorized=false;return new Response(JSON.stringify({access_token:'SYNTHETIC',expires_in:7200}));}});
  assert.equal((await transport.send(delivery)).status,'failed');assert.equal(requests.length,1);
  f.state.authorized=true;f.state.revision++;
  await assert.rejects(f.ingress.resolveReplyContext(delivery),/QQ_BINDING_CHANGED/);
});
test('social resolver attests only persisted exact-conversation original sources',async t=>{
  const f=fixture(t);f.state.group=true;f.ingress.subscribeSDK(f.sdk);await f.emit(f.msg('group'));
  const e=f.social[0];const sourceId=createHash('sha256').update(JSON.stringify([e.key,e.bindingRevision,e.eventId])).digest('hex');
  const d={id:'social-result',kind:'social',account:f.account,conversation:e.key,body:'回复',payload:{rawSources:[{sourceId,revision:1}]}};
  assert.equal((await f.ingress.resolveReplyContext(d)).messageId,e.eventId);
  await assert.rejects(f.ingress.resolveReplyContext({...d,payload:{rawSources:[{sourceId:'forged'}]}}),/QQ_REPLY_DENIED/);
  f.state.group=false;await assert.rejects(f.ingress.resolveReplyContext(d),/QQ_GROUP_DISABLED/);
});
test('missing configuration fails closed',()=>{assert.throws(()=>createQQOfficialIngress(),/QQ_INGRESS_NOT_CONFIGURED/);});
test('unsubscribe cancels a hanging authentication and idle settles before late proof',async t=>{
  let resolveAuth;let entered;
  const began=new Promise(r=>{entered=r;});
  const f=fixture(t,{authenticateEvent:()=>{entered();return new Promise(r=>{resolveAuth=r;});}});
  const dispose=f.ingress.subscribeSDK(f.sdk);const operation=f.emit();await began;dispose();
  const draining=f.ingress.idle();await assert.rejects(operation,/QQ_INGRESS_STOPPED/);await draining;
  resolveAuth({authenticated:true,appId:'app',issuer:'qq-open-platform',account:f.account,actorKind:'human',self:false});
  await new Promise(r=>setImmediate(r));assert.equal(f.tasks.list().length,0);
});
test('unsubscribe and idle drain an admitted social operation before closing its store',async t=>{
  let complete;const f=fixture(t,{onSocial:()=>new Promise(r=>{complete=r;})});f.state.group=true;
  const dispose=f.ingress.subscribeSDK(f.sdk);const operation=f.emit(f.msg('group'));await new Promise(r=>setImmediate(r));dispose();
  let idle=false;const draining=f.ingress.idle().then(()=>{idle=true;});await Promise.resolve();assert.equal(idle,false);
  complete('done');await operation;await draining;assert.equal(idle,true);
});
test('self attestation and unrelated admin are denied',async t=>{
  const f=fixture(t);f.options.authenticateEvent=()=>({authenticated:true,appId:'app',issuer:'qq-open-platform',account:f.account,actorKind:'human',self:true});
  const ingress=createQQOfficialIngress(f.options);ingress.subscribeSDK(f.sdk);await assert.rejects(f.emit(),/QQ_NON_HUMAN/);
  const g=fixture(t,{getAdminGrant:()=>({verified:true,adminActor:'12345678',account:'app',conversationKey:'fake'})});g.ingress.subscribeSDK(g.sdk);
  await assert.rejects(g.emit(),/QQ_CODE_NOT_AUTHORIZED/);
});
test('authentication timeout returns safely while a late proof cannot admit work',async t=>{
  let resolveAuth;let capturedSignal;
  const f=fixture(t,{authTimeoutMs:10,authenticateEvent:({signal})=>{capturedSignal=signal;return new Promise(r=>{resolveAuth=r;});}});
  f.ingress.subscribeSDK(f.sdk);await assert.rejects(f.emit(),/QQ_AUTH_TIMEOUT/);await f.ingress.idle();assert.equal(capturedSignal.aborted,true);
  resolveAuth({authenticated:true,appId:'app',issuer:'qq-open-platform',account:f.account,actorKind:'human',self:false});
  await new Promise(r=>setImmediate(r));assert.equal(f.tasks.list().length,0);
});
test('reserved exact private commands control Code before task admission and remain idempotent',async t=>{
  const f=fixture(t);f.tasks.disable(f.state.time);f.ingress.subscribeSDK(f.sdk);
  const m=f.msg();m.raw.content=m.content='/开启code';
  const [enabled]=await f.emit(m);assert.equal(enabled.route,'code-control');assert.equal(f.tasks.snapshot().value.enabled,true);
  const revision=f.tasks.snapshot().revision;assert.equal((await f.emit(m))[0].code,'QQ_EVENT_REPLAY');assert.equal(f.tasks.snapshot().revision,revision);
  const again=f.msg();again.raw.id=again.messageId=again.replyTarget.msgId='repeat-enable';again.raw.content=again.content='/开启code';
  await f.emit(again);assert.equal(f.tasks.snapshot().revision,revision);
  const off=f.msg();off.raw.id=off.messageId=off.replyTarget.msgId='disable';off.raw.content=off.content='/关闭code';
  assert.equal((await f.emit(off))[0].route,'code-control');assert.equal(f.tasks.snapshot().value.enabled,false);
  assert.equal(f.tasks.list().length,0);assert.equal(f.social.length,0);assert.equal(f.admitted.length,0);
});
test('control does not fall into model admission when callback is missing, or bypass nonadmin/group/quote checks',async t=>{
  const f=fixture(t);delete f.options.codeTasks.control;f.ingress.subscribeSDK(f.sdk);
  const cmd=f.msg();cmd.raw.content=cmd.content='/开启code';await assert.rejects(f.emit(cmd),/^Error: NOT_CONFIGURED$/);
  assert.equal(f.tasks.list().length,0);
  const group=f.msg('group');group.raw.content=group.content='/开启code';f.state.group=true;
  await assert.rejects(f.emit(group),/QQ_CODE_PRIVATE_REQUIRED/);assert.equal(f.social.length,0);
  const g=fixture(t);g.state.verified=false;g.ingress.subscribeSDK(g.sdk);const unauthorized=g.msg();unauthorized.raw.content=unauthorized.content='/关闭code';
  await assert.rejects(g.emit(unauthorized),/QQ_CODE_NOT_AUTHORIZED/);
  const quoted=g.msg();quoted.raw.content=quoted.content='/开启code';quoted.raw.msg_elements=[{content:'/开启code'}];
  await assert.rejects(g.emit(quoted),/QQ_PLAIN_TEXT_REQUIRED/);
});
test('only full exact control text is reserved; extra text remains an ordinary private Code input',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);const m=f.msg();m.raw.content=m.content='/开启code 然后修改项目';
  assert.equal((await f.emit(m))[0].route,'code');assert.equal(f.tasks.list()[0].input.text,m.raw.content);
});
test('approval answers bypass Code admission and preserve exact authenticated reply source',async t=>{
  const f=fixture(t);f.tasks.disable(f.state.time);f.ingress.subscribeSDK(f.sdk);
  const m=f.msg();m.raw.content=m.content='/code审批 request_1 3 允许';
  assert.equal((await f.emit(m))[0].route,'code-interaction');assert.equal(f.interactions.length,1);
  assert.deepEqual(f.interactions[0],{requestId:'request_1',revision:3,kind:'approval',decision:'allowed-once',
    source:{eventId:'message-1',actor:f.actor,conversationKey:f.key('direct'),account:'app',plain:true,text:m.raw.content,observedAt:epoch}});
  assert.equal((await f.emit(m))[0].code,'QQ_EVENT_REPLAY');assert.equal(f.interactions.length,1);
  assert.equal(f.tasks.list().length,0);assert.equal(f.admitted.length,0);assert.equal(f.social.length,0);
});
test('question answers use explicit SDK answer IDs/labels/custom text and denial stays single-request',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);const m=f.msg();
  const answers=[{id:'question-a',selected:['选项甲'],custom:'补充\n第二行'},{id:'question-b',custom:'自由答复'}];
  m.raw.content=m.content='/code答复 request_2 1 '+JSON.stringify({answers});await f.emit(m);
  assert.deepEqual(f.interactions[0].answers,answers);assert.equal(f.interactions[0].kind,'question');
  const reject=f.msg();reject.raw.id=reject.messageId=reject.replyTarget.msgId='deny-message';reject.raw.content=reject.content='/code审批 request_3 5 拒绝';
  await f.emit(reject);assert.equal(f.interactions[1].decision,'rejected');assert.equal(f.tasks.list().length,0);
});
for(const body of ['/code审批','/code审批 request 01 允许','/code审批 request 0 允许','/code审批 request 1 允许 ',
  '/code审批 request 1 允许 永久','/code审批 request 1 allow','/code审批 request 9007199254740992 允许',
  '/code答复 request 1 答案','/code答复 request 1 {"answers":[],"extra":true}',
  '/code答复 request 1 {"answers":[{"id":"q","selected":["A"],"admin":true}]}',
  '/code答复 request 1 {"answers":[{"id":"q","custom":"A"},{"id":"q","custom":"B"}]}'])
  test(`malformed reserved interaction never becomes a Code task: ${body}`,async t=>{
    const f=fixture(t);f.ingress.subscribeSDK(f.sdk);const m=f.msg();m.raw.content=m.content=body;
    await assert.rejects(f.emit(m),/QQ_CODE_COMMAND_INVALID/);assert.equal(f.tasks.list().length,0);assert.equal(f.interactions.length,0);
  });
test('interaction syntax cannot bypass external admin, private route, quote, or configured broker',async t=>{
  const f=fixture(t);f.ingress.subscribeSDK(f.sdk);const direct=f.msg();direct.raw.content=direct.content='/code审批 request 1 允许';
  f.state.verified=false;await assert.rejects(f.emit(direct),/QQ_CODE_NOT_AUTHORIZED/);f.state.verified=true;
  const group=f.msg('group');group.raw.content=group.content=direct.content;f.state.group=true;
  await assert.rejects(f.emit(group),/QQ_CODE_PRIVATE_REQUIRED/);
  const quoted=f.msg();quoted.raw.content=quoted.content=direct.content;quoted.raw.msg_elements=[{content:'approval'}];
  await assert.rejects(f.emit(quoted),/QQ_PLAIN_TEXT_REQUIRED/);
  delete f.options.codeTasks.respondInteraction;await assert.rejects(f.emit(direct),/NOT_CONFIGURED/);
  assert.equal(f.interactions.length,0);assert.equal(f.tasks.list().length,0);assert.equal(f.social.length,0);
});

const maintenanceReviewer = 'trusted-ingress-owner';
const permitMaintenance = proof => proof.reviewer === maintenanceReviewer;
function archiveInput(f, ids = ['message-1']) {
  const inspected = f.ingress.inspectIngress({ ids, reviewer: maintenanceReviewer });
  return { ids: inspected.items.map(({ id, revision }) => ({ id, revision })), expectedRevision: inspected.expectedRevision,
    reviewer: maintenanceReviewer, reason: 'Reviewed completed ingress dependencies' };
}
const sourceOf = envelope => createHash('sha256').update(JSON.stringify([envelope.key,envelope.bindingRevision,envelope.eventId])).digest('hex');

test('explicit direct social route never calls Code; precise controls still authenticate and cannot fall into social', async t => {
  const f = fixture(t, { directSocialEnabled: () => true }); f.ingress.subscribeSDK(f.sdk);
  const result = (await f.emit())[0]; assert.equal(result.route, 'social'); assert.equal(f.social.length, 1); assert.equal(f.admitted.length, 0);
  const identity = { botId:'bot',personaId:'persona',connector:'qq-official',issuer:'qq-open-platform',accountId:'app',kind:'direct',remoteId:'user-openid' };
  assert.equal(f.ingress.acceptSocialAttestation(f.social[0], identity), true);
  assert.equal(f.ingress.acceptSocialAttestation({ ...f.social[0],text:'forged' }, identity), false);
  const command = f.msg(); command.raw.id=command.messageId=command.replyTarget.msgId='command'; command.raw.content=command.content='/关闭code';
  assert.equal((await f.emit(command))[0].route, 'code-control'); assert.equal(f.social.length, 1);
  f.state.verified=false; command.raw.id=command.messageId=command.replyTarget.msgId='unauthorized-command';
  await assert.rejects(f.emit(command), /QQ_CODE_NOT_AUTHORIZED/); assert.equal(f.social.length, 1);
});

test('direct and group social map only explicit trusted raw message references into replyTo', async t => {
  const f = fixture(t, { directSocialEnabled: () => true }); f.state.group=true; f.ingress.subscribeSDK(f.sdk);
  for (const kind of ['direct','group']) { const message = f.msg(kind); message.raw.id=message.messageId=message.replyTarget.msgId=`quoted-${kind}`;
    message.raw.message_reference={message_id:'actual-outgoing-message',ignore_get_message_error:false}; await f.emit(message); }
  assert.equal(f.social[0].replyTo,'actual-outgoing-message'); assert.equal(f.social[1].replyTo,'actual-outgoing-message');
  const textOnly=f.msg();textOnly.raw.id=textOnly.messageId=textOnly.replyTarget.msgId='text-only';textOnly.raw.content=textOnly.content='引用 actual-outgoing-message';
  await f.emit(textOnly); assert.equal(Object.hasOwn(f.social[2],'replyTo'),false);
  const g=fixture(t);g.ingress.subscribeSDK(g.sdk); const quoted=g.msg();quoted.raw.message_reference={message_id:'actual-outgoing-message'};
  await assert.rejects(g.emit(quoted), /QQ_PLAIN_TEXT_REQUIRED/); assert.equal(g.tasks.list().length,0);
});

test('saved Code route cannot be attested or resolved as social after Host routing changes', async t => {
  let direct=false;const f=fixture(t,{directSocialEnabled:()=>direct});f.ingress.subscribeSDK(f.sdk);await f.emit();direct=true;
  await assert.rejects(f.emit(),/QQ_EVENT_CONFLICT/);const envelope={key:f.key('direct'),bindingRevision:1,eventId:'message-1',actor:f.actor,actorKind:'human',plain:true,text:f.msg().raw.content,observedAt:epoch};
  const identity={botId:'bot',personaId:'persona',connector:'qq-official',issuer:'qq-open-platform',accountId:'app',kind:'direct',remoteId:'user-openid'};
  assert.equal(f.ingress.acceptSocialAttestation(envelope,identity),false);
  await assert.rejects(f.ingress.resolveReplyContext({id:'forged-social',kind:'social',account:f.account,conversation:f.key('direct'),body:'no',payload:{rawSources:[{sourceId:sourceOf(envelope)}]}}),/QQ_REPLY_DENIED/);
});

test('explicit ingress archive preserves complete original and source proofs, frees hot capacity and never replays cold events', async t => {
  const f=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:permitMaintenance});f.ingress.subscribeSDK(f.sdk);await f.emit();
  const envelope=f.social[0], batch=archiveInput(f); const before=f.ingress.readArchivedIngress;
  const metadata=f.ingress.archiveIngress(batch);assert.equal(metadata.length,1);assert.equal(metadata[0].route,'social');
  const record=f.ingress.readArchivedIngress({eventId:'message-1',reviewer:maintenanceReviewer});assert.deepEqual(record.original.proof.envelope,envelope);
  assert.equal(record.audit.reviewer,maintenanceReviewer);assert.equal(f.ingress.listArchivedIngress({reviewer:maintenanceReviewer}).total,1);
  assert.equal((await f.emit())[0].code,'QQ_EVENT_REPLAY');assert.equal(f.social.length,1);
  const delivery={id:'social-result',kind:'social',account:f.account,conversation:envelope.key,body:'reply',payload:{rawSources:[{sourceId:sourceOf(envelope),revision:1}]}};
  assert.equal((await f.ingress.resolveReplyContext(delivery)).messageId,'message-1');
  const identity={botId:'bot',personaId:'persona',connector:'qq-official',issuer:'qq-open-platform',accountId:'app',kind:'direct',remoteId:'user-openid'};
  assert.equal(f.ingress.acceptSocialAttestation(envelope,identity),true);
  const cap=f.db.prepare("SELECT value FROM agent_state WHERE key LIKE 'qq-official:ingress-capacity:%'").get();assert.equal(JSON.parse(cap.value).count,0);
  assert.throws(()=>f.ingress.archiveIngress(batch),/QQ_ARCHIVE_CONFLICT/);
  assert.throws(()=>f.ingress.readArchivedIngress({eventId:'message-1',reviewer:'forged'}),/QQ_MAINTENANCE_DENIED/);
});

test('ingress archive rejects processing and unknown callback outcomes without discarding evidence', async t => {
  let finish;const f=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:permitMaintenance,onSocial:()=>new Promise(r=>{finish=r;})});
  const stop=f.ingress.subscribeSDK(f.sdk);const operation=f.emit();await new Promise(r=>setImmediate(r));
  assert.throws(()=>f.ingress.archiveIngress(archiveInput(f)),/QQ_EVENT_NOT_TERMINAL/);finish('done');await operation;stop();
  const g=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:permitMaintenance,onSocial:()=>{throw Error('social fault');}});g.ingress.subscribeSDK(g.sdk);
  await assert.rejects(g.emit(),/social fault/);assert.throws(()=>g.ingress.archiveIngress(archiveInput(g)),/QQ_EVENT_NOT_TERMINAL/);
});

test('ingress archive validates the whole batch, CAS, immutable caller inputs, revoked authority and SQLite rollback', async t => {
  let calls=0,authority=true,mutation;const f=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:proof=>{
    assert.ok(Object.isFrozen(proof)&&Object.isFrozen(proof.items));if(mutation)mutation();calls++;return authority&&proof.reviewer===maintenanceReviewer;
  }});f.ingress.subscribeSDK(f.sdk);await f.emit();const batch=archiveInput(f);const before=f.db.prepare('SELECT * FROM agent_state ORDER BY key').all();
  assert.throws(()=>f.ingress.archiveIngress({...batch,ids:[...batch.ids,{id:'missing',revision:1}]}),/QQ_EVENT_NOT_TERMINAL/);
  assert.throws(()=>f.ingress.archiveIngress({...batch,expectedRevision:batch.expectedRevision+1}),/QQ_ARCHIVE_CONFLICT/);
  calls=0;mutation=()=>{if(calls===1)authority=false;};assert.throws(()=>f.ingress.archiveIngress(batch),/QQ_MAINTENANCE_DENIED/);
  mutation=null;authority=true;assert.deepEqual(f.db.prepare('SELECT * FROM agent_state ORDER BY key').all(),before);
  f.db.exec(`CREATE TEMP TRIGGER reject_cold BEFORE INSERT ON agent_state WHEN NEW.key LIKE 'qq-official:ingress-archive:%' BEGIN SELECT RAISE(FAIL,'fault'); END`);
  assert.throws(()=>f.ingress.archiveIngress(batch));assert.deepEqual(f.db.prepare('SELECT * FROM agent_state ORDER BY key').all(),before);f.db.exec('DROP TRIGGER reject_cold');
  mutation=()=>{batch.reviewer='changed';batch.ids[0].id='changed';}; f.ingress.archiveIngress(batch);mutation=null;
  assert.equal(f.ingress.readArchivedIngress({eventId:'message-1',reviewer:maintenanceReviewer}).audit.reviewer,maintenanceReviewer);
});

test('cold ingress detects full-record hash alteration and preserves event replay tombstone', async t => {
  const f=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:permitMaintenance});f.ingress.subscribeSDK(f.sdk);await f.emit();f.ingress.archiveIngress(archiveInput(f));
  const row=f.db.prepare("SELECT key,value FROM agent_state WHERE key LIKE 'qq-official:ingress-archive:%'").get();const record=JSON.parse(row.value);record.audit.reason='altered';
  f.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(record),row.key);
  assert.throws(()=>f.ingress.readArchivedIngress({eventId:'message-1',reviewer:maintenanceReviewer}),/QQ_ARCHIVE_CORRUPT/);
  assert.equal((await f.emit())[0].code,'QQ_EVENT_REPLAY');assert.equal(f.social.length,1);
});

test('explicit ingress archive frees one full hot slot without losing permanent event/source tombstones', async t => {
  const f=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:permitMaintenance});f.ingress.subscribeSDK(f.sdk);await f.emit();
  const row=f.db.prepare("SELECT key FROM agent_state WHERE key LIKE 'qq-official:ingress-capacity:%'").get();
  f.options.stateStore.atomic(tx=>{const current=tx.read(row.key);tx.write(row.key,current.revision,{count:2048});});
  const fresh=f.msg();fresh.raw.id=fresh.messageId=fresh.replyTarget.msgId='after-full';await assert.rejects(f.emit(fresh),/QQ_INGRESS_CAPACITY/);
  f.ingress.archiveIngress(archiveInput(f));await f.emit(fresh);assert.equal(f.social.length,2);assert.equal((await f.emit())[0].code,'QQ_EVENT_REPLAY');
  assert.equal(JSON.parse(f.db.prepare('SELECT value FROM agent_state WHERE key=?').get(row.key).value).count,2048);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_state WHERE key LIKE 'qq-official:source:%'").get().n,2);
});

test('ingress archive cold index is bounded at 4096 and missing/async authority cannot authorize a maintenance write', async t => {
  const f=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:permitMaintenance});f.ingress.subscribeSDK(f.sdk);await f.emit();const batch=archiveInput(f);
  const key='qq-official:ingress-archives:'+createHash('sha256').update(JSON.stringify(f.account)).digest('hex');
  f.options.stateStore.atomic(tx=>tx.write(key,0,Array.from({length:4096},(_,i)=>({id:`old-${i}`,hash:'synthetic',route:'social',kind:'direct',at:epoch}))));
  assert.throws(()=>f.ingress.archiveIngress(batch),/QQ_ARCHIVE_CAPACITY/);
  for(const authorizeIngressMaintenance of [undefined,()=>false,()=>Promise.resolve(true),()=>Promise.reject(Error('private-host-failure'))]){
    const g=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance});g.ingress.subscribeSDK(g.sdk);await g.emit();
    assert.throws(()=>g.ingress.inspectIngress({ids:['message-1'],reviewer:maintenanceReviewer}),/QQ_MAINTENANCE_DENIED/);
  }
});

test('ingress direct routing and maintenance reject async routes, forged shapes and mutated event snapshots', async t => {
  const invalid=fixture(t,{routeDirect:()=>Promise.resolve('social')});invalid.ingress.subscribeSDK(invalid.sdk);await assert.rejects(invalid.emit(),/QQ_ROUTE_INVALID/);
  let effect;const f=fixture(t,{directSocialEnabled:()=>true,authorizeIngressMaintenance:()=>{effect?.();return true;}});f.ingress.subscribeSDK(f.sdk);await f.emit();const batch=archiveInput(f);
  const getter={...batch};Object.defineProperty(getter,'reviewer',{enumerable:true,get(){throw Error('getter executed');}});
  assert.throws(()=>f.ingress.archiveIngress(getter),/QQ_MAINTENANCE_INVALID/);assert.throws(()=>f.ingress.archiveIngress({...batch,[Symbol('extra')]:true}),/QQ_MAINTENANCE_INVALID/);
  const before=f.db.prepare('SELECT * FROM agent_state ORDER BY key').all();
  effect=()=>{const row=f.db.prepare("SELECT key,value FROM agent_state WHERE key LIKE 'qq-official:ingress:%'").get();const value=JSON.parse(row.value);value.phase='unknown';f.db.prepare('UPDATE agent_state SET value=? WHERE key=?').run(JSON.stringify(value),row.key);};
  assert.throws(()=>f.ingress.archiveIngress(batch),/QQ_ARCHIVE_CONFLICT/);assert.deepEqual(f.db.prepare('SELECT * FROM agent_state ORDER BY key').all(),before);
});
