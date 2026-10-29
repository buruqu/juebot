import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../src/store.ts';
import { ConversationLedger } from '../../conversation-v1/src/ledger.ts';
import { BotRuntime } from '../src/runtime.ts';
import { CreationService } from '../src/creation.ts';
import { CodeTasks } from '../src/code-jobs.ts';
import { DispatchCoordinator } from '../src/dispatch.ts';
import { DeliveryReconciler, deliveryFingerprint } from '../src/delivery-reconciliation.ts';
import type { Envelope, ModelPort, ModelRequest, RuntimeOptions } from '../src/runtime.ts';
import type { ParticipationPolicy } from '../src/self-growth.ts';
import type { RepetitionEvent } from '../../social-v1/src/repetition.ts';

const identity = { botId:'bot',personaId:'juejue',connector:'local-test' as const,issuer:'fixture',accountId:'account',kind:'group' as const,remoteId:'a' };
const permissions={receive:true,save:true,learn:true,reply:true,proactive:true};
function fixture(t:{after(fn:()=>void):void}){
  const stateDb=new DatabaseSync(':memory:'),ledgerDb=new DatabaseSync(':memory:');
  const store=new SqliteStateStore(stateDb,{namespace:'runtime-test',initialize:true});
  const ledger=new ConversationLedger(ledgerDb,{namespace:'runtime-test',initialize:true});
  let now=1000;const requests:ModelRequest[]=[];let deny=false;
  const model:ModelPort={id:'model-a',async generate(request){requests.push(request);return{text:'synthetic reply',learning:[{text:'synthetic knowledge',kind:'knowledge'}]};}};
  const options:RuntimeOptions={profile:{botId:'bot',personaId:'juejue',mode:'juejue',name:'撅撅',roleCore:'fixed core'},now:()=>now,model,
    acceptIngress:()=>true,authorizeLearning:principal=>principal==='human',
    participation:key=>({enabled:true,allowedTargets:[key],deniedTargets:deny?[key]:[],timeZoneOffsetMinutes:0,windows:[{startMinute:0,endMinute:1440}],cooldownMs:0,dailyLimit:10,unansweredLimit:10} satisfies ParticipationPolicy)};
  const runtime=new BotRuntime(store,ledger,options);const key=runtime.register(identity,1,'group-a');
  runtime.memory.configure(0,{permissions,typing:{enabled:false}});runtime.outbox.setPause(0,false);
  const envelope=(eventId:string,patch:Partial<Envelope>={}):Envelope=>({key,bindingRevision:1,eventId,actor:'human-a',actorKind:'human',plain:true,text:eventId,observedAt:now,...patch});
  const account=JSON.stringify([identity.connector,identity.issuer,identity.accountId]);
  t.after(()=>{runtime.close();store.close();stateDb.close();ledgerDb.close();});
  return{runtime,model,options,store,stateDb,ledger,ledgerDb,key,requests,envelope,account,advance(ms:number){now+=ms;},deny(){deny=true;}};
}
async function repetitionFixture(f:ReturnType<typeof fixture>,withStyles=true){
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{reply:false}});
  const events:RepetitionEvent[]=[];const sources:string[]=[];
  for(let i=0;i<3;i++){
    const envelope=f.envelope(`repeat-event-${i}`,{actor:i===1?'human-b':'human-a',text:'same copied text'});
    const turn=await f.runtime.receive(envelope);sources.push(turn.id);
    events.push({conversationKey:{namespace:identity.connector,opaqueId:identity.remoteId,accountKey:f.account,bindingRevision:1},
      id:envelope.eventId,actorKey:envelope.actor,actorVerified:true,observedAt:envelope.observedAt,senderKind:'human',kind:'text',text:envelope.text});
  }
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{reply:true},
    ...(withStyles?{styleContracts:[{contractId:'natural',policyText:'keep natural style',counterexamples:[]}]}:{})});
  return{events,sources};
}

test('unknown social delivery and verified confirmation remain separate deduplicated audit facts without another send',async t=>{
  const f=fixture(t);await f.runtime.receive(f.envelope('uncertain-social'));
  const item=await f.runtime.dispatch(f.account,'sender',{id:'day',limit:1},async()=>({status:'unknown',receipt:null}));
  const creation=new CreationService(f.store,{now:()=>1000,authorizeHuman:()=>true,resolveAsset:()=>null,
    currentAuthority:()=>({policyRevision:0,accountRevision:0,publishAllowed:false,sources:[]})});
  const code=new CodeTasks(f.store,{getAuthorization:()=>null});
  const dispatcher=new DispatchCoordinator(f.runtime,creation,code,()=>1000);
  const reconciler=new DeliveryReconciler(dispatcher,{authorizeHuman:p=>p==='human',query:async row=>({deliveryId:row.id,account:row.account,
    fingerprint:deliveryFingerprint(row),outcome:'confirmed',receipt:'private-evidence',notSubmitted:false})});
  f.advance(1);await reconciler.reconcile(item!.id,f.runtime.outbox.state().revision,'human');
  f.runtime.recordDelivery(f.runtime.outbox.list()[0]!);
  const outcomes=f.ledger.pageEvents(f.key,1,0,50).filter(event=>['reply.unknown','reply.confirmed'].includes(event.eventType));
  assert.deepEqual(outcomes.map(event=>event.eventType),['reply.unknown','reply.confirmed']);
  assert.ok(outcomes.every(event=>event.bodyRef===null));assert.equal(JSON.stringify(outcomes).includes('private-evidence'),false);
  assert.equal(await dispatcher.dispatch(f.account,'sender',{id:'day',limit:1},async()=>assert.fail('no resend')),null);
});

