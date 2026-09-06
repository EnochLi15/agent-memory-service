import { Worker } from 'node:worker_threads';
import { Models } from './models.js';
import { Extractor,hash } from './extraction.js';
import { ServiceError,type AddRequest,type SearchRequest,type Receipt,type Snapshot,type SearchResponse } from './types.js';
import type { Config } from './config.js';
import type {RerankDecision} from './retrieval-policy.js';
import {appendFileSync} from 'node:fs';
import {rerankPayload,decodeRerank} from './reranking.js';

export class Engine {
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
      signal.throwIfAborted();const payloadHash=hash(JSON.stringify(req));const existing=await this.call<Receipt|null>('receipt',req.user_id,[req.request_id,payloadHash]);if(existing)return existing;
      const snapshot=await this.call<Snapshot>('snapshot',req.user_id,[req.session_id]);const prepared=await this.extractor.prepare(req,snapshot,signal);signal.throwIfAborted();
      // Explicit experiment only. The production default always applies lifecycle.
      if(this.config.experimental?.lifecycle===false){prepared.operations=[];for(const f of prepared.facts){f.cardinality='multiple';f.supersedes=[];f.depends_on=[];}}
      const receipt=await this.call<Receipt>('commit',req.user_id,[req,payloadHash,prepared,snapshot.revision],deadline);
      if(prepared.degraded.length)process.stdout.write(JSON.stringify({event:'degraded',request_id:req.request_id,reasons:prepared.degraded})+'\n');return receipt;
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
  async close():Promise<void>{await this.worker.terminate();}
}
