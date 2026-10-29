import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../src/store.ts';
import { ConversationLedger } from '../../conversation-v1/src/ledger.ts';
import { BotRuntime } from '../src/runtime.ts';
import { CreationService } from '../src/creation.ts';
import { CodeTasks } from '../src/code-jobs.ts';
import { DispatchCoordinator } from '../src/dispatch.ts';
import { QQOfficialTextTransport } from '../host/qq-official-transport.js';
import { createQQOfficialCodeChannel } from '../host/qq-official-code-channel.js';
import { syntheticDsh } from './support/dsh-code-sdk.mjs';

const timestamp = '2026-10-28T10:00:00.000Z';const at=Date.parse(timestamp)+1000;
const tick=()=>new Promise(r=>setImmediate(r));
const model={provider:'synthetic-provider',model:'synthetic-model',maxTokens:512};
async function waitFor(read) { for(let i=0;i<200;i++){const value=read();if(value)return value;await tick();}assert.fail('expected interaction state did not appear'); }
const nextNotice=(f,previous=[])=>waitFor(()=>f.runtime.outbox.list().find(d=>d.kind==='code-interaction'&&!previous.includes(d.id)));

// Only the external DSH Agent service and QQ event source are synthetic. The
// actual executor, CodeTasks, runtime, SQLite and common dispatcher run below.
function sdkService(workspace,{blocked=false,behavior}={}) {
  const release=[];
  const fixture=syntheticDsh({workspace,behavior:async (run,service)=>{
    if(behavior)return behavior(run,service);
    if(blocked) await new Promise(r=>release.push(r));
    run.options.signal.throwIfAborted();run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    run.assistant('',[{type:'reasoning',text:'PRIVATE REASONING MUST STAY IN DSH'},{type:'text',text:'synthetic final result'}]);run.end();
  }});
  return {ctx:fixture.ctx,get submitted(){return fixture.runs.map(run=>run.message);},get runs(){return fixture.runs;},get factory(){return fixture.calls;},get disposed(){return fixture.disposed;},
    releaseOne(){assert.ok(release.length);release.shift()();}};
}
function fixture(t,{blocked=false,enabled=true,authorizeReply,authenticateEvent,behavior,timeoutMs=1000,authorizeCodeMaintenance,verifyCodeSessionStopped,socialOptions={}}={}) {
  let currentAt=at;
  const dir=mkdtempSync(join(tmpdir(),'qq-code-channel-'));
  const db=new DatabaseSync(':memory:'),events=new DatabaseSync(':memory:');
  const actual=new SqliteStateStore(db,{namespace:'channel',initialize:true});let released=false;let lateAccess=0;let failCodeRead=false;
  const store={read(key){if(released){lateAccess++;throw Error('LATE STORE READ');}
    if(failCodeRead&&key===JSON.stringify(['code-jobs-v1','default'])){failCodeRead=false;throw Object.assign(new Error('STORAGE_FAILURE'),{code:'STORAGE_FAILURE'});}
    return actual.read(key);},
    atomic(work){if(released){lateAccess++;throw Error('LATE STORE WRITE');}return actual.atomic(work);}};
  const ledger=new ConversationLedger(events,{namespace:'channel',initialize:true});
  const runtimeOptions={profile:{botId:'bot',personaId:'juejue',mode:'juejue',name:'撅撅',roleCore:'synthetic core'},
    now:()=>currentAt,model:null,acceptIngress:()=>false,authorizeLearning:()=>false,
    participation:()=>({enabled:false,allowedTargets:[],deniedTargets:[],timeZoneOffsetMinutes:0,windows:[],cooldownMs:0,dailyLimit:0,unansweredLimit:0})};
  let runtime=new BotRuntime(store,ledger,runtimeOptions);
  const key=runtime.register({botId:'bot',personaId:'juejue',connector:'qq-official',issuer:'official-synthetic',accountId:'app',kind:'direct',remoteId:'admin-open-id'},1,'synthetic private');
  const groupKey=runtime.register({botId:'bot',personaId:'juejue',connector:'qq-official',issuer:'official-synthetic',accountId:'app',kind:'group',remoteId:'group-open-id'},1,'synthetic group');
  const account=JSON.stringify(['qq-official','official-synthetic','app']);
  const actor=JSON.stringify(['qq-official','official-synthetic','app','user','admin-open-id']);
  const grant={revision:1,adminActor:actor,conversationKey:key,account:'app',workspaceId:'controlled',sessionId:'code-private',
    modelConfigured:true,budgetAvailable:true,sandboxVerified:true,toolsRestricted:true,allowedTools:['read'],verified:true};
  const code=new CodeTasks(store,{getAuthorization:()=>grant});if(enabled)code.enable(at);
  const creation=new CreationService(store,{now:()=>currentAt,authorizeHuman:()=>false,resolveAsset:()=>null,currentAuthority:()=>({publishAllowed:false})});
  const dispatcher=new DispatchCoordinator(runtime,creation,code,()=>currentAt,{resolveAccount:handle=>handle==='app'?account:null});
  const application={get runtime(){return runtime;},code,dispatcher};
  const handlers=new Set();const qqSDK={appId:'app',on(event,fn){assert.equal(event,'message');handlers.add(fn);},off(event,fn){handlers.delete(fn);},
    start(){assert.fail('must never login');},stop(){assert.fail('must never disconnect foreign SDK');}};
  const dsh=sdkService(dir,{blocked,behavior});
  const channelOptions={application,ctx:dsh.ctx,stateStore:store,sdk:qqSDK,
    qq:{appId:'app',issuer:'official-synthetic'},
    authenticateEvent:authenticateEvent??(()=>({authenticated:true,appId:'app',issuer:'official-synthetic',account,actorKind:'human',self:false})),
    resolveBinding:identity=>({key:identity.kind==='group'?groupKey:key,bindingRevision:1}),authorizeReply:authorizeReply??(()=>true),getAdminGrant:()=>grant,
    resolveWorkspace:id=>{assert.equal(id,'controlled');return dir;},model,now:()=>currentAt,timeoutMs,cleanupTimeoutMs:100,
    authorizeCodeMaintenance,verifyCodeSessionStopped,...socialOptions};
  const channel=createQQOfficialCodeChannel(channelOptions);
  function message(id='message-1',body='请在指定工作区检查项目说明'){
    const originalTimestamp=new Date(currentAt).toISOString();
    const raw={id,content:body,timestamp:originalTimestamp,author:{user_openid:'admin-open-id'}};
    return{kind:'c2c',rawEventType:'C2C_MESSAGE_CREATE',senderId:'admin-open-id',messageId:id,timestamp:originalTimestamp,content:body,raw,
      replyTarget:{scope:'c2c',targetId:'admin-open-id',msgId:id}};
  }
  const emit=async(m=message())=>Promise.all([...handlers].map(fn=>fn({bot:qqSDK,message:m,replyTarget:m.replyTarget,aborted:false},m)));
  let disposed=false;let expectedCloseFailure=false;
  function releaseDatabase(){if(disposed)return;disposed=true;runtime.close();actual.close();db.close();ledger.close();events.close();released=true;}
  t.after(async()=>{try{if(expectedCloseFailure)await assert.rejects(channel.close(),/CODE_CHANNEL_CLOSE_FAILED/);else await channel.close();}
    finally{releaseDatabase();rmSync(dir,{recursive:true,force:true});}});
  return{runtimeOptions,groupKey,channel,channelOptions,application,code,dispatcher,store,ledger,dsh,key,account,grant,handlers,message,emit,
    get now(){return currentAt;},advance(ms){currentAt+=ms;},
    makeDatabaseReadOnly(){db.exec('PRAGMA query_only=ON');},makeDatabaseWritable(){db.exec('PRAGMA query_only=OFF');},
    stateRows(){return db.prepare('SELECT key,revision,value FROM agent_state ORDER BY key').all();},
    expectCloseFailure(){expectedCloseFailure=true;},failNextCodeRead(){failCodeRead=true;},
    get runtime(){return runtime;},releaseDatabase,get lateAccess(){return lateAccess;},
    switchProfile(){runtime.close();runtime=new BotRuntime(store,ledger,{...runtimeOptions,profile:{...runtimeOptions.profile,personaId:'new-persona',mode:'persona'}});}};
}