test('end-to-end authorized receive persists a draft, dispatches once, and human learning acceptance atomically preserves sources',async t=>{
  const f=fixture(t);const envelope=f.envelope('event-one');const turn=await f.runtime.receive(envelope);
  assert.equal(turn.status,'queued');assert.equal(f.runtime.outbox.list().length,1);let sends=0;
  const result=await f.runtime.dispatch(f.account,'sender',{id:'day',limit:1},async item=>{sends++;assert.equal(item.body,'synthetic reply');return{status:'confirmed',receipt:'platform-object'};});
  assert.equal(result!.status,'confirmed');assert.equal(sends,1);
  assert.equal(await f.runtime.dispatch(f.account,'sender',{id:'day',limit:1},async()=>{throw new Error('must not resend');}),null);
  const proposal=f.runtime.learning()[0]!;assert.equal(proposal.provenanceComplete,true);assert.ok(proposal.sourceRefs.some(ref=>ref.sourceId===turn.id));
  assert.throws(()=>f.runtime.reviewLearning(proposal.id,true,'model'));
  f.runtime.reviewLearning(proposal.id,true,'human');assert.equal(f.runtime.learning()[0]!.status,'accepted');
  const learned=f.runtime.memory.card(f.key,1000).items[0]!;
  assert.equal(learned.text,'synthetic knowledge');assert.equal(learned.sharing.approved,false);assert.deepEqual(learned.sharing.targets,[]);
  assert.throws(()=>f.runtime.reviewLearning(proposal.id,true,'human'));
  f.advance(100);assert.equal((await f.runtime.receive(envelope)).id,turn.id);assert.equal(f.requests.length,1);
  await assert.rejects(f.runtime.receive({...envelope,text:'different'}),{message:'EVENT_CONFLICT'});
});

test('learning and source collection permissions are separate; bot echoes cannot create model calls or learning evidence',async t=>{
  const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{learn:false}});
  const turn=await f.runtime.receive(f.envelope('chat-without-learning'));
  assert.equal(turn.status,'queued');assert.equal(f.runtime.learning().length,0);
  assert.deepEqual(f.runtime.memory.readPolicy().value.sources[turn.id]!.purposes,['read','draft']);
  const echo=await f.runtime.receive(f.envelope('own-echo',{actorKind:'bot',actor:'juebot'}));
  assert.equal(echo.reason,'NON_HUMAN');assert.equal(f.requests.length,1);assert.equal(f.runtime.memory.readPolicy().value.sources[echo.id],undefined);
});

test('latest bounded authorized recent context works after more than 100 received events',async t=>{
  const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{reply:false}});
  for(let index=0;index<110;index++){f.advance(1);await f.runtime.receive(f.envelope(`event-${index}`));}
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{reply:true}});
  await f.runtime.receive(f.envelope('event-latest'));
  const recent=f.requests[0]!.recent.map(item=>item.text);
  assert.equal(recent.length,8);assert.equal(recent.at(-1),'event-latest');assert.ok(recent.includes('event-109'));assert.ok(!recent.includes('event-99'));
  assert.equal(f.store.read<unknown[]>('recent:'+f.key)!.value.length,32);
});

test('revoked raw messages do not re-enter the next model context and old queued drafts fail closed',async t=>{
  const f=fixture(t);const first=await f.runtime.receive(f.envelope('revoked-secret'));
  f.runtime.memory.revokeSource(f.runtime.memory.readPolicy().revision,first.id,2);
  await f.runtime.receive(f.envelope('next'));
  assert.ok(!f.requests[1]!.recent.some(item=>item.text==='revoked-secret'));
  assert.equal(f.runtime.sendGate(f.runtime.outbox.list().find(item=>item.id===first.draftId)!).allowed,false);
  const proposal=f.runtime.learning().find(item=>item.sourceId===first.id)!;
  assert.throws(()=>f.runtime.reviewLearning(proposal.id,true,'human'),{message:'SOURCE_REVOKED'});
});

test('isolation keeps another stream out of context and shared candidates cannot launder parent provenance',async t=>{
  const f=fixture(t);const other=f.runtime.register({...identity,remoteId:'b'},1,'group-b');
  let revision=f.runtime.memory.readPolicy().revision;
  revision=f.runtime.memory.putSource(revision,{id:'private-source',conversationKey:f.key,revision:1,domain:'social',status:'active',purposes:['read','learn','draft'],audiences:[f.key,other],expiresAt:null}).revision;
  f.runtime.memory.addMemory(revision,{id:'private-memory',revision:1,conversationKey:f.key,kind:'private',text:'private fact',sourceRefs:[{sourceId:'private-source',revision:1}],derivedFrom:[],
    sharing:{approved:true,approvedBy:'human',ruleRevision:revision,targets:[other],purposes:['read','learn','draft'],expiresAt:null}});
  await f.runtime.receive(f.envelope('isolated',{key:other,text:'private'}));assert.deepEqual(f.requests.at(-1)!.memories,[]);
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{mode:'shared'});
  f.model.generate=async request=>{f.requests.push(request);return{text:'reply',learning:[{text:request.memories[0]!.text,kind:'knowledge'}]};};
  await f.runtime.receive(f.envelope('shared',{key:other,text:'private'}));const proposal=f.runtime.learning().at(-1)!;
  assert.ok(proposal.sourceRefs.some(ref=>ref.sourceId==='private-source'));assert.deepEqual(proposal.derivedFrom,[{memoryId:'private-memory',revision:1}]);
  assert.throws(()=>f.runtime.reviewLearning(proposal.id,true,'human'),{message:'SOURCE_SCOPE_MISMATCH'});
  assert.equal(f.runtime.learning().at(-1)!.status,'pending');assert.equal(f.runtime.memory.card(other,1000).items.length,0);
  f.runtime.memory.revokeSource(f.runtime.memory.readPolicy().revision,'private-source',2);
  assert.throws(()=>f.runtime.reviewLearning(proposal.id,true,'human'),{message:'SOURCE_REVOKED'});
});

test('all model-visible inputs require learning permission, not just the latest event',async t=>{
  const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{learn:false}});
  await f.runtime.receive(f.envelope('read-only-input'));
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{learn:true}});
  await f.runtime.receive(f.envelope('learnable-input'));const proposal=f.runtime.learning()[0]!;
  assert.equal(proposal.sourceRefs.length,2);assert.throws(()=>f.runtime.reviewLearning(proposal.id,true,'human'),{message:'SOURCE_REVOKED'});
  assert.equal(f.runtime.memory.card(f.key,1000).items.length,0);
});

