import {test} from 'node:test';
import assert from 'node:assert/strict';
import {erasureWork,decodeErasure,validateErasurePlan} from '../dist/erasure.js';
import {factSchema,operationSchema} from '../dist/types.js';
const timestamp='2026-01-01T00:00:00Z';
const req={request_id:'delete',user_id:'u',session_id:'s',messages:[{role:'user',content:'Forget Rowan’s Cafe North preference.',timestamp}]};
const claim="It's my favorite lunch spot.",context='I found Cafe North near the office.';
const source={id:'current-source',session_id:'s',ordinal:1,role:'user',content:context+' '+claim,timestamp,searchable:true};
function fact(id:string,subject:string,quote:string,source_id:string){const {sources,...f}=factSchema.parse({content:subject+' favors Cafe North.',subject,predicate:'favorite_place',value:'Cafe North',sources:[{index:0,quote}]});return {...f,id,source_ids:[source_id],source_quotes:[quote],created_at:timestamp,observed_at:timestamp,state:'active',vector:null,entities:[],revision:1};}
const target=fact('target','Rowan','Rowan likes Cafe North.','target-source'),independent=fact('independent','user',claim,source.id);
const operations=[operationSchema.parse({type:'forget',target_ids:[target.id],subject:'Rowan',predicate:'favorite_place',value:'Cafe North',source:{index:0,quote:req.messages[0].content}})];
const work=(sources:any[]=[source])=>erasureWork(req,[target,independent] as any,[],operations,[],sources);
const response=(value_context:any)=>({decisions:[{index:0,effect:'retain',quote:claim,reason:'The same human message establishes the user’s independent restaurant preference.',value_context}]});
test('retention can resolve a narrow quote using exact context from the same linked human message',()=>{
 const w=work(),plan=decodeErasure(response({source_slot:0,quote:context}),w);
 assert.equal(plan.decisions[0].quote,claim);assert.equal(plan.decisions[0].value_context?.source_id,source.id);validateErasurePlan(plan,w);
});
test('only linked human sources are exposed and their content binds the plan identity',()=>{
 const w=work([{...source,id:'unlinked'},source,{...source,id:'assistant',role:'assistant'}]);
 assert.deepEqual(w.source_contexts,[{id:source.id,content:source.content}]);assert.deepEqual(w.candidates[0].context_source_slots,[0]);
 const plan=decodeErasure(response({source_slot:0,quote:context}),w);
 assert.throws(()=>validateErasurePlan(plan,work([{...source,content:source.content+' changed'}])),/stale/);
 const tampered=structuredClone(plan);tampered.decisions[0].value_context!.start++;assert.throws(()=>validateErasurePlan(tampered,w));
});
test('context cannot be missing, invented, ambiguous, unlinked or lack the colliding value',()=>{
 for(const value_context of [null,undefined,{source_slot:1,quote:context},{source_slot:0,quote:'Cafe North invented'},{source_slot:0,quote:claim}])assert.throws(()=>decodeErasure(response(value_context),work()));
 assert.throws(()=>decodeErasure(response({source_slot:0,quote:context}),work([{...source,content:source.content+' '+context}])));
 assert.throws(()=>decodeErasure(response({source_slot:0,quote:context}),work([{...source,role:'assistant'}])));
 assert.throws(()=>decodeErasure(response({source_slot:0,quote:context}),work([{...source,content:source.content+' '+claim}])));
});
test('legacy erasure without full-source partitioning still rejects a pronoun-only value witness',()=>{
 assert.throws(()=>decodeErasure(response(null),work([])),/Independent-value witness/);
});