test('SDK private text reaches native DSH once, stays out of social, then only explicit shared dispatch sends',async t=>{
  const f=fixture(t);assert.equal(f.handlers.size,0);assert.equal(f.dsh.factory.length,0);
  f.channel.start();const body='请检查代码\n保留这条原始文字。';await f.emit(f.message('original-id',body));await f.channel.idle();
  const task=f.code.list()[0];assert.equal(task.input.text,body);assert.equal(task.input.eventId,'original-id');assert.equal(task.state,'completed');
  assert.equal(f.dsh.submitted.length,1);assert.deepEqual(f.dsh.submitted[0].content,[{type:'text',text:body}]);
  assert.equal(f.dsh.factory.length,1);assert.equal(f.runtime.learning().length,0);assert.equal(f.ledger.pageEvents(f.key,1,0,20).length,0);
  const item=f.runtime.outbox.list()[0];assert.equal(item.kind,'code-result');assert.equal(item.account,f.account);assert.equal(item.conversation,f.key);
  assert.equal(item.body,'synthetic final result');assert.equal(item.body.includes('PRIVATE REASONING'),false);assert.equal(item.status,'queued');
  const [replay]=await f.emit(f.message('original-id',body));assert.equal(replay.code,'QQ_EVENT_REPLAY');await f.channel.idle();assert.equal(f.dsh.submitted.length,1);
  const network=[];const transport=new QQOfficialTextTransport({appId:'app',issuer:'official-synthetic',account:f.account,stateStore:f.store,now:()=>at,
    resolveReplyContext:f.channel.resolveReplyContext,getCredentials:()=>({clientSecret:'SYNTHETIC-NOT-A-CREDENTIAL'}),
    fetchImpl:async(url,init)=>{network.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify(url.endsWith('getAppAccessToken')?
      {access_token:'SYNTHETIC',expires_in:7200}:{id:'synthetic-platform-message'}));}});
  assert.equal(network.length,0);f.runtime.outbox.setPause(f.runtime.outbox.state().revision,false);
  const result=await f.dispatcher.dispatch(f.account,'synthetic-owner',{id:'synthetic-budget',limit:10},(d,s)=>transport.send(d,s));
  assert.equal(result.status,'confirmed');assert.equal(network.length,2);assert.equal(network[1].body.msg_id,'original-id');assert.equal(network[1].body.content,'synthetic final result');
  assert.equal(f.code.get(task.id).resultDelivery,'delivered');
});

test('channel close cancels reply authorization await and late resolution never reads a released SQLite',async t=>{
  let resolveAuthorization;let started;const entering=new Promise(r=>{started=r;});
  const f=fixture(t,{authorizeReply:()=>{started();return new Promise(r=>{resolveAuthorization=r;});}});
  f.channel.start();await f.emit();await f.channel.idle();const delivery=f.runtime.outbox.list()[0];
  const proof=f.channel.resolveReplyContext(delivery);const rejected=assert.rejects(proof,/CODE_CHANNEL_CLOSED/);await entering;
  await f.channel.close();assert.equal(f.handlers.size,0);await rejected;f.releaseDatabase();resolveAuthorization(true);await tick();
  assert.equal(f.lateAccess,0);await assert.rejects(f.channel.resolveReplyContext(delivery),/CODE_CHANNEL_CLOSED/);
});

test('OFF allows the running DSH turn to finish and holds the already queued private task',async t=>{
  const f=fixture(t,{blocked:true});f.channel.start();await f.emit(f.message('running'));await tick();await f.emit(f.message('queued'));
  assert.equal(f.code.list()[0].state,'running');assert.equal(f.code.list()[1].state,'queued');f.code.disable(at);
  await assert.rejects(f.emit(f.message('off-new')),/CODE_DISABLED/);f.dsh.releaseOne();await f.channel.idle();
  assert.equal(f.code.list()[0].state,'completed');assert.equal(f.code.list()[1].state,'held');assert.equal(f.dsh.submitted.length,1);
  assert.equal(f.runtime.outbox.list().length,1);assert.equal(f.runtime.learning().length,0);
});

