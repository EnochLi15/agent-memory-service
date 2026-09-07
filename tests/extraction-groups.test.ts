import {test} from 'node:test';import assert from 'node:assert/strict';
import {decodeGroupedExtraction} from '../dist/extraction-groups.js';
import {Extractor} from '../dist/extraction.js';import {configFromEnv} from '../dist/config.js';
const req={user_id:'u',request_id:'grouped',session_id:'s',messages:[{role:'user',content:'My salary is 90000.',timestamp:'2026-01-01T00:00:00Z'},{role:'assistant',content:'Understood.',timestamp:'2026-01-01T00:00:01Z'},{role:'user',content:'Forget my salary. I use Firefox.',timestamp:'2026-01-01T00:00:02Z'}]};
const fact=(index:number,quote:string,predicate='salary')=>({content:quote,subject:'user',predicate,value:quote,sources:[{index,quote}]});
const operation={type:'forget',subject:'user',predicate:'salary',target_ids:['new:0:0'],source:{index:2,quote:'Forget my salary.'}};
const groups=()=>({message_groups:[{message_index:2,facts:[fact(2,'I use Firefox.','browser')],operations:[operation]},{message_index:0,facts:[fact(0,'My salary is 90000.')],operations:[]}]});
test('message-local handles flatten chronologically without redirecting targets when groups arrive reordered',()=>{
 const raw=groups(),p=decodeGroupedExtraction(raw,req);assert.deepEqual(p.facts.map(f=>f.sources[0].index),[0,2]);assert.deepEqual(p.operations[0].target_ids,['new:0']);assert.equal(raw.message_groups[0].operations[0].target_ids[0],'new:0:0');
 const dependent=groups();dependent.message_groups[0].facts[0]={...dependent.message_groups[0].facts[0],depends_on:['new:0:0']} as any;
 assert.deepEqual(decodeGroupedExtraction(dependent,req).facts[1].depends_on,['new:0']);
});
test('group coverage cannot omit, duplicate, invent, or silently substitute assistant messages',()=>{
 const valid=groups();for(const raw of [{message_groups:valid.message_groups.slice(0,1)},{message_groups:[valid.message_groups[0],valid.message_groups[0]]},{message_groups:[...valid.message_groups,{message_index:1,facts:[],operations:[]}]},{...valid,facts:[]},{message_groups:[{...valid.message_groups[0],message_index:1},valid.message_groups[1]]}])assert.throws(()=>decodeGroupedExtraction(raw,req));
 assert.throws(()=>configFromEnv({MEMORY_EXTRACTION_FORMAT:'unknown'}));
});
test('group provenance and stable handles cannot borrow other speakers or hide forward evidence',()=>{
 for(const mode of ['fact_source','future_source','operation_source','flat_target','unknown_target']){
  const raw=groups();if(mode==='fact_source')raw.message_groups[0].facts[0].sources=[{index:1,quote:'Understood.'}];
  if(mode==='future_source')raw.message_groups[1].facts[0].sources.push({index:2,quote:'I use Firefox.'});
  if(mode==='operation_source')raw.message_groups[0].operations[0]={...operation,source:{index:0,quote:'My salary is 90000.'}};
  if(mode==='flat_target')raw.message_groups[0].operations[0]={...operation,target_ids:['new:0']};
  if(mode==='unknown_target')raw.message_groups[0].operations[0]={...operation,target_ids:['new:0:99']};
  assert.throws(()=>decodeGroupedExtraction(raw,req),mode);
 }
});
test('empty groups still require independent coverage and repairs use the flattened patch protocol',async()=>{
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'message_groups',MEMORY_MAX_REPAIR_ROUNDS:'2'});let generations=0,verifications=0;
 const r={...req,messages:[req.messages[0]]},snapshot={facts:[],tail:[],anchor:null,revision:0};
 const models={json:async(_system:string,input:string,_signal:AbortSignal,ctx:any)=>{
  generations++;const data=JSON.parse(input);
  if(ctx.purpose==='extraction'){assert.deepEqual(data.PARTICIPANT_INDEX,[0]);return {message_groups:[{message_index:0,facts:[],operations:[]}]};}
  assert.equal(ctx.purpose,'repair');assert.deepEqual(data.FAILED_PROPOSAL,{facts:[],operations:[]});assert.deepEqual(data.REPAIR_SCOPE.source_indices,[0]);return {append_facts:[{...fact(0,'My salary is 90000.'),modality:'confirmed'}]};
 },verify:async(p:any)=>{verifications++;return p.facts.length?[]:['message 0: personal salary is missing'];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 const prepared=await new Extractor(config,models as any).prepare(r,snapshot,AbortSignal.timeout(1000));assert.equal(prepared.facts.length,1);assert.equal(generations,2);assert.equal(verifications,2);assert.deepEqual(prepared.degraded,[]);
});
test('an empty generic knowledge group can remain empty without manufacturing a personal fact',async()=>{
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'message_groups'}),r={...req,messages:[{...req.messages[0],content:'What is photosynthesis?'}]};let verified=0;
 const p=await new Extractor(config,{json:async()=>({message_groups:[{message_index:0,facts:[],operations:[]}]}),verify:async(p:any)=>{verified++;assert.equal(p.facts.length,0);return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any).prepare(r,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000));assert.equal(verified,1);assert.equal(p.facts.length,0);
});
test('repeated grouped protocol omissions reject instead of becoming an offline success',async()=>{
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'message_groups',MEMORY_MAX_REPAIR_ROUNDS:'2'});let calls=0;
 await assert.rejects(()=>new Extractor(config,{json:async()=>{calls++;return {message_groups:[]};},verify:async()=>{throw Error('Invalid traversal must not reach verifier');}} as any).prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000)),/Grouped extraction must cover every participant exactly once/);assert.equal(calls,3);
});
