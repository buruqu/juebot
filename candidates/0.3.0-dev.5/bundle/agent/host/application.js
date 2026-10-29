import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { AssetRegistry } from './assets.js';
import { VideoProducer } from './video-producer.js';
import { createRunner } from './runner.js';

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
  const lockIdentity=lstatSync(lock,{bigint:true});const opened=[];let runtime,store,ledger,runner,closed=false,closing;
  const release=()=>{store?.close();ledger?.close();let failed=false;
    for(const db of opened.reverse())try{db.close();}catch{failed=true;}
    try{const info=lstatSync(lock,{bigint:true});need(info.ino===lockIdentity.ino&&info.dev===lockIdentity.dev&&!info.isSymbolicLink(),'APPLICATION_LOCK_CHANGED');rmdirSync(lock);}catch{failed=true;}
    if(failed)fail('APPLICATION_CLOSE_FAILED');
  };
  const close=()=>{if(closed)return closing;closed=true;runtime?.close();
    if(runner){closing=runner.stop().then(release,()=>{release();fail('APPLICATION_CLOSE_FAILED');});return closing;}
    release();};
  try{
    const modules=ports.modules??await Promise.all([
      import('../lib/agent-v1/src/store.js'),import('../lib/conversation-v1/src/ledger.js'),import('../lib/agent-v1/src/runtime.js'),
      import('../lib/agent-v1/src/creation.js'),import('../lib/agent-v1/src/code-jobs.js'),import('../lib/agent-v1/src/dispatch.js'),import('../lib/agent-v1/src/api.js')]);
    const [{SqliteStateStore},{ConversationLedger},{BotRuntime},{CreationService},{CodeTasks},{DispatchCoordinator},{createAgentApi}]=modules;
    const {AgentError}=await import('../lib/agent-v1/src/common.js');
    const {CreativeWorkflow}=await import('../lib/agent-v1/src/creative-workflow.js');
    const {DeliveryReconciler}=await import('../lib/agent-v1/src/delivery-reconciliation.js');
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
    const videoPlanProvider=ports.videoPlanProvider??(ports.model?.planVideo?((work,{signal})=>ports.model.planVideo(work,signal)):null);
    const producer=videoPlanProvider?new VideoProducer(assets,{planProvider:videoPlanProvider}):null;
    const creation=new CreationService(store,{now:ports.now??Date.now,authorizeHuman:p=>ports.authorizeHuman?.(p)===true,
      resolveAsset:ref=>assets.resolve(ref),currentAuthority:work=>({...ports.publicationAuthority?.(work)??{policyRevision:0,accountRevision:0,publishAllowed:false,sources:work.sources.map(s=>({...s,publishAllowed:false}))},contextRevision:readIdentity().revision}),
      validateWorkflow:work=>{
        const flow=work.workflow;if(!flow||closed)return false;const profile=readIdentity().profile;
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
    const makeRunner=()=>ports.runner?createRunner({...ports.runner,runtime,dispatcher,now:ports.now??Date.now}):null;
    runner=makeRunner();
    const identity={read:readIdentity,write(expectedRevision,profile){
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
    const workflow=key=>{managementCheck(ports.creative,'CREATION_PROVIDER_MISSING');return new CreativeWorkflow({self:runtime.self,creation,scope:runtime.scope(key),now:ports.now??Date.now,
      policy:ports.creative.policy,materials:ports.creative.materials,plan:ports.creative.plan??(ports.model?.planCreation?(input=>ports.model.planCreation(input)):undefined)});};
    const deps={get runtime(){return runtime;},creation,code,assets,identity,resolvePrincipal:async()=>closed?null:principal,access,
      submitCreation:(id,revision)=>dispatcher.submitCreation(id,revision),now:ports.now??Date.now,
      recoverCreation:(id,revision,actor,reason,beforeCommit)=>{const work=creation.read(id);managementCheck(work?.value.workflow,'NOT_FOUND');return workflow(work.value.workflow.selfScope.scope).recover(id,revision,actor,reason,beforeCommit);},
      reconcileDelivery:(id,revision,actor,beforeCommit)=>new DeliveryReconciler(dispatcher,{authorizeHuman:p=>!closed&&ports.authorizeHuman?.(p)===true,query:ports.deliveryEvidence}).reconcile(id,revision,actor,beforeCommit)};
    const fetch=createAgentApi(deps);
    return {fetch,close,get runtime(){return runtime;},creation,code,assets,workflow,get dispatcher(){return dispatcher;},get runner(){return runner;}};
  }catch(error){try{await close();}catch{}if(error?.code)throw error;fail('APPLICATION_UNAVAILABLE');}
}