import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true'});
async function transactionFixture(borrowDeletedContext:boolean,extraCut:string|undefined,fn:any){
 const dir=mkdtempSync(join(tmpdir(),'retained-context-'));let store=new TenantStore(dir,'u');
 const targetQuote='Rowan likes Cafe North.',text=targetQuote+' '+(borrowDeletedContext?'':context+' ')+claim;
 const seed={...req,request_id:'seed',messages:[{role:'user',content:text,timestamp}]};
 const proposal=(subject:string,quote:string)=>({content:subject+' favors Cafe North.',subject,predicate:'favorite_place',value:'Cafe North',sources:[{index:0,quote}]});
 const prepare=(r:any,p:any)=>new Extractor(config,{verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,input:string,_signal:any,ctx:any)=>{
  const data=JSON.parse(input);
  if(ctx?.purpose==='erasure_binding')return {decisions:data.CANDIDATES.map((c:any,index:number)=>({index,effect:'retain',quote:claim,reason:'Independent user claim.',value_context:{source_slot:c.context_source_slots[0],quote:borrowDeletedContext?targetQuote:context}}))};
  if(ctx?.purpose==='source_erasure')return {decisions:data.CANDIDATES.map((c:any)=>{
   const s=data.SOURCES[c.source_slot];
   if(s.kind==='fact')return {index:c.index,effect:'retain',erase_quotes:[],reason:'independent_owner'};
   if(s.text===text)return {index:c.index,effect:'mixed',erase_quotes:[targetQuote,...(extraCut?[extraCut]:[])],reason:'mixed_source'};
   return {index:c.index,effect:'erase',erase_quotes:[],reason:'erased_record_echo'};
  })};
  return structuredClone(p);
 }} as any).prepare(r,store.snapshot('s'),AbortSignal.timeout(2000));
 const commit=(r:any,p:any,fail?:string)=>store.commit(r,hash(JSON.stringify(r)),p,store.revision(),fail);
 try{
  commit(seed,await prepare(seed,{facts:[proposal('Rowan',targetQuote),proposal('user',claim)],operations:[]}));
  const t=store.facts().find(f=>f.subject==='Rowan')!;
  const del={...req,request_id:'delete'},p=await prepare(del,{facts:[],operations:[{...operations[0],target_ids:[t.id]}]});
  await fn({store,del,p,commit,reopen:()=>{store.close();store=new TenantStore(dir,'u');return store;}});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('context-backed retention commits atomically, preserves raw neighbors and survives restart',()=>transactionFixture(false,undefined,async({store,del,p,commit,reopen}:any)=>{
 const before=store.snapshot('s');
 for(const stage of ['operations','indexes']){
  assert.throws(()=>commit(del,p,stage),(e:any)=>e.code==='INJECTED_FAILURE');assert.deepEqual(store.snapshot('s'),before);assert.equal(store.receipt(del.request_id,hash(JSON.stringify(del))),null);
 }
 commit(del,p);assert.equal(store.revision(),2);assert.equal(store.facts().find((f:any)=>f.subject==='Rowan').state,'erased');
 const retained=store.facts().find((f:any)=>f.subject==='user');assert.equal(retained.state,'active');assert.equal(retained.content,'user favors Cafe North.');assert.deepEqual(retained.source_quotes,[claim]);
 const messages=store.snapshot('s').erasureSources;assert.doesNotMatch(JSON.stringify(messages),/Rowan likes/);assert.match(JSON.stringify(messages),/I found Cafe North/);assert.match(JSON.stringify(messages),/favorite lunch spot/);
 const after=store.snapshot('s'),restarted=reopen();assert.deepEqual(restarted.snapshot('s'),after);assert.deepEqual(restarted.receipt(del.request_id,hash(JSON.stringify(del))),{success:true,request_id:del.request_id,user_id:'u',session_id:'s'});
}));
test('a model retention verdict cannot borrow value context from the neighbor being erased',()=>transactionFixture(true,undefined,async({store,del,p,commit}:any)=>{
 const before=store.snapshot('s');assert.throws(()=>commit(del,p),/Retained value context or claim was erased/);assert.deepEqual(store.snapshot('s'),before);assert.equal(store.receipt(del.request_id,hash(JSON.stringify(del))),null);
}));
test('all boundaries must preserve both context and primary claim, even when another quote survives',async()=>{
 for(const cut of [context,claim])await transactionFixture(false,cut,async({store,del,p,commit}:any)=>{
  const before=store.snapshot('s');assert.throws(()=>commit(del,p),/Retained value context or claim was erased/);assert.deepEqual(store.snapshot('s'),before);assert.equal(store.receipt(del.request_id,hash(JSON.stringify(del))),null);
 });
});