test('changing persona invalidates the channel original target and new ingress',async t=>{
  const f=fixture(t);f.channel.start();await f.emit();await f.channel.idle();const delivery=f.runtime.outbox.list()[0];
  assert.equal((await f.channel.resolveReplyContext(delivery)).targetOpenId,'admin-open-id');f.switchProfile();
  await assert.rejects(f.channel.resolveReplyContext(delivery),/CODE_CHANNEL_IDENTITY_CHANGED/);
  await assert.rejects(f.emit(f.message('new-profile')),/CODE_CHANNEL_IDENTITY_CHANGED/);assert.equal(f.dsh.submitted.length,1);
});

test('close aborts native Agent execution and drains domain changes before the database is released',async t=>{
  const f=fixture(t,{blocked:true});f.channel.start();await f.emit();await tick();assert.equal(f.code.list()[0].state,'running');
  await f.channel.close();assert.equal(f.code.list()[0].state,'needs-review');assert.equal(f.runtime.outbox.list().length,0);f.releaseDatabase();
  f.dsh.releaseOne();await tick();assert.equal(f.lateAccess,0);assert.throws(()=>f.channel.start(),/CODE_CHANNEL_CLOSED/);
});
test('same application has one channel owner; close releases ownership without enabling Code or subscribing again',async t=>{
  const f=fixture(t);f.channel.start();assert.throws(()=>createQQOfficialCodeChannel(f.channelOptions),/CODE_CHANNEL_ALREADY_OWNED/);
  await f.channel.close();assert.equal(f.code.snapshot().value.enabled,false);assert.equal(f.handlers.size,0);
  const replacement=createQQOfficialCodeChannel(f.channelOptions);
  assert.equal(replacement.status().started,false);assert.equal(f.handlers.size,0);assert.equal(f.code.snapshot().value.enabled,false);
  assert.equal(f.dsh.factory.length,0);await replacement.close();
});
test('channel close cancels a hanging SDK authentication and ignores proof returned after database release',async t=>{
  let complete;let signal;let began;const entered=new Promise(r=>{began=r;});
  const f=fixture(t,{authenticateEvent:input=>{signal=input.signal;began();return new Promise(r=>{complete=r;});}});
  f.channel.start();const operation=f.emit();const rejected=assert.rejects(operation,/QQ_INGRESS_STOPPED/);await entered;
  await f.channel.close();await rejected;assert.equal(signal.aborted,true);assert.equal(f.code.list().length,0);f.releaseDatabase();
  complete({authenticated:true,appId:'app',issuer:'official-synthetic',account:f.account,actorKind:'human',self:false});
  await tick();assert.equal(f.lateAccess,0);assert.equal(f.dsh.factory.length,0);
});
test('QQ exact control commands enable default-OFF Code and disable admission immediately during a running model turn',async t=>{
  const f=fixture(t,{blocked:true,enabled:false});f.channel.start();assert.equal(f.code.snapshot().value.enabled,false);
  const enable=f.message('enable-command','/开启code');assert.equal((await f.emit(enable))[0].route,'code-control');
  assert.equal(f.code.snapshot().value.enabled,true);assert.equal(f.dsh.factory.length,0);assert.equal(f.code.list().length,0);
  const enabledRevision=f.code.snapshot().revision;assert.equal((await f.emit(enable))[0].code,'QQ_EVENT_REPLAY');
  await f.emit(f.message('enable-again','/开启code'));assert.equal(f.code.snapshot().revision,enabledRevision);
  await f.emit(f.message('running-task'));await tick();await f.emit(f.message('queued-task'));
  assert.equal(f.code.list()[0].state,'running');assert.equal(f.code.list()[1].state,'queued');
  // This resolves while the DSH fixture is still blocked, proving no model FIFO
  // wait and no cancellation of the active task are involved in the command.
  const disable=f.message('disable-command','/关闭code');assert.equal((await f.emit(disable))[0].route,'code-control');
  assert.equal(f.code.snapshot().value.enabled,false);assert.equal(f.code.list()[0].state,'running');assert.equal(f.code.list()[1].state,'held');
  const offRevision=f.code.snapshot().revision;assert.equal((await f.emit(disable))[0].code,'QQ_EVENT_REPLAY');
  await f.emit(f.message('disable-again','/关闭code'));assert.equal(f.code.snapshot().revision,offRevision);
  await assert.rejects(f.emit(f.message('after-disable')),/CODE_DISABLED/);assert.equal(f.runtime.outbox.list().length,0);
  f.dsh.releaseOne();await f.channel.idle();assert.equal(f.code.list()[0].state,'completed');assert.equal(f.dsh.submitted.length,1);
  assert.equal(f.code.list().length,2);assert.equal(f.runtime.outbox.list().length,1);assert.equal(f.runtime.learning().length,0);
});
test('nonadmin command is denied without creating a task or changing OFF',async t=>{
  const f=fixture(t,{enabled:false});f.channel.start();f.grant.verified=false;
  await assert.rejects(f.emit(f.message('not-admin','/开启code')),/QQ_CODE_NOT_AUTHORIZED/);
  assert.equal(f.code.snapshot().value.enabled,false);assert.equal(f.code.list().length,0);assert.equal(f.dsh.factory.length,0);
  f.grant.verified=true;const group=f.message('group-command','/开启code');
  group.kind='group';group.rawEventType='GROUP_AT_MESSAGE_CREATE';group.senderId='member-open-id';
  group.raw.author={member_openid:'member-open-id'};group.raw.group_openid=group.groupOpenid='group-open-id';
  group.replyTarget.scope='group';group.replyTarget.targetId='group-open-id';
  await assert.rejects(f.emit(group),/QQ_CODE_PRIVATE_REQUIRED/);
  assert.equal(f.code.snapshot().value.enabled,false);assert.equal(f.runtime.learning().length,0);assert.equal(f.runtime.outbox.list().length,0);
});
test('QQ single-use approval resumes the same native Agent promise and final reply attests the new answer event',async t=>{
  let tool;
  const f=fixture(t,{timeoutMs:10000,behavior:async run=>{
    run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    tool=await run.approvedTool('read',{path:'synthetic.txt'},{callId:'read-once'});
    await run.model();run.assistant(tool.executed?'approved once':'denied');run.end();
  }});
  f.channel.start();await f.emit(f.message('original-task','检查文件'));const notice=await nextNotice(f);
  assert.equal(f.code.list()[0].state,'running');assert.equal(f.dsh.factory.length,1);assert.equal(tool,undefined);
  assert.equal(notice.account,f.account);assert.equal(notice.conversation,f.key);assert.match(notice.body,/read/);
  const originalProof=await f.channel.resolveReplyContext(notice);assert.equal(originalProof.messageId,'original-task');
  assert.equal(f.runtime.learning().length,0);assert.equal(f.ledger.pageEvents(f.key,1,0,20).length,0);
  const network=[];
  const transport=new QQOfficialTextTransport({appId:'app',issuer:'official-synthetic',account:f.account,stateStore:f.store,now:()=>f.now,
    resolveReplyContext:f.channel.resolveReplyContext,getCredentials:()=>({clientSecret:'SYNTHETIC'}),
    fetchImpl:async(url,init)=>{network.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify(url.endsWith('getAppAccessToken')?
      {access_token:'SYNTHETIC',expires_in:7200}:{id:'interaction-notice-receipt'}));}});
  assert.equal(network.length,0);f.runtime.outbox.setPause(f.runtime.outbox.state().revision,false);
  const sent=await f.dispatcher.dispatch(f.account,'notice-owner',{id:'notice-budget',limit:10},(delivery,signal)=>transport.send(delivery,signal));
  assert.equal(sent.kind,'code-interaction');assert.equal(sent.status,'confirmed');assert.equal(network.length,2);
  assert.equal(network[1].body.msg_id,'original-task');assert.equal(network[1].body.content,notice.body);assert.equal(tool,undefined);
  f.advance(3000);const answer=f.message('approval-reply',`/code审批 ${notice.payload.requestId} ${notice.payload.requestRevision} 允许`);
  const answered=await f.emit(answer);assert.equal(answered[0].route,'code-interaction');await f.channel.idle();
  assert.equal(tool.outcome,'allowed-once');assert.equal(tool.executed,true);assert.equal(f.dsh.factory.length,1);assert.equal(f.dsh.submitted.length,1);
  const task=f.code.list()[0];assert.equal(task.state,'completed');assert.equal(task.input.eventId,'original-task');assert.equal(task.input.text,'检查文件');
  const final=f.runtime.outbox.list().find(d=>d.kind==='code-result');assert.equal(final.body,'approved once');
  const proof=await f.channel.resolveReplyContext(final);assert.equal(proof.messageId,'approval-reply');assert.equal(proof.eventTimestamp,Date.parse(answer.raw.timestamp));
  await assert.rejects(f.channel.resolveReplyContext(notice),/QQ_REPLY_DENIED/);
  assert.equal(final.status,'queued');assert.equal(network.length,2); // response did not automatically send its final result
  const [replay]=await f.emit(answer);assert.equal(replay.code,'QQ_EVENT_REPLAY');assert.equal(f.dsh.submitted.length,1);
  f.advance(300000);await assert.rejects(f.channel.resolveReplyContext(final),/QQ_EVENT_EXPIRED/);
});
test('OFF still permits the current task explicit question reply without starting another turn or enabling queued work',async t=>{
  let response;
  const f=fixture(t,{timeoutMs:10000,behavior:async run=>{
    run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    response=await run.hook('user-questions/request',{agent:run.agent,questions:[{id:'choice',question:'选择哪个方案？',options:[{label:'方案甲'},{label:'方案乙'}]}],
      signal:run.options.signal,wait:{callId:'question-choice'}});
    await run.model();run.assistant('答复已处理');run.end();
  }});
  f.channel.start();await f.emit(f.message('question-task'));const notice=await nextNotice(f);await f.emit(f.message('queued-after-question'));
  const queued=f.code.list()[1];
  await assert.rejects(f.channel.resolveReplyContext({...notice,payload:{...notice.payload,taskId:queued.id}}),/QQ_REPLY_DENIED/);
  await assert.rejects(f.channel.resolveReplyContext({...notice,payload:{...notice.payload,requestRevision:2}}),/QQ_REPLY_DENIED/);
  await assert.rejects(f.channel.resolveReplyContext({...notice,body:notice.body+' 替换工具参数'}),/QQ_REPLY_DENIED/);
  await f.emit(f.message('disable-while-waiting','/关闭code'));assert.equal(f.code.snapshot().value.enabled,false);
  assert.equal(f.code.list()[0].state,'running');assert.equal(f.code.list()[1].state,'held');f.advance(3000);
  const answers=[{id:'choice',selected:['方案乙'],custom:'这次按乙处理'}];
  const answer=f.message('question-answer',`/code答复 ${notice.payload.requestId} ${notice.payload.requestRevision} ${JSON.stringify({answers})}`);
  await f.emit(answer);await f.channel.idle();assert.deepEqual(response,{answers});assert.equal(f.code.list()[0].state,'completed');
  assert.equal(f.code.list()[1].state,'held');assert.equal(f.code.snapshot().value.enabled,false);assert.equal(f.dsh.factory.length,1);assert.equal(f.dsh.submitted.length,1);
  const final=f.runtime.outbox.list().find(d=>d.kind==='code-result');assert.equal((await f.channel.resolveReplyContext(final)).messageId,'question-answer');
  assert.equal(f.runtime.learning().length,0);assert.equal(f.ledger.pageEvents(f.key,1,0,20).length,0);
});
test('stale revisions, wrong admin, unknown requests and invalid option labels cannot resolve a pending question',async t=>{
  let response;
  const f=fixture(t,{timeoutMs:10000,behavior:async run=>{
    run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    response=await run.hook('user-questions/request',{agent:run.agent,questions:[{id:'q',question:'问题',options:[{label:'A'}]}],signal:run.options.signal,wait:{callId:'q1'}});
    run.assistant('done');run.end();
  }});
  f.channel.start();await f.emit();const notice=await nextNotice(f);const rid=notice.payload.requestId;
  const cmd=(id,rev,selected='A')=>`/code答复 ${id} ${rev} ${JSON.stringify({answers:[{id:'q',selected:[selected]}]})}`;
  await assert.rejects(f.emit(f.message('stale',cmd(rid,2))),/CODE_INTERACTION_CONFLICT/);
  await assert.rejects(f.emit(f.message('unknown',cmd('unknown-request',1))),/CODE_INTERACTION_NOT_FOUND/);
  await assert.rejects(f.emit(f.message('invalid-label',cmd(rid,1,'not-an-option'))),/CODE_INTERACTION_INVALID/);
  await assert.rejects(f.emit(f.message('wrong-request-kind',`/code审批 ${rid} 1 允许`)),/CODE_INTERACTION_CONFLICT/);
  f.grant.verified=false;await assert.rejects(f.emit(f.message('unauthorized',cmd(rid,1))),/QQ_CODE_NOT_AUTHORIZED/);f.grant.verified=true;
  assert.equal(response,undefined);assert.equal(f.code.list().length,1);assert.equal(f.code.list()[0].state,'running');
  f.advance(3000);await f.emit(f.message('valid',cmd(rid,1)));await f.channel.idle();assert.deepEqual(response,{answers:[{id:'q',selected:['A']}]});
  await assert.rejects(f.emit(f.message('second-different-message',cmd(rid,1))),/CODE_INTERACTION_UNAVAILABLE|CODE_INTERACTION_EXPIRED/);
  assert.equal(f.dsh.submitted.length,1);
});
test('closing a live question settles its original SDK promise before releasing SQLite and cannot replay it',async t=>{
  let rejected=false;
  const f=fixture(t,{timeoutMs:10000,behavior:async run=>{
    run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    try { await run.hook('user-questions/request',{agent:run.agent,questions:[{id:'q',question:'等待人工答复'}],signal:run.options.signal,wait:{callId:'close-question'}}); }
    catch(error){rejected=true;throw error;}
    assert.fail('closed request must not continue');
  }});
  f.channel.start();await f.emit();const notice=await nextNotice(f);assert.equal(f.code.list()[0].state,'running');
  await f.channel.close();assert.equal(rejected,true);assert.equal(f.code.list()[0].state,'needs-review');
  assert.equal(f.runtime.outbox.list().filter(d=>d.kind==='code-result').length,0);assert.equal(f.dsh.submitted.length,1);
  f.releaseDatabase();await tick();assert.equal(f.lateAccess,0);await assert.rejects(f.channel.resolveReplyContext(notice),/CODE_CHANNEL_CLOSED/);
});
test('a notice answered during reply authorization is rechecked and never receives a stale send attestation',async t=>{
  let authorize;let began;const entered=new Promise(r=>{began=r;});
  const f=fixture(t,{timeoutMs:10000,authorizeReply:()=>{began();return new Promise(r=>{authorize=r;});},behavior:async run=>{
    run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    await run.hook('user-questions/request',{agent:run.agent,questions:[{id:'q',question:'继续？',options:[{label:'继续'}]}],signal:run.options.signal,wait:{callId:'answer-during-auth'}});
    run.assistant('done');run.end();
  }});
  f.channel.start();await f.emit();const notice=await nextNotice(f);const pending=f.channel.resolveReplyContext(notice);
  const rejected=assert.rejects(pending,/QQ_REPLY_DENIED/);await entered;
  const answers=[{id:'q',selected:['继续']}];await f.emit(f.message('reply-during-auth',`/code答复 ${notice.payload.requestId} 1 ${JSON.stringify({answers})}`));
  await f.channel.idle();authorize(true);await rejected;assert.equal(f.runtime.outbox.list().every(d=>d.status==='queued'),true);
});
test('read-only SQLite shutdown failure still drains the pending human call before reporting failure or releasing the database',async t=>{
  let nativeSettled=false;let approved=false;
  const f=fixture(t,{timeoutMs:10000,behavior:async run=>{
    run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    try {
      await run.hook('user-questions/request',{agent:run.agent,questions:[{id:'q',question:'关闭故障期间不得被批准'}],signal:run.options.signal,wait:{callId:'readonly-close'}});
      approved=true;
    }finally{nativeSettled=true;}
  }});
  f.channel.start();await f.emit();const notice=await nextNotice(f);const retainedHandler=[...f.handlers][0];
  assert.equal(f.code.list()[0].state,'running');f.makeDatabaseReadOnly();f.expectCloseFailure();
  let closing;assert.doesNotThrow(()=>{closing=f.channel.close();});assert.equal(typeof closing.then,'function');
  assert.equal(f.channel.close(),closing);await assert.rejects(closing,/CODE_CHANNEL_CLOSE_FAILED/);
  assert.equal(nativeSettled,true);assert.equal(approved,false);assert.equal(f.dsh.disposed,1);assert.equal(f.channel.status().code.active,null);
  assert.equal(f.handlers.size,0);assert.equal(f.runtime.outbox.list().filter(d=>d.kind==='code-result').length,0);
  assert.throws(()=>createQQOfficialCodeChannel(f.channelOptions),/CODE_CHANNEL_ALREADY_OWNED/);
  f.releaseDatabase();const message=f.message('late-readonly-answer',`/code答复 ${notice.payload.requestId} 1 {"answers":[{"id":"q","selected":[],"custom":"继续"}]}`);
  await assert.rejects(retainedHandler({bot:f.channelOptions.sdk,message,replyTarget:message.replyTarget},message),/QQ_UNTRUSTED_INGRESS/);
  await assert.rejects(f.channel.resolveReplyContext(notice),/CODE_CHANNEL_CLOSED/);await tick();assert.equal(f.lateAccess,0);assert.equal(approved,false);
});
test('a queued task read failure is contained in the Code drain without a detached rejection or model execution',async t=>{
  const f=fixture(t);f.channel.start();f.failNextCodeRead();await f.emit(f.message('read-failure'));await f.channel.idle();
  assert.equal(f.channel.status().code.lastFailure.code,'STORAGE_FAILURE');assert.equal(f.channel.status().code.active,null);
  assert.equal(f.channel.status().code.pending,0);assert.equal(f.dsh.factory.length,0);assert.equal(f.runtime.outbox.list().length,0);
  assert.equal(f.code.list()[0].state,'queued');await tick();assert.equal(f.dsh.factory.length,0);
});
const reviewer='trusted-maintainer';
const failedTurn=async run=>{run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);throw Error('SYNTHETIC FAILURE');};
async function failedRecoveryFixture(t,options={}) {
  const f=fixture(t,{authorizeCodeMaintenance:r=>r===reviewer,verifyCodeSessionStopped:()=>true,behavior:failedTurn,...options});
  f.channel.start();const original=f.message('failed-original','原任务不得重放');await f.emit(original);await f.channel.idle();
  const task=f.code.list()[0];assert.equal(task.state,'needs-review');await f.emit(f.message('off-for-maintenance','/关闭code'));
  return Object.assign(f,{original,failedTask:task});
}
const abandonInput=preview=>({taskId:preview.taskId,expectedStateRevision:preview.expectedStateRevision,
  expectedSessionRevision:preview.session.revision,reviewer,reason:'已核验停止；明确放弃原任务'});