test('generation-time source, mode, binding, identity and model changes all suppress old drafts',async t=>{
  for(const change of ['source','memory-mode','binding','identity','model'] as const){
    const f=fixture(t);f.model.generate=async request=>{
      f.requests.push(request);
      if(change==='source'){const source=Object.values(f.runtime.memory.readPolicy().value.sources).at(-1)!;f.runtime.memory.revokeSource(f.runtime.memory.readPolicy().revision,source.id,2);}
      if(change==='memory-mode')f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{mode:'shared'});
      if(change==='binding')f.ledger.changeBinding(f.key,1,2,1000);
      if(change==='identity')f.runtime.self.rename(f.runtime.scope(f.key),'changed',f.runtime.self.get(f.runtime.scope(f.key)).revision);
      if(change==='model')f.model.id='changed-model';
      return{text:'stale reply',learning:[]};
    };
    await assert.rejects(f.runtime.receive(f.envelope('event')));assert.equal(f.runtime.outbox.list().length,0,change);
  }
});

test('persona/profile mutation while generating does not reuse another identity with revision one',async t=>{
  const f=fixture(t);f.model.generate=async()=>{f.options.profile={...f.options.profile,personaId:'another-persona'};return{text:'wrong persona',learning:[]};};
  await assert.rejects(f.runtime.receive(f.envelope('event')),{message:'IDENTITY_CHANGED'});assert.equal(f.runtime.outbox.list().length,0);
});

test('literal and semantic rewriting is bounded and includes explicit generation constraints',async t=>{
  const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{expressionRules:[{ruleId:'robotic',phrase:'bad phrase',match:'contains',action:'rewrite'}],
    styleContracts:[{contractId:'natural',policyText:'avoid mechanical summaries',counterexamples:['robotic ending']}]});
  let calls=0,reviews=0;f.model.generate=async request=>{f.requests.push(request);calls++;return{text:calls===1?'bad phrase':calls===2?'robotic ending':'natural answer',learning:[]};};
  f.model.reviewStyle=async request=>{reviews++;return request.text==='robotic ending'?'rewrite':'pass';};
  const turn=await f.runtime.receive(f.envelope('topic'));assert.equal(turn.status,'queued');assert.equal(calls,3);assert.equal(reviews,2);
  assert.equal(f.requests[0]!.expressionRules.length,1);assert.equal(f.requests[0]!.styleContracts.length,1);assert.equal(f.requests[1]!.rewrite!.reason,'EXPRESSION_REWRITE_REQUIRED');
  assert.equal(f.runtime.outbox.list()[0]!.body,'natural answer');assert.equal(f.runtime.sendGate(f.runtime.outbox.list()[0]!).allowed,true);
  const tampered={...f.runtime.outbox.list()[0]!,body:'changed body'};assert.equal(f.runtime.sendGate(tampered).allowed,false);
});

test('semantic contracts without a reviewer fail closed; failed reviews never silently fall back to literal allow',async t=>{
  for(const mode of ['missing','block','throw','loop'] as const){
    const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{styleContracts:[{contractId:'style',policyText:'be natural',counterexamples:[]}]});
    if(mode==='block')f.model.reviewStyle=async()=> 'block';
    if(mode==='throw')f.model.reviewStyle=async()=>{throw new Error('private provider failure');};
    if(mode==='loop')f.model.reviewStyle=async()=> 'rewrite';
    if(mode==='missing'||mode==='throw')await assert.rejects(f.runtime.receive(f.envelope('topic')));
    else assert.equal((await f.runtime.receive(f.envelope('topic'))).status,'skipped');
    assert.equal(f.runtime.outbox.list().length,0);if(mode==='loop')assert.equal(f.requests.length,3);
  }
});

test('queued replies respect newly refused contact and final gate is repeated immediately before external IO',async t=>{
  const f=fixture(t);await f.runtime.receive(f.envelope('topic'));f.deny();let sends=0;
  assert.equal(await f.runtime.dispatch(f.account,'owner',{id:'day',limit:10},async()=>{sends++;return{status:'confirmed',receipt:'object'};}),null);
  assert.equal(sends,0);
  const g=fixture(t);await g.runtime.receive(g.envelope('topic'));const original=g.runtime.outbox.claim.bind(g.runtime.outbox);
  g.runtime.outbox.claim=(...args)=>{const item=original(...args);g.deny();return item;};
  const result=await g.runtime.dispatch(g.account,'owner',{id:'day',limit:10},async()=>{sends++;return{status:'confirmed',receipt:'object'};});
  assert.equal(result!.status,'failed');assert.equal(result!.charged,false);assert.equal(sends,0);
});

test('unknown sends retain their reservations and cannot be retried through another sender',async t=>{
  const f=fixture(t);await f.runtime.receive(f.envelope('topic'));let sends=0;
  const result=await f.runtime.dispatch(f.account,'owner',{id:'day',limit:1},async()=>{sends++;throw new Error('uncertain transport');});
  assert.equal(result!.status,'unknown');assert.equal(sends,1);
  assert.equal(await f.runtime.dispatch(f.account,'other-owner',{id:'day',limit:1},async()=>{sends++;return{status:'confirmed',receipt:'object'};}),null);assert.equal(sends,1);
});

test('unconfigured models and model attempts to grant sharing cannot create an authorized draft',async t=>{
  const f=fixture(t);f.options.model=null;await assert.rejects(f.runtime.receive(f.envelope('offline')),{message:'MODEL_NOT_CONFIGURED'});assert.equal(f.runtime.outbox.list().length,0);
  const g=fixture(t);g.model.generate=async()=>({text:'reply',learning:[{text:'claim authority',kind:'knowledge',sharing:{approved:true}}]}) as never;
  await assert.rejects(g.runtime.receive(g.envelope('injection')));assert.equal(g.runtime.learning().length,0);assert.equal(g.runtime.outbox.list().length,0);
});

