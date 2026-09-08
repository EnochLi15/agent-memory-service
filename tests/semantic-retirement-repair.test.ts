import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Extractor} from '../dist/extraction.js';
import {configFromEnv} from '../dist/config.js';
import {extractionSchema,ServiceError} from '../dist/types.js';
import {applyRepair,scopeForFindings,retirementInstructionsAtRisk} from '../dist/repair.js';
import {missingForgetObligations,authorizesForget} from '../dist/operation-intent.js';

// Minimized from the recorded B14 recovery: a semantically rejected operation
// occupies the second retirement witness until the last repair removes it.
const first='Forget that Mara lived in Siena.';
const repeat='Just remove the Siena detail.';
const reason='She asked me not to share that and I feel weird having it stored.';
const text=`${first} ${reason} Keep all her food preferences. ${repeat}`;
const req={request_id:'semantic-repair',user_id:'u',session_id:'s',messages:[{role:'user' as const,content:text,timestamp:'2026-01-01T00:00:00Z'}]};
const op=(predicate:string,value:string,quote:string,target:string)=>({type:'forget' as const,target_ids:[target],subject:'Mara',predicate,scope:'',value,boundary:'value' as const,source:{index:0,quote}});
const snapshot={facts:[
 {id:'residence',content:'Mara lived in Siena.',subject:'Mara',predicate:'former_residence',value:'Siena'},
 {id:'food-memory',content:'Mara remembers a meal in Siena.',subject:'Mara',predicate:'food_memory',value:'meal in Siena'},
 {id:'food-preference',content:'Mara likes the Siena food scene.',subject:'Mara',predicate:'food_preference',value:'Siena food scene'}
].map(f=>({...f,scope:'',kind:'state',cardinality:'single',modality:'confirmed',time_text:'',valid_from:null,valid_to:null,source_ids:[],source_quotes:[],created_at:'',observed_at:'',state:'active',vector:null,entities:[],depends_on:[],supersedes:[],revision:1})),tail:[],anchor:null,revision:1};
const semanticFinding='operation 1: The user explicitly kept food preferences; this deletion exceeds the residence-only instruction.';
const expectedRisk={index:0,start:text.indexOf(' '+repeat),end:text.length,quote:repeat,rejected_operation_indices:[1]};
const config={...configFromEnv({MEMORY_MODE:'enhanced'}),maxRepairRounds:2};

async function run(mode:'recorded-removal'|'correct-target'|'remove-and-append'){
 let repairs=0,verifications=0;const feedback:any[]=[];let finalProposal:any;
 const models={json:async(system:string,input:string,_signal:any,context:any)=>{
  const d=JSON.parse(input);
  if(context.purpose==='extraction'){
   const alias=(id:string)=>d.EXISTING_FACTS.find((f:any)=>f.predicate===id).id;
   return {facts:[],operations:[op('former_residence','Siena',first,alias('former_residence')),op('food_memory','meal in Siena',reason,alias('food_memory')),op('food_preference','Siena food scene',repeat,alias('food_preference'))]};
  }
  assert.equal(context.purpose,'repair');repairs++;feedback.push(d);
  assert.deepEqual(d.REPAIR_SCOPE,{fact_indices:[],operation_indices:[1],source_indices:[0]});
  assert.equal(d.MISSING_OPERATION_INSTRUCTIONS,undefined);
  if(repairs===1){assert.equal(d.AT_RISK_OPERATION_INSTRUCTIONS,undefined);return {operation_edits:[{index:1,remove:true}]};}
  assert.deepEqual(d.AT_RISK_OPERATION_INSTRUCTIONS,[expectedRisk]);
  assert.match(system,/if.*remov|remov.*if/i);
  assert.match(system,/same patch/i);
  if(mode==='recorded-removal')return {operation_edits:[{index:1,remove:true}]};
  const sibling=d.FAILED_PROPOSAL.operations[0];
  const corrected=op('former_residence','Siena',repeat,sibling.target_ids[0]);
  return mode==='correct-target'?{operation_edits:[{index:1,changes:corrected}]}:{operation_edits:[{index:1,remove:true}],append_operations:[corrected]};
 },verify:async(p:any)=>{
  verifications++;
  if(verifications===1)return [semanticFinding];
  finalProposal=structuredClone(p);
  assert.deepEqual(missingForgetObligations(req,p),[]);
  assert.ok(p.operations.every((o:any)=>authorizesForget(o,req)));
  assert.equal(p.operations.length,2);
  assert.ok(p.operations.every((o:any)=>o.target_ids[0]==='residence'));
  // An analyst-authored output proves only that the existing guards permit
  // verification. Do not supply a synthetic passing semantic verdict.
  throw new ServiceError('EVIDENCE_VALIDATION','Fixture stopped before a new semantic verdict');
 },embedBatch:async()=>{throw Error('Embedding must not be reached');}};
 const x=new Extractor(config,models as any);
 await assert.rejects(x.prepare(structuredClone(req),structuredClone(snapshot) as any,AbortSignal.timeout(2000)),(e:any)=>{
  assert.deepEqual(feedback[1]?.AT_RISK_OPERATION_INSTRUCTIONS,[expectedRisk]);
  if(mode==='recorded-removal')return e.code==='OPERATION_INTENT';
  return e.code==='EVIDENCE_VALIDATION'&&e.message==='Fixture stopped before a new semantic verdict';
 });
 assert.equal(repairs,2);assert.equal(verifications,mode==='recorded-removal'?1:2);
 return {feedback,finalProposal};
}

