import {createHash} from 'node:crypto';
import {AgentError,ensure,integer,stable,text} from './common.ts';
import type {Delivery} from './outbox.ts';
import {DELIVERY_RECEIPT_MAX} from './outbox.ts';
import type {DispatchCoordinator} from './dispatch.ts';
export interface DeliveryEvidence {
  deliveryId:string;account:string;fingerprint:string;outcome:'confirmed'|'failed';receipt:string;
  notSubmitted:boolean;visibility?:'accepted'|'pending-review'|'published';
}
export interface ReconciliationDependencies {
  authorizeHuman(principal:string):boolean;
  /** Trusted, read-only platform evidence query. A UI-supplied conclusion is never evidence. */
  query?(item:Readonly<Delivery>,signal:AbortSignal):Promise<DeliveryEvidence|null>;
  timeoutMs?:number;
}
export const deliveryFingerprint=(item:Delivery):string=>createHash('sha256').update(stable({account:item.account,conversation:item.conversation,kind:item.kind,body:item.body,payload:item.payload})).digest('hex');
export class DeliveryReconciler {
  private dispatcher:DispatchCoordinator;private deps:ReconciliationDependencies;
  constructor(dispatcher:DispatchCoordinator,deps:ReconciliationDependencies){this.dispatcher=dispatcher;this.deps=deps;integer(deps.timeoutMs??10000,1,25000);}
  async reconcile(id:string,expectedRevision:number,principal:string,beforeCommit?:()=>Promise<void>):Promise<{id:string;status:string;revision:number;reason:string}>{
    text(id);text(principal);integer(expectedRevision);ensure(this.deps.authorizeHuman(principal),'ACCESS_DENIED');ensure(this.deps.query,'NOT_CONFIGURED');
    const queue=this.dispatcher.outbox;ensure(queue.state().revision===expectedRevision,'CONFLICT');
    const item=queue.list().find(row=>row.id===id);ensure(item?.status==='unknown','INVALID_STATE');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_yes,no)=>{timer=setTimeout(()=>{controller.abort();no(new AgentError('EVIDENCE_TIMEOUT'));},this.deps.timeoutMs??10000);});
    let evidence:DeliveryEvidence|null;
    try{evidence=await Promise.race([this.deps.query(structuredClone(item),controller.signal),deadline]);}
    catch(error){if(error instanceof AgentError)throw error;throw new AgentError('EVIDENCE_UNAVAILABLE');}
    finally{clearTimeout(timer);controller.abort();}
    await beforeCommit?.();ensure(this.deps.authorizeHuman(principal),'ACCESS_DENIED');ensure(queue.state().revision===expectedRevision,'CONFLICT');
    const current=queue.list().find(row=>row.id===id);ensure(current?.status==='unknown'&&stable(current)===stable(item),'CONFLICT');
    if(evidence===null)return{id,status:'unknown',revision:expectedRevision,reason:'EVIDENCE_UNAVAILABLE'};
    ensure(evidence&&typeof evidence==='object'&&Object.keys(evidence).every(key=>['deliveryId','account','fingerprint','outcome','receipt','notSubmitted','visibility'].includes(key)),'EVIDENCE_INVALID');
    ensure(evidence.deliveryId===id&&evidence.account===item.account&&evidence.fingerprint===deliveryFingerprint(item),'EVIDENCE_MISMATCH');
    ensure(['confirmed','failed'].includes(evidence.outcome)&&typeof evidence.notSubmitted==='boolean','EVIDENCE_INVALID');text(evidence.receipt,DELIVERY_RECEIPT_MAX);
    ensure(!evidence.notSubmitted||evidence.outcome==='failed','EVIDENCE_INVALID');
    ensure(evidence.visibility===undefined||(evidence.outcome==='confirmed'&&['accepted','pending-review','published'].includes(evidence.visibility)),'EVIDENCE_INVALID');
    const result=this.dispatcher.reconcile(id,evidence.outcome,evidence.receipt,evidence.notSubmitted,expectedRevision,evidence.visibility);
    return{id,status:result.status,revision:queue.state().revision,reason:'RECONCILED'};
  }
}
