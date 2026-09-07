import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';import {retrieve} from '../dist/retrieval.js';import {erasureInput} from '../dist/erasure.js';
const timestamp='2026-01-01T00:00:00Z',deleted='Rowan ordered hot curry at Cafe North.',independent='I stuck with my usual mild curry.',neighbor='I still use Firefox.',text=[deleted,independent,neighbor].join(' ');
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SOURCE_ERASURE_GROUPED:'true'});
const request=(id:string,content:string)=>({request_id:id,user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp}]});
async function fixture(keepDeleted:boolean,fn:any){
 const dir=mkdtempSync(join(tmpdir(),'mixed-fact-retirement-'));let store=new TenantStore(dir,'u');
 let proposal:any={facts:[{content:deleted,subject:'Rowan',predicate:'order',value:'Cafe North',sources:[{index:0,quote:deleted}]},{content:'User stuck with mild curry when Rowan ordered hot curry at Cafe North.',subject:'user',predicate:'order',value:'mild curry',sources:[{index:0,quote:deleted},{index:0,quote:independent}]},{content:neighbor,subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:neighbor}]}],operations:[]};
 let mixedRetired=false;
 const models={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(system:string,input:string,_signal:any,ctx:any)=>{
  const x=JSON.parse(input);
  if(ctx.purpose==='erasure_binding'){
   assert.equal(x.SOURCE_PARTITION_ENABLED,true);assert.match(system,/retire the contaminated derived fact/);mixedRetired=true;
   return {decisions:x.CANDIDATES.map((c:any)=>({index:c.index,effect:'erase',quote:deleted,reason:'The derived summary still includes the erased order; preserve the separate user clause in raw sources.',value_context:null}))};
  }
  if(ctx.purpose==='source_erasure')return {decisions:x.SOURCES.map((s:any)=>{
   assert.notEqual(s.kind,'fact','contaminated derived summary was already retired');
   return s.text===text?{index:s.index,effect:keepDeleted?'retain':'mixed',erase_quotes:keepDeleted?[]:[deleted],reason:keepDeleted?'independent_record':'mixed_source'}:{index:s.index,effect:'erase',erase_quotes:[],reason:'erased_record_echo'};
  })};
  return structuredClone(proposal);
 }} as any;
 const extractor=new Extractor(config,models),seed=request('seed',text);
 try{
  store.commit(seed,hash(JSON.stringify(seed)),await extractor.prepare(seed,store.snapshot('s'),AbortSignal.timeout(3000)),0);
  const target=store.facts().find(f=>f.subject==='Rowan')!,del=request('delete','Forget Rowan’s order at Cafe North.');proposal={facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'Rowan',predicate:'order',value:'Cafe North',source:{index:0,quote:del.messages[0].content}}]};
  await fn({store,del,prepare:()=>extractor.prepare(del,store.snapshot('s'),AbortSignal.timeout(3000)),mixedRetired:()=>mixedRetired,reopen:()=>{store.close();store=new TenantStore(dir,'u');return store;}});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('retire a contaminated summary while preserving independently searchable raw clauses and neighbor facts',()=>fixture(false,async({store,del,prepare,mixedRetired,reopen}:any)=>{
 const before=store.snapshot('s'),p=await prepare();assert.equal(mixedRetired(),true);assert.equal(p.facts.length,0,'no invented replacement fact');
 assert.throws(()=>store.commit(del,hash(JSON.stringify(del)),p,1,'indexes'));assert.deepEqual(store.snapshot('s'),before);
 store.commit(del,hash(JSON.stringify(del)),p,1);assert.equal(store.revision(),2);
 assert.equal(store.facts().filter((f:any)=>f.state==='erased').length,2);assert.ok(store.facts().some((f:any)=>f.value==='Firefox'&&f.state==='active'));
 const raw=JSON.stringify(store.snapshot('s').erasureSources);assert.doesNotMatch(raw,/Rowan|hot curry/);assert.ok(raw.includes(independent));assert.ok(raw.includes(neighbor));
 const results=JSON.stringify(retrieve(store,{user_id:'u',query:'usual mild curry Firefox',top_k:32},null,config).data);assert.ok(results.includes(independent));assert.match(results,/Firefox/);assert.doesNotMatch(results,/Rowan|hot curry/);
 const after=store.snapshot('s'),restarted=reopen();assert.deepEqual(restarted.snapshot('s'),after);
}));
test('retired mixed summaries cannot leave their affected original evidence recoverable',()=>fixture(true,async({store,prepare}:any)=>{
 const before=store.snapshot('s');await assert.rejects(()=>prepare(),/certified erased fact witness intact/);assert.deepEqual(store.snapshot('s'),before);assert.equal(store.revision(),1);
}));
test('mixed-summary retirement is not offered by the legacy input without source partitioning',()=>{
 const req=request('legacy','hello'),work={fingerprint:'x',candidates:[],automatic:[],source_contexts:[]};
 assert.equal(erasureInput(req,[],work as any).SOURCE_PARTITION_ENABLED,false);
});
