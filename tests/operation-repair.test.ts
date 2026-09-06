import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Minimized from the D24_reflect prefix: an unrecorded assistant explanation is
// corrected by the user, while a generic context word overlaps an unrelated fact.
async function fixture(body:any){
 const dir=mkdtempSync(join(tmpdir(),'target-repair-'));const store=new TenantStore(dir,'u');const config=configFromEnv({});
 const seed={request_id:'seed',user_id:'u',session_id:'s',messages:[{role:'user',content:'I will do my research and consult a financial advisor.',timestamp:'2026-01-01T00:00:00Z'}]};
 const offline=new Extractor(config,{} as any);store.commit(seed,hash(JSON.stringify(seed)),await offline.prepare(seed,store.snapshot('s'),AbortSignal.timeout(1000)),0);
 const correction='The main reason was the open feel and the windows. Can you fix that in your notes?';
 const req={request_id:'correction',user_id:'u',session_id:'s',messages:[{role:'assistant',content:'Research shows those options differ. Your main reason for choosing the Outback was AWD.',timestamp:'2026-02-01T00:00:00Z'},{role:'user',content:correction,timestamp:'2026-02-01T00:00:01Z'}]};
 const fact={content:'The main reason was the open feel and the windows.',subject:'user',predicate:'car_purchase_reason',scope:'Outback vs RAV4',value:'open feel and windows',cardinality:'single',sources:[{index:1,quote:'The main reason was the open feel and the windows.'}]};
 const operation={type:'correct',target_ids:['m0'],subject:'user',predicate:'car_purchase_reason',scope:'Outback vs RAV4',value:'open feel and windows',boundary:'property',source:{index:1,quote:'Can you fix that in your notes?'}};
 try{await body({store,config,req,fact,operation});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('scope mismatch reaches bounded extraction repair before transaction; an unrecorded assistant claim cannot target an unrelated fact',()=>fixture(async({store,config,req,fact,operation}:any)=>{
 let calls=0;const before=store.facts()[0];
 const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async(_system:string,input:string)=>{calls++;if(calls===2){assert.match(_system,/PATCH_SCHEMA/);assert.doesNotThrow(()=>JSON.parse(input));assert.match(input,/subject|scope/);assert.match(input,/FAILED_PROPOSAL/);assert.match(input,/financial advisor/);assert.match(input,/car_purchase_reason/);}return calls===1?{facts:[structuredClone(fact)],operations:[structuredClone(operation)]}:{operation_edits:[{index:0,remove:true}]};},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const prepared=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,2);
 store.commit(req,hash(JSON.stringify(req)),prepared,store.revision());
 assert.deepEqual(store.facts().find((f:any)=>f.id===before.id),before);assert.ok(store.facts().some((f:any)=>f.value==='open feel and windows'));
}));
test('persistent invalid scope cannot degrade into a successful write that silently loses the correction',()=>fixture(async({store,config,req,fact,operation}:any)=>{
 let calls=0;const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async()=>{calls++;return {facts:[structuredClone(fact)],operations:[structuredClone(operation)]};}} as any);
 await assert.rejects(x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000)),/scope|subject/);assert.equal(calls,2);assert.equal(store.revision(),1);
}));
test('same-scope unrelated property still triggers repair; matching only the user is insufficient',()=>fixture(async({store,config,req,fact,operation}:any)=>{
 let calls=0;operation.scope='';const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async()=>{calls++;return calls===1?{facts:[structuredClone(fact)],operations:[structuredClone(operation)]}:{operation_edits:[{index:0,remove:true}]};},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const before=store.facts()[0];const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,2);store.commit(req,hash(JSON.stringify(req)),p,store.revision());assert.deepEqual(store.facts().find((f:any)=>f.id===before.id),before);
}));
test('replacement fact references cannot supersede a different property without an operation',()=>fixture(async({store,config,req,fact}:any)=>{
 let calls=0;const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async()=>{calls++;return calls===1?{facts:[{...structuredClone(fact),scope:'',supersedes:['m0']}],operations:[]}:{fact_edits:[{index:0,changes:{supersedes:[]}}]};},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const before=store.facts()[0];const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,2);store.commit(req,hash(JSON.stringify(req)),p,store.revision());assert.deepEqual(store.facts().find((f:any)=>f.id===before.id),before);
}));
test('a complete personal-state message cannot disappear behind a later unrelated topic',()=>fixture(async({store,config}:any)=>{
 const req={request_id:'coverage',user_id:'u',session_id:'s',messages:[{role:'user',content:'I set up an auto-invest of $250 every two weeks into the index fund.',timestamp:'2026-02-01T00:00:00Z'},{role:'user',content:'I might visit the island for photos.',timestamp:'2026-02-01T00:00:01Z'}]};
 const fund={content:req.messages[0].content,subject:'user',predicate:'auto_invest',value:'$250 every two weeks',sources:[{index:0,quote:req.messages[0].content}]};
 const travel={content:req.messages[1].content,subject:'user',predicate:'travel_plan',value:'island',sources:[{index:1,quote:req.messages[1].content}],modality:'tentative'};
 let calls=0;const x=new Extractor({...config,mode:'enhanced'},{verify:async(_p:any,_r:any,_f:any,omitted:number[])=>omitted.map(index=>'message '+index+': Missing personal source'),json:async()=>{calls++;return calls===1?{facts:[travel],operations:[]}:{append_facts:[{...fund,modality:"confirmed"}]};},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,2);assert.ok(p.facts.some((f:any)=>f.value==='$250 every two weeks'));
}));

test('offline retirement cannot turn an untyped experience bucket into a property-wide deletion',async()=>{
 const x=new Extractor(configFromEnv({MEMORY_MODE:'offline'}),{} as any);
 const req={request_id:'offline-generic',user_id:'u',session_id:'s',messages:[{role:'user',content:'My default browser on my work laptop is Firefox. I had a bookmark sync issue with my old tablet. No need to track anything about the tablet.',timestamp:'2026-01-01T00:00:00Z'}]};
 await assert.rejects(x.prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000)),/untyped|bind/i);
});