test('concurrent duplicate delivery makes one model call while a distinct same-stream turn is rejected as busy',async t=>{
  const f=fixture(t);let release!:()=>void,started!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{started=resolve;});let calls=0;
  f.model.generate=async()=>{calls++;started();await waiting;return{text:'reply',learning:[]};};
  const envelope=f.envelope('event');const pending=f.runtime.receive(envelope);await ready;
  const duplicate=await f.runtime.receive(envelope);assert.equal(duplicate.status,'generating');assert.equal(calls,1);
  await assert.rejects(f.runtime.receive(f.envelope('different-event')),{message:'CONVERSATION_BUSY'});
  release();assert.equal((await pending).status,'queued');assert.equal(f.runtime.outbox.list().length,1);
});

test('draft enqueue, learning proposals and turn commit together; a later review write failure cannot leave accepted memory',async t=>{
  const f=fixture(t);
  f.stateDb.exec("CREATE TRIGGER block_learning BEFORE INSERT ON agent_state WHEN NEW.key='learning:pending' BEGIN SELECT RAISE(ABORT,'private failure'); END");
  await assert.rejects(f.runtime.receive(f.envelope('failed-turn')),{message:'STORAGE_FAILURE'});
  assert.equal(f.runtime.outbox.list().length,0);assert.equal(f.runtime.learning().length,0);
  f.stateDb.exec('DROP TRIGGER block_learning');
  await f.runtime.receive(f.envelope('successful-turn'));const proposal=f.runtime.learning()[0]!;
  f.stateDb.exec("CREATE TRIGGER block_review BEFORE UPDATE ON agent_state WHEN NEW.key='learning:pending' BEGIN SELECT RAISE(ABORT,'private failure'); END");
  assert.throws(()=>f.runtime.reviewLearning(proposal.id,true,'human'),{message:'STORAGE_FAILURE'});
  assert.equal(f.runtime.learning()[0]!.status,'pending');assert.equal(f.runtime.memory.card(f.key,1000).items.length,0);
  f.stateDb.exec('DROP TRIGGER block_review');f.runtime.reviewLearning(proposal.id,true,'human');
  assert.equal(f.runtime.learning()[0]!.status,'accepted');assert.equal(f.runtime.memory.card(f.key,1000).items.length,1);
});

test('active intention sources and latest refusal are rechecked before initiative delivery without learning from bot output',async t=>{
  const f=fixture(t);f.runtime.observe(f.key,{eventId:'interest-proof',revision:1,kind:'external',topic:'music',interestDelta:10,feedback:'interest'});
  const turn=await f.runtime.idle(f.key,'music','idle-topic') as {status:string};assert.equal(turn.status,'queued');assert.equal(f.requests[0]!.kind,'initiative');
  assert.equal(f.runtime.learning().length,0);const item=f.runtime.outbox.list()[0]!;
  assert.equal(f.runtime.sendGate(item).allowed,true);
  f.runtime.self.revokeSource(f.runtime.scope(f.key),'interest-proof',1);
  assert.equal(f.runtime.sendGate(item).allowed,false);let calls=0;
  assert.equal(await f.runtime.dispatch(f.account,'owner',{id:'day',limit:10},async()=>{calls++;return{status:'confirmed',receipt:'object'};}),null);
  assert.equal(calls,0);
});

test('source expiry and semantic review-time revocation invalidate drafts even without a new incoming event',async t=>{
  const f=fixture(t);let revision=f.runtime.memory.readPolicy().revision;
  revision=f.runtime.memory.putSource(revision,{id:'expiring-source',revision:1,conversationKey:f.key,domain:'social',status:'active',purposes:['read','learn','draft'],audiences:[f.key],expiresAt:1100}).revision;
  f.runtime.memory.addMemory(revision,{id:'expiring-memory',revision:1,conversationKey:f.key,kind:'knowledge',text:'expiring fact',sourceRefs:[{sourceId:'expiring-source',revision:1}],derivedFrom:[],
    sharing:{approved:false,approvedBy:null,ruleRevision:revision,targets:[],purposes:['read','learn','draft'],expiresAt:null}});
  const turn=await f.runtime.receive(f.envelope('expiring'));const item=f.runtime.outbox.list().find(item=>item.id===turn.draftId)!;
  assert.equal(f.runtime.sendGate(item).allowed,true);const unchangedRevision=f.runtime.memory.readPolicy().revision;
  f.advance(101);assert.equal(f.runtime.memory.readPolicy().revision,unchangedRevision);assert.equal(f.runtime.sendGate(item).allowed,false);
  const g=fixture(t);g.runtime.memory.configure(g.runtime.memory.readPolicy().revision,{styleContracts:[{contractId:'style',policyText:'natural',counterexamples:[]}]});
  g.model.reviewStyle=async()=>{g.runtime.memory.configure(g.runtime.memory.readPolicy().revision,{permissions:{reply:false}});return'pass';};
  await assert.rejects(g.runtime.receive(g.envelope('topic')));assert.equal(g.runtime.outbox.list().length,0);
});

test('reviewed repetition passes semantic review unchanged, bypasses ordinary typing, and carries actual ingress sources',async t=>{
  const f=fixture(t);const {events,sources}=await repetitionFixture(f);let reviews=0;
  f.model.reviewStyle=async()=>{reviews++;return'pass';};
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{typing:{enabled:true,minDelayMs:5000,maxDelayMs:5000}});
  await f.runtime.receive(f.envelope('ordinary-topic'));const ordinary=f.runtime.outbox.list()[0]!;assert.equal(ordinary.dueAt,6000);
  assert.equal(f.runtime.repeat(f.key,events,true),null,'synchronous entry cannot fake semantic review');
  const id=await f.runtime.repeatReviewed(f.key,events,true);assert.ok(id);const repeated=f.runtime.outbox.list().find(item=>item.id===id)!;
  assert.equal(repeated.body,'same copied text');assert.equal(repeated.dueAt,repeated.createdAt);assert.equal(repeated.dueAt,1000);
  assert.deepEqual(repeated.sourceRefs.map(ref=>ref.id),sources);assert.equal(reviews,2);
  const sent=await f.runtime.dispatch(f.account,'owner',{id:'day',limit:2},async item=>{assert.equal(item.kind,'repetition');return{status:'confirmed',receipt:'repeat-object'};});
  assert.equal(sent!.id,id);assert.equal(f.runtime.outbox.list().find(item=>item.id===ordinary.id)!.status,'queued');
});

