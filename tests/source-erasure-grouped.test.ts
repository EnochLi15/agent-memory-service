import {test} from 'node:test';import assert from 'node:assert/strict';
import {executeGroupedSourceErasure,groupSourceErasureWork,groupedSourceErasureInput} from '../dist/source-erasure-grouped.js';
import {validateSourceErasure,maskSource,sourceErasureBatches} from '../dist/source-erasure.js';
import {configFromEnv} from '../dist/config.js';
const text='Our backup is Iris. Iris has the understated feel we like. Priya named her daughter Violet Mae. We chose Elara.';
const fixture=()=>({fingerprint:'original',candidates:[0,1,2].map(i=>({kind:'source',id:'s',start:0,text,key:'b'+i,boundary:{subject:'user',predicate:['backup','reason','ranking'][i]},authorization:{source:{quote:'Forget the backup and its details.'}},matching_words:['Iris'],context:{role:'user',linked_facts:[{id:'keep',content:'Priya named her daughter Violet Mae.',source_quotes:['Priya named her daughter Violet Mae.']}],linked_erased_facts:[{id:'style',content:'We like the understated feel of Iris.',source_quotes:['Iris has the understated feel we like.']}]}}))}) as any;
const mixed=(index=0)=>({index,effect:'mixed',reason:'mixed_source',erase_quotes:['Our backup is Iris.','Iris has the understated feel we like.']});
test('joint review includes every authorization and fixed erased obligation exactly once per source',()=>{
 const original=fixture(),saved=structuredClone(original),{work,members}=groupSourceErasureWork(original),input=groupedSourceErasureInput(work);
 assert.deepEqual(members,[[0,1,2]]);assert.equal(input.SOURCES.length,1);assert.equal(input.SOURCES[0].boundary_refs.length,3);
 assert.deepEqual(input.SOURCES[0].context,original.candidates[0].context);assert.deepEqual(input.SOURCES[0].boundary_refs.map(r=>input.BOUNDARIES[r.boundary_slot].key),['b0','b1','b2']);assert.notEqual(work.fingerprint,original.fingerprint);assert.deepEqual(original,saved);
 original.candidates[1].authorization.source.quote='Different authority';assert.notEqual(groupSourceErasureWork(original).work.fingerprint,work.fingerprint);
});
test('one joint partition maps back to complete original coverage and preserves independent neighbors',async()=>{
 const original=fixture();let calls=0;
 const plan=await executeGroupedSourceErasure(original,3,AbortSignal.timeout(1000),async(_s,input)=>{calls++;assert.equal(JSON.parse(input).SOURCES.length,1);return {decisions:[mixed()]};});
 assert.equal(calls,1);assert.equal(plan.fingerprint,original.fingerprint);assert.deepEqual(plan.decisions.map(d=>d.index),[0,1,2]);
 const {cuts}=validateSourceErasure(plan,original),masked=maskSource(text,cuts.get('s')!);assert.doesNotMatch(masked,/Iris|understated/);assert.match(masked,/Priya named her daughter Violet Mae/);assert.match(masked,/We chose Elara/);
 plan.decisions[0].parts[0].text='mutated';assert.notEqual(plan.decisions[1].parts[0].text,'mutated');
});
test('joint review rejects the observed omitted style witness without another semantic sampling',async()=>{
 let calls=0;await assert.rejects(()=>executeGroupedSourceErasure(fixture(),3,AbortSignal.timeout(1000),async()=>{calls++;return {decisions:[{...mixed(),erase_quotes:['Our backup is Iris.']}]};}),/certified erased fact witness intact/);assert.equal(calls,1);
});
test('identical words belonging to different sources, kinds or contexts are never merged',()=>{
 const original=fixture(),base=original.candidates[0];original.candidates.push({...base,id:'other'},{...base,kind:'fact'},{...base,context:{role:'assistant'}});
 const {members}=groupSourceErasureWork(original);assert.deepEqual(members,[[0,1,2],[3],[4],[5]]);
});
test('groups stay indivisible across batches and out of order responses preserve original indices',async()=>{
 const original=fixture();original.candidates=[];for(let i=0;i<65;i++)for(let j=0;j<2;j++)original.candidates.push({...fixture().candidates[j],id:'s'+i});
 const {work,members}=groupSourceErasureWork(original);assert.equal(members.length,65);assert.deepEqual(sourceErasureBatches(work,groupedSourceErasureInput).flatMap(b=>b.candidates),work.candidates);
 let calls=0;const plan=await executeGroupedSourceErasure(original,3,AbortSignal.timeout(2000),async(_s,input)=>{calls++;return {decisions:JSON.parse(input).SOURCES.map((s:any)=>mixed(s.index)).reverse()};});
 assert.ok(calls>=2);assert.deepEqual(plan.decisions.map(d=>d.index),Array.from({length:130},(_,i)=>i));
});
test('missing, duplicated, uncertain and nonliteral grouped rows cannot publish a partial plan',async()=>{
 for(const decisions of [[],[mixed(),mixed()],[{...mixed(),index:1}],[{...mixed(),effect:'uncertain',reason:'uncertain_scope',erase_quotes:[]}],[{...mixed(),erase_quotes:['other source words']}]] ){
  await assert.rejects(()=>executeGroupedSourceErasure(fixture(),1,AbortSignal.timeout(1000),async(_s,_i,_a,purpose)=>purpose==='source_erasure'?{decisions}:{repairs:[]}));
 }
});
test('joint literal repair receives all boundaries and retains fixed decisions and original identity',async()=>{
 let repairs=0;const plan=await executeGroupedSourceErasure(fixture(),1,AbortSignal.timeout(1000),async(_s,input,_signal,purpose)=>{
  if(purpose==='source_erasure')return {decisions:[{...mixed(),erase_quotes:['Our backup is Iris.','Iris has understated feel we like.']}]};
  repairs++;const p=JSON.parse(input).PROBLEMS[0];assert.equal(p.candidate.context.boundaries.length,3);return {repairs:[{index:0,status:'resolved',quote:'Iris has the understated feel we like.'}]};
 });assert.equal(repairs,1);assert.equal(plan.decisions.length,3);
});
test('joint mode is opt in, configuration constrained, and cancellation and original capacity remain enforced',async()=>{
 assert.equal(configFromEnv({}).sourceErasureGrouped,false);assert.throws(()=>configFromEnv({MEMORY_SOURCE_ERASURE_GROUPED:'true'}),/requires/);
 assert.equal(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_SOURCE_ERASURE:'true',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE_GROUPED:'true'}).sourceErasureGrouped,true);
 const work=fixture();work.candidates=Array.from({length:257},()=>work.candidates[0]);assert.throws(()=>groupSourceErasureWork(work),/candidate capacity/);
 const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(()=>executeGroupedSourceErasure(fixture(),3,controller.signal,async()=>{calls++;return {decisions:[mixed()]};}));assert.equal(calls,0);
});

