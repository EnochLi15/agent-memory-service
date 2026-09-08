import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {instructionSpans,missingForgetObligations} from '../dist/operation-intent.js';

const first='Forget that Mara lived in Siena.';
const repeat='Just remove the Siena detail.';
const advice="Don't factor the ended training phase into outing suggestions.";
const content=`${advice} ${first} Keep her pottery hobby. ${repeat}`;
const request=(id:string,text:string)=>({request_id:id,user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-01-01T00:00:00Z'}]});
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true'});
const command=(target:string,quote=first)=>({type:'forget',target_ids:[target],subject:'Mara',predicate:'former_residence',scope:'',value:'Siena',boundary:'value',source:{index:0,quote}});

async function fixture(fn:any){
 const dir=mkdtempSync(join(tmpdir(),'obligation-repair-')),store=new TenantStore(dir,'u');
 const seed=request('seed','Mara lived in Siena. Mara likes pottery.');
 const model={json:async()=>({facts:[{content:'Mara lived in Siena.',subject:'Mara',predicate:'former_residence',value:'Siena',sources:[{index:0,quote:'Mara lived in Siena.'}]},{content:'Mara likes pottery.',subject:'Mara',predicate:'hobby',value:'pottery',sources:[{index:0,quote:'Mara likes pottery.'}]}],operations:[]}),verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 try{const p=await new Extractor(config,model as any).prepare(seed,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(seed,hash(JSON.stringify(seed)),p,0);await fn(store);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test('a repeated retirement gets its exact missing witness, not an unrelated current recommendation',()=>fixture(async(store:TenantStore)=>{
 const req=request('delete',content);let calls=0,feedback:any,repairPrompt='',verified=0,sourceChecks=0;
 const x=new Extractor(config,{json:async(system:string,input:string,_signal:any,context:any)=>{
  const d=JSON.parse(input);
  if(context.purpose==='extraction'){calls++;return {facts:[],operations:[command(d.EXISTING_FACTS.find((f:any)=>f.value==='Siena').id)]};}
  if(context.purpose==='repair'){calls++;feedback=d;repairPrompt=system;return {append_operations:[command(d.FAILED_PROPOSAL.operations[0].target_ids[0],repeat)]};}
  if(context.purpose==='source_erasure'){
   sourceChecks++;return {decisions:d.CANDIDATES.map((c:any)=>{const text=d.SOURCES[c.source_slot].text;const matches=['Mara lived in Siena.',first,repeat].filter(q=>text.includes(q));const cuts=matches.filter(q=>!matches.some(other=>other!==q&&other.includes(q)));return {index:c.index,effect:'mixed',erase_quotes:cuts,reason:'mixed_source'};})};
  }
  throw Error('Unexpected test model stage '+context.purpose);
 },verify:async(p:any)=>{verified++;assert.equal(p.operations.length,2);assert.ok(p.operations.every((o:any)=>o.value==='Siena'&&o.boundary==='value'));return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 const prepared=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(2000));
 assert.equal(calls,2);assert.equal(verified,1);assert.ok(sourceChecks>0);assert.deepEqual(prepared.degraded,[]);
 assert.deepEqual(feedback.MISSING_OPERATION_INSTRUCTIONS,[{index:0,start:content.indexOf(' '+repeat),end:content.length,quote:repeat}]);
 assert.match(repairPrompt,/same target.*distinct|distinct.*same target/i);
 assert.match(feedback.REPAIR_FEEDBACK,/MISSING_OPERATION_INSTRUCTIONS/);
 assert.equal(instructionSpans(advice)[0]?.intent,'none');
 store.commit(req,hash(JSON.stringify(req)),prepared,store.revision());
 assert.ok(store.facts().some(f=>f.predicate==='former_residence'&&f.state==='erased'));
 assert.ok(store.facts().some(f=>f.predicate==='hobby'&&f.state==='active'&&f.value==='pottery'));
 assert.doesNotMatch(JSON.stringify(store.raw()),/Siena/);
 assert.match(JSON.stringify(store.raw()),/pottery/);
 assert.equal((store.db.prepare('SELECT count(*) AS n FROM markers').get() as any).n,1);
}));

test('same literal with a different owner remains a separate uncovered operation',()=>{
 const req=request('two','Forget Mara\'s Siena detail. Forget Nia\'s Siena detail.');
 const proposal={facts:[],operations:[command('m0',"Forget Mara's Siena detail.")]};
 const missing=missingForgetObligations(req,proposal as any);
 assert.deepEqual(missing.map(x=>x.span.quote),["Forget Nia's Siena detail."]);
});

test('missing witnesses follow the active repair scope across messages',()=>fixture(async(store:TenantStore)=>{
 const req={...request('cross-message',''),messages:[{role:'user',content:advice},{role:'user',content:first}]};
 let repairs=0;
 const x=new Extractor({...config,erasureBinding:false,sourceErasure:false,maxRepairRounds:2},{json:async(_system:string,input:string,_signal:any,context:any)=>{
  const d=JSON.parse(input);
  if(context.purpose==='extraction')return {facts:[],operations:[command(d.EXISTING_FACTS.find((f:any)=>f.value==='Siena').id,advice)]};
  assert.equal(context.purpose,'repair');repairs++;
  for(const witness of d.MISSING_OPERATION_INSTRUCTIONS??[])assert.ok(d.REPAIR_SCOPE.source_indices.includes(witness.index),'every advertised missing witness must be editable this round');
  if(repairs===1){
   assert.deepEqual(d.REPAIR_SCOPE.source_indices,[0]);
   assert.equal(d.MISSING_OPERATION_INSTRUCTIONS,undefined);
   return {operation_edits:[{index:0,remove:true}]};
  }
  assert.deepEqual(d.MISSING_OPERATION_INSTRUCTIONS,[{index:1,start:0,end:first.length,quote:first}]);
  return {append_operations:[{...command(d.EXISTING_FACTS.find((f:any)=>f.value==='Siena').id),source:{index:1,quote:first}}]};
 },verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 const prepared=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(2000));
 assert.equal(repairs,2);assert.deepEqual(prepared.degraded,[]);assert.equal(prepared.operations.length,1);assert.equal(prepared.operations[0]?.source.index,1);
}));

test('exhausted missing instructions fail as operation intent instead of offline extraction',()=>fixture(async(store:TenantStore)=>{
 const req=request('missing',content),before=store.snapshot('s');let calls=0;
 const x=new Extractor({...config,maxRepairRounds:1},{json:async(_system:string,input:string,_signal:any,context:any)=>{
  calls++;if(context.purpose==='extraction'){const d=JSON.parse(input);return {facts:[],operations:[command(d.EXISTING_FACTS.find((f:any)=>f.value==='Siena').id)]};}return {};
 },verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 await assert.rejects(x.prepare(req,before,AbortSignal.timeout(2000)),(e:any)=>e.code==='OPERATION_INTENT');
 assert.equal(calls,2);assert.deepEqual(store.snapshot('s'),before);
}));

test('exhausted unauthorized operation witnesses cannot degrade to an offline deletion',()=>fixture(async(store:TenantStore)=>{
 const req=request('unauthorized',`${advice} ${first}`),before=store.snapshot('s');let calls=0;
 const x=new Extractor({...config,maxRepairRounds:1},{json:async(_system:string,input:string,_signal:any,context:any)=>{
  calls++;if(context.purpose==='extraction'){const d=JSON.parse(input);return {facts:[],operations:[command(d.EXISTING_FACTS.find((f:any)=>f.value==='Siena').id,advice)]};}return {};
 },verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 await assert.rejects(x.prepare(req,before,AbortSignal.timeout(2000)),(e:any)=>e.code==='OPERATION_INTENT');
 assert.equal(calls,2);assert.deepEqual(store.snapshot('s'),before);
}));

test('source review capability failure cannot turn candidate nomination into source deletion',()=>fixture(async(store:TenantStore)=>{
 const req=request('source-unavailable',first),before=store.snapshot('s');let sourceCalls=0;
 const x=new Extractor(config,{json:async(_system:string,input:string,_signal:any,context:any)=>{
  if(context.purpose==='extraction'){const d=JSON.parse(input);return {facts:[],operations:[command(d.EXISTING_FACTS.find((f:any)=>f.value==='Siena').id)]};}
  assert.equal(context.purpose,'source_erasure');sourceCalls++;throw Error('Local fixture: source-review provider unavailable');
 },verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 await assert.rejects(x.prepare(req,before,AbortSignal.timeout(2000)),(e:any)=>e.code==='EVIDENCE_VALIDATION'&&/semantic review required/.test(e.message));
 assert.equal(sourceCalls,1);assert.deepEqual(store.snapshot('s'),before);assert.equal(store.receipt(req.request_id,hash(JSON.stringify(req))),null);
}));

test('a capability failure while repairing unresolved intent cannot activate offline extraction',()=>fixture(async(store:TenantStore)=>{
 const req=request('repair-unavailable',content),before=store.snapshot('s');let calls=0;
 const x=new Extractor(config,{json:async(_system:string,input:string,_signal:any,context:any)=>{
  calls++;if(context.purpose==='extraction'){const d=JSON.parse(input);return {facts:[],operations:[command(d.EXISTING_FACTS.find((f:any)=>f.value==='Siena').id)]};}throw Error('Local fixture: repair provider unavailable');
 },verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 await assert.rejects(x.prepare(req,before,AbortSignal.timeout(2000)),(e:any)=>e.code==='OPERATION_INTENT');
 assert.equal(calls,2);assert.deepEqual(store.snapshot('s'),before);
}));
