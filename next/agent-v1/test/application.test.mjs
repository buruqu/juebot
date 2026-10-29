import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,existsSync,writeFileSync,linkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openApplication} from '../host/application.js';
import {JsonModelProvider} from '../host/model-provider.js';
function folder(t){const parent=realpathSync(tmpdir());const root=mkdtempSync(path.join(parent,'juebot-agent-app-'));t.after(()=>{assert.ok(path.dirname(root)===parent&&path.basename(root).startsWith('juebot-agent-app-'));rmSync(root,{recursive:true,force:true});});return root;}
const owner={principal:'juebot-host-owner'};
const config=root=>({enabled:true,dataRoot:root,namespace:'synthetic-test',initializeEmpty:true});
test('disabled application does not touch requested nonexistent data path',async()=>{const root=path.join(tmpdir(),'juebot-must-not-create-'+Date.now());const app=await openApplication({}, {enabled:false,dataRoot:root,initializeEmpty:true}, owner);assert.equal((await app.fetch(new Request('http://localhost/api/juebot/agent/status'))).status,503);assert.equal(existsSync(root),false);app.close();});
test('compiled application reopens owned SQLite with settings and stays paused without models',async t=>{const root=folder(t);let app=await openApplication({},config(root),owner);const identity={botId:'juebot',personaId:'juejue',connector:'local-test',issuer:'synthetic',accountId:'one',kind:'direct',remoteId:'person'};const key=app.runtime.register(identity,1,'合成会话');app.runtime.memory.configure(0,{permissions:{receive:true,save:true,reply:true}});let response=await app.fetch(new Request('http://localhost/api/juebot/agent/status'));assert.equal(response.status,200);assert.equal((await response.json()).data.modelConfigured,false);await assert.rejects(openApplication({},config(root),owner),/APPLICATION_ALREADY_OWNED/);app.close();app=await openApplication({}, {...config(root),initializeEmpty:false},owner);try{assert.equal(app.runtime.conversations()[0].key,key);assert.equal(app.runtime.memory.effective(key).permissions.reply,true);assert.equal(app.runtime.outbox.state().paused,true);assert.equal(app.code.snapshot().value.enabled,false);}finally{app.close();}});
test('owner identity management updates profile and scopes, stale CAS rejected',async t=>{const root=folder(t);const app=await openApplication({},config(root),owner);try{const key=app.runtime.register({botId:'juebot',personaId:'juejue',connector:'local-test',issuer:'test',accountId:'one',kind:'direct',remoteId:'one'},1,'测试');const request=profile=>new Request('http://localhost/api/juebot/agent/identity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:0,profile})});let response=await app.fetch(request({botId:'juebot',personaId:'juejue',mode:'juejue',name:'新名字',roleCore:'连续的合成角色'}));assert.equal(response.status,200);assert.equal(app.runtime.profile.name,'新名字');assert.equal(app.runtime.self.get(app.runtime.scope(key)).value.name,'新名字');response=await app.fetch(request(app.runtime.profile));assert.equal(response.status,409);}finally{app.close();}});
test('foreign ledger database refuses activation and owner lock is cleaned',async t=>{const root=folder(t);const db=new DatabaseSync(path.join(root,'events.sqlite'));db.exec('CREATE TABLE unrelated(value TEXT)');db.close();await assert.rejects(openApplication({},config(root),owner),/STORE_MISMATCH/);assert.equal(existsSync(path.join(root,'.juebot-agent-owner')),false);const check=new DatabaseSync(path.join(root,'events.sqlite'));try{assert.equal(check.prepare('SELECT name FROM sqlite_schema').all()[0].name,'unrelated');}finally{check.close();}});

test('mode switching restores independent saved identities across reopen',async t=>{
  const root=folder(t);let app=await openApplication({},config(root),owner);let revision=0;
  const save=async profile=>{const response=await app.fetch(new Request('http://localhost/api/juebot/agent/identity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:revision,profile})}));assert.equal(response.status,200);const data=(await response.json()).data;revision=data.revision;return data;};
  await save({...app.runtime.profile,name:'Original J',roleCore:'J core'});
  const key=app.runtime.register({botId:'juebot',personaId:'juejue',connector:'local-test',issuer:'test',accountId:'one',kind:'direct',remoteId:'person'},1,'测试');
  await save({...app.runtime.profile,mode:'persona',name:'P',roleCore:'P core'});assert.equal(app.runtime.conversations().length,0);
  const restored=await save({...app.runtime.profile,mode:'juejue'});assert.equal(restored.profile.roleCore,'J core');assert.equal(restored.profile.name,'Original J');
  assert.equal(app.runtime.self.get(app.runtime.scope(key)).value.roleCore,'J core');assert.equal(restored.profiles.persona.roleCore,'P core');
  app.close();app=await openApplication({}, {...config(root),initializeEmpty:false},owner);
  try{await save({...app.runtime.profile,mode:'persona'});assert.equal(app.runtime.profile.roleCore,'P core');}finally{app.close();}
});
test('explicit initialization still refuses source/install trees before any lock or database',async t=>{
  const root=folder(t);writeFileSync(path.join(root,'package.json'),'{}');await assert.rejects(openApplication({},config(root),owner),/APPLICATION_PACKAGE_PATH/);
  assert.equal(existsSync(path.join(root,'agent.sqlite')),false);assert.equal(existsSync(path.join(root,'.juebot-agent-owner')),false);
});
test('SQLite journal hardlinks are rejected before DatabaseSync can touch their targets',async t=>{
  const root=folder(t);const target=path.join(root,'synthetic-private.txt');writeFileSync(target,'synthetic protected material');linkSync(target,path.join(root,'agent.sqlite-wal'));
  await assert.rejects(openApplication({},config(root),owner),/APPLICATION_PATH_UNSAFE/);assert.equal(readFileSync(target,'utf8'),'synthetic protected material');assert.equal(existsSync(path.join(root,'agent.sqlite')),false);
});
test('compiled runtime uses real model-port format, persists response and dispatches through the common sender',async t=>{
  const root=folder(t);const requests=[];const model=new JsonModelProvider({id:'synthetic-model',endpoint:'https://synthetic.invalid/chat/completions',model:'test-only',credential:async()=>'SYNTHETIC-ONLY',
    maxTokens:256,timeoutMs:1000,budget:{reserve:async()=>({id:'test'}),settle:async()=>{}},fetchImpl:async(_url,request)=>{requests.push(JSON.parse(request.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'合成回答',learning:[]})}}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}}));}});
  const app=await openApplication({},config(root),owner,{model,now:()=>1000,acceptIngress:()=>true,participation:key=>({enabled:true,allowedTargets:[key],deniedTargets:[],timeZoneOffsetMinutes:0,windows:[{startMinute:0,endMinute:1440}],cooldownMs:0,dailyLimit:10,unansweredLimit:10})});
  try{const key=app.runtime.register({botId:'juebot',personaId:'juejue',connector:'local-test',issuer:'fixture',accountId:'one',kind:'direct',remoteId:'person'},1,'测试');
    app.runtime.memory.configure(0,{permissions:{receive:true,save:true,learn:true,reply:true},typing:{enabled:false}});app.runtime.outbox.setPause(0,false);
    app.runtime.observe(key,{eventId:'source',revision:1,kind:'external',topic:'music',feedback:'interest',interestDelta:10,affect:{valence:60,intensity:80}});
    const turn=await app.runtime.receive({key,bindingRevision:1,eventId:'incoming',actor:'human',actorKind:'human',plain:true,text:'synthetic',observedAt:1000});assert.equal(turn.status,'queued');
    const input=JSON.parse(requests[0].messages[1].content);assert.deepEqual(input.affect,{valence:0.6,intensity:0.8});
    const result=await app.dispatcher.dispatch(JSON.stringify(['local-test','fixture','one']),'test',{id:'day',limit:1},async()=>({status:'confirmed',receipt:'synthetic-message'}));assert.equal(result.status,'confirmed');
    assert.ok(app.runtime.ledger.pageEvents(key,1,0,20).some(event=>event.eventType==='reply.confirmed'));
  }finally{app.close();}
});
test('runner is inert until explicit start and application close drains admitted transport before DB release',async t=>{
  const root=folder(t);let callback,unsubscribed=0;const timers=[];
  const app=await openApplication({},config(root),owner,{runner:{accounts:[],subscribe:async handler=>{callback=handler;return()=>{unsubscribed++;};},decode:()=>null,setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}}});
  assert.equal(app.runner.status().started,false);await app.runner.start();assert.equal(typeof callback,'function');const closing=app.close();assert.equal(app.runner.status().closed,true);await closing;
  assert.equal(unsubscribed,1);assert.equal(existsSync(path.join(root,'.juebot-agent-owner')),false);assert.equal((await callback({})).accepted,false);
});