test('trusted OFF recovery abandons the old task atomically and only a new QQ event creates a different SDK session',async t=>{
  let calls=0;const stopped=[];
  const f=await failedRecoveryFixture(t,{verifyCodeSessionStopped:proof=>{stopped.push(proof);return true;},behavior:async run=>{
    calls++;if(calls===1)return failedTurn(run);run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);run.assistant('新会话完成');run.end();
  }});
  const preview=f.channel.inspectRecovery({taskId:f.failedTask.id,reviewer});const oldSession=preview.session.sessionId;
  const outbox=f.runtime.outbox;outbox.enqueue({id:'prior-unknown',account:f.account,conversation:f.key,kind:'creation',body:'历史发送不明',payload:{},
    revisions:{binding:1,policy:0,memory:0,identity:0,expression:0},sourceRefs:[],createdAt:f.now,dueAt:f.now,expiresAt:f.now+60000,costUnits:0});
  outbox.setPause(outbox.state().revision,false);const prior=outbox.claim(f.account,'prior-owner',f.now,30000,{id:'prior-budget',limit:1},()=>({allowed:true,reason:'NONE'}));
  const unknown=outbox.finish(prior.id,prior.claim,f.now,'unknown',null);
  assert.equal(preview.session.phase,'needs-review');assert.equal(f.dsh.factory.length,1);
  const recovered=f.channel.abandonSession(abandonInput(preview));assert.equal(recovered.state,'stopped');assert.equal(recovered.session.phase,'fresh');
  assert.notEqual(recovered.session.sessionId,oldSession);assert.equal(recovered.session.generation,preview.session.generation+1);
  assert.deepEqual(stopped,[{sessionId:oldSession,taskId:f.failedTask.id,mappingRevision:preview.session.revision}]);
  assert.equal(f.code.list().length,1);assert.equal(f.code.get(f.failedTask.id).state,'stopped');assert.equal(f.dsh.submitted.length,1);assert.deepEqual(outbox.list().find(d=>d.id==='prior-unknown'),unknown);
  const replay=await f.emit(f.original);assert.equal(replay[0].code,'QQ_EVENT_REPLAY');assert.equal(f.dsh.submitted.length,1);
  await f.emit(f.message('on-after-abandon','/开启code'));await f.emit(f.message('new-explicit-task','只执行这条新任务'));await f.channel.idle();
  assert.deepEqual(f.dsh.factory.map(call=>call.kind),['create','create']);assert.notEqual(f.dsh.factory[0].options.sessionId,f.dsh.factory[1].options.sessionId);
  assert.equal(f.dsh.factory[1].options.sessionId,recovered.session.sessionId);assert.equal(f.code.get(f.failedTask.id).state,'stopped');
  assert.equal(f.code.list().length,2);assert.equal(f.dsh.submitted.length,2);assert.equal(f.dsh.submitted[1].content[0].text,'只执行这条新任务');
  const final=outbox.list().find(d=>d.kind==='code-result');assert.equal(final.body,'新会话完成');assert.equal(final.status,'queued');assert.deepEqual(outbox.list().find(d=>d.id==='prior-unknown'),unknown);
});
test('maintenance rejects absent or asynchronous authority, enabled Code, active work, and a changed profile',async t=>{
  const denied=await failedRecoveryFixture(t,{authorizeCodeMaintenance:undefined});
  assert.throws(()=>denied.channel.inspectRecovery({taskId:denied.failedTask.id,reviewer}),/CODE_MAINTENANCE_DENIED/);
  const asyncAuthority=await failedRecoveryFixture(t,{authorizeCodeMaintenance:()=>Promise.resolve(true)});
  assert.throws(()=>asyncAuthority.channel.inspectRecovery({taskId:asyncAuthority.failedTask.id,reviewer}),/CODE_MAINTENANCE_DENIED/);
  const active=fixture(t,{blocked:true,authorizeCodeMaintenance:()=>true,verifyCodeSessionStopped:()=>true});active.channel.start();await active.emit();await tick();
  const task=active.code.list()[0];assert.throws(()=>active.channel.inspectRecovery({taskId:task.id,reviewer}),/CODE_RECOVERY_REQUIRES_OFF/);
  active.code.disable(active.now);assert.throws(()=>active.channel.inspectRecovery({taskId:task.id,reviewer}),/CODE_MAINTENANCE_BUSY/);
  await active.channel.close();active.dsh.releaseOne();await tick();
  const changed=await failedRecoveryFixture(t);changed.switchProfile();assert.throws(()=>changed.channel.inspectRecovery({taskId:changed.failedTask.id,reviewer}),/CODE_MAINTENANCE_UNAVAILABLE/);
});
for(const [name,verifier]of[['missing',undefined],['false',()=>false],['Promise',()=>Promise.resolve(true)]])
  test(`session abandonment requires synchronous stopped evidence: ${name}`,async t=>{
    const f=await failedRecoveryFixture(t,{verifyCodeSessionStopped:verifier});const preview=f.channel.inspectRecovery({taskId:f.failedTask.id,reviewer});
    const before=f.stateRows();assert.throws(()=>f.channel.abandonSession(abandonInput(preview)),/DSH_CODE_RECOVERY_NOT_STOPPED|CODE_SESSION_STOP_UNPROVEN|STORAGE_FAILURE/);
    assert.deepEqual(f.stateRows(),before);assert.equal(f.code.get(f.failedTask.id).state,'needs-review');assert.equal(f.dsh.submitted.length,1);
  });
