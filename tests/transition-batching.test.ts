import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as transitions from '../dist/transitions.js';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {ServiceError} from '../dist/types.js';

const request=(id='next',content='A complete synthetic state statement.')=>({user_id:'batch-fixture',request_id:id,session_id:'s',messages:[{role:'user',content,timestamp:'2026-02-01T00:00:00Z'}]});
const stored=(id:string,extra={})=>({id,content:'Grounded synthetic state '+id,subject:'user',predicate:'fixture_state',value:id,scope:'',kind:'fact',modality:'confirmed',cardinality:'single',time_text:'',valid_from:null,valid_to:null,depends_on:[],supersedes:[],source_ids:['source-'+id],source_quotes:['Witness zero for '+id,'Witness one for '+id],source_spans:[],created_at:'2026-01-01T00:00:00Z',observed_at:'2026-01-01T00:00:00Z',state:'active',vector:null,entities:[],revision:1,...extra});

test('large complete transition work becomes bounded packets without dropping any pair or witness',()=>{
 const req=request(),incoming=stored('incoming',{content:'Full synthetic detail. '.repeat(250)}),prior=Array.from({length:12},(_,i)=>stored('old-'+i));
 const work=transitions.transitionWork(req as any,prior as any,[incoming] as any,[]);
 assert.ok(JSON.stringify(work.candidates).length>64000);
 const batches=(transitions as any).transitionBatches(req,work);
 assert.ok(batches.length>1&&batches.length<=4);
 assert.deepEqual(batches.flatMap((b:any)=>b.work.candidates),work.candidates);
 let offset=0;
 for(const batch of batches){assert.equal(batch.offset,offset);assert.equal(batch.work.fingerprint,work.fingerprint);assert.equal(batch.input,JSON.stringify(transitions.transitionInput(req,batch.work)));assert.ok(batch.input.length<=64000);offset+=batch.work.candidates.length;}
 assert.equal(offset,12);
});

test('one packet keeps its original complete wire input and empty work emits no packet',()=>{
 const req=request(),work=transitions.transitionWork(req as any,[stored('old')] as any,[stored('new')] as any,[]);
 const batches=(transitions as any).transitionBatches(req,work);
 assert.equal(batches.length,1);assert.equal(batches[0].offset,0);
 assert.equal(batches[0].input,JSON.stringify(transitions.transitionInput(req,work)));
 assert.deepEqual(batches[0].work,work);
 const empty=transitions.transitionWork(req as any,[],[],[]);
 assert.deepEqual((transitions as any).transitionBatches(req,empty),[]);
});

test('the global pair ceiling remains 64 and is never satisfied by truncation',()=>{
 const req=request(),prior=Array.from({length:65},(_,i)=>stored('old-'+i));
 assert.throws(()=>transitions.transitionWork(req as any,prior as any,[stored('new')] as any,[]),/bounded capacity/);
});

const cfg=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SEMANTIC_TRANSITIONS:'true',MEMORY_SOURCE_INDEX:'false',MEMORY_EXPERIMENT_AGGREGATE:'false'});
const capacityError=(e:any)=>e instanceof ServiceError&&e.code==='EVIDENCE_VALIDATION'&&/capacity|batch|budget|limit|large|size/i.test(e.message);
const logical=(store:TenantStore)=>store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row:any)=>({name:row.name,rows:store.db.prepare('SELECT * FROM "'+row.name.replaceAll('"','""')+'"').all().map(x=>JSON.stringify(x)).sort()}));