test('compiled interest -> model creative plan -> actual local MP4 -> final human approval -> one synthetic submission',async t=>{
  const root=folder(t);let modelCalls=0;const publication={title:'Synthetic final title',description:'Synthetic description',tags:['synthetic'],text:'Synthetic public text'};
  const model=new JsonModelProvider({id:'synthetic-creative-model',endpoint:'https://synthetic.invalid/chat/completions',model:'test-only',credential:async()=>'SYNTHETIC-ONLY',maxTokens:512,timeoutMs:2000,
    budget:{reserve:async()=>({id:'test'}),settle:async()=>{}},fetchImpl:async(_url,request)=>{modelCalls++;const payload=JSON.parse(request.body);
      const content=payload.messages[0].content.includes('unapproved creative plan')?{brief:'A synthetic local video',script:'One two-second text scene',...publication}
        :{title:'Storyboard title',description:'Storyboard details',tags:['storyboard'],scenes:[{text:'Synthetic offline video',duration:2}]};
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:25,completion_tokens:15,total_tokens:40}}));}});
  const policy={enabled:true,allowedTargets:['public-creation'],deniedTargets:[],timeZoneOffsetMinutes:0,windows:[{startMinute:0,endMinute:1440}],cooldownMs:0,dailyLimit:2,unansweredLimit:2};
  const account=JSON.stringify(['bilibili','synthetic','one']);
  const app=await openApplication({},config(root),owner,{model,now:()=>1000,authorizeHuman:p=>p===owner.principal,resolveAccount:handle=>handle==='bili-one'?account:null,
    publicationAuthority:work=>({policyRevision:1,accountRevision:1,publishAllowed:true,sources:work.sources.map(source=>({...source,publishAllowed:true}))}),
    creative:{policy:()=>({revision:1,allowedAccounts:['bili-one'],allowedActions:['bili.video']}),materials:async()=>({revision:1,sources:[{id:'public-proof',revision:1,personLinkRevision:null}],items:[{id:'public-proof',text:'Approved synthetic creative material'}]})}});
  try{const key=app.runtime.register({botId:'juebot',personaId:'juejue',connector:'local-test',issuer:'fixture',accountId:'one',kind:'direct',remoteId:'person'},1,'测试');
    app.runtime.memory.configure(0,{permissions:{receive:true,save:true,learn:true}});
    app.runtime.memory.putSource(app.runtime.memory.readPolicy().revision,{id:'public-proof',revision:1,conversationKey:key,domain:'social',status:'active',purposes:['read','learn','draft','publish'],audiences:[key],expiresAt:null});
    app.runtime.observe(key,{eventId:'public-proof',revision:1,kind:'external',topic:'synthetic video',interestDelta:10,feedback:'interest'});
    const decision=app.runtime.self.decide(app.runtime.scope(key),{target:'public-creation',topic:'synthetic video',action:'idle-topic',policy});assert.ok(decision.intention);
    const result=await app.workflow(key).start(decision.intention.id,{action:'bili.video',accountId:'bili-one',target:{objectId:null,parentId:null,visibility:'public',category:'synthetic'}});
    assert.equal(result.status,'ready');assert.equal(modelCalls,2);assert.equal(result.work.value.approval,null);assert.equal(app.runtime.outbox.list().length,0);
    const final=result.work.value.final.manifest;assert.equal(final.title,publication.title);assert.equal(final.text,publication.text);
    const video=app.assets.read(final.video.previewRef);assert.equal(video.mime,'video/mp4');assert.ok(video.bytes.length>1000);assert.equal(Buffer.from(video.bytes).subarray(4,8).toString(),'ftyp');
    const approved=app.creation.approve(result.work.value.id,result.work.revision,owner.principal,10000);app.dispatcher.submitCreation(approved.value.id,approved.revision);
    app.runtime.outbox.setPause(app.runtime.outbox.state().revision,false);let sends=0;
    const sent=await app.dispatcher.dispatch(account,'synthetic-sender',{id:'day',limit:1},async()=>{sends++;return{status:'confirmed',receipt:'synthetic-video-id',visibility:'pending-review'};});
    assert.equal(sent.status,'confirmed');assert.equal(sends,1);assert.equal(app.creation.read(approved.value.id).value.submission.state,'pending-review');
  }finally{app.close();}
});
