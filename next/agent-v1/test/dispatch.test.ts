import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStateStore} from '../src/store.ts';
import {ConversationLedger} from '../../conversation-v1/src/ledger.ts';
import {BotRuntime} from '../src/runtime.ts';
import {CreationService} from '../src/creation.ts';
import {CodeTasks} from '../src/code-jobs.ts';
import {DispatchCoordinator} from '../src/dispatch.ts';
function fixture(t){
  const db=new DatabaseSync(':memory:'),events=new DatabaseSync(':memory:');const store=new SqliteStateStore(db,{namespace:'dispatch',initialize:true});
  const ledger=new ConversationLedger(events,{namespace:'dispatch',initialize:true});let now=1000,human=true,active=true,slow=false,checks=0;
  const runtime=new BotRuntime(store,ledger,{profile:{botId:'bot',personaId:'juejue',mode:'juejue',name:'撅撅',roleCore:'synthetic'},now:()=>now,
    model:{id:'synthetic',generate:async()=>({text:'synthetic reply',learning:[]})},acceptIngress:()=>true,authorizeLearning:()=>false,
    participation:key=>({enabled:true,allowedTargets:[key],deniedTargets:[],timeZoneOffsetMinutes:0,windows:[{startMinute:0,endMinute:1440}],cooldownMs:0,dailyLimit:10,unansweredLimit:10})});
  const key=runtime.register({botId:'bot',personaId:'juejue',connector:'qq-personal',issuer:'fixture',accountId:'one',kind:'direct',remoteId:'admin'},1,'synthetic');
  runtime.memory.configure(0,{permissions:{receive:true,save:true,reply:true},typing:{enabled:false}});runtime.outbox.setPause(0,false);
  const account=JSON.stringify(['qq-personal','fixture','one']);let mapped=account;
  const authority={policyRevision:1,accountRevision:1,contextRevision:1,publishAllowed:true,sources:[]};
  const creation=new CreationService(store,{now:()=>now,authorizeHuman:()=>human,resolveAsset:()=>null,currentAuthority:()=>{if(slow)now+=31000;checks++;return structuredClone(authority);}});
  const grant={revision:1,adminActor:'admin',conversationKey:key,account:'one',workspaceId:'test',sessionId:'session',modelConfigured:true,budgetAvailable:true,sandboxVerified:true,toolsRestricted:true,allowedTools:['read'],verified:true};
  const code=new CodeTasks(store,{getAuthorization:()=>grant});
  const dispatcher=new DispatchCoordinator(runtime,creation,code,()=>now,{resolveAccount:handle=>handle==='one'?mapped:null,isActive:()=>active});
  const prepare=()=>{const target={objectId:null,parentId:null,visibility:'public',category:null};let w=creation.create({id:'work',action:'qqspace',accountId:'one',target,intention:'synthetic',sources:[]});
    w=creation.prepareFinal('work',w.revision,{accountId:'one',target,title:'title',text:'synthetic publication',description:'',tags:[],video:null,audio:[],subtitles:[],cover:null,attachments:[]});
    w=creation.approve('work',w.revision,'human',100000);return w;};
  t.after(()=>{runtime.close();store.close();db.close();events.close();});
  return{runtime,creation,code,dispatcher,account,key,prepare,authority,change(kind){if(kind==='human')human=false;if(kind==='active')active=false;if(kind==='expiry')now=100000;if(kind==='source')authority.policyRevision++;if(kind==='identity')authority.contextRevision++;if(kind==='account')mapped=JSON.stringify(['qq-personal','fixture','two']);if(kind==='slow')slow=true;},checks:()=>checks};
}
const budget={id:'synthetic-day',limit:10};
test('approval consumption and Outbox are atomic and repeat submit never duplicates',async t=>{
  const f=fixture(t),w=f.prepare();const one=f.dispatcher.submitCreation('work',w.revision),two=f.dispatcher.submitCreation('work',w.revision);
  assert.equal(one.intentId,two.intentId);assert.equal(two.duplicate,true);assert.equal(f.runtime.outbox.list().length,1);
  let sent=0;await f.dispatcher.dispatch(f.account,'worker',budget,async()=>{sent++;return{status:'confirmed',receipt:'synthetic-object',visibility:'pending-review'};});
  assert.equal(sent,1);assert.equal(f.creation.read('work').value.submission.state,'pending-review');
  assert.equal(await f.dispatcher.dispatch(f.account,'worker',budget,async()=>assert.fail('duplicate')),null);
});
test('queued publications recheck reviewer, expiry, source, identity and trusted account binding',async t=>{
  for(const change of ['human','expiry','source','identity','account','active']){const f=fixture(t),w=f.prepare();f.dispatcher.submitCreation('work',w.revision);f.change(change);
    const result=await f.dispatcher.dispatch(f.account,'worker',budget,async()=>assert.fail(change+' must not send'));
    assert.equal(result,null);assert.equal(f.runtime.outbox.list()[0].status,'cancelled',change);}
});
test('slow synchronous revalidation cannot send after its ownership lease expired',async t=>{
  const f=fixture(t),w=f.prepare();f.dispatcher.submitCreation('work',w.revision);f.change('slow');
  const result=await f.dispatcher.dispatch(f.account,'worker',budget,async()=>assert.fail('lease expired before IO'));
  assert.equal(result.status,'unknown');assert.equal(result.reason,'LEASE_EXPIRED');
});
test('social chat and approved QQ-space use one canonical account lock',async t=>{
  const f=fixture(t);await f.runtime.receive({key:f.key,bindingRevision:1,eventId:'in',actor:'admin',actorKind:'human',plain:true,text:'hello',observedAt:1000});
  const w=f.prepare();f.dispatcher.submitCreation('work',w.revision);assert.equal(new Set(f.runtime.outbox.list().map(i=>i.account)).size,1);
  let finish;const waiting=new Promise(resolve=>finish=resolve);let sends=0;
  const first=f.dispatcher.dispatch(f.account,'worker-a',budget,async()=>{sends++;await waiting;return{status:'confirmed',receipt:'chat-message'};});
  const second=await f.dispatcher.dispatch(f.account,'worker-b',budget,async()=>{sends++;assert.fail('same account concurrent send');});
  assert.equal(second,null);assert.equal(sends,1);finish();await first;
  assert.equal((await f.dispatcher.dispatch(f.account,'worker-b',budget,async()=>({status:'confirmed',receipt:'space-object'}))).kind,'creation');
});
test('Code OFF retains empty result and still sends once to the same verified administrator',async t=>{
  const f=fixture(t);f.code.enable(1);const task=f.code.admit({eventId:'code',actor:'admin',conversationKey:f.key,account:'one',plain:true,text:'synthetic task'},2).task;
  f.code.start(task.id,3);f.code.disable(4);f.code.finish(task.id,'',5);const id=f.dispatcher.enqueueCode(task.id);assert.equal(f.dispatcher.enqueueCode(task.id),id);
  const result=await f.dispatcher.dispatch(f.account,'worker',budget,async item=>{assert.equal(item.body,'任务已结束，结果为空。');return{status:'confirmed',receipt:'code-message'};});
  assert.equal(result.status,'confirmed');assert.equal(f.code.get(task.id).resultDelivery,'delivered');assert.equal(f.code.snapshot().value.enabled,false);
});
test('uncertain transport is never resent and keeps the common account locked',async t=>{
  const f=fixture(t),w=f.prepare();f.dispatcher.submitCreation('work',w.revision);
  const result=await f.dispatcher.dispatch(f.account,'worker',budget,async()=>{throw new Error('synthetic dropped connection');});assert.equal(result.status,'unknown');
  assert.equal(f.creation.read('work').value.submission.state,'unknown');assert.equal(await f.dispatcher.dispatch(f.account,'worker',budget,async()=>assert.fail('no retry')),null);
});
test('unbound public account names cannot create independent sender locks or consume approval',t=>{
  const f=fixture(t),w=f.prepare();const unbound=new DispatchCoordinator(f.runtime,f.creation,f.code,()=>1000);
  assert.throws(()=>unbound.submitCreation('work',w.revision),/ACCOUNT_UNBOUND/);assert.equal(f.creation.read('work').value.stage,'approved');assert.equal(f.runtime.outbox.list().length,0);
});
test('a transport that never settles has a bounded deadline, aborts, and remains unknown without retry',async t=>{
  const f=fixture(t),w=f.prepare();f.dispatcher.submitCreation('work',w.revision);let signal;
  const dispatcher=new DispatchCoordinator(f.runtime,f.creation,f.code,()=>1000,{resolveAccount:()=>f.account,sendTimeoutMs:20});
  const result=await dispatcher.dispatch(f.account,'worker',budget,async(_item,received)=>{signal=received;return new Promise(()=>{});});
  assert.equal(result.status,'unknown');assert.equal(signal.aborted,true);
  assert.equal(await dispatcher.dispatch(f.account,'worker',budget,async()=>assert.fail('no retry')),null);
});