// Every seed is a complete independent confirmed MULTIPLE record. Only the
// later synthetic single-valued statement triggers the pair comparisons.
async function fixture(fn:any,{oldCount=27,oldPadding=600,newPadding=600}:any={}){
 const dir=mkdtempSync(join(tmpdir(),'transition-batching-')),store=new TenantStore(dir,'batch-fixture');
 const statement=(label:string,padding:number)=>({head:label+'.',support:'Complete supporting detail '+label+' '+('context '.repeat(Math.ceil(padding/8))).slice(0,padding)+'.'});
 const sources=(text:any,index:number)=>[{index,quote:text.head},{index,quote:text.support}];
 const texts=Array.from({length:oldCount},(_,i)=>statement('Independent state '+i,oldPadding));
 const seed={...request('seed'),messages:texts.map(t=>({role:'user',content:t.head+' '+t.support,timestamp:'2026-01-01T00:00:00Z'}))};
 const seedFacts=texts.map((t,i)=>({content:t.head+' '+t.support,subject:'user',predicate:'fixture_state',value:'old-'+i,scope:'',kind:'fact',modality:'confirmed',cardinality:'multiple',sources:sources(t,i)}));
 const incoming=statement('My consolidated current state',newPadding),req=request('new',incoming.head+' '+incoming.support);
 const proposal={facts:[{content:incoming.head+' '+incoming.support,subject:'user',predicate:'fixture_state',value:'new-state',scope:'',kind:'fact',modality:'confirmed',cardinality:'single',sources:sources(incoming,0)}],operations:[]};
 const calls:any[]=[];let embeddings=0;
 const model=(facts:any[],handler?:any)=>({verify:async()=>[],embedBatch:async(xs:string[])=>{embeddings++;return xs.map(()=>[1,0]);},json:async(system:string,input:string,signal:AbortSignal,context:any)=>{
  if(context.purpose==='extraction')return {facts:structuredClone(facts),operations:[]};
  assert.equal(context.purpose,'state_transition','no extra model stage may replace transition verification');
  assert.equal(system,transitions.TRANSITION_PROMPT);assert.ok(input.length<=64000);
  const data=JSON.parse(input);assert.deepEqual(data.NEW_MESSAGES,req.messages);
  const call={system,input,data,signal};calls.push(call);
  return handler?handler(call,calls.length-1):decisions(data);
 }});
 const commit=(r:any,p:any)=>store.commit(r,hash(JSON.stringify(r)),p,store.revision());
 try{
  const seedPrepared=await new Extractor(cfg,model(seedFacts) as any).prepare(seed,store.snapshot('s'),AbortSignal.timeout(10000));commit(seed,seedPrepared);
  assert.equal(store.revision(),1);assert.equal(calls.length,0);
  const before=logical(store),beforeEmbeddings=embeddings;
  const prepare=(handler?:any,signal=AbortSignal.timeout(10000))=>new Extractor(cfg,model(proposal.facts,handler) as any).prepare(req,store.snapshot('s'),signal);
  await fn({store,req,proposal,calls,prepare,commit:(p:any)=>commit(req,p),before,beforeEmbeddings,embeddings:()=>embeddings});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

function decisions(data:any,relation:(candidate:any)=>string=()=> 'compatible'){
 return {decisions:data.CANDIDATES.map((c:any,index:number)=>({index,relation:relation(c),old_source_slot:1,new_source_slot:1,reason:'Synthetic fixture verdict for this exact pair and its complete second source witnesses.'}))};
}

test('Extractor batches complete records and TenantStore applies every authored relation with original quote slots',()=>fixture(async(f:any)=>{
 const prepared=await f.prepare(({data}:any)=>decisions(data,c=>c.old.value==='old-0'?'exclusive':c.old.value==='old-1'?'uncertain':'compatible'));
 assert.ok(f.calls.length>1&&f.calls.length<=4);assert.ok(f.calls.every((c:any)=>c.signal===f.calls[0].signal));
 const work=transitions.transitionWork(f.req,f.store.facts(),prepared.facts,prepared.operations);
 assert.ok(JSON.stringify(work.candidates).length>64000);assert.equal(work.candidates.length,27);
 assert.equal(prepared.transitionPlan.fingerprint,work.fingerprint);
 assert.deepEqual(prepared.transitionPlan.decisions.map((d:any)=>d.index),Array.from({length:27},(_,i)=>i));
 assert.ok(prepared.transitionPlan.decisions.every((d:any)=>d.old_source_slot===1&&d.new_source_slot===1));
 let offset=0;for(const call of f.calls){const expected=work.candidates.slice(offset,offset+call.data.CANDIDATES.length);assert.equal(call.input,JSON.stringify(transitions.transitionInput(f.req,{...work,candidates:expected})));offset+=expected.length;}
 assert.equal(offset,27);assert.deepEqual(logical(f.store),f.before);
 f.commit(prepared);assert.equal(f.store.revision(),2);assert.ok(f.store.receipt(f.req.request_id,hash(JSON.stringify(f.req))));
 const facts=f.store.facts();assert.equal(facts.length,28);
 assert.equal(facts.find((x:any)=>x.value==='old-0').state,'superseded');assert.equal(facts.find((x:any)=>x.value==='old-1').state,'conflicted');
 assert.ok(facts.filter((x:any)=>/^old-/.test(x.value)&&!['old-0','old-1'].includes(x.value)).every((x:any)=>x.state==='active'));
 assert.equal(facts.find((x:any)=>x.value==='new-state').state,'conflicted');
}));

test('the single-packet Extractor path sends the unchanged original transition input',()=>fixture(async(f:any)=>{
 const prepared=await f.prepare();const work=transitions.transitionWork(f.req,f.store.facts(),prepared.facts,prepared.operations);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].input,JSON.stringify(transitions.transitionInput(f.req,work)));
 f.commit(prepared);assert.equal(f.store.revision(),2);
},{oldCount:1,oldPadding:20,newPadding:20}));

