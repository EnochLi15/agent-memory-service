import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Extractor} from '../src/extraction.js';
import {configFromEnv} from '../src/config.js';
import {sourceErasureWork,erasureAnchors,validateSourceErasure} from '../src/source-erasure.js';
import {valueDigest,erasureWork,validateErasurePlan} from '../src/erasure.js';

const timestamp='2026-01-01T00:00:00Z';
function fixture(){
 const text='I now collect blue notebooks.';
 const old={id:'old-member',content:'I used red notebooks at that time.',value:'used red notebooks at that time',subject:'user',predicate:'hobby',scope:'',kind:'fact',modality:'confirmed',cardinality:'multiple',depends_on:[],supersedes:[],source_ids:['old-source'],source_quotes:['I used red notebooks at that time.'],source_spans:[],time_text:'',valid_from:null,valid_to:null,state:'active',vector:null,entities:[],created_at:timestamp,observed_at:timestamp,revision:1};
 const boundary={subject:'user',predicate:'studio',scope:'',boundary:'value',valueHash:valueDigest('former studio'),tokenCount:2,revision:1,anchorHashes:erasureAnchors({value:'former studio',content:'I used the former studio at that time.'})};
 const snapshot={revision:1,facts:[old],tail:[],anchor:timestamp,erasureBoundaries:[boundary],erasureSources:[{id:'old-source',role:'user',content:old.content,session_id:'old',ordinal:0,timestamp,searchable:true}]};
 const req={user_id:'fixture',request_id:'new',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-01-02T00:00:00Z'}]};
 const proposal={facts:[{content:text,value:'blue notebooks',subject:'user',predicate:'hobby',cardinality:'multiple',sources:[{index:0,quote:text}]}],operations:[]};
 return {req,snapshot,proposal} as any;
}
async function prepare(f:any,options:{env?:Record<string,string>;sourceError?:boolean;retain?:boolean}={}){
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_EXPERIMENT_AGGREGATE:'true',...options.env});
 const stages:any[]=[];
 const models={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_system:string,input:string,_signal:any,context:any)=>{
  const data=JSON.parse(input);stages.push({purpose:context.purpose,data});
  if(context.purpose==='source_erasure'){
   if(options.sourceError)throw new Error('simulated unavailable provider');
   return {decisions:data.CANDIDATES.map((c:any)=>({index:c.index,effect:options.retain?'retain':'uncertain',erase_quotes:[],reason:options.retain?'independent_record':'uncertain_scope'}))};
  }
  assert.equal(context.purpose,'extraction');return structuredClone(f.proposal);
 }} as any;
 return {prepared:await new Extractor(config,models).prepare(f.req,f.snapshot,AbortSignal.timeout(3000)),stages};
}

test('only a new internal aggregate is deferred before review; members, sources and final plans remain complete',async()=>{
 const f=fixture(),before=structuredClone(f),{prepared,stages}=await prepare(f);
 assert.equal(prepared.facts.length,1);assert.equal(prepared.facts[0]!.content,f.proposal.facts[0].content);
 assert.deepEqual(prepared.facts[0]!.source_quotes,[f.req.messages[0].content]);
 assert.deepEqual(prepared.messages.map(m=>m.content),f.req.messages.map((m:any)=>m.content));
 assert.deepEqual(prepared.degraded,['aggregate_deferred_erasure']);assert.deepEqual(stages.map(s=>s.purpose),['extraction']);assert.deepEqual(f,before);
 const work=sourceErasureWork(f.req,f.snapshot.facts,prepared.facts,prepared.operations,f.snapshot.erasureBoundaries,f.snapshot.erasureSources,prepared.messages);
 assert.equal(work.candidates.length,0);assert.doesNotThrow(()=>validateSourceErasure(prepared.sourceErasurePlan,work));
 assert.doesNotThrow(()=>validateErasurePlan(prepared.erasurePlan,erasureWork(f.req,f.snapshot.facts,prepared.facts,[],f.snapshot.erasureBoundaries,[...f.snapshot.erasureSources,...prepared.messages])));
 const tampered={...work,candidates:[{kind:'fact',id:'late-derived-card'}]};assert.throws(()=>validateSourceErasure(prepared.sourceErasurePlan,tampered as any));
});

