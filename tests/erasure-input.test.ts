import {test} from 'node:test';import assert from 'node:assert/strict';
import {erasureInput,decodeErasure} from '../dist/erasure.js';
const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:'Forget Rowan’s code.',timestamp:'2026-01-01T00:00:00Z'}]},tail=[{id:'tail',role:'user',content:'Earlier context'}];
const fact={id:'f',content:'Ellis uses 8319.',subject:'Ellis',predicate:'code',value:'8319',source_quotes:['Ellis uses 8319.'],source_ids:['m'],depends_on:[],scope:'work',modality:'confirmed',state:'active'},boundary={subject:'Rowan',predicate:'code',scope:'',valueHash:'hash',tokenCount:1,revision:0},authorization={quote:req.messages[0].content,target:{id:'t',content:'Rowan uses 8319.',source_quotes:['Rowan uses 8319.']}};
const candidate={fact_id:fact.id,fact,boundary,key:'key',scope_matches:false,authorization,context_source_slots:[0]};
const work={fingerprint:'fingerprint',automatic:[],source_contexts:[{id:'m',content:fact.content}],candidates:[candidate,{...candidate,key:'second',boundary:{...boundary,predicate:'old_code'}},{...candidate,fact_id:'g',fact:{...fact,id:'g',subject:'Morgan'}}]};
const restore=(x:any)=>x.CANDIDATES.map(({index,fact_slot,boundary_slot,...pair}:any)=>({...x.FACTS[fact_slot],...x.BOUNDARIES[boundary_slot],...pair}));
test('erasure wire tables round-trip every evidence field and keep each pair identity',()=>{
 const x=erasureInput(req,tail as any,work as any);assert.deepEqual(restore(x),work.candidates);assert.deepEqual(x.CANDIDATES.map(c=>c.index),[0,1,2]);assert.deepEqual(x.NEW_MESSAGES,req.messages);assert.deepEqual(x.CONTEXT_ONLY,tail);assert.deepEqual(x.SOURCE_CONTEXTS,work.source_contexts);assert.equal(x.FACTS.length,2);assert.equal(x.BOUNDARIES.length,2);
 const raw={decisions:work.candidates.map((c,index)=>({index,effect:'erase',quote:c.fact.source_quotes[0],reason:'Same record.'}))};
 assert.deepEqual(decodeErasure(raw,{...work,candidates:restore(x)} as any),decodeErasure(raw,work as any));
});
test('deduplication uses complete records rather than merging same IDs with different evidence',()=>{
 const changed={...candidate,fact:{...fact,source_quotes:['Changed original quote.']},authorization:{...authorization,quote:'Another authorization.'}};
 const x=erasureInput(req,[],{...work,candidates:[candidate,changed]} as any);assert.equal(x.FACTS.length,2);assert.equal(x.BOUNDARIES.length,2);assert.deepEqual(restore(x),[candidate,changed]);
});
test('repeated long records reduce wire size without dropping candidate pairs or linked context',()=>{
 const c={...candidate,fact:{...fact,content:fact.content+' context'.repeat(300)},authorization:{...authorization,target:{...authorization.target,content:'Record context '.repeat(300)}}};
 const w={...work,candidates:Array.from({length:48},(_,i)=>({...c,scope_matches:i%2===0}))};const x=erasureInput(req,[],w as any);assert.equal(x.CANDIDATES.length,48);assert.deepEqual(restore(x),w.candidates);assert.ok(JSON.stringify(x).length<JSON.stringify(w.candidates).length/4);assert.deepEqual(x,erasureInput(req,[],w as any));
});