test('stale CAS, grant changes, final authorization withdrawal and SQLite write errors roll back the whole recovery',async t=>{
  let allowed=true;let revoke=false;
  const f=await failedRecoveryFixture(t,{authorizeCodeMaintenance:()=>allowed,verifyCodeSessionStopped:()=>{if(revoke)allowed=false;return true;}});
  const preview=f.channel.inspectRecovery({taskId:f.failedTask.id,reviewer});const input=abandonInput(preview);const before=f.stateRows();
  assert.throws(()=>f.channel.abandonSession({...input,expectedStateRevision:input.expectedStateRevision+1}),/CONFLICT/);assert.deepEqual(f.stateRows(),before);
  assert.throws(()=>f.channel.abandonSession({...input,expectedSessionRevision:input.expectedSessionRevision+1}),/DSH_CODE_RECOVERY_CONFLICT|STORAGE_FAILURE/);assert.deepEqual(f.stateRows(),before);
  f.grant.revision++;assert.throws(()=>f.channel.abandonSession(input),/CODE_AUTH_CHANGED/);f.grant.revision--;assert.deepEqual(f.stateRows(),before);
  revoke=true;assert.throws(()=>f.channel.abandonSession(input),/CODE_MAINTENANCE_DENIED|STORAGE_FAILURE/);allowed=true;revoke=false;assert.deepEqual(f.stateRows(),before);
  f.makeDatabaseReadOnly();try{assert.throws(()=>f.channel.abandonSession(input),/STORAGE_FAILURE/);}finally{f.makeDatabaseWritable();}
  assert.deepEqual(f.stateRows(),before);assert.equal(f.code.get(f.failedTask.id).state,'needs-review');assert.equal(f.dsh.submitted.length,1);
});
test('settled interaction cold archives retain private full records and only the trusted reviewer can maintain or read them',async t=>{
  let permitted=true;
  const f=fixture(t,{timeoutMs:10000,authorizeCodeMaintenance:r=>permitted&&r===reviewer,verifyCodeSessionStopped:()=>true,behavior:async run=>{
    run.emit('turn/start',{turn:run.turn});await run.model();run.emit('user/message',run.message);
    await run.hook('user-questions/request',{agent:run.agent,questions:[{id:'private-q',question:'仅管理员可见问题',options:[{label:'继续'}]}],signal:run.options.signal,wait:{callId:'archive-question'}});
    run.assistant('仅管理员可见结果');run.end();
  }});
  f.channel.start();await f.emit();const notice=await nextNotice(f);
  const answer=await f.emit(f.message('private-answer',`/code答复 ${notice.payload.requestId} 1 ${JSON.stringify({answers:[{id:'private-q',selected:['继续'],custom:'私密答复内容'}]})}`));
  await f.channel.idle();const revision=answer[0].result.revision;
  f.runtime.outbox.setPause(f.runtime.outbox.state().revision,false);
  const delivered=await f.dispatcher.dispatch(f.account,'archive-fixture',{id:'archive-budget',limit:10},async()=>({status:'confirmed',receipt:'synthetic-receipt'}));
  assert.equal(delivered.kind,'code-result');assert.equal(f.code.list()[0].resultDelivery,'delivered');
  await f.emit(f.message('off-for-archive','/关闭code'));const input={ids:[{id:notice.payload.requestId,revision}],reviewer,reason:'任务结束后转冷归档'};
  const before=f.stateRows();assert.throws(()=>f.channel.archiveInteractions({...input,reviewer:'unknown-reviewer'}),/CODE_MAINTENANCE_DENIED/);assert.deepEqual(f.stateRows(),before);
  assert.throws(()=>f.channel.archiveInteractions({...input,ids:[{id:notice.payload.requestId,revision:revision+1}]}),/CODE_INTERACTION_CONFLICT|STORAGE_FAILURE/);assert.deepEqual(f.stateRows(),before);
  const receipt=f.channel.archiveInteractions(input);assert.equal(receipt.archived,true);assert.equal(receipt.count,1);
  const page=f.channel.listArchivedInteractions({reviewer,offset:0,limit:1});assert.equal(page.total,1);assert.equal(page.items[0].id,notice.payload.requestId);assert.equal(page.nextOffset,null);
  const cold=f.channel.readArchivedInteraction({reviewer,id:notice.payload.requestId});assert.equal(cold.text,notice.body);assert.equal(cold.questions[0].question,'仅管理员可见问题');
  assert.equal(cold.sourceHistory[0].eventId,'private-answer');assert.equal(cold.response.answers[0].custom,'私密答复内容');assert.equal(cold.archive.sha256,receipt.receipts[0].sha256);
  assert.equal(f.channel.listArchivedInteractions({reviewer,offset:1,limit:1}).items.length,0);
  assert.throws(()=>f.channel.listArchivedInteractions({reviewer:'unknown-reviewer'}),/CODE_MAINTENANCE_DENIED/);
  permitted=false;assert.throws(()=>f.channel.readArchivedInteraction({reviewer,id:notice.payload.requestId}),/CODE_MAINTENANCE_DENIED/);
  assert.equal(f.dsh.submitted.length,1);assert.equal(f.runtime.learning().length,0);
});
test('maintenance snapshots caller inputs before callbacks so audit identity cannot change or stale CAS be repaired',async t=>{
  let submitted;
  const f=await failedRecoveryFixture(t,{verifyCodeSessionStopped:()=>{
    submitted.reason='CALLBACK REPLACED REASON';submitted.reviewer='CALLBACK REPLACED REVIEWER';return true;
  }});
  const preview=f.channel.inspectRecovery({taskId:f.failedTask.id,reviewer});submitted=abandonInput(preview);
  const original={reviewer:submitted.reviewer,reason:submitted.reason};
  const result=f.channel.abandonSession(submitted);assert.equal(result.state,'stopped');
  assert.equal(submitted.reason,'CALLBACK REPLACED REASON');assert.equal(submitted.reviewer,'CALLBACK REPLACED REVIEWER');
  const taskAudit=f.code.get(f.failedTask.id).recovery;assert.equal(taskAudit.reviewer,original.reviewer);assert.equal(taskAudit.reason,original.reason);
  const sessionAudits=f.stateRows().filter(row=>row.key.startsWith('["dsh-code-recovery-v1",')).map(row=>JSON.parse(row.value));
  assert.equal(sessionAudits.length,1);assert.deepEqual(sessionAudits[0].recovery,taskAudit);

  let input;let repair=false;let g;
  g=await failedRecoveryFixture(t,{authorizeCodeMaintenance:()=>{
    if(repair)input.expectedStateRevision=g.code.snapshot().revision;return true;
  }});
  const stale=g.channel.inspectRecovery({taskId:g.failedTask.id,reviewer});input=abandonInput(stale);
  input.expectedStateRevision--;assert.ok(input.expectedStateRevision>0);const staleRevision=input.expectedStateRevision;
  const before=g.stateRows();repair=true;
  assert.throws(()=>g.channel.abandonSession(input),/CONFLICT|STORAGE_FAILURE/);
  assert.notEqual(input.expectedStateRevision,staleRevision);assert.equal(input.expectedStateRevision,stale.expectedStateRevision);
  assert.deepEqual(g.stateRows(),before);assert.equal(g.code.get(g.failedTask.id).state,'needs-review');
});