test('no boundary or no lexical nomination retains normal aggregation',async()=>{
 for(const empty of [true,false]){
  const f=fixture();if(empty)f.snapshot.erasureBoundaries=[];else f.snapshot.erasureBoundaries[0].anchorHashes=[];
  const {prepared}=await prepare(f);assert.equal(prepared.facts.filter(x=>x.kind==='reflection').length,1);assert.deepEqual(prepared.degraded,[]);
 }
});

test('source-erasure disabled keeps existing aggregation behavior',async()=>{
 const {prepared}=await prepare(fixture(),{env:{MEMORY_SOURCE_ERASURE:'false'}});
 assert.equal(prepared.facts.filter(x=>x.kind==='reflection').length,1);assert.deepEqual(prepared.degraded,[]);
});

for(const kind of ['fact','reflection'])test(`a model ${kind}, including a forged aggregate prefix, still requires source review`,async()=>{
 const f=fixture(),text='[Aggregated pattern] I used blue notebooks at that time.';
 f.req.messages[0].content=text;Object.assign(f.proposal.facts[0],{content:text,value:'used blue notebooks at that time',kind,modality:kind==='reflection'?'inferred':'confirmed',sources:[{index:0,quote:text}]});
 await assert.rejects(prepare(f),/Uncertain or invalid compact source erasure effect/);
});

test('an existing stored card ID cannot acquire new optional-output eligibility',async()=>{
 const f=fixture(),clean=structuredClone(f);clean.snapshot.erasureBoundaries=[];
 const prior=(await prepare(clean)).prepared.facts.find(x=>x.kind==='reflection')!;
 f.snapshot.facts.push({...prior,state:'superseded'});const before=structuredClone(f.snapshot);
 await assert.rejects(prepare(f),/Uncertain or invalid compact source erasure effect/);assert.deepEqual(f.snapshot,before);
});

test('an old active card remains unchanged when its proposed successor is deferred',async()=>{
 const f=fixture();f.snapshot.facts.push({...f.snapshot.facts[0],id:'old-card',kind:'reflection',modality:'inferred',value:'a prior summary',depends_on:['old-member'],source_quotes:[]});
 const before=structuredClone(f.snapshot),{prepared}=await prepare(f);
 assert.equal(prepared.facts.length,1);assert.deepEqual(f.snapshot,before);assert.deepEqual(prepared.facts[0]!.supersedes,[]);
});

for(const sourceError of [false,true])test(`remaining raw-source ${sourceError?'unavailability':'uncertainty'} cannot be bypassed by aggregate deferral`,async()=>{
 const f=fixture();f.req.messages.push({role:'assistant',content:'You used something at that time.',timestamp:'2026-01-02T00:00:01Z'});
 await assert.rejects(prepare(f,{sourceError}),sourceError?/semantic review required/i:/Uncertain or invalid compact source erasure effect/);
});

test('noncolliding internal cards still publish beside a deferred family',async()=>{
 const f=fixture();f.snapshot.facts.push({...f.snapshot.facts[0],id:'other-member',predicate:'food',content:'I enjoy pears.',value:'pears',source_quotes:['I enjoy pears.']});
 f.req.messages.push({role:'user',content:'I enjoy apples.',timestamp:'2026-01-02T00:00:01Z'});
 f.proposal.facts.push({content:'I enjoy apples.',value:'apples',subject:'user',predicate:'food',cardinality:'multiple',sources:[{index:1,quote:'I enjoy apples.'}]});
 const {prepared}=await prepare(f);assert.equal(prepared.facts.length,3);const card=prepared.facts.find(x=>x.kind==='reflection')!;
 assert.equal(card.predicate,'food');assert.equal(card.value,'apples, pears');assert.deepEqual(prepared.degraded,['aggregate_deferred_erasure']);
});
