import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Extractor} from '../src/extraction.js';
import {configFromEnv} from '../src/config.js';
import {ServiceError,extractionSchema} from '../src/types.js';
import {applyRepair,RepairScopeError} from '../src/repair.js';

test('scope feedback is bounded without skipping later structural and dangling-reference checks',()=>{
 const base=extractionSchema.parse({facts:[{content:'x',subject:'u',predicate:'p',value:'x',sources:[{index:0,quote:'x'}]}],operations:[]});
 const patch={fact_edits:[{index:0,changes:{sources:Array.from({length:512},()=>({index:1,quote:'x'}))}}]};
 const scope={fact_indices:[0],operation_indices:[],source_indices:[0]};
 const before=structuredClone({base,patch,scope});
 assert.throws(()=>applyRepair(base,patch,scope),(e:any)=>{
  assert.ok(e instanceof RepairScopeError);
  assert.equal(e.code,'EVIDENCE_VALIDATION');
  assert.ok(e.message.length<1200,`scope feedback expanded to ${e.message.length} characters`);
  assert.equal(e.message.match(/source index 1/g)?.length,8);
  assert.match(e.message,/504 additional scope problems omitted/);
  return true;
 });
 const malformed=[
  {...patch,fact_edits:[...patch.fact_edits,{index:0,remove:true}]},
  {...patch,append_operations:[{type:'forget',subject:'u',predicate:'p',source:{index:0,quote:'x'},target_ids:['new:99']}]},
 ];
 for(const raw of malformed){
  const rawBefore=structuredClone(raw);
  assert.throws(()=>applyRepair(base,raw,scope),(e:any)=>e instanceof ServiceError&&!(e instanceof RepairScopeError));
  assert.deepEqual(raw,rawBefore);
 }
 assert.deepEqual({base,patch,scope},before);
});

test('semantic findings and exact risk indexes survive a wholly rejected scope patch within the existing budget',async()=>{
 const first='Forget that Mara lived in Siena.',repeat='Just remove the Siena detail.';
 const text=first+' Keep all her food preferences. '+repeat;
 const req={request_id:'scope-semantic-interaction',user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-01-01T00:00:00Z'}]};
 const snapshot={facts:[
  {id:'residence',content:'Mara lived in Siena.',subject:'Mara',predicate:'former_residence',value:'Siena'},
  {id:'food',content:'Mara likes the Siena food scene.',subject:'Mara',predicate:'food_preference',value:'Siena food scene'},
 ].map(f=>({...f,scope:'',kind:'fact',cardinality:'single',modality:'confirmed',time_text:'',valid_from:null,valid_to:null,source_ids:[],source_quotes:[],created_at:'',observed_at:'',state:'active',vector:null,entities:[],depends_on:[],supersedes:[],revision:1})),tail:[],anchor:null,revision:1};
 const before=structuredClone({req,snapshot});let calls=0,verifications=0;const inputs:any[]=[],systems:string[]=[];
 const op=(predicate:string,value:string,quote:string,id:string)=>({type:'forget',target_ids:[id],subject:'Mara',predicate,scope:'',value,boundary:'value',source:{index:0,quote}});
 const models={json:async(system:string,input:string)=>{
  calls++;const d=JSON.parse(input);inputs.push(d);systems.push(system);
  if(calls===1){const id=(p:string)=>d.EXISTING_FACTS.find((f:any)=>f.predicate===p).id;return {facts:[],operations:[op('former_residence','Siena',first,id('former_residence')),op('food_preference','Siena food scene',repeat,id('food_preference'))]};}
  assert.deepEqual(d.REPAIR_SCOPE,{fact_indices:[],operation_indices:[1],source_indices:[0]});
  assert.equal(d.MISSING_OPERATION_INSTRUCTIONS,undefined);
  assert.equal(d.AT_RISK_OPERATION_INSTRUCTIONS[0].quote,repeat);
  assert.deepEqual(d.AT_RISK_OPERATION_INSTRUCTIONS[0].rejected_operation_indices,[1]);
  if(calls===2)return {operation_edits:[{index:0,remove:true},{index:1,changes:{reason:'this permitted edit must also be discarded'}}]};
  assert.equal(calls,3,'scope rejection cannot extend the configured repair budget');
  assert.deepEqual(d.REPAIR_SCOPE,inputs[1].REPAIR_SCOPE);
  assert.deepEqual(d.FAILED_PROPOSAL,inputs[1].FAILED_PROPOSAL,'the rejected removal cannot shift later operation indexes');
  assert.deepEqual(d.AT_RISK_OPERATION_INSTRUCTIONS,inputs[1].AT_RISK_OPERATION_INSTRUCTIONS);
  assert.equal(system,systems[1]);
  assert.match(d.REPAIR_FEEDBACK,/unflagged operation index 0/);
  return {operation_edits:[{index:1,changes:op('former_residence','Siena',repeat,d.FAILED_PROPOSAL.operations[0].target_ids[0])}]};
 },verify:async()=>{
  verifications++;
  if(verifications===1)return ['operation 1: The user retained food preferences.'];
  // This analyst-authored patch only proves routing. Do not invent a passing
  // semantic verdict or let it reach embeddings/commit.
  throw new ServiceError('EVIDENCE_VALIDATION','Stop at unknown semantic verdict');
 },embedBatch:async()=>assert.fail('No embedding allowed')};
 const x=new Extractor({...configFromEnv({MEMORY_MODE:'enhanced'}),maxRepairRounds:2},models as any);
 await assert.rejects(x.prepare(req,snapshot as any,AbortSignal.timeout(3000)),(e:any)=>e.code==='EVIDENCE_VALIDATION'&&e.message==='Stop at unknown semantic verdict');
 assert.equal(calls,3);assert.equal(verifications,2);assert.deepEqual({req,snapshot},before);
});