test('reviewed repetition does not rewrite copied content and refuses unverified event material',async t=>{
  for(const outcome of ['rewrite','block'] as const){const f=fixture(t);const {events}=await repetitionFixture(f);
    f.model.reviewStyle=async()=>outcome;assert.equal(await f.runtime.repeatReviewed(f.key,events,true),null);assert.equal(f.runtime.outbox.list().length,0);}
  const f=fixture(t);const {events}=await repetitionFixture(f);f.model.reviewStyle=async()=> 'pass';
  const forged=events.map(event=>({...event,text:'forged copied text'}));
  await assert.rejects(f.runtime.repeatReviewed(f.key,forged,true),{message:'UNTRUSTED_REPETITION_SOURCE'});assert.equal(f.runtime.outbox.list().length,0);
  const g=fixture(t);const prepared=await repetitionFixture(g);await assert.rejects(g.runtime.repeatReviewed(g.key,prepared.events,true),{message:'STYLE_REVIEW_UNAVAILABLE'});
});

test('repetition review-time source revocation, policy change, refusal and expiry all invalidate submission',async t=>{
  for(const change of ['source','policy','refusal','expiry'] as const){
    const f=fixture(t);const {events,sources}=await repetitionFixture(f);
    f.model.reviewStyle=async()=>{
      if(change==='source')f.runtime.revokeSource(sources[0]!,f.runtime.memory.readPolicy().revision,2);
      if(change==='policy')f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{prompt:'new policy'});
      if(change==='refusal')f.deny();if(change==='expiry')f.advance(120001);return'pass';
    };
    await assert.rejects(f.runtime.repeatReviewed(f.key,events,true));assert.equal(f.runtime.outbox.list().length,0,change);
  }
});

test('management revocation clears affect, interest and intent evidence and supports idempotent cascade retry',async t=>{
  const f=fixture(t);f.runtime.observe(f.key,{eventId:'proof',revision:1,kind:'external',topic:'music',interestDelta:10,feedback:'interest',affect:{valence:60,intensity:80}});
  await f.runtime.idle(f.key,'music','idle-topic');assert.equal(f.runtime.outbox.list().length,1);
  const before=f.runtime.memory.readPolicy().revision;f.runtime.revokeSource('proof',before,2);
  f.runtime.revokeSource('proof',before,2);const state=f.runtime.self.get(f.runtime.scope(f.key)).value;
  assert.equal(state.affect.intensity,0);assert.equal(Object.hasOwn(state.interests,'music'),false);assert.equal(state.evidence.proof!.revoked,true);
  assert.equal(f.runtime.sendGate(f.runtime.outbox.list()[0]!).allowed,false);
  const g=fixture(t);g.runtime.memory.putSource(g.runtime.memory.readPolicy().revision,{id:'expiring-proof',revision:1,conversationKey:g.key,domain:'social',status:'active',purposes:['read','learn','draft'],audiences:[g.key],expiresAt:1100});
  g.runtime.observe(g.key,{eventId:'expiring-proof',revision:1,kind:'external',topic:'music',interestDelta:10,feedback:'interest',affect:{valence:40,intensity:70}});
  await g.runtime.idle(g.key,'music','idle-topic');const item=g.runtime.outbox.list()[0]!;assert.equal(g.runtime.sendGate(item).allowed,true);
  g.advance(101);assert.equal(g.runtime.sendGate(item).allowed,false);
  assert.equal(g.runtime.self.get(g.runtime.scope(g.key)).value.affect.intensity,0,'expired state cannot enter a later model request');
});

test('reviewed identity configuration persists into model requests and invalidates old drafts by identity revision',async t=>{
  const f=fixture(t);await f.runtime.receive(f.envelope('before'));const old=f.runtime.outbox.list()[0]!;const scope=f.runtime.scope(f.key);
  f.runtime.self.configureIdentity(scope,f.runtime.self.get(scope).revision,'新名字','reviewed new role core');
  assert.equal(f.runtime.sendGate(old).allowed,false);
  await f.runtime.receive(f.envelope('after'));assert.equal(f.requests.at(-1)!.name,'新名字');assert.equal(f.requests.at(-1)!.roleCore,'reviewed new role core');
});

const experience={topic:'music',interestDelta:6,valence:40,intensity:35,relationshipDelta:3,feedback:'interest' as const};
test('real receive learns bounded experience, reviewed adaptation reaches the next request and source revocation cannot revive it',async t=>{
  const f=fixture(t);f.model.generate=async request=>{f.requests.push(request);return{text:'music reply',learning:[],observation:experience};};
  const first=await f.runtime.receive(f.envelope('music-source',{text:'music'}));const scope=f.runtime.scope(f.key);
  let state=f.runtime.self.get(scope).value;assert.equal(state.interests.music!.score,56);assert.equal(state.affect.valence,40);
  assert.equal(state.relationships['human-a']!.score,53);assert.deepEqual(state.interests.music!.sources,[{eventId:first.id,revision:1}]);
  const engine=f.runtime.self;
  const proposed=engine.propose(scope,{id:'reviewed',adaptation:{warmth:60,curiosity:60,initiative:60},sources:[{eventId:first.id,revision:1}]});
  engine.freezeSuite(scope,{id:'heldout',version:1,checks:[{id:'privacy',required:true},{id:'conversation',required:true}]});
  const evaluated=engine.evaluate(scope,'reviewed',proposed.revision,{suiteId:'heldout',suiteVersion:1,modelVersion:f.model.id,baselineVersion:'initial',baseline:{privacy:'pass',conversation:'pass'},candidate:{privacy:'pass',conversation:'pass'}});
  const reviewed=engine.review(scope,'reviewed',evaluated.revision,{reviewer:'human',human:true,approve:true});
  engine.activate(scope,'reviewed',reviewed.revision,engine.get(scope).revision);
  await f.runtime.receive(f.envelope('after-growth',{text:'more music please'}));
  assert.deepEqual(f.requests.at(-1)!.adaptation,{warmth:60,curiosity:60,initiative:60});assert.equal(f.requests.at(-1)!.affect.valence,0.4);
  assert.equal(f.requests.at(-1)!.topic,'music');
  const active=engine.get(scope).value.growthVersion;assert.notEqual(active,'initial');
  f.runtime.revokeSource(first.id,f.runtime.memory.readPolicy().revision,2);
  state=engine.get(f.runtime.scope(f.key)).value;assert.equal(state.growthVersion,'initial');assert.equal(state.affect.intensity,0);assert.deepEqual(state.interests,{});
  assert.throws(()=>engine.restore(scope,active,engine.get(scope).revision,{reviewer:'human',human:true}),{message:'SOURCE_REVOKED'});
  assert.equal((await f.runtime.receive(f.envelope('music-source',{text:'music'}))).id,first.id);
  assert.deepEqual(engine.get(f.runtime.scope(f.key)).value.interests,{});
});