test('one managed SDK subscription routes OFF private/group social through trusted attestation while ON administrator remains Code', async t => {
  const social=[];let f;f=fixture(t,{enabled:false,socialOptions:{directSocialEnabled:()=>true,groupSocialEnabled:()=>true,onSocial:async envelope=>{
    const identity={botId:'bot',personaId:'juejue',connector:'qq-official',issuer:'official-synthetic',accountId:'app',kind:envelope.key===f.key?'direct':'group',remoteId:envelope.key===f.key?'admin-open-id':'group-open-id'};
    assert.equal(f.channel.acceptSocialAttestation(envelope,identity),true);social.push(envelope);return f.runtime.receive(envelope);
  }}});f.runtimeOptions.acceptIngress=(...args)=>f.channel.acceptSocialAttestation(...args);
  f.runtime.memory.configure(0,{permissions:{receive:true,save:true,learn:false,reply:false,proactive:false}});f.channel.start();f.channel.start();assert.equal(f.handlers.size,1);
  await f.emit(f.message('social-direct','普通聊天'));assert.equal(social.length,1);assert.equal(f.code.list().length,0);
  assert.equal(f.ledger.pageEvents(f.key,1,0,20).length,1);assert.equal(f.dsh.factory.length,0);
  const group=f.message('social-group','群聊内容');group.kind='group';group.rawEventType='GROUP_AT_MESSAGE_CREATE';group.senderId='admin-open-id';
  group.raw.author={member_openid:'admin-open-id'};group.raw.group_openid=group.groupOpenid='group-open-id';group.replyTarget={scope:'group',targetId:'group-open-id',msgId:group.raw.id};
  await f.emit(group);assert.equal(social.length,2);assert.equal(f.ledger.pageEvents(f.groupKey,1,0,20).length,1);
  await f.emit(f.message('enable-from-social','/开启code'));await f.emit(f.message('code-private','PRIVATE CODE CONTENT'));await f.channel.idle();
  assert.equal(social.length,2);assert.equal(f.dsh.factory.length,1);assert.equal(f.code.list()[0].input.text,'PRIVATE CODE CONTENT');
  assert.equal(f.ledger.pageEvents(f.key,1,0,20).length,1);
});