test('source recovery cannot redirect a same-chunk salary deletion to the following manager fact',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'partial-slot-')),store=new TenantStore(dir,'u');
 const text='My salary is 85000. My manager is Alice. Forget my salary.';
 const req={request_id:'partial',user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-01-01T00:00:00Z'}]};
 const response={facts:[{content:'I like swimming.',subject:'user',predicate:'hobby',value:'swimming',sources:[{index:0,quote:'swimming'}]},{content:'My salary is 85000.',subject:'user',predicate:'salary',value:'85000',sources:[{index:0,quote:'My salary is 85000.'}]},{content:'My manager is Alice.',subject:'user',predicate:'manager',value:'Alice',sources:[{index:0,quote:'My manager is Alice.'}]}],operations:[{type:'forget',target_ids:['new:1'],subject:'user',predicate:'salary',value:'85000',source:{index:0,quote:'Forget my salary.'}}]};
 const x=new Extractor(configFromEnv({MEMORY_MODE:'enhanced'}),{json:async(system:string)=>system.includes('PATCH_SCHEMA')?{}:structuredClone(response),verify:async()=>[],embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 try{
  const prepared=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.ok(prepared.degraded.includes('source_span_partial'));
  store.commit(req,hash(JSON.stringify(req)),prepared,0);assert.ok(store.facts().some(f=>f.predicate==='salary'&&f.state==='erased'));assert.ok(store.facts().some(f=>f.predicate==='manager'&&f.value==='Alice'&&f.state==='active'));assert.doesNotMatch(JSON.stringify(store.raw()),/85000/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('one repair receives target binding and independent source errors together',()=>fixture(async({store,config,req,fact,operation}:any)=>{
 let calls=0,verified=false,observedFeedback='';const badQuote='The reason was sunlight and extra legroom.';
 const x=new Extractor({...config,mode:'enhanced'},{json:async(_system:string,input:string)=>{
  calls++;if(calls===1)return {facts:[{...fact,sources:[{index:1,quote:badQuote}]}],operations:[operation]};
  observedFeedback=JSON.parse(input).REPAIR_FEEDBACK;
  return {fact_edits:[{index:0,changes:{sources:fact.sources}}],operation_edits:[{index:0,remove:true}]};
 },verify:async(p:any)=>{verified=true;assert.deepEqual(p.facts[0].sources,fact.sources);assert.equal(p.operations.length,0);return [];},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.ok(verified);assert.equal(calls,2);assert.equal(p.facts.length,1);assert.ok(!p.degraded.includes('source_span_partial'));assert.match(observedFeedback,/Operation target binding/);assert.ok(observedFeedback.includes('SOURCE_ERRORS'));assert.ok(observedFeedback.includes(badQuote));
}));