test('disagreement observation has no affect or relationship penalty and learn-disabled input creates no experienced state',async t=>{
  const f=fixture(t);f.model.generate=async()=>({text:'we can disagree',learning:[],observation:{...experience,feedback:'disagreement',interestDelta:0,relationshipDelta:-10,valence:-100,intensity:100}});
  await f.runtime.receive(f.envelope('different-opinion'));const state=f.runtime.self.get(f.runtime.scope(f.key)).value;
  assert.deepEqual(state.relationships,{});assert.equal(state.affect.intensity,0);
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{learn:false}});
  const next=await f.runtime.receive(f.envelope('private-no-learning'));assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.evidence[next.id],undefined);
});

test('participation zero silences ingress and initiative and lower participation can decline repetition without a provider call',async t=>{
  const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{participation:0});
  assert.equal((await f.runtime.receive(f.envelope('muted'))).reason,'PARTICIPATION_DISABLED');
  assert.equal((await f.runtime.idle(f.key,'music','idle-topic') as {reason:string}).reason,'PARTICIPATION_DISABLED');assert.equal(f.requests.length,0);assert.equal(f.runtime.outbox.list().length,0);
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{participation:0.01});
  for(let i=0;i<3;i++)assert.equal((await f.runtime.receive(f.envelope('quiet-repeat-'+i,{text:'same',actor:i%2?'b':'a'}))).reason,'LOW_PARTICIPATION');
  assert.equal(f.runtime.outbox.list().length,0);assert.equal(f.requests.length,0);
});

test('receive automatically selects one multi-human repetition, bypasses typing delay and suppresses duplicate and bot echoes',async t=>{
  const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{typing:{enabled:true,minDelayMs:1000,maxDelayMs:3000}});
  const first=await f.runtime.receive(f.envelope('auto-1',{text:'same copied text',actor:'a'}));
  await f.runtime.receive(f.envelope('auto-gap',{text:'unrelated',actor:'c'}));
  await f.runtime.receive(f.envelope('auto-2',{text:'same copied text',actor:'b'}));
  const input=f.envelope('auto-3',{text:'same copied text',actor:'a'});const third=await f.runtime.receive(input);
  assert.equal(third.reason,'REPETITION_SELECTED');assert.equal(f.requests.length,3);const item=f.runtime.outbox.list().find(row=>row.id===third.draftId)!;
  assert.equal(item.kind,'repetition');assert.equal(item.dueAt,item.createdAt);assert.equal(item.sourceRefs.length,3);
  assert.ok(f.runtime.outbox.list().find(row=>row.id===first.draftId)!.dueAt>item.dueAt);
  await f.runtime.receive(input);assert.equal(f.runtime.outbox.list().filter(row=>row.kind==='repetition').length,1);
  assert.equal((await f.runtime.receive(f.envelope('self-human',{actor:'bot',text:'same copied text'}))).reason,'NON_HUMAN');
  f.runtime.revokeSource(item.sourceRefs[0]!.id,f.runtime.memory.readPolicy().revision,2);assert.equal(f.runtime.sendGate(item).allowed,false);
});

test('only a trusted reply to a confirmed initiative clears one unanswered attempt; unrelated or unknown delivery replies do not',async t=>{
  const f=fixture(t);f.model.generate=async()=>({text:'music reply',learning:[],observation:experience});
  await f.runtime.receive(f.envelope('seed',{text:'music'}));
  const initiative=await f.runtime.idle(f.key,'music','group-participation') as {draftId:string};
  assert.ok(initiative.draftId);assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.counters['group-participation']!.unanswered,1);
  await f.runtime.receive(f.envelope('before-confirmation',{replyTo:initiative.draftId}));
  assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.counters['group-participation']!.unanswered,1);
  // A fresh initiative gets the current policy revision; the old queued one is invalidated by the intervening input.
  f.advance(1);const second=await f.runtime.idle(f.key,'music','group-participation') as {draftId:string};
  let delivered;
  do {delivered=await f.runtime.dispatch(f.account,'sender',{id:'day',limit:10},async item=>({status:'confirmed',receipt:item.id===second.draftId?'confirmed-platform-id':'ordinary-receipt'}));}while(delivered&&delivered.id!==second.draftId);
  assert.equal(delivered!.id,second.draftId);f.advance(1);
  await f.runtime.receive(f.envelope('unrelated',{actor:'someone-else'}));
  assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.counters['group-participation']!.unanswered,2);
  const answer=f.envelope('actual-answer',{replyTo:'confirmed-platform-id',actor:'someone-else'});await f.runtime.receive(answer);
  assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.counters['group-participation']!.unanswered,1);
  await f.runtime.receive(answer);await f.runtime.receive(f.envelope('second-answer',{replyTo:'confirmed-platform-id'}));
  assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.counters['group-participation']!.unanswered,1);
});

test('trace projection exposes scoped decisions and receipts without input text, prompts, learning bodies or model context',async t=>{
  const f=fixture(t);f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{prompt:'PRIVATE-PROMPT'});
  const turn=await f.runtime.receive(f.envelope('trace',{text:'PRIVATE-INPUT'}));
  const trace=f.runtime.trace(f.key);assert.equal(trace.turns[0]!.id,turn.id);assert.equal(trace.turns[0]!.status,'queued');assert.equal(trace.deliveries[0]!.kind,'social');
  const json=JSON.stringify(trace);for(const forbidden of ['PRIVATE-PROMPT','PRIVATE-INPUT','synthetic knowledge','synthetic reply','roleCore'])assert.equal(json.includes(forbidden),false);
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{permissions:{receive:false}});assert.throws(()=>f.runtime.trace(f.key),{message:'ACCESS_DENIED'});
});

