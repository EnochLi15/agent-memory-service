import {ContinuationCache,ContinuationAttempt,withContinuation,CONTINUATION_TTL} from './write-continuation.js';
import {randomUUID} from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Models } from './models.js';
import { Extractor,hash } from './extraction.js';
import { ServiceError,type AddRequest,type SearchRequest,type Receipt,type Snapshot,type SearchResponse } from './types.js';
import type { Config } from './config.js';
import type {RerankDecision} from './retrieval-policy.js';
import {appendFileSync} from 'node:fs';
import {rerankPayload,decodeRerank} from './reranking.js';

export class Engine {
  private continuations=new ContinuationCache();private continuationOwner=randomUUID();
  private worker:Worker; private counter=0; private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void}>();
  private queues=new Map<string,Promise<unknown>>();private models:Models;private extractor:Extractor;ready:Promise<void>;private healthy=true;
  constructor(readonly config:Config){
    this.models=new Models(config);this.extractor=new Extractor(config,this.models);
    this.worker=new Worker(new URL('./db-worker.js',import.meta.url),{workerData:config});
    this.ready=new Promise((resolve,reject)=>{
      this.worker.on('message',(m:{ready?:boolean;id:number;result:unknown;error?:{code:string;message:string;status:number}})=>{
        if(m.ready){resolve();return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);if(m.error)p.reject(new ServiceError(m.error.code,m.error.message,m.error.status));else p.resolve(m.result);
      });
      this.worker.on('error',error=>{this.healthy=false;reject(error);for(const p of this.pending.values())p.reject(error);this.pending.clear();});
      this.worker.on('exit',code=>{this.healthy=false;for(const p of this.pending.values())p.reject(new ServiceError('WORKER_EXIT',`Storage worker exited (${code})`));this.pending.clear();});
    });
  }
  isHealthy():boolean{return this.healthy;}
  private async call<T>(method:string,userId:string,args:unknown[],deadline?:number):Promise<T>{await this.ready;if(!this.healthy)throw new ServiceError('WORKER_EXIT','Storage unavailable');if(this.pending.size>=200)throw new ServiceError('OVERLOADED','Storage queue full');return new Promise<T>((resolve,reject)=>{const id=++this.counter;this.pending.set(id,{resolve:v=>resolve(v as T),reject});this.worker.postMessage({id,method,userId,args,deadline});});}
  async add(req:AddRequest,signal:AbortSignal):Promise<Receipt>{
    const deadline=Date.now()+this.config.addTimeout;
    const prior=this.queues.get(req.user_id)??Promise.resolve();
    const run=prior.catch(()=>{}).then(async()=>{
      signal.throwIfAborted();const payloadHash=hash(JSON.stringify(req)),cacheKey=hash(JSON.stringify([req.user_id,req.request_id]));
      const existing=await this.call<Receipt|null>('receipt',req.user_id,[req.request_id,payloadHash]);if(existing){this.continuations.drop(cacheKey);return existing;}
      if(!this.config.writeContinuation&&await this.call<boolean>('preparation_present',req.user_id,[req.request_id,payloadHash]))throw new ServiceError('EVIDENCE_VALIDATION','Write continuation metadata prevents regenerating this request');
      const snapshot=await this.call<Snapshot>('snapshot',req.user_id,[req.session_id]);
      let continuation:ContinuationAttempt|undefined,attemptNumber=0;
      if(this.config.writeContinuation){
        const identity=hash(JSON.stringify({req,snapshot,config:this.config})),prior=this.continuations.get(cacheKey,identity);
        // Validate identity in durable metadata before replacing any cache entry;
        // a conflicting payload must not destroy the original continuation.
        try{attemptNumber=await this.call<number>('preparation_begin',req.user_id,[req.request_id,payloadHash,identity,this.continuationOwner,!!prior,prior?.expires??Date.now()+CONTINUATION_TTL],deadline);}
        catch(error){if(prior)this.continuations.drop(cacheKey);throw error;}
        const entry=prior??this.continuations.create(cacheKey,req.user_id,identity);
        continuation=new ContinuationAttempt(entry,signal);
      }
      try{
        const prepare=()=>this.extractor.prepare(req,snapshot,signal);
        const prepared=await (continuation?withContinuation(continuation,prepare):prepare());signal.throwIfAborted();
        // A lower layer may have attempted its ordinary fallback. A pending
        // interrupted model stage must never be committed as fallback success.
        if(continuation?.pending)throw new ServiceError('WRITE_CONTINUATION_PENDING','Model preparation is incomplete');
        if(continuation&&(continuation.terminalModelFailure||prepared.degraded.includes('extraction_offline')))throw new ServiceError('EVIDENCE_VALIDATION','Write continuation cannot commit an unverified extraction fallback');
        continuation?.assertComplete();
        // Explicit experiment only. The production default always applies lifecycle.
        if(this.config.experimental?.lifecycle===false){prepared.operations=[];for(const f of prepared.facts){f.cardinality='multiple';f.supersedes=[];f.depends_on=[];}}
        const receipt=await this.call<Receipt>('commit',req.user_id,[req,payloadHash,prepared,snapshot.revision],deadline);
        this.continuations.invalidateTenant(req.user_id);
        if(prepared.degraded.length)process.stdout.write(JSON.stringify({event:'degraded',request_id:req.request_id,reasons:prepared.degraded})+'\n');
        if(continuation)this.continuationAudit(req,continuation,attemptNumber,'committed');
        return receipt;
      }catch(error){
        if(continuation){
          const retryable=continuation.pending&&!continuation.terminalModelFailure&&!signal.aborted&&continuation.entry.valid&&Date.now()<continuation.entry.expires&&attemptNumber<3;
          try{await this.call('preparation_finish',req.user_id,[req.request_id,this.continuationOwner,retryable]);}
          catch{this.continuations.drop(cacheKey);throw new ServiceError('EVIDENCE_VALIDATION','Could not preserve write continuation state');}
          this.continuationAudit(req,continuation,attemptNumber,retryable?'pending':'closed');
          if(!retryable)this.continuations.drop(cacheKey);
          if(retryable)throw new ServiceError('WRITE_CONTINUATION_PENDING','Retry the identical request to continue its interrupted model preparation');
        }
        throw error;
      }
    });
    this.queues.set(req.user_id,run);
    void run.finally(()=>{if(this.queues.get(req.user_id)===run)this.queues.delete(req.user_id);}).catch(()=>{});
    return new Promise<Receipt>((resolve,reject)=>{
      const aborted=()=>reject(new ServiceError('DEADLINE','Add deadline exceeded'));
      if(signal.aborted){aborted();return;}
      signal.addEventListener('abort',aborted,{once:true});
      void run.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
    });
  }
  async search(req:SearchRequest,signal:AbortSignal):Promise<SearchResponse>{
    signal.throwIfAborted();const task=this.searchImpl(req,signal);
    return new Promise<SearchResponse>((resolve,reject)=>{const abort=()=>reject(new ServiceError('DEADLINE','Search deadline exceeded'));signal.addEventListener('abort',abort,{once:true});void task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
  }
  private async searchImpl(req:SearchRequest,signal:AbortSignal):Promise<SearchResponse>{
    signal.throwIfAborted();if(req.top_k<1)return {data:[]};let vector:number[]|null=null;
    if(this.config.mode==='enhanced'&&this.config.retrieval!=='lexical'){
      try{vector=(await this.models.embedBatch([req.query],'search',signal))[0]??null;}catch(error){if(signal.aborted)throw error;}
    }
    signal.throwIfAborted();
    const rerank=this.config.rerank&&this.config.mode==='enhanced';
    let result=await this.call<{response:SearchResponse;revision:number;rerankDecision?:RerankDecision}>(rerank?'candidates':'search',req.user_id,[req,vector]);
    const decision=result.rerankDecision,initialRevision=result.revision;let rerankOutcome='skipped';const rerankStart=performance.now();
    let scores:{id:string;score:number}[]|undefined;
    if(rerank && result.response.data.length>1&&decision?.enabled!==false){
      try{
        const payload=rerankPayload(req.query,result.response.data,this.config.rerankFormat);
        const raw=await this.models.json(payload.prompt,payload.input,AbortSignal.any([signal,AbortSignal.timeout(12000)]),{purpose:'rerank'});
        scores=decodeRerank(raw,result.response.data,this.config.rerankFormat);rerankOutcome='ok';
      }catch{rerankOutcome=signal.aborted?'cancelled':'fallback'; /* Bounded rerank failure preserves deterministic retrieval. */ }
    }
    signal.throwIfAborted();
    if(rerank)result=await this.call<{response:SearchResponse;revision:number}>('pack',req.user_id,[req,vector,result.revision,scores]);
    if(process.env.MEMORY_RETRIEVAL_AUDIT)appendFileSync(process.env.MEMORY_RETRIEVAL_AUDIT,JSON.stringify({event:'retrieval_policy',query_sha256:hash(req.query),tenant_sha256:hash(req.user_id),revision:result.revision,initial_revision:initialRevision,rerank_policy:this.config.rerankPolicy,rerank_format:this.config.rerankFormat,decision:decision??{enabled:false,reason:'disabled'},rerank_outcome:rerankOutcome,elapsed_ms:performance.now()-rerankStart,scores_discarded:!!scores&&result.revision!==initialRevision})+'\n');
    signal.throwIfAborted();return result.response;
  }
  private continuationAudit(req:AddRequest,attempt:ContinuationAttempt,number:number,outcome:string):void{
    try{if(process.env.MEMORY_MODEL_AUDIT)appendFileSync(process.env.MEMORY_MODEL_AUDIT,JSON.stringify({at:new Date().toISOString(),kind:'write_continuation',tenant_sha256:hash(req.user_id),request_sha256:hash(req.request_id),attempt:number,outcome,replayed_packets:attempt.replayed,fresh_calls:attempt.fresh})+'\n');}catch{/* Optional metrics cannot turn a committed write into a failure. */}
  }
  async close():Promise<void>{this.continuations.clear();await this.worker.terminate();}
}
