// Development fault reproduction; never shipped in the production image.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {TenantStore} from '../dist/storage.js';import {Extractor,hash} from '../dist/extraction.js';import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';
const runs=process.argv.slice(2);const config=configFromEnv({...process.env,MEMORY_EMBEDDING_DIGEST:'0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f'});const models=new Models(config);let generation=0;const json=models.json.bind(models);models.json=async(system,user,signal)=>{const raw=await json(system,user,signal);if(process.env.REPAIR_CAPTURE)writeFileSync('.data/repair-raw-'+process.env.REPAIR_CAPTURE+'-'+(++generation)+'.json',JSON.stringify({input:JSON.parse(user.split('\nREPAIR:')[0]),output:raw},null,2));return raw;};const extractor=new Extractor(config,models);const results=[];
for(const run of runs){
 const dir=`../eval/artifacts/${run}`;const failed=new Set(readFileSync(join(dir,'ingest.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x)).filter(r=>r.status==='failed').map(r=>r.request_id));
 const reqs=readFileSync(join(dir,'requests.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x)).filter(r=>failed.has(r.body.request_id)).map(r=>r.body);
 for(const req of reqs.filter(r=>!process.env.REPAIR_MATCH||r.request_id.includes(process.env.REPAIR_MATCH))){
  const original=new TenantStore('.data/dev-v2',req.user_id);const snapshot=original.snapshot(req.session_id);const prefix='.data/repair-check-'+Date.now();const folder=join(prefix,hash(req.user_id));mkdirSync(folder,{recursive:true});await original.db.backup(join(folder,'memory.sqlite'));original.close();const store=new TenantStore(prefix,req.user_id);const start=Date.now();
  try{const p=await extractor.prepare(req,snapshot,AbortSignal.timeout(115000));store.commit(req,hash(JSON.stringify(req)),p,snapshot.revision);const result={request_id:req.request_id,status:'passed',elapsed_ms:Date.now()-start,facts:p.facts.length,operations:p.operations.map(o=>({type:o.type,predicate:o.predicate,targets:o.target_ids.length})),degraded:p.degraded};results.push(result);console.log(JSON.stringify(result));}
  catch(e){const result={request_id:req.request_id,status:'failed',elapsed_ms:Date.now()-start,code:e.code,error:e.message};results.push(result);console.log(JSON.stringify(result));}finally{store.close();}
 }
}
writeFileSync('.data/repair-check-results-'+(process.env.REPAIR_CAPTURE??'default')+'.json',JSON.stringify(results,null,2)+'\n');