test('a direct confirmed initiative requires the fixed target actor and a later ingress, while failures retain readable codes',async t=>{
  const f=fixture(t);const direct=f.runtime.register({...identity,kind:'direct',remoteId:'dm-a'},1,'direct');
  f.model.generate=async()=>({text:'hello',learning:[],observation:experience});
  await f.runtime.receive(f.envelope('direct-seed',{key:direct,text:'music'}));
  const initiative=await f.runtime.idle(direct,'music','direct-contact') as {draftId:string};let delivered;
  do {delivered=await f.runtime.dispatch(f.account,'sender',{id:'day',limit:10},async()=>({status:'confirmed',receipt:'dm-message'}));}while(delivered&&delivered.id!==initiative.draftId);
  f.advance(1);await f.runtime.receive(f.envelope('wrong-actor',{key:direct,actor:'human-b'}));
  assert.equal(f.runtime.self.get(f.runtime.scope(direct)).value.counters['direct-contact']!.unanswered,1);
  await f.runtime.receive(f.envelope('right-actor',{key:direct,actor:'human-a'}));assert.equal(f.runtime.self.get(f.runtime.scope(direct)).value.counters['direct-contact']!.unanswered,0);
  f.model.generate=async()=>{throw Object.assign(new Error('private details'),{code:'MODEL_TIMEOUT'});};
  await assert.rejects(f.runtime.receive(f.envelope('failure')));assert.equal(f.runtime.trace(f.key).turns.at(-1)!.reason,'MODEL_TIMEOUT');
});

test('trusted source learning intake is pending, idempotent, bounded to the current source and requires separate human acceptance',async t=>{
  const f=fixture(t);f.options.model=null;
  const put=f.runtime.memory.putSource(f.runtime.memory.readPolicy().revision,{id:'bili-source',conversationKey:f.key,revision:1,domain:'social',status:'active',purposes:['read','learn','draft'],audiences:[f.key],expiresAt:null});
  const input={id:'bili-candidate',text:'public source fact',kind:'knowledge' as const,sourceId:'bili-source',sourceRevision:1};
  assert.throws(()=>f.runtime.proposeLearning(f.key,input,'model'),{message:'ACCESS_DENIED'});
  const candidate=f.runtime.proposeLearning(f.key,input,'human');assert.equal(candidate.status,'pending');assert.equal(f.runtime.learning().length,1);
  f.runtime.proposeLearning(f.key,input,'human');assert.equal(f.runtime.learning().length,1);assert.equal(f.runtime.memory.card(f.key,1000).items.length,0);
  assert.throws(()=>f.runtime.proposeLearning(f.key,{...input,text:'different'},'human'),{message:'EVENT_CONFLICT'});
  f.runtime.reviewLearning(candidate.id,true,'human');assert.equal(f.runtime.memory.card(f.key,1000).items[0]!.text,input.text);
  f.runtime.revokeSource(input.sourceId,f.runtime.memory.readPolicy().revision,2);assert.equal(f.runtime.memory.card(f.key,1000).items.length,0);
  assert.throws(()=>f.runtime.proposeLearning(f.key,{...input,id:'revoked'},'human'),{message:'SOURCE_REVOKED'});assert.ok(put.revision>0);
});

test('configured local contact restrictions close receive and queued send gates without widening the Host window',async t=>{
  const f=fixture(t);const queued=await f.runtime.receive(f.envelope('before-quiet'));
  f.runtime.memory.configure(f.runtime.memory.readPolicy().revision,{contactPolicy:{timeZoneOffsetMinutes:0,windows:[{startMinute:100,endMinute:200}],cooldownMs:0,dailyLimit:10,unansweredLimit:10}},f.key);
  const turn=await f.runtime.receive(f.envelope('during-quiet'));assert.equal(turn.reason,'QUIET_HOURS');assert.equal(f.requests.length,1);
  assert.equal(f.runtime.sendGate(f.runtime.outbox.list().find(row=>row.id===queued.draftId)!).allowed,false);
});

test('observation provenance and experienced state roll back together on a real SQLite dependency write failure',async t=>{
  const f=fixture(t);const parent=await f.runtime.receive(f.envelope('prior-raw-source'));
  f.model.generate=async()=>({text:'reply',learning:[],observation:experience});
  f.stateDb.exec("CREATE TRIGGER refuse_observation_sources BEFORE INSERT ON agent_state WHEN NEW.key LIKE 'observation-sources:%' BEGIN SELECT RAISE(ABORT,'synthetic provenance failure'); END");
  await assert.rejects(f.runtime.receive(f.envelope('failed-observation')),{message:'STORAGE_FAILURE'});
  let state=f.runtime.self.get(f.runtime.scope(f.key)).value;assert.deepEqual(state.interests,{});assert.equal(state.affect.intensity,0);assert.deepEqual(state.relationships,{});
  assert.equal(Object.keys(state.evidence).length,0);f.stateDb.exec('DROP TRIGGER refuse_observation_sources');
  f.runtime.revokeSource(parent.id,f.runtime.memory.readPolicy().revision,2);f.runtime.close();
  const reopened=new BotRuntime(f.store,f.ledger,f.options);state=reopened.self.get(reopened.scope(f.key)).value;
  assert.deepEqual(state.interests,{});assert.equal(state.affect.intensity,0);assert.equal(Object.keys(state.evidence).length,0);reopened.close();
});

