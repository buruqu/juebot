import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AssetRegistry } from './assets.js';
import { VideoProducer } from './video-producer.js';
import { createRunner } from './runner.js';
import { createBiliReadSource } from './bili-read-source.js';
import { createBiliMaterials } from './bili-materials.js';
import { createMaintenance } from './maintenance.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(ok,code='APPLICATION_INVALID_CONFIG')=>{if(!ok)fail(code);};
function checkDirectory(directory){
  need(path.isAbsolute(directory)&&path.resolve(directory)!==path.parse(directory).root&&!directory.startsWith('\\\\'));
  for(let p=path.resolve(directory);;p=path.dirname(p)){const info=lstatSync(p);need(!info.isSymbolicLink(),'APPLICATION_PATH_UNSAFE');
    // State belongs outside source/install trees; confirmation must never write into a bundle.
    if(existsSync(path.join(p,'package.json'))||existsSync(path.join(p,'cordis.patch.yml')))fail('APPLICATION_PACKAGE_PATH');
    if(path.dirname(p)===p)break;}
  const resolved=realpathSync(directory);need(lstatSync(resolved).isDirectory(),'APPLICATION_PATH_UNSAFE');return resolved;
}
function database(root,name,initialize){
  const filename=path.join(root,name);const existed=existsSync(filename);
  for(const suffix of ['','-wal','-shm','-journal']){const file=filename+suffix;const info=lstatSync(file,{bigint:true,throwIfNoEntry:false});if(info)need(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n&&realpathSync(file)===file,'APPLICATION_PATH_UNSAFE');}
  if(!existed){need(initialize,'APPLICATION_INITIALIZATION_REQUIRED');const fd=openSync(filename,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR,0o600);closeSync(fd);}
  const before=lstatSync(filename,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n,'APPLICATION_PATH_UNSAFE');
  need(realpathSync(filename)===filename,'APPLICATION_PATH_UNSAFE');
  const db=new DatabaseSync(filename,{allowExtension:false});
  try{const after=lstatSync(filename,{bigint:true});need(after.ino===before.ino&&after.dev===before.dev&&after.nlink===1n&&!after.isSymbolicLink(),'APPLICATION_PATH_CHANGED');
    // Schema/owner validation runs before changing journal policy in the caller.
    return db;
  }catch(error){db.close();throw error;}
}
/** Only explicit enabled+owned storage configuration opens a database. Path confirmation alone never calls this factory. */
export async function openApplication(_ctx,config,{principal},ports={}){
  if(config.enabled!==true)return {fetch:async()=>new Response(JSON.stringify({ok:false,error:{code:'AGENT_NOT_ENABLED'}}),{status:503,headers:{'content-type':'application/json','cache-control':'no-store'}}),close(){}};
  need(typeof config.dataRoot==='string'&&typeof config.namespace==='string'&&config.namespace.length>0&&config.namespace.length<=128);
  need(config.initializeEmpty===undefined||typeof config.initializeEmpty==='boolean');
  const root=checkDirectory(config.dataRoot);const lock=path.join(root,'.juebot-agent-owner');
  try{mkdirSync(lock);}catch{fail('APPLICATION_ALREADY_OWNED');}
  const lockIdentity=lstatSync(lock,{bigint:true});const opened=[],lifetimes=[],pending=new Set();let runtime,store,ledger,runner,closed=false,closing;
  const release=()=>{store?.close();ledger?.close();let failed=false;
    for(const db of opened.reverse())try{db.close();}catch{failed=true;}
    try{const info=lstatSync(lock,{bigint:true});need(info.ino===lockIdentity.ino&&info.dev===lockIdentity.dev&&!info.isSymbolicLink(),'APPLICATION_LOCK_CHANGED');rmdirSync(lock);}catch{failed=true;}
    if(failed)fail('APPLICATION_CLOSE_FAILED');
  };
  const close=()=>{if(closed)return closing;closed=true;runtime?.close();
    const stops=[...(runner?[runner.stop()]:[]),...lifetimes.map(stop=>stop())],waits=[...stops,...pending];
    if(waits.length){closing=Promise.allSettled(waits).then(results=>{release();if(results.slice(0,stops.length).some(item=>item.status==='rejected'))fail('APPLICATION_CLOSE_FAILED');});return closing;}
    release();};
  try{
    const modules=ports.modules??await Promise.all([
      import('../lib/agent-v1/src/store.js'),import('../lib/conversation-v1/src/ledger.js'),import('../lib/agent-v1/src/runtime.js'),
      import('../lib/agent-v1/src/creation.js'),import('../lib/agent-v1/src/code-jobs.js'),import('../lib/agent-v1/src/dispatch.js'),import('../lib/agent-v1/src/api.js')]);
    const [{SqliteStateStore},{ConversationLedger},{BotRuntime},{CreationService},{CodeTasks},{DispatchCoordinator},{createAgentApi}]=modules;
    const {AgentError}=ports.modules?.[9]??await import('../lib/agent-v1/src/common.js');
    const {CreativeWorkflow}=ports.modules?.[7]??await import('../lib/agent-v1/src/creative-workflow.js');
    const {DeliveryReconciler}=ports.modules?.[8]??await import('../lib/agent-v1/src/delivery-reconciliation.js');
    const managementCheck=(ok,code='INVALID_INPUT')=>{if(!ok)throw new AgentError(code);};
    const sdb=database(root,'agent.sqlite',config.initializeEmpty===true);opened.push(sdb);store=new SqliteStateStore(sdb,{namespace:config.namespace,initialize:config.initializeEmpty===true});
    const ldb=database(root,'events.sqlite',config.initializeEmpty===true);opened.push(ldb);ledger=new ConversationLedger(ldb,{namespace:config.namespace,initialize:config.initializeEmpty===true});
    need(!ports.onStore?.(store)?.then,'APPLICATION_ASYNC_HOOK');
    for(const db of opened){db.exec('PRAGMA journal_mode=WAL');db.exec('PRAGMA synchronous=FULL');db.exec('PRAGMA foreign_keys=ON');}
    const assetRoot=path.join(root,'assets');if(!existsSync(assetRoot)){need(config.initializeEmpty===true,'APPLICATION_INITIALIZATION_REQUIRED');mkdirSync(assetRoot);}
    const assets=new AssetRegistry(store,{root:assetRoot});
    const defaultProfile={botId:'juebot',personaId:'juejue',mode:'juejue',name:'撅撅',roleCore:'保持连续的撅撅身份，依据真实经历交流，区分知道的事与不确定的事。'};
    const readIdentity=()=>{const s=store.read('identity:active');return {revision:s?.revision??0,profile:s?.value??defaultProfile,
      profiles:{juejue:store.read('identity:profile:juejue')?.value??defaultProfile,persona:store.read('identity:profile:persona')?.value??null}};};
    const participation=ports.participation??(()=>({enabled:false,allowedTargets:[],deniedTargets:[],timeZoneOffsetMinutes:480,windows:[],cooldownMs:60000,dailyLimit:0,unansweredLimit:0}));
    const makeRuntime=()=>new BotRuntime(store,ledger,{profile:readIdentity().profile,model:ports.model??null,now:ports.now??Date.now,
      acceptIngress:ports.acceptIngress??(()=>false),participation,authorizeLearning:p=>ports.authorizeHuman?.(p)===true});
    runtime=makeRuntime();need(!ports.onRuntime?.(runtime)?.then,'APPLICATION_ASYNC_HOOK');runtime.outbox.recover();
    const code=new CodeTasks(store,{getAuthorization:ports.codeAuthorization??(()=>null),namespace:config.namespace});code.restart((ports.now??Date.now)());
    const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const human=actor=>{const value=ports.authorizeHuman?.(actor);if(value?.then)Promise.resolve(value).catch(()=>{});managementCheck(!closed&&value===true,'ACCESS_DENIED');};
    const track=operation=>{pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;};
    const activeGuard=(key,actor,beforeCommit)=>{
      human(actor);const captured=runtime,identityRevision=readIdentity().revision;const conversation=runtime.conversations().find(item=>item.key===key);
      managementCheck(conversation&&ledger.getConversation(key)?.bindingRevision===conversation.bindingRevision,'BINDING_CONFLICT');
      return async()=>{await beforeCommit?.();human(actor);managementCheck(runtime===captured&&identityRevision===readIdentity().revision,'IDENTITY_CHANGED');
        const current=runtime.conversations().find(item=>item.key===key);managementCheck(current?.bindingRevision===conversation.bindingRevision&&ledger.getConversation(key)?.bindingRevision===conversation.bindingRevision,'BINDING_CONFLICT');};
    };
    const biliServices=new Map();
    const biliScope=()=>digest([config.namespace,readIdentity().profile.botId,readIdentity().profile.personaId]);
    const aliasesKey=()=>JSON.stringify(['application-bili-aliases-v1',biliScope()]);
    const aliases=()=>store.read(aliasesKey())?.value??{};
    const holdsKey=()=>JSON.stringify(['application-bili-holds-v1',biliScope()]);
    const holdFor=id=>store.read(holdsKey())?.value[id]??null;
    const knownBili=id=>Object.hasOwn(aliases(),id)||holdFor(id)!==null||Object.hasOwn(store.read(JSON.stringify(['bili-materials-v1','bili-'+biliScope()]))?.value.sources??{},id);
    const holdBili=(id,minimumRevision,reviewer,operation)=>store.atomic(tx=>{const current=tx.read(holdsKey()),holds=current?.value??{};
      holds[id]={minimumRevision:Math.max(holds[id]?.minimumRevision??0,minimumRevision),reviewer,operation,at:(ports.now??Date.now)()};tx.write(holdsKey(),current?.revision??0,holds);});
    const getBili=()=>{
      managementCheck(ports.bili,'NOT_CONFIGURED');const profile=readIdentity().profile,scope=biliScope();if(biliServices.has(scope))return biliServices.get(scope);
      const authorization=callback=>request=>{managementCheck(!closed&&readIdentity().profile.botId===profile.botId&&readIdentity().profile.personaId===profile.personaId,'IDENTITY_CHANGED');
        return callback?.({...request,profile:structuredClone(readIdentity().profile),identityRevision:readIdentity().revision});};
      const reader=createBiliReadSource({transport:ports.bili.transport,authorize:authorization(ports.bili.authorizeRead),budget:ports.bili.budget,now:ports.now??Date.now,
        ...(ports.bili.timeoutMs===undefined?{}:{timeoutMs:ports.bili.timeoutMs})});
      const materials=createBiliMaterials({store,reader,authorize:authorization(ports.bili.authorizeMaterials),now:ports.now??Date.now,namespace:'bili-'+scope});
      const service={reader,materials};biliServices.set(scope,service);lifetimes.push(()=>materials.close(),()=>reader.close());return service;
    };
    const invalidateBili=(id,nextRevision)=>{
      const map=aliases(),policy=runtime.memory.readPolicy();
      const affected=Object.entries(policy.value.sources).filter(([sourceId,source])=>(sourceId===id||map[sourceId]?.snapshotId===id)&&source.status==='active');
      for(const [sourceId,source]of affected)runtime.revokeSource(sourceId,runtime.memory.readPolicy().revision,Math.max(source.revision+1,nextRevision));
    };
    const sourceAllowed=(key,ref)=>{const source=runtime.memory.readPolicy().value.sources[ref.id??ref.eventId];
      managementCheck(source&&source.status==='active'&&source.domain==='social'&&source.revision===ref.revision&&source.purposes.includes('draft')&&source.purposes.includes('publish')
        &&source.audiences.includes(key)&&(source.expiresAt===null||source.expiresAt>(ports.now??Date.now)()),'SOURCE_REVOKED');};
    const validateBili=(ref,target,purpose)=>{
      if(!ports.bili)return !knownBili(ref.id);const alias=aliases()[ref.id];
      if((holdFor(alias?.snapshotId??ref.id)?.minimumRevision??0)>(alias?.snapshotRevision??ref.revision))return false;
      try{const service=getBili().materials;
        if(purpose)service.validateSource(alias?.snapshotId??ref.id,alias?.snapshotRevision??ref.revision,target,purpose);
        else{service.validateSource(alias?.snapshotId??ref.id,alias?.snapshotRevision??ref.revision,target,'draft');service.validateSource(alias?.snapshotId??ref.id,alias?.snapshotRevision??ref.revision,target,'publish');}return true;
      }catch(error){if(!alias&&error?.code==='BILI_SOURCE_NOT_FOUND')return true;return false;}
    };
    const validateSummary=(ref,request,key)=>{
      if(!runtime.memory.isSummaryMaterial?.(ref.id))return true;
      try{const source=runtime.memory.readPolicy().value.sources[ref.id],scope=key??source?.conversationKey;
        const resolved=runtime.memory.resolveSummaryMaterial(ref.id,scope,request,(ports.now??Date.now)());
        if(!resolved||resolved.revision!==ref.revision)return false;
        const record=runtime.memory.readPolicy().value.summaryMaterials[ref.id];
        return record.sourceRefs.every(origin=>validateBili({id:origin.sourceId,revision:origin.revision},scope,'learn'));
      }catch{return false;}
    };
    const combinedMaterials=async(key,intention,target,request)=>{
      const partition=[],external=[],map=aliases(),summaries=[];
      for(const ref of intention.sources){sourceAllowed(key,ref);const alias=map[ref.eventId];
        if(runtime.memory.isSummaryMaterial?.(ref.eventId)){
          managementCheck(request&&validateSummary({id:ref.eventId,revision:ref.revision},request,key),'SUMMARY_MATERIAL_STALE');
          const material=runtime.memory.resolveSummaryMaterial(ref.eventId,key,request,(ports.now??Date.now)());
          summaries.push({revision:material.revision,sources:[{id:material.id,revision:material.revision,personLinkRevision:null}],items:[{id:material.id,text:material.text}]});continue;
        }
        managementCheck(ports.bili||!knownBili(ref.eventId),'NOT_CONFIGURED');
        if(alias){managementCheck(alias.key===key,'ACCESS_DENIED');partition.push({ref,id:alias.snapshotId,revision:alias.snapshotRevision});continue;}
        if(ports.bili){try{getBili().materials.get(ref.eventId,ref.revision);partition.push({ref,id:ref.eventId,revision:ref.revision});continue;}catch(error){if(error?.code!=='BILI_SOURCE_NOT_FOUND')throw error;}}
        external.push(ref);
      }
      const projections=[...summaries];
      for(const item of partition){const projection=await getBili().materials.materials({...intention,sources:[{eventId:item.id,revision:item.revision}]},target);
        projections.push({...projection,sources:[{id:item.ref.eventId,revision:item.ref.revision,personLinkRevision:null}],items:projection.items.map(entry=>({...entry,id:'bili-item-'+digest([item.ref.eventId,entry.id])}))});}
      if(external.length){managementCheck(typeof ports.creative?.materials==='function','MATERIALS_PROVIDER_MISSING');const projection=await ports.creative.materials({...intention,sources:external},target);projections.push(projection);}
      const sources=projections.flatMap(item=>item.sources),items=projections.flatMap(item=>item.items);managementCheck(new Set(sources.map(item=>item.id)).size===sources.length,'MATERIALS_CHANGED');
      for(const ref of sources)sourceAllowed(key,ref);managementCheck(intention.sources.every(ref=>sources.some(source=>source.id===ref.eventId&&source.revision===ref.revision)),'MATERIALS_CHANGED');
      return{revision:parseInt(digest(projections.map(item=>item.revision)).slice(0,12),16),sources,items};
    };
    const videoPlanProvider=ports.videoPlanProvider??(ports.model?.planVideo?((work,{signal})=>ports.model.planVideo(work,signal)):null);
    const producer=videoPlanProvider?new VideoProducer(assets,{planProvider:videoPlanProvider}):null;
    const creation=new CreationService(store,{now:ports.now??Date.now,authorizeHuman:p=>ports.authorizeHuman?.(p)===true,
      resolveAsset:ref=>assets.resolve(ref),currentAuthority:work=>{const authority=ports.publicationAuthority?.(work)??{policyRevision:0,accountRevision:0,publishAllowed:false,sources:work.sources.map(s=>({...s,publishAllowed:false}))};
        return {...authority,publishAllowed:authority.publishAllowed===true&&work.sources.every(ref=>validateBili(ref,work.target)&&validateSummary(ref,{action:work.action,accountId:work.accountId,target:work.target},work.workflow?.selfScope.scope)),contextRevision:readIdentity().revision};},
      validateWorkflow:work=>{
        const flow=work.workflow;if(!flow||closed)return false;const profile=readIdentity().profile;
        if(!work.sources.every(ref=>validateBili(ref,work.target)&&validateSummary(ref,{action:work.action,accountId:work.accountId,target:work.target},flow.selfScope.scope)))return false;
        if(flow.selfScope.botId!==profile.botId||flow.selfScope.personaId!==profile.personaId||flow.mode!==profile.mode)return false;
        const state=runtime.self.get(flow.selfScope).value;const sources=runtime.memory.readPolicy().value.sources;
        return state.identityRevision===flow.identityRevision&&state.growthVersion===flow.growthVersion&&state.modelVersion===flow.modelVersion
          &&state.intents.every(intent=>intent.id!==flow.intentId||intent.status!=='invalid')
          &&flow.intentionSources.every(ref=>{const e=state.evidence[ref.eventId],source=sources[ref.eventId];return e&&!e.revoked&&e.revision===ref.revision
            &&source?.status==='active'&&source.revision===ref.revision&&source.domain==='social'&&source.purposes.includes('draft')&&source.purposes.includes('publish')
            &&source.audiences.includes(flow.selfScope.scope)&&(source.expiresAt===null||source.expiresAt>(ports.now??Date.now)());});
      },
      ...(producer?{productionProvider:producer}:{})});
    const makeDispatcher=()=>{const captured=runtime;return new DispatchCoordinator(runtime,creation,code,ports.now??Date.now,
      {resolveAccount:ports.resolveAccount,isActive:()=>!closed&&runtime===captured});};
    let dispatcher=makeDispatcher();
    const makeRunner=()=>ports.runner?createRunner({...ports.runner,runtime,dispatcher,now:ports.now??Date.now,
      ...(ports.runner.creationPlans?{prepareCreation:async plan=>{
        const guard=async()=>managementCheck(!closed&&runner?.status().started&&!runner?.status().closed,'RUNNER_STOPPED');
        const decision=await prepareCreationIntention(plan.key,plan.topic,principal,guard);
        if(!decision.intention)return{status:'skipped',reason:decision.reason};
        return startCreation(plan.key,decision.intention.id,plan.request,principal,guard);
      }}:{})}):null;
    runner=makeRunner();
    const identity={read:readIdentity,write(expectedRevision,profile){
      managementCheck(!closed&&pending.size===0,'APPLICATION_BUSY');
      const old=readIdentity();managementCheck(expectedRevision===old.revision,'CONFLICT');managementCheck(profile&&typeof profile==='object'&&Object.keys(profile).sort().join(',')==='botId,mode,name,personaId,roleCore');
      managementCheck(!runner?.status().started||runner.status().closed,'RUNNER_STOP_REQUIRED');
      managementCheck(profile.botId===old.profile.botId&&['juejue','persona'].includes(profile.mode));
      managementCheck(typeof profile.name==='string'&&profile.name.trim().length&&profile.name.length<=256&&typeof profile.roleCore==='string'&&profile.roleCore.length>0&&profile.roleCore.length<=8000);
      const switching=profile.mode!==old.profile.mode;const saved=old.profiles[profile.mode];
      const next=switching&&saved?saved:{...profile,personaId:switching?profile.mode:old.profile.personaId};
      // Fixed role edits are management actions, never growth patches. Old social drafts fail identity/version checks.
      store.atomic(tx=>{
        for(const item of (tx.read('runtime:catalog')?.value.items??[]).filter(c=>c.identity.personaId===next.personaId)){
          const scope={botId:next.botId,personaId:next.personaId,scope:item.key};try{const s=runtime.self.get(scope);runtime.self.configureIdentityIn(tx,scope,s.revision,next.name,next.roleCore);}catch(error){if(error?.code!=='NOT_FOUND')throw error;}
        }
        const previous=tx.read('identity:profile:'+old.profile.mode);tx.write('identity:profile:'+old.profile.mode,previous?.revision??0,old.profile);
        const target=tx.read('identity:profile:'+next.mode);tx.write('identity:profile:'+next.mode,target?.revision??0,next);
        tx.write('identity:active',expectedRevision,next);
      });runtime.close();runtime=makeRuntime();need(!ports.onRuntime?.(runtime)?.then,'APPLICATION_ASYNC_HOOK');dispatcher=makeDispatcher();runner=makeRunner();return readIdentity();
    }};
    const access=ports.access??(async p=>({revision:0,readKeys:[],bodyKeys:[],manage:p===principal,review:false}));
    const workflow=(key,request)=>{
      managementCheck(ports.creative,'CREATION_PROVIDER_MISSING');
      const create=request=>{const captured=request?structuredClone(request):null;return new CreativeWorkflow({self:runtime.self,creation,scope:runtime.scope(key),now:ports.now??Date.now,
        policy:ports.creative.policy,materials:(intention,target)=>combinedMaterials(key,intention,target,captured),plan:ports.creative.plan??(ports.model?.planCreation?(input=>ports.model.planCreation(input)):undefined)});};
      if(request)return create(request);
      return{start:(id,input,guard)=>create(input).start(id,input,guard),recover:(id,revision,actor,reason,guard)=>{
        const work=creation.read(id)?.value;managementCheck(work,'NOT_FOUND');return create({action:work.action,accountId:work.accountId,target:work.target}).recover(id,revision,actor,reason,guard);}};
    };
    const biliOperations={
      capture(input,actor,beforeCommit){human(actor);const captured=runtime,revision=readIdentity().revision;const request=structuredClone(input);
        const guard=async()=>{await beforeCommit?.();human(actor);managementCheck(runtime===captured&&readIdentity().revision===revision,'IDENTITY_CHANGED');};
        return track(getBili().materials.capture(request,{beforeCommit:guard,beforePersist:()=>{human(actor);managementCheck(runtime===captured&&readIdentity().revision===revision,'IDENTITY_CHANGED');
          holdBili(request.id,request.expectedRevision+1,actor,'capture');invalidateBili(request.id,request.expectedRevision+1);}}));},
      read(id,revision,actor){human(actor);const result=getBili().materials.get(id,revision);return{...result,applicationHold:holdFor(id)};},
      revoke(input,actor){human(actor);const request=structuredClone(input);return getBili().materials.revoke(request,{beforeCommit:()=>{human(actor);holdBili(request.id,request.expectedRevision+1,actor,'revoke');invalidateBili(request.id,request.expectedRevision+1);}});},
      learning(input,actor){human(actor);const {key,id,revision,itemId,proposalId}=structuredClone(input);const scope=runtime.scope(key);void scope;
        managementCheck((holdFor(id)?.minimumRevision??0)<=revision,'BILI_LEARNING_RECAPTURE_REQUIRED');
        const candidate=getBili().materials.learningSource({id,revision,conversationKey:key});const item=candidate.items.find(item=>item.id===itemId);managementCheck(item,'NOT_FOUND');
        const sourceId='bili-source-'+digest([biliScope(),id,revision,key]);const source={...candidate.candidate,id:sourceId};const policy=runtime.memory.readPolicy(),prior=policy.value.sources[sourceId];
        if(!prior)runtime.memory.putSource(policy.revision,source);else{managementCheck(prior.status!=='revoked','BILI_LEARNING_RECAPTURE_REQUIRED');managementCheck(Object.entries(source).every(([key,value])=>JSON.stringify(prior[key])===JSON.stringify(value)),'SOURCE_CONFLICT');}
        store.atomic(tx=>{const current=tx.read(aliasesKey());const map=current?.value??{};map[sourceId]={snapshotId:id,snapshotRevision:revision,key};tx.write(aliasesKey(),current?.revision??0,map);});
        const proposal=runtime.proposeLearning(key,{id:proposalId,text:item.text,kind:'knowledge',sourceId,sourceRevision:revision},actor);
        return{requiresHumanApproval:true,proposal,sourceId,contentHash:candidate.contentHash};},
    };
    const biliCodes=new Set(['BILI_ACCESS_CHANGED','BILI_ASYNC_GUARD','BILI_CANCELLED','BILI_CAPACITY','BILI_CLOSED','BILI_INVALID_CLOCK','BILI_MATERIALS_TOO_LARGE',
      'BILI_NOT_AUTHORIZED','BILI_REVISION_CONFLICT','BILI_SNAPSHOT_INVALID','BILI_SOURCE_CHANGED','BILI_SOURCE_NOT_FOUND','BILI_SOURCE_REVOKED','BILI_ACCOUNT_INVALID',
      'BILI_BUDGET_DENIED','BILI_COMMENT_MISMATCH','BILI_INVALID_INPUT','BILI_PAGE_MISMATCH','BILI_PLATFORM_REJECTED','BILI_READ_FAILED','BILI_RESPONSE_INVALID',
      'BILI_RESPONSE_REJECTED','BILI_RESPONSE_TOO_LARGE','BILI_TIMEOUT','BILI_UNSAFE_ID','BILI_VIDEO_MISMATCH']);
    const biliFailure=error=>{if(error instanceof AgentError)throw error;throw new AgentError(biliCodes.has(error?.code)?error.code:'BILI_OPERATION_FAILED');};
    const biliSources=Object.fromEntries(Object.entries(biliOperations).map(([name,operation])=>[name,(...args)=>{try{const result=operation(...args);return result?.then?result.catch(biliFailure):result;}catch(error){return biliFailure(error);}}]));
    const maintenance=createMaintenance({code,getRuntime:()=>runtime,getRunner:()=>runner,getProfile:readIdentity,creation,isClosed:()=>closed,ports:ports.maintenance,now:ports.now??Date.now});
    const startCreation=(key,intentionId,request,actor,beforeCommit)=>{const captured=structuredClone(request),guard=activeGuard(key,actor,beforeCommit);
      return track((async()=>{await guard();const intent=runtime.self.get(runtime.scope(key)).value.intents.find(item=>item.id===intentionId);
        for(const ref of intent?.sources??[])if(runtime.memory.isSummaryMaterial?.(ref.eventId))managementCheck(validateSummary({id:ref.eventId,revision:ref.revision},captured,key),'SUMMARY_MATERIAL_STALE');
        return workflow(key,captured).start(intentionId,captured,guard);})());};
    const prepareCreationIntention=(key,topic,actor,beforeCommit)=>{
      const guard=activeGuard(key,actor,beforeCommit);return track((async()=>{await guard();managementCheck(typeof runtime.prepareCreationIntention==='function','NOT_CONFIGURED');
        return runtime.prepareCreationIntention(key,topic);})());
    };
    const prepareSummaryCreation=(key,input,actor,beforeCommit)=>{
      const request=structuredClone(input),guard=activeGuard(key,actor,beforeCommit);
      return track((async()=>{await guard();managementCheck(typeof request.memoryId==='string','INVALID_INPUT');
        const material=runtime.memory.approveSummaryMaterial(request.expectedPolicyRevision,{memoryId:request.memoryId,expectedMemoryRevision:request.expectedMemoryRevision,key,
          ...request.request,principal:actor,reason:request.reason,expiresAt:request.expiresAt,...(request.includePrivate===undefined?{}:{includePrivate:request.includePrivate})},(ports.now??Date.now)());
        runtime.observe(key,{eventId:material.sourceId,revision:material.revision,kind:'external',topic:material.topic,interestDelta:0,feedback:'interest'});
        const decision=runtime.prepareCreationIntention(key,material.topic);return{material,decision};})());
    };
    const evaluateGrowth=(input,actor,beforeCommit)=>{
      const request=structuredClone(input),guard=activeGuard(request.key,actor,beforeCommit);managementCheck(typeof ports.growthEvaluation?.evaluate==='function','NOT_CONFIGURED');
      return track((async()=>{const profile=readIdentity(),scope=runtime.scope(request.key);await guard();
        const evidence=await ports.growthEvaluation.evaluate({scope,id:request.id,expectedRevision:request.expectedRevision,principal:actor,identityRevision:profile.revision});
        await guard();managementCheck(evidence?.kind==='host-evidence'&&typeof evidence.evidenceId==='string'&&evidence.evidenceId.length>0,'GROWTH_EVIDENCE_REQUIRED');
        managementCheck(evidence.evidenceId.length<=256,'GROWTH_EVIDENCE_REQUIRED');
        const auditKey='growth-host-evidence:'+digest([scope,request.id,request.expectedRevision,evidence.evidenceId]);
        store.atomic(tx=>{const prior=tx.read(auditKey);if(!prior)tx.write(auditKey,0,{scope,id:request.id,expectedRevision:request.expectedRevision,evidenceId:evidence.evidenceId,kind:'host-evidence',evaluation:structuredClone(evidence.evaluation)});});
        const result=runtime.self.evaluate(scope,request.id,request.expectedRevision,evidence.evaluation);return{result,evidenceId:evidence.evidenceId,kind:'host-evidence'};})());
    };
    const deps={get runtime(){return runtime;},creation,code,assets,identity,resolvePrincipal:async()=>closed?null:principal,access,
      submitCreation:(id,revision)=>dispatcher.submitCreation(id,revision),now:ports.now??Date.now,biliSources,startCreation,prepareCreationIntention,prepareSummaryCreation,
      ...(typeof ports.growthEvaluation?.evaluate==='function'?{evaluateGrowth}:{}),
      recoverCreation:(id,revision,actor,reason,beforeCommit)=>{const work=creation.read(id);managementCheck(work?.value.workflow,'NOT_FOUND');const guard=activeGuard(work.value.workflow.selfScope.scope,actor,beforeCommit);return track(workflow(work.value.workflow.selfScope.scope).recover(id,revision,actor,reason,guard));},
      reconcileDelivery:(id,revision,actor,beforeCommit)=>new DeliveryReconciler(dispatcher,{authorizeHuman:p=>!closed&&ports.authorizeHuman?.(p)===true,query:ports.deliveryEvidence}).reconcile(id,revision,actor,beforeCommit)};
    const fetch=createAgentApi(deps);
    return {fetch,close,get runtime(){return runtime;},creation,code,assets,workflow,biliSources,startCreation,prepareCreationIntention,prepareSummaryCreation,evaluateGrowth,maintenance,get dispatcher(){return dispatcher;},get runner(){return runner;}};
  }catch(error){try{await close();}catch{}if(error?.code)throw error;fail('APPLICATION_UNAVAILABLE');}
}