test('shared boundary table losslessly reconstructs every source authorization and its own matching words',()=>{
 const original=fixture();original.candidates.push(...fixture().candidates.map((c:any,i:number)=>({...c,id:'other',matching_words:['word-'+i]})));
 const {work}=groupSourceErasureWork(original),before=structuredClone(work),wire=groupedSourceErasureInput(work);
 assert.equal(wire.SOURCES.length,2);assert.equal(wire.BOUNDARIES.length,3);
 for(const [i,source] of wire.SOURCES.entries()){
  assert.deepEqual(source.boundary_refs.map(r=>({...wire.BOUNDARIES[r.boundary_slot],matching_words:r.matching_words})),(work.candidates[i].context as any).boundaries);
  assert.deepEqual(source.context,(work.candidates[i].context as any).source_context);assert.equal(source.text,work.candidates[i].text);
 }
 assert.deepEqual(work,before);
 original.candidates[3].authorization={source:{quote:'Separate authorization'}};
 assert.equal(groupedSourceErasureInput(groupSourceErasureWork(original).work).BOUNDARIES.length,4);
});
test('every batch carries complete local reference tables including repeated authorizations',()=>{
 const original=fixture();original.candidates=[];for(let i=0;i<70;i++)for(const c of fixture().candidates)original.candidates.push({...c,id:'s'+i});
 const {work}=groupSourceErasureWork(original),batches=sourceErasureBatches(work,groupedSourceErasureInput);assert.equal(batches.length,2);
 for(const batch of batches){const wire=groupedSourceErasureInput(batch);assert.equal(wire.BOUNDARIES.length,3);
  assert.ok(JSON.stringify(wire).length<=64000);for(const [i,s] of wire.SOURCES.entries())assert.deepEqual(s.boundary_refs.map(r=>({...wire.BOUNDARIES[r.boundary_slot],matching_words:r.matching_words})),(batch.candidates[i].context as any).boundaries);
 }
 assert.equal(batches.reduce((n,b)=>n+b.candidates.length,0),70);
});