test('creation intention preparation uses real ingress evidence, leaves it pending and never sends or consumes an attempt',async t=>{
  const f=fixture(t);f.model.generate=async()=>({text:'reply',learning:[],observation:experience});
  assert.equal(f.runtime.prepareCreationIntention(f.key,'music').reason,'NO_EVIDENCE');
  const source=await f.runtime.receive(f.envelope('creation-interest',{text:'music'}));const count=f.runtime.outbox.list().length;
  const decision=f.runtime.prepareCreationIntention(f.key,'music');assert.equal(decision.intention!.status,'pending');assert.equal(f.runtime.outbox.list().length,count);
  assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.counters['idle-topic'],undefined);
  assert.equal(f.runtime.prepareCreationIntention(f.key,'music').intention!.id,decision.intention!.id);
  f.runtime.revokeSource(source.id,f.runtime.memory.readPolicy().revision,2);assert.equal(f.runtime.prepareCreationIntention(f.key,'music').reason,'NO_EVIDENCE');
});

test('provider-selected failure names cannot place secrets in durable turns or trace',async t=>{
  const f=fixture(t);f.model.generate=async()=>{throw Object.assign(new Error('private details'),{code:'MODEL_PRIVATE_API_SECRET'});};
  await assert.rejects(f.runtime.receive(f.envelope('unsafe-error')));const trace=f.runtime.trace(f.key);assert.equal(trace.turns.at(-1)!.reason,'TURN_FAILED');
  assert.equal(JSON.stringify(trace).includes('MODEL_PRIVATE_API_SECRET'),false);
  const persisted=f.stateDb.prepare("SELECT value FROM agent_state WHERE key LIKE 'turn:%'").all();assert.equal(JSON.stringify(persisted).includes('MODEL_PRIVATE_API_SECRET'),false);
});

test('only a reviewed summary alias can prepare a neutral creation intention with learning disabled; raw scopes stay restricted',async t=>{
  const f=fixture(t),memory=f.runtime.memory;
  memory.putSource(memory.readPolicy().revision,{id:'private-raw',conversationKey:f.key,revision:1,domain:'social',status:'active',purposes:['read','learn'],audiences:[f.key],expiresAt:null});
  memory.addMemory(memory.readPolicy().revision,{id:'reviewed-summary',revision:1,conversationKey:f.key,kind:'knowledge',text:'Only this approved summary',sourceRefs:[{sourceId:'private-raw',revision:1}],derivedFrom:[],
    sharing:{approved:false,approvedBy:null,ruleRevision:memory.readPolicy().revision,targets:[],purposes:['read','learn','draft'],expiresAt:null}});
  const grant=memory.approveSummaryMaterial(memory.readPolicy().revision,{key:f.key,memoryId:'reviewed-summary',expectedMemoryRevision:1,action:'bili.dynamic',accountId:'target-account',target:{objectId:null,parentId:null,visibility:'public',category:null},principal:'human',reason:'Exact summary only',expiresAt:2000},1000);
  memory.configure(memory.readPolicy().revision,{permissions:{learn:false}});
  f.runtime.observe(f.key,{eventId:grant.sourceId,revision:1,kind:'external',topic:grant.topic,interestDelta:0,feedback:'interest'});
  const state=f.runtime.self.get(f.runtime.scope(f.key)).value;assert.equal(state.interests[grant.topic]!.score,50);assert.equal(state.affect.intensity,0);
  const intention=f.runtime.prepareCreationIntention(f.key,grant.topic).intention!;assert.ok(intention);assert.deepEqual(intention.sources,[{eventId:grant.sourceId,revision:1}]);assert.equal(f.runtime.learning().length,0);
  assert.deepEqual(memory.readPolicy().value.sources['private-raw']!.purposes,['read','learn']);assert.deepEqual(memory.readPolicy().value.sources[grant.sourceId]!.purposes,['draft','publish']);
  assert.throws(()=>f.runtime.observe(f.key,{eventId:'private-raw',revision:1,kind:'external',topic:'raw',interestDelta:0,feedback:'interest'}),{message:'ACCESS_DENIED'});
  assert.throws(()=>f.runtime.observe(f.key,{eventId:grant.sourceId,revision:1,kind:'external',topic:grant.topic,interestDelta:10,feedback:'interest'}),{message:'SUMMARY_OBSERVATION_INVALID'});
  f.advance(1000);assert.equal(f.runtime.prepareCreationIntention(f.key,grant.topic).reason,'NO_EVIDENCE');assert.equal(f.runtime.self.get(f.runtime.scope(f.key)).value.evidence[grant.sourceId]!.revoked,true);
});

test('summary parent correction revokes the alias experience and prevents its pending intention from surviving reopen',async t=>{
  const f=fixture(t),memory=f.runtime.memory;
  memory.putSource(memory.readPolicy().revision,{id:'summary-parent',conversationKey:f.key,revision:1,domain:'social',status:'active',purposes:['read','learn'],audiences:[f.key],expiresAt:null});
  memory.addMemory(memory.readPolicy().revision,{id:'summary-card',revision:1,conversationKey:f.key,kind:'knowledge',text:'Old reviewed summary',sourceRefs:[{sourceId:'summary-parent',revision:1}],derivedFrom:[],sharing:{approved:false,approvedBy:null,ruleRevision:memory.readPolicy().revision,targets:[],purposes:['read'],expiresAt:null}});
  const grant=memory.approveSummaryMaterial(memory.readPolicy().revision,{key:f.key,memoryId:'summary-card',expectedMemoryRevision:1,action:'bili.dynamic',accountId:'target-account',target:{objectId:null,parentId:null,visibility:'public',category:null},principal:'human',reason:'Approved summary',expiresAt:10000},1000);
  f.runtime.observe(f.key,{eventId:grant.sourceId,revision:1,kind:'external',topic:grant.topic,interestDelta:0,feedback:'interest'});assert.ok(f.runtime.prepareCreationIntention(f.key,grant.topic).intention);
  memory.reviewMemory(memory.readPolicy().revision,{id:'summary-card',expectedMemoryRevision:1,action:'correct',text:'Corrected summary',principal:'human',reason:'Correction'},1000);
  f.runtime.close();const reopened=new BotRuntime(f.store,f.ledger,f.options);assert.equal(reopened.prepareCreationIntention(f.key,grant.topic).reason,'NO_EVIDENCE');
  assert.equal(reopened.self.get(reopened.scope(f.key)).value.evidence[grant.sourceId]!.revoked,true);reopened.close();
});