test('managed channel drains admitted social tails and rejects later callbacks after close', async t => {
  let complete;const f=fixture(t,{enabled:false,socialOptions:{directSocialEnabled:()=>true,onSocial:()=>new Promise(r=>{complete=r;})}});
  f.channel.start();const retained=[...f.handlers][0];const operation=f.emit(f.message('pending-social'));await tick();
  let closed=false;const closing=f.channel.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
  complete('done');await operation;await closing;f.releaseDatabase();
  const message=f.message('late-social');await assert.rejects(retained({bot:f.channelOptions.sdk,message,replyTarget:message.replyTarget},message),/QQ_UNTRUSTED_INGRESS/);
  assert.equal(f.channel.acceptSocialAttestation({},{}),false);
  assert.throws(()=>f.channel.archiveIngress({}),/CODE_MAINTENANCE_UNAVAILABLE/);assert.equal(f.lateAccess,0);
});

test('managed channel ingress maintenance needs independent trusted privilege and preserves social cold reply attestation', async t => {
  const social=[];const f=fixture(t,{enabled:false,authorizeCodeMaintenance:r=>r==='host-reviewer',socialOptions:{directSocialEnabled:()=>true,
    onSocial:e=>{social.push(e);},authorizeIngressMaintenance:p=>p.reviewer==='host-reviewer'}});f.channel.start();await f.emit(f.message('archive-social','ordinary private'));
  const inspect=f.channel.inspectIngress({ids:['archive-social'],reviewer:'host-reviewer'});
  f.channel.archiveIngress({ids:inspect.items.map(({id,revision})=>({id,revision})),expectedRevision:inspect.expectedRevision,reviewer:'host-reviewer',reason:'manual reviewed'});
  assert.equal(f.channel.listArchivedIngress({reviewer:'host-reviewer'}).total,1);assert.equal(f.channel.readArchivedIngress({eventId:'archive-social',reviewer:'host-reviewer'}).original.proof.route,'social');
  await f.emit(f.message('archive-social','ordinary private'));assert.equal(social.length,1);
  await f.channel.close();assert.throws(()=>f.channel.inspectIngress({ids:['archive-social'],reviewer:'host-reviewer'}),/CODE_MAINTENANCE_UNAVAILABLE/);
});