test('a bad witness in the second packet prevents any partial transaction or fallback',()=>fixture(async(f:any)=>{
 await assert.rejects(async()=>f.commit(await f.prepare(({data}:any,index:number)=>{
  const raw=decisions(data);if(index===1)raw.decisions[0].old_source_slot=999;return raw;
 })),(e:any)=>e.code==='EVIDENCE_VALIDATION'&&/witness/.test(e.message));
 assert.equal(f.calls.length,2);assert.deepEqual(logical(f.store),f.before);assert.equal(f.store.revision(),1);
 assert.equal(f.store.receipt(f.req.request_id,hash(JSON.stringify(f.req))),null);assert.equal(f.embeddings(),f.beforeEmbeddings);
}));

test('parent cancellation in the second packet stops before embeddings or a partial commit',()=>fixture(async(f:any)=>{
 const parent=new AbortController();const reason=new DOMException('Synthetic caller cancellation','AbortError');
 await assert.rejects(async()=>f.commit(await f.prepare(({data,signal}:any,index:number)=>{
  if(index===1){parent.abort(reason);signal.throwIfAborted();}return decisions(data);
 },parent.signal)),(e:any)=>e===reason||e.name==='AbortError');
 assert.equal(f.calls.length,2);assert.ok(f.calls.every((c:any)=>c.signal===f.calls[0].signal));
 assert.deepEqual(logical(f.store),f.before);assert.equal(f.store.receipt(f.req.request_id,hash(JSON.stringify(f.req))),null);assert.equal(f.embeddings(),f.beforeEmbeddings);
}));

test('a later transport outage discards early exclusive decisions before the existing all-pair degraded fallback',()=>fixture(async(f:any)=>{
 const prepared=await f.prepare(({data}:any,index:number)=>{
  if(index===1)throw new Error('Synthetic transport outage');return decisions(data,()=> 'exclusive');
 });
 assert.equal(f.calls.length,2);assert.ok(prepared.degraded.includes('state_transition_deterministic'));
 assert.equal(prepared.transitionPlan.decisions.length,27);
 assert.ok(prepared.transitionPlan.decisions.every((d:any)=>d.relation==='uncertain'&&d.old_source_slot===0&&d.new_source_slot===0));
 assert.deepEqual(prepared.transitionPlan.decisions.map((d:any)=>d.index),Array.from({length:27},(_,i)=>i));
 assert.deepEqual(logical(f.store),f.before);f.commit(prepared);
 assert.equal(f.store.revision(),2);assert.equal(f.store.facts().length,28);assert.ok(f.store.facts().every((x:any)=>x.state==='conflicted'));
}));

test('a single complete pair over the wire limit is rejected before any transition call',()=>fixture(async(f:any)=>{
 await assert.rejects(()=>f.prepare(),capacityError);assert.equal(f.calls.length,0);assert.deepEqual(logical(f.store),f.before);assert.equal(f.embeddings(),f.beforeEmbeddings);
},{oldCount:1,oldPadding:34000,newPadding:20}));

test('requiring more than four complete packets is rejected before the first transition call',()=>fixture(async(f:any)=>{
 await assert.rejects(()=>f.prepare(),capacityError);assert.equal(f.calls.length,0);assert.deepEqual(logical(f.store),f.before);assert.equal(f.embeddings(),f.beforeEmbeddings);
},{oldCount:5,oldPadding:18000,newPadding:20}));
