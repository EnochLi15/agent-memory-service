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
 const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async(_system:string,input:string)=>{calls++;if(calls===2){assert.match(_system,/PATCH_SCHEMA/);assert.doesNotThrow(()=>JSON.parse(input));assert.match(input,/subject|scope/);assert.match(input,/FAILED_PROPOSAL/);const failed=JSON.parse(input).FAILED_PROPOSAL;assert.equal(failed.facts[0].fact_index,0);assert.equal(failed.operations[0].operation_index,0);assert.match(input,/financial advisor/);assert.match(input,/car_purchase_reason/);}return calls===1?{facts:[structuredClone(fact)],operations:[structuredClone(operation)]}:{operation_edits:[{index:0,remove:true}]};},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
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
test('a binding failure in an appended fact gets a new repair scope without exposing unrelated facts',()=>fixture(async({store,config,req,fact}:any)=>{
 let calls=0,checks=0,repairScope:any;const before=store.facts()[0];
 const x=new Extractor({...config,mode:'enhanced',maxRepairRounds:2},{verify:async()=>++checks===1?['message 1: Missing the confirmed purchase reason.']:[],json:async(_system:string,input:string)=>{
  calls++;if(calls===1)return {facts:[structuredClone(fact)],operations:[]};
  if(calls===2)return {append_facts:[{...structuredClone(fact),modality:'confirmed',supersedes:['m0']}]};
  repairScope=JSON.parse(input).REPAIR_SCOPE;
  return {fact_edits:[{index:1,changes:{supersedes:[]}}]};
 },embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const prepared=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,3);assert.equal(checks,2);assert.deepEqual(repairScope.fact_indices,[1]);assert.deepEqual(repairScope.operation_indices,[]);
 store.commit(req,hash(JSON.stringify(req)),prepared,store.revision());assert.deepEqual(store.facts().find((f:any)=>f.id===before.id),before);
}));
test('a newly appended operation can be repaired after a localized coverage failure',()=>fixture(async({store,config,req,fact,operation}:any)=>{
 let calls=0,checks=0,repairScope:any;const before=store.facts()[0];
 const x=new Extractor({...config,mode:'enhanced',maxRepairRounds:2},{verify:async()=>++checks===1?['message 1: Missing the confirmed reason.']:[],json:async(_system:string,input:string)=>{
  calls++;if(calls===1)return {facts:[structuredClone(fact)],operations:[]};
  if(calls===2)return {append_operations:[structuredClone(operation)]};
  repairScope=JSON.parse(input).REPAIR_SCOPE;return {operation_edits:[{index:0,remove:true}]};
 },embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const prepared=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,3);assert.equal(checks,2);assert.deepEqual(repairScope.operation_indices,[0]);assert.deepEqual(repairScope.fact_indices,[]);
 store.commit(req,hash(JSON.stringify(req)),prepared,store.revision());assert.deepEqual(store.facts().find((f:any)=>f.id===before.id),before);
}));
test('refreshing a binding repair scope still rejects changes to unflagged facts',()=>fixture(async({store,config,req,fact}:any)=>{
 let calls=0;const x=new Extractor({...config,mode:'enhanced',maxRepairRounds:2},{verify:async()=>['message 1: Missing a detail.'],json:async()=>{
  calls++;if(calls===1)return {facts:[structuredClone(fact)],operations:[]};
  if(calls===2)return {append_facts:[{...structuredClone(fact),modality:'confirmed',supersedes:['m0']}]};
  return {fact_edits:[{index:1,changes:{supersedes:[]}},{index:0,remove:true}]};
 }} as any);
 await assert.rejects(x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000)),/Invalid target\/scope repair patch/);assert.equal(calls,3);assert.equal(store.revision(),1);
}));
test('a complete personal-state message cannot disappear behind a later unrelated topic',()=>fixture(async({store,config}:any)=>{
 const req={request_id:'coverage',user_id:'u',session_id:'s',messages:[{role:'user',content:'I set up an auto-invest of $250 every two weeks into the index fund.',timestamp:'2026-02-01T00:00:00Z'},{role:'user',content:'I might visit the island for photos.',timestamp:'2026-02-01T00:00:01Z'}]};
 const fund={content:req.messages[0].content,subject:'user',predicate:'auto_invest',value:'$250 every two weeks',sources:[{index:0,quote:req.messages[0].content}]};
 const travel={content:req.messages[1].content,subject:'user',predicate:'travel_plan',value:'island',sources:[{index:1,quote:req.messages[1].content}],modality:'tentative'};
 let calls=0;const x=new Extractor({...config,mode:'enhanced'},{verify:async(_p:any,_r:any,_f:any,omitted:number[])=>omitted.map(index=>'message '+index+': Missing personal source'),json:async()=>{calls++;return calls===1?{facts:[travel],operations:[]}:{append_facts:[{...fund,modality:"confirmed"}]};},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,2);assert.ok(p.facts.some((f:any)=>f.value==='$250 every two weeks'));
}));

test('offline retirement binds an untyped experience bucket by distinctive content word, never property-wide',async()=>{
 const x=new Extractor(configFromEnv({MEMORY_MODE:'offline'}),{} as any);
 const req={request_id:'offline-generic',user_id:'u',session_id:'s',messages:[{role:'user',content:'My default browser on my work laptop is Firefox. I had a bookmark sync issue with my old tablet. No need to track anything about the tablet.',timestamp:'2026-01-01T00:00:00Z'}]};
 const prepared=await x.prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000));
 // Degraded no-track commits: the tablet experience is bound by its distinctive
 // word and erased by value, the browser fact survives, nothing else is touched.
 assert.equal(prepared.operations.length,1);
 assert.equal(prepared.operations[0].boundary,'value');
 assert.ok(prepared.facts.some((f:any)=>f.predicate==='experience'&&f.content.includes('tablet')));
 const dir=mkdtempSync(join(tmpdir(),'offline-generic-'));const store=new TenantStore(dir,'u');
 try{
  store.commit(req,hash(JSON.stringify(req)),prepared,0);
  assert.ok(store.facts().some((f:any)=>f.predicate==='experience'&&f.state==='erased'));
  assert.ok(store.facts().some((f:any)=>f.state==='active'&&f.content.includes('Firefox')));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
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

// Scope errors and missing selectors coexist before the first repair. Reporting
// only the former consumes a bounded round without allowing the latter to change.
async function mixedBindingFixture(tamper:boolean){
 const dir=mkdtempSync(join(tmpdir(),'mixed-binding-')),store=new TenantStore(dir,'u'),config=configFromEnv({MEMORY_MODE:'enhanced'});
 const message=(content:string)=>({role:'user',content,timestamp:'2026-01-01T00:00:00Z'});
 const f=(content:string,index:number,scope:string,value:string,subject='Rowan',predicate='food')=>({content,subject,predicate,scope,value,sources:[{index,quote:content}]});
 const seed={request_id:'seed',user_id:'u',session_id:'s',messages:[message('Rowan orders curry at Cafe North.'),message('Rowan orders soup at Cafe South.'),message('Rowan orders tea at Cafe West.'),message('My browser is Firefox.')]};
 const models={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>Array(768).fill(0)),json:async()=>({facts:seed.messages.map((m,i)=>i===3?f(m.content,i,'','Firefox','user','browser'):f(m.content,i,['Cafe North','Cafe South','Cafe West'][i],['curry','soup','tea'][i])),operations:[]})};
 try{
  const seeded=await new Extractor(config,models as any).prepare(seed,store.snapshot('s'),AbortSignal.timeout(2000));store.commit(seed,hash(JSON.stringify(seed)),seeded,0);const before=store.snapshot('s');
  const req={request_id:'erase',user_id:'u',session_id:'s',messages:[message('Rowan orders noodles at Cafe East.'),message("Forget Rowan's food details. Keep my browser preference.")]};
  const op=(target_ids:string[],scope:string,value:string,predicate='food')=>({type:'forget',target_ids,subject:'Rowan',predicate,scope,value,boundary:'property',source:{index:1,quote:req.messages[1].content}});
  let calls=0,verified=0,repairInput:any;const current={...models,verify:async()=>{verified++;return [];},json:async(_system:string,input:string)=>{
   calls++;const d=JSON.parse(input),target=(scope:string)=>d.EXISTING_FACTS.find((x:any)=>x.subject==='Rowan'&&x.scope===scope).id;
   if(calls===1)return {facts:[f(req.messages[0].content,0,'Cafe East','noodles')],operations:[op([target('Cafe North'),target('Cafe South')],'','food'),op([],'','food',''),op([target('Cafe West')],'Cafe West','tea')]};
   repairInput=d;
   const edits:any[]=[{index:0,changes:op([target('Cafe North')],'Cafe North','curry')},{index:1,changes:op(['new:0'],'Cafe East','noodles')}];
   if(tamper)edits.push({index:2,remove:true});
   return {operation_edits:edits,append_operations:[op([target('Cafe South')],'Cafe South','soup')]};
  }};
  const outcome=await new Extractor(config,current as any).prepare(req,before,AbortSignal.timeout(2000)).then(prepared=>({prepared,error:undefined}),error=>({prepared:undefined,error}));
  assert.ok(repairInput,'the initial proposal must reach structural repair');
  assert.deepEqual(repairInput.REPAIR_SCOPE.operation_indices,[0,1]);assert.deepEqual(repairInput.REPAIR_SCOPE.fact_indices,[]);assert.match(repairInput.REPAIR_FEEDBACK,/No grounded record matches/);
  if(tamper){assert.match(outcome.error?.message??'',/Invalid target\/scope repair patch/);assert.equal(verified,0);assert.deepEqual(store.snapshot('s'),before);}
  else{
   if(outcome.error)throw outcome.error;const prepared=outcome.prepared!;assert.equal(verified,1);assert.equal(prepared.operations.length,4);store.commit(req,hash(JSON.stringify(req)),prepared,1);
   const rows=store.facts();assert.equal(rows.filter(f=>f.subject==='Rowan'&&f.state==='erased').length,4);assert.ok(rows.some(f=>f.subject==='user'&&f.value==='Firefox'&&f.state==='active'));assert.equal(store.revision(),2);
  }
  assert.equal(calls,2,'all known structural binding errors fit the one configured repair round');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('one bounded repair sees simultaneous scope and selector failures and preserves valid siblings',()=>mixedBindingFixture(false));
test('combined binding feedback does not authorize editing a valid sibling operation',()=>mixedBindingFixture(true));
