import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {retrieve} from '../dist/retrieval.js';
import {buildServer} from '../dist/server.js';

const date='2026-01-01T00:00:00Z';
const config=configFromEnv({MEMORY_MODE:'enhanced'});
function request(content:string,id='change'){return {request_id:id,user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp:date}]};}
function proposal(content:string,ids=['m0']){return {facts:[],operations:[{type:'forget',target_ids:ids,subject:'user',predicate:'access_code',value:'ZX-482',scope:'',boundary:'value',source:{index:0,quote:content}}]};}
async function fixture(fn:any){
 const dir=mkdtempSync(join(tmpdir(),'operation-intent-'));const store=new TenantStore(dir,'u');
 const offline=new Extractor({...config,mode:'offline'},{} as any);
 const req=request('My access code is ZX-482. My manager is Alice.','initial');
 const prepared=await offline.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(req,hash(JSON.stringify(req)),prepared,0);
 const snapshot=store.snapshot('s');const fact=snapshot.facts.find(f=>f.predicate==='access_code')!;
 const prepare=(content:string,response:any)=>new Extractor(config,{json:async()=>structuredClone(response),embedBatch:async()=>{throw Error('test embedding unavailable');}} as any).prepare(request(content),snapshot,AbortSignal.timeout(1000));
 try{await fn({store,snapshot,fact,prepare});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test('polite retirement intents survive model validation and erase evidence while retaining neighbors',()=>fixture(async({store,fact,prepare}:any)=>{
 const content='You can forget my access code entirely.';
 const p=await prepare(content,proposal(content,[fact.id]));assert.equal(p.operations.length,1);assert.ok(!p.degraded.includes('extraction_offline'));
 const req=request(content);store.commit(req,hash(JSON.stringify(req)),p,store.revision());
 const evidence=retrieve(store,{user_id:'u',query:'previous access code manager',top_k:100},null,config).data;
 assert.doesNotMatch(JSON.stringify(evidence),/ZX-482/);assert.match(JSON.stringify(evidence),/Alice/);
}));
test('retirement paraphrase is handled even when the model emits empty arrays',()=>fixture(async({prepare,fact}:any)=>{
 for(const content of ['I do not need my access code stored anymore.','I no longer need you to remember my access code.']){
  const p=await prepare(content,{facts:[],operations:[]});assert.equal(p.operations.length,1,content);assert.ok(p.operations[0].target_ids.includes(fact.id));
 }
}));
test('unresolved real commands cannot degrade to a successful empty operation list',()=>fixture(async({prepare}:any)=>{
 await assert.rejects(()=>prepare('Please forget my gym schedule.',{facts:[],operations:[]}),/operation|target|bind/i);
}));
test('one covered command cannot hide a second unresolved command',()=>fixture(async({prepare,fact}:any)=>{
 const content='Forget my access code. Forget my gym schedule.';
 await assert.rejects(()=>prepare(content,proposal('Forget my access code.',[fact.id])),/operation|target|bind/i);
 await assert.rejects(()=>prepare(content,proposal(content,[fact.id])),/operation|target|bind/i);
}));
test('negation, quoted imperative, conditional and third-party request preserve stored values',()=>fixture(async({prepare}:any)=>{
 for(const content of ['Do not delete my access code.','Never erase my access code.','I do not want you to forget my access code.','"Forget my access code."',"I don't agree. 'Alice. Forget my access code.'",'If I change my mind, forget my access code.','Alice said: forget my access code.','我不想让你忘记我的门禁码。']){
  const p=await prepare(content,proposal(content));assert.equal(p.operations.length,0,content);
 }
}));
test('unrelated quotation does not veto a separate real command',()=>fixture(async({prepare,fact}:any)=>{
 const content='Alice said "forget it." You can forget my access code.';
 const p=await prepare(content,proposal('You can forget my access code.',[fact.id]));assert.equal(p.operations.length,1);assert.ok(!p.degraded.includes('extraction_offline'));
}));
test('same-chunk handles bind only earlier sourced facts and are erased in the transaction',()=>fixture(async({store,snapshot}:any)=>{
 const req=request('My salary is 85000. Forget my salary.');
 const response={facts:[{content:'My salary is 85000.',subject:'user',predicate:'salary',value:'85000',sources:[{index:0,quote:'My salary is 85000.'}]}],operations:[{type:'forget',target_ids:['new:0'],subject:'user',predicate:'salary',value:'85000',source:{index:0,quote:'Forget my salary.'}}]};
 const x=new Extractor(config,{json:async()=>structuredClone(response),embedBatch:async()=>{throw Error('no embedding');}} as any);
 const p=await x.prepare(req,snapshot,AbortSignal.timeout(1000));assert.equal(p.operations[0].target_ids[0],p.facts[0].id);
 store.commit(req,hash(JSON.stringify(req)),p,store.revision());assert.doesNotMatch(JSON.stringify(store.facts()),/85000/);
 const reversed=request('Forget my salary. My salary is 85000.','forward');
 await assert.rejects(()=>x.prepare(reversed,snapshot,AbortSignal.timeout(1000)),/target|chronolog/i);
 response.operations[0]!.target_ids=[];
 const future=await x.prepare(reversed,snapshot,AbortSignal.timeout(1000));
 assert.throws(()=>store.commit(reversed,hash(JSON.stringify(reversed)),future,store.revision()),/target/i);
}));
test('HTTP success means retirement took effect; unresolved deletion returns failure atomically',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'operation-http-'));const app=await buildServer({...config,mode:'offline',dataDir:dir});
 try{
  assert.equal((await app.inject({method:'POST',url:'/add',payload:request('My access code is ZX-482. My manager is Alice.','a')})).statusCode,200);
  const failed=await app.inject({method:'POST',url:'/add',payload:request('My manager is Beth. Please forget my gym schedule.','b')});assert.equal(failed.statusCode,503);
  assert.equal((await app.inject({method:'POST',url:'/add',payload:request('You can forget my access code entirely.','c')})).statusCode,200);
  const result=await app.inject({method:'POST',url:'/search',payload:{user_id:'u',query:'previous access code manager',top_k:100}});
  assert.equal(result.statusCode,200);assert.doesNotMatch(result.body,/ZX-482|Beth/);assert.match(result.body,/Alice/);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('same-value records in another scope survive deletion and mixed-source redaction',()=>fixture(async({store,snapshot}:any)=>{
 const req=request('For project Red my access code is SHARED-821. For project Blue my access code is SHARED-821.','scoped');
 const response={facts:['Red','Blue'].map(scope=>({content:`For project ${scope} my access code is SHARED-821.`,subject:'user',predicate:'access_code',value:'SHARED-821',scope,sources:[{index:0,quote:`For project ${scope} my access code is SHARED-821.`}]})),operations:[]};
 // A model may copy a mixed sentence as the retained neighbor's source. Its
 // atomic content is valid, but its support must not carry the erased context.
 response.facts[1]!.sources[0]!.quote=req.messages[0]!.content;
 const x=new Extractor(config,{json:async()=>structuredClone(response),embedBatch:async()=>{throw Error('no embedding');}} as any);
 const p=await x.prepare(req,snapshot,AbortSignal.timeout(1000));store.commit(req,hash(JSON.stringify(req)),p,store.revision());
 const target=store.facts().find((f:any)=>f.scope==='Red');
 const deletion=request('Forget my access code for project Red.','scope-delete');
 const op=proposal(deletion.messages[0]!.content,[target.id]);Object.assign(op.operations[0]!,{scope:'Red',value:'SHARED-821'});
 const prepared=await new Extractor(config,{json:async()=>structuredClone(op)} as any).prepare(deletion,store.snapshot('s'),AbortSignal.timeout(1000));
 store.commit(deletion,hash(JSON.stringify(deletion)),prepared,store.revision());
 assert.equal(store.facts().find((f:any)=>f.scope==='Red'&&f.predicate==='access_code').state,'erased');
 const kept=store.facts().find((f:any)=>f.scope==='Blue');assert.equal(kept.state,'active');assert.equal(kept.value,'SHARED-821');
 const rows=retrieve(store,{user_id:'u',query:'project Blue access code',top_k:100},null,config).data;
 assert.match(JSON.stringify(rows),/For project Blue my access code is SHARED-821/);assert.doesNotMatch(JSON.stringify(rows),/For project Red my access code is SHARED-821/);
}));
test('repeating a completed property deletion is a safe no-op but an unrelated missing target is not',()=>fixture(async({store}:any)=>{
 const x=new Extractor({...config,mode:'offline'},{} as any);
 for(const id of ['first','repeat']){
  const req=request('Forget my access code.',id);const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));
  assert.ok(p.operations.every(o=>o.predicate==='access_code'));
  store.commit(req,hash(JSON.stringify(req)),p,store.revision());
 }
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM markers').get().n,1);
 assert.equal(store.facts().filter((f:any)=>f.predicate==='access_code'&&f.state==='erased').length,1);
 await assert.rejects(()=>x.prepare(request('Forget my bank account.'),store.snapshot('s'),AbortSignal.timeout(1000)),/bind/);
 await assert.rejects(()=>x.prepare(request('Forget my access code NEW-123.'),store.snapshot('s'),AbortSignal.timeout(1000)),/bind/);
}));
