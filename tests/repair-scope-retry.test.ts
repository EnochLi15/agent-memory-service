import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyRepair,RepairScopeError} from '../src/repair.js';
import {extractionSchema,ServiceError} from '../src/types.js';
import {Extractor} from '../src/extraction.js';
import {configFromEnv} from '../src/config.js';

const fact=(value:string,index:number)=>({content:value,subject:'user',predicate:value,value,sources:[{index,quote:value}]});
const original=()=>extractionSchema.parse({facts:[fact('bike',0),fact('badge',1)],operations:[{type:'forget',target_ids:['new:0'],subject:'user',predicate:'bike',source:{index:2,quote:'Forget my bike.'}}]});
const scope={fact_indices:[1],operation_indices:[],source_indices:[1]};
const isScope=(error:unknown)=>error instanceof RepairScopeError&&error.code==='EVIDENCE_VALIDATION';
const terminal=(error:unknown)=>error instanceof ServiceError&&!(error instanceof RepairScopeError);
const cases:[string,unknown,RegExp][]=[
 ['unflagged fact',{fact_edits:[{index:0,changes:{value:'changed'}}]},/unflagged fact.*0/],
 ['unflagged operation',{operation_edits:[{index:0,changes:{reason:'changed'}}]},/unflagged operation.*0/],
 ['edited fact source',{fact_edits:[{index:1,changes:{sources:[{index:0,quote:'bike'}]}}]},/fact.*1.*source.*0/],
 ['appended fact source',{append_facts:[{...fact('bike',0),modality:'confirmed'}]},/fact.*source.*0/],
 ['appended operation source',{append_operations:[{type:'forget',subject:'user',predicate:'bike',source:{index:2,quote:'Forget my bike.'}}]},/operation.*source.*2/],
];
for(const [name,patch,message] of cases)test(`a structurally valid ${name} scope violation stays rejected with exact feedback`,()=>{
 const base=original(),before=structuredClone(base),patchBefore=structuredClone(patch);
 assert.throws(()=>applyRepair(base,patch,scope),e=>isScope(e)&&message.test((e as Error).message));
 assert.deepEqual(base,before);assert.deepEqual(patch,patchBefore);
});
test('an edited operation source outside both original and permitted sources has typed scope feedback',()=>{
 const base=original(),before=structuredClone(base);
 assert.throws(()=>applyRepair(base,{operation_edits:[{index:0,changes:{source:{index:0,quote:'bike'}}}]},{fact_indices:[],operation_indices:[0],source_indices:[2]}),e=>isScope(e)&&/operation.*0.*source.*0/.test((e as Error).message));
 assert.deepEqual(base,before);
});

test('unavailable indexes, duplicate edits and dangling references are terminal even with a scope violation',()=>{
 const unflagged={index:0,changes:{reason:'outside scope'}};
 const patches=[
  {fact_edits:[{index:99,remove:true}]},
  {operation_edits:[{index:99,remove:true}]},
  {fact_edits:[{changes:{value:'missing index'}}]},
  {operation_edits:[unflagged,unflagged]},
  {fact_edits:[{index:0,changes:{value:'x'}},{index:0,changes:{value:'y'}}]},
  {operation_edits:[unflagged],fact_edits:[{index:1,changes:{depends_on:['new:99']}}]},
  {operation_edits:[unflagged],fact_edits:[{index:0,remove:true}]},
 ];
 for(const patch of patches){const base=original(),before=structuredClone(base);assert.throws(()=>applyRepair(base,patch,scope),terminal);assert.deepEqual(base,before);}
});

test('repair can keep an edited item on its original source without widening scope',()=>{
 const base=original();
 const p=applyRepair(base,{operation_edits:[{index:0,changes:{reason:'localized'}}]},{fact_indices:[],operation_indices:[0],source_indices:[]});
 assert.deepEqual(p.operations[0]!.source,base.operations[0]!.source);
});

const messages=['My retired bike code is BLUE-21.','My office badge is GREEN-73.','Forget my retired bike code.'].map(content=>({role:'user',content,timestamp:'2026-01-01T00:00:00Z'}));
const req={request_id:'local',user_id:'u',session_id:'s',messages};
const badProposal={facts:[{content:messages[0]!.content,subject:'user',predicate:'bike_code',value:'BLUE-21',sources:[{index:0,quote:messages[0]!.content}]},{content:messages[1]!.content,subject:'user',predicate:'badge_code',value:'GREEN-73',sources:[{index:1,quote:messages[1]!.content}],supersedes:['new:0']}],operations:[{type:'forget',target_ids:['new:0'],subject:'user',predicate:'bike_code',value:'BLUE-21',source:{index:2,quote:messages[2]!.content}}]};
const badPatch={fact_edits:[{index:1,changes:{supersedes:[]}}],operation_edits:[{index:0,changes:{reason:'unrelated modification'}}]};
const goodPatch={fact_edits:[{index:1,changes:{supersedes:[]}}]};
async function bindingFixture(budget:1|2,secondPatch:unknown,thirdPatch:unknown,expectedCalls:number,expectedVerifier:number){
 const snapshot={revision:0,facts:[],tail:[],anchor:null},before=structuredClone(snapshot),request=structuredClone(req),requestBefore=structuredClone(request);
 const calls:{purpose:string;input:any}[]=[];let verified=0;
 const x=new Extractor({...configFromEnv({MEMORY_MODE:'enhanced'}),maxRepairRounds:budget},{json:async(_system:string,input:string,_signal:any,ctx:any)=>{
  calls.push({purpose:ctx.purpose,input:JSON.parse(input)});
  if(calls.length===1)return structuredClone(badProposal);
  if(calls.length===2)return structuredClone(secondPatch);
  assert.equal(calls.length,3,'never exceed extraction plus the configured repair budget');
  assert.deepEqual(calls[2]!.input.REPAIR_SCOPE,calls[1]!.input.REPAIR_SCOPE);
  assert.deepEqual(calls[2]!.input.FAILED_PROPOSAL,calls[1]!.input.FAILED_PROPOSAL,'discard the entire invalid patch, including valid preceding edits');
  assert.match(calls[2]!.input.REPAIR_FEEDBACK,/Patch rejected:.*unflagged operation.*0/);
  assert.deepEqual(calls[2]!.input.REPAIR_SCOPE.operation_indices,[]);
  return structuredClone(thirdPatch);
 },verify:async()=>{verified++;throw new ServiceError('EVIDENCE_VALIDATION','Fixture stops at unknown semantic verdict');},embedBatch:async()=>assert.fail('No model embeddings or write allowed in this fixture')} as any);
 await assert.rejects(x.prepare(request,snapshot,AbortSignal.timeout(3000)),(e:any)=>expectedVerifier?e.code==='EVIDENCE_VALIDATION'&&e.message==='Fixture stops at unknown semantic verdict':e.code==='OPERATION_TARGET');
 assert.equal(calls.length,expectedCalls);assert.equal(verified,expectedVerifier);assert.deepEqual(snapshot,before);assert.deepEqual(request,requestBefore);
 return calls;
}
test('binding repair uses only the remaining budget to report an exact scope violation',()=>bindingFixture(2,badPatch,goodPatch,3,1));
test('the same out-of-scope patch remains terminal after the last allowed repair',()=>bindingFixture(1,badPatch,goodPatch,2,0));
test('repeating the out-of-scope patch cannot increase the repair budget',()=>bindingFixture(2,badPatch,badPatch,3,0));
test('a structurally invalid edit does not become a retryable scope error',()=>bindingFixture(2,{operation_edits:[{index:999,remove:true}]},goodPatch,2,0));
