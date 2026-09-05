import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { TenantStore } from './storage.js';
import { retrieve } from './retrieval.js';
import { ServiceError, type AddRequest, type Prepared, type SearchRequest } from './types.js';
import type { Config } from './config.js';

const config=workerData as Config;const stores=new Map<string,TenantStore>();
function store(id:string):TenantStore {let s=stores.get(id);if(s){stores.delete(id);stores.set(id,s);return s;}if(stores.size>=32){const old=stores.keys().next().value!;stores.get(old)!.close();stores.delete(old);}s=new TenantStore(config.dataDir,id);stores.set(id,s);return s;}
parentPort!.on('message',(job:{id:number;method:string;userId:string;args:unknown[];deadline?:number})=>{
  try{
    if(job.deadline&&Date.now()>=job.deadline)throw new ServiceError('DEADLINE','Storage deadline exceeded');
    const s=store(job.userId);let result:unknown;
    switch(job.method){
      case 'snapshot':result=s.snapshot(job.args[0] as string);break;
      case 'receipt':result=s.receipt(job.args[0] as string,job.args[1] as string);break;
      case 'revision':result=s.revision();break;
      case 'commit':result=s.commit(job.args[0] as AddRequest,job.args[1] as string,job.args[2] as Prepared,job.args[3] as number,job.args[4] as string|undefined);break;
      case 'search':result={response:retrieve(s,job.args[0] as SearchRequest,job.args[1] as number[]|null,config.rerank?{...config,maxEvidence:Math.min(100,config.maxEvidence*2),tokenBudget:config.tokenBudget*3}:config),revision:s.revision()};break;
      default:throw new ServiceError('WORKER_METHOD','Unknown worker method');
    }
    parentPort!.postMessage({id:job.id,result});
  }catch(e){parentPort!.postMessage({id:job.id,error:{code:e instanceof ServiceError?e.code:'STORAGE',message:e instanceof ServiceError?e.message:'Storage operation failed',status:e instanceof ServiceError?e.status:503}});}
});
const healthDir=mkdtempSync(join(config.dataDir,'.health-'));
try{const db=new Database(join(healthDir,'probe.sqlite'));db.exec("CREATE VIRTUAL TABLE readiness USING fts5(text); INSERT INTO readiness VALUES ('ready');");if(!db.prepare("SELECT text FROM readiness WHERE readiness MATCH 'ready'").get())throw new Error('FTS readiness failed');db.close();}finally{rmSync(healthDir,{recursive:true,force:true});}
parentPort!.postMessage({ready:true});