test('last semantic repair sees the exact instruction that removing its rejected operation would uncover',()=>run('recorded-removal'));
test('same scoped final repair can correct its target and reach fresh semantic verification within two rounds',()=>run('correct-target'));
test('same scoped final repair may remove and append with the distinct original witness',()=>run('remove-and-append'));

test('coverage feedback does not relax patch scope, witness separation, or source authorization',()=>{
 const p=extractionSchema.parse({facts:[],operations:[op('former_residence','Siena',first,'residence'),op('food_preference','Siena food scene',repeat,'food-preference')]});
 const scope=scopeForFindings(p,[semanticFinding]);
 assert.throws(()=>applyRepair(p,{operation_edits:[{index:0,remove:true}]},scope),/unflagged operation/);
 assert.throws(()=>applyRepair(p,{append_operations:[{...p.operations[0],source:{index:1,quote:repeat}}]},scope),/outside the affected sources/);
 const duplicated=applyRepair(p,{operation_edits:[{index:1,changes:p.operations[0]}]},scope);
 assert.deepEqual(missingForgetObligations(req,duplicated).map(x=>x.span.quote),[repeat]);
 const unauthorized=op('former_residence','Siena',reason,'residence');
 assert.equal(authorizesForget(unauthorized,req),false);
});

test('conditional feedback uses only explicitly rejected operations and respects both existing scope dimensions',()=>{
 const p=extractionSchema.parse({facts:[],operations:[op('former_residence','Siena',first,'residence'),op('food_preference','Siena food scene',repeat,'food-preference')]});
 const scope=scopeForFindings(p,[semanticFinding]);
 const before=structuredClone(p);
 assert.deepEqual(retirementInstructionsAtRisk(req,p,[semanticFinding],scope),[expectedRisk]);
 assert.deepEqual(retirementInstructionsAtRisk(req,p,['message 0: Some content is missing.'],scope),[]);
 assert.deepEqual(retirementInstructionsAtRisk(req,p,['fact 0: Unsupported fact.'],scope),[]);
 assert.deepEqual(retirementInstructionsAtRisk(req,p,['operation 99: Unknown.'],scope),[]);
 assert.deepEqual(retirementInstructionsAtRisk(req,p,[semanticFinding],{...scope,operation_indices:[]}),[]);
 assert.deepEqual(retirementInstructionsAtRisk(req,p,[semanticFinding],{...scope,source_indices:[]}),[]);
 assert.deepEqual(retirementInstructionsAtRisk(req,p,[semanticFinding],scope,[{message:0,start:expectedRisk.start,end:expectedRisk.end}]),[]);
 assert.deepEqual(p,before,'feedback cannot mutate the model proposal');
});

test('already missing instructions and witnesses still covered by a valid sibling are not conditional losses',()=>{
 const p=extractionSchema.parse({facts:[],operations:[op('former_residence','Siena',first,'residence'),op('food_preference','Siena food scene',repeat,'food-preference')]});
 const scope={fact_indices:[],operation_indices:[0,1,2],source_indices:[0]};
 const alreadyMissing={...p,operations:[p.operations[0]!]};
 assert.deepEqual(retirementInstructionsAtRisk(req,alreadyMissing,[semanticFinding],scope),[]);
 const shared={...p,operations:[...p.operations,p.operations[1]!]};
 assert.deepEqual(retirementInstructionsAtRisk(req,shared,[semanticFinding],scope),[]);
 assert.deepEqual(retirementInstructionsAtRisk(req,shared,[semanticFinding,'operation 2: Unsupported deletion.'],scope),[{...expectedRisk,rejected_operation_indices:[1,2]}]);
 const unauthorized={...p,operations:[p.operations[0]!,op('food_preference','Siena food scene',reason,'food-preference')]};
 assert.deepEqual(retirementInstructionsAtRisk(req,unauthorized,[semanticFinding],scope),[]);
});
