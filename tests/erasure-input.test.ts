import {test} from 'node:test';import assert from 'node:assert/strict';
import {erasureInput,decodeErasure,valueDigest} from '../dist/erasure.js';
const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:'Forget Rowan’s code.',timestamp:'2026-01-01T00:00:00Z'}]},tail=[{id:'tail',role:'user',content:'Earlier context'}];
const fact={id:'f',content:'Ellis uses 8319.',subject:'Ellis',predicate:'code',value:'8319',source_quotes:['Ellis uses 8319.'],source_ids:['m'],depends_on:[],scope:'work',modality:'confirmed',state:'active'},boundary={subject:'Rowan',predicate:'code',scope:'',valueHash:'hash',tokenCount:1,revision:0},authorization={quote:req.messages[0].content,target:{id:'t',content:'Rowan uses 8319.',source_quotes:['Rowan uses 8319.']}};
const candidate={fact_id:fact.id,fact,boundary,key:'key',scope_matches:false,authorization,context_source_slots:[0]};
const work={fingerprint:'fingerprint',automatic:[],source_contexts:[{id:'m',content:fact.content}],candidates:[candidate,{...candidate,key:'second',boundary:{...boundary,predicate:'old_code'}},{...candidate,fact_id:'g',fact:{...fact,id:'g',subject:'Morgan'}}]};
const restore=(x:any)=>x.CANDIDATES.map(({index,fact_slot,boundary_slot,value_witness,...pair}:any)=>({...x.FACTS[fact_slot],...x.BOUNDARIES[boundary_slot],...pair}));
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


test('each pair exposes the decoder’s own value requirement and exact matched literals',()=>{
 const f={...fact,content:'User favors Cafe North.',subject:'user',value:'Cafe North',source_quotes:["It is my favorite."]};
 const c={...candidate,fact:f},restaurant={...boundary,valueHash:valueDigest('Cafe North'),tokenCount:2},role={...boundary,valueHash:valueDigest('user'),tokenCount:1};
 const w={...work,candidates:[{...c,boundary:restaurant},{...c,boundary:role}]},x=erasureInput(req,[],w as any);
 assert.deepEqual(x.CANDIDATES.map(c=>c.value_witness),[{required_for_retain:true,matched_literals:['Cafe North']},{required_for_retain:false,matched_literals:[]}]);
 // These are input hints, never an exemption from runtime witness validation.
 x.CANDIDATES[0].value_witness.required_for_retain=false;
 assert.throws(()=>decodeErasure({decisions:[{index:0,effect:'retain',quote:f.source_quotes[0],reason:'Independent.',value_context:null}]},{...w,candidates:[w.candidates[0]]} as any),/Independent-value witness/);
});
test('protected boundaries expose only a literal already present in current evidence',()=>{
 const f={...fact,content:'The access code is BLUE-FOX; Blue Fox also appears here.',value:'BLUE FOX'};
 const c={...candidate,fact:f,boundary:{...boundary,scope:'',scopeHash:'protected',keyHash:'protected-key',valueHash:valueDigest('blue fox'),tokenCount:2},authorization:null};
 const x=erasureInput(req,[],{...work,candidates:[c]} as any);
 assert.deepEqual(x.CANDIDATES[0].value_witness,{required_for_retain:true,matched_literals:['BLUE-FOX','Blue Fox']});assert.equal(x.BOUNDARIES[0].authorization,null);assert.equal(x.BOUNDARIES[0].boundary.scope,'');
});
test('real quoted or stored user values remain required despite a generated user subject',()=>{
 const b={...boundary,valueHash:valueDigest('user'),tokenCount:1};
 for(const f of [{...fact,content:'User login is user.',subject:'user',value:'user',source_quotes:['The login is user.']},{...fact,content:'User repeated the word user.',subject:'user',value:'repetition',source_quotes:['I repeated the word user.']}]){
  const x=erasureInput(req,[],{...work,candidates:[{...candidate,fact:f,boundary:b}]} as any);assert.equal(x.CANDIDATES[0].value_witness.required_for_retain,true);assert.ok(x.CANDIDATES[0].value_witness.matched_literals.includes('user'));
 }
});
