import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {messageAnchors} from '../dist/temporal.js';

test('a synthetic ordering sentinel never inherits as a session anchor over real timestamps',()=>{
 const req={messages:[{role:'user',content:'I live in Boston.',timestamp:'2026-01-01T00:00:00Z'}]};
 for(const previous of ['synthetic ordering','synthetic ordering only; use dates stated by speakers'])
  assert.equal(messageAnchors(req,previous,[true]).anchors[0],'2026-01-01T00:00:00Z',previous);
 // A real session label still inherits across chunks of one session.
 assert.equal(messageAnchors({messages:[{role:'user',content:'Hello.',timestamp:'2026-01-01T00:00:00Z'}]},'Tuesday evening',[true]).anchors[0],'Tuesday evening');
});

test('an offline named-property deletion spares an independent same-literal record in another slot',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-offline-'));const store=new TenantStore(dir,'u');
 const config=configFromEnv({MEMORY_MODE:'offline'});const offline=new Extractor(config,{} as any);
 const req=(id:string,content:string)=>({request_id:id,user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp:'2026-01-01T00:00:00Z'}]});
 const put=async(r:any)=>store.commit(r,hash(JSON.stringify(r)),await offline.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000)),store.revision());
 await put(req('a1','My manager is Iris.'));await put(req('a2','I love Iris.'));await put(req('a3','I love coding.'));
 await put(req('a4','Forget my manager Iris.'));
 try{
  assert.equal(store.facts().find((f:any)=>f.predicate==='manager').state,'erased');
  const hobby=store.facts().find((f:any)=>f.predicate==='hobby'&&f.value==='Iris');
  assert.ok(hobby);assert.equal(hobby.state,'active');
  assert.equal(store.facts().find((f:any)=>f.predicate==='hobby'&&f.value==='coding').state,'active');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('degraded erasure binding erases echoes but retains an independent same-literal record',async()=>{
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true'});
 const dir=mkdtempSync(join(tmpdir(),'review-degraded-'));const store=new TenantStore(dir,'u');
 const fact=(content:string,predicate:string,value:string,scope='',index=0)=>({content,predicate,value,scope,subject:'user',sources:[{index,quote:content}]});
 const seed={request_id:'seed',user_id:'u',session_id:'s',messages:[{role:'user',content:'Our backup name is Iris.',timestamp:'2026-01-01T00:00:00Z'},{role:'user',content:'My coworker is Iris.',timestamp:'2026-01-01T00:01:00Z'}]};
 const seedProposal={facts:[fact('Our backup name is Iris.','backup_name','Iris'),fact('Our backup name is Iris.','backup_note','Iris','notes',0),fact('My coworker is Iris.','coworker_name','Iris','office',1)],operations:[]};
 const seedPrepared=await new Extractor(config,{verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async()=>structuredClone(seedProposal)} as any).prepare(seed,store.snapshot('s'),AbortSignal.timeout(1000));
 store.commit(seed,hash(JSON.stringify(seed)),seedPrepared,store.revision());
 const target=store.facts().find((f:any)=>f.predicate==='backup_name');
 const echo=store.facts().find((f:any)=>f.predicate==='backup_note');
 const independent=store.facts().find((f:any)=>f.predicate==='coworker_name');
 const forget={request_id:'forget',user_id:'u',session_id:'s',messages:[{role:'user',content:'Remove Iris from our backup list entirely.',timestamp:'2026-01-02T00:00:00Z'}]};
 const forgetProposal={facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'backup_name',value:'Iris',scope:'',boundary:'value',source:{index:0,quote:'Remove Iris from our backup list entirely.'}}]};
 let erasureCalls=0;
 const model={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,_i:string,_signal:AbortSignal,context:any)=>{
  if(context?.purpose==='erasure_binding'){erasureCalls++;throw Error('erasure endpoint unavailable');}
  return structuredClone(forgetProposal);
 }} as any;
 try{
  const prepared=await new Extractor(config,model).prepare(forget,store.snapshot('s'),AbortSignal.timeout(1000));
  assert.equal(erasureCalls,1);assert.ok(prepared.degraded.includes('erasure_binding_deterministic'),JSON.stringify(prepared.degraded));
  store.commit(forget,hash(JSON.stringify(forget)),prepared,store.revision());
  assert.equal(store.facts().find((f:any)=>f.id===target.id).state,'erased');
  assert.equal(store.facts().find((f:any)=>f.id===echo.id).state,'erased','a same-source echo dies with the target');
  assert.equal(store.facts().find((f:any)=>f.id===independent.id).state,'active','an independent record survives the outage');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
