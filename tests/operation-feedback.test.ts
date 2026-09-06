import {test} from 'node:test';import assert from 'node:assert/strict';
import {operationBindingProblems} from '../dist/repair.js';import {extractionSchema,operationScopeProblem,operationScopeProblems} from '../dist/types.js';import {Extractor} from '../dist/extraction.js';import {configFromEnv} from '../dist/config.js';
const stamp='2026-01-01T00:00:00Z',req={user_id:'u',request_id:'forget-groups',session_id:'s',messages:[{role:'user',content:'Forget all information about Rowan, including our shared food preferences.',timestamp:stamp}]};
const target=(id:string,subject:string,predicate:string,scope:string,content:string)=>({id,subject,predicate,scope,content,value:content,state:'active',modality:'confirmed',kind:'fact',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:[id+'-source'],source_quotes:[content],created_at:stamp,observed_at:stamp,vector:null,entities:[],revision:1});
const targets=[target('direct-meal','Rowan','meal','cafe','Rowan likes hot curry.'),target('direct-drink','Rowan','drink','home','Rowan drinks tea.'),target('shared','user_and_Rowan','food_comparison','cafe','User and Rowan have different food preferences.'),target('neighbor','Morgan','browser','','Morgan uses Firefox.')];
const operation={type:'forget',subject:'Rowan',predicate:'',scope:'',target_ids:targets.slice(0,3).map(t=>t.id),source:{index:0,quote:req.messages[0].content}};
const proposal=()=>extractionSchema.parse({facts:[],operations:[operation]});
test('subject and scope conflicts are reported together without weakening first-failure guard behavior',()=>{
 const p=proposal(),selected=targets.slice(0,3);
 assert.deepEqual(operationScopeProblems(p.operations[0],selected),['OPERATION_SCOPE','AMBIGUOUS_OPERATION']);assert.equal(operationScopeProblem(p.operations[0],selected),'OPERATION_SCOPE');
 const update={...p.operations[0],type:'update' as const,predicate:'meal'};assert.deepEqual(operationScopeProblems(update,selected),['OPERATION_SCOPE','AMBIGUOUS_OPERATION','OPERATION_TARGET']);assert.equal(operationScopeProblem(update,selected),'OPERATION_SCOPE');
});
test('selected-target groups preserve shared actors, exact aliases and all constraints without nominating neighbors',()=>{
 const p=proposal(),before=structuredClone(p),details=operationBindingProblems(p,targets,id=>({ 'direct-meal':'m0','direct-drink':'m1',shared:'new:0',neighbor:'m3'}[id]!));
 assert.equal(details.length,1);assert.deepEqual(details[0].codes,['OPERATION_SCOPE','AMBIGUOUS_OPERATION']);assert.equal(details[0].code,'OPERATION_SCOPE');assert.deepEqual(details[0].selected_target_groups.map(g=>g.target_ids),[['m0'],['m1'],['new:0']]);assert.equal(details[0].selected_target_groups[2].subject,'user_and_Rowan');assert.doesNotMatch(JSON.stringify(details),/Morgan|Firefox|direct-meal|direct-drink/);assert.deepEqual(p,before);
});
test('one bounded repair receives all groups and preserves the shared record in the globally verified proposal',async()=>{
 let repairs=0,verified=0;
 const models={json:async(system:string,input:string,_s:any,ctx:any)=>{
  const x=JSON.parse(input);if(ctx.purpose==='extraction'){const ids=x.EXISTING_FACTS.filter((f:any)=>f.subject!=='Morgan').map((f:any)=>f.id);return {facts:[],operations:[{...operation,target_ids:ids}]};}
  repairs++;assert.match(system,/selected_target_groups/);const feedback=JSON.parse(x.REPAIR_FEEDBACK.slice(x.REPAIR_FEEDBACK.indexOf('{'),x.REPAIR_FEEDBACK.indexOf('. Reuse matching'))),problem=feedback.operations[0];
  assert.deepEqual(problem.codes,['OPERATION_SCOPE','AMBIGUOUS_OPERATION']);assert.ok(problem.selected_target_groups.some((g:any)=>g.subject==='user_and_Rowan'));assert.equal(problem.selected_targets.length,3);
  return {operation_edits:[{index:0,remove:true}],append_operations:problem.selected_target_groups.map((g:any)=>({type:'forget',subject:g.subject,predicate:g.predicate,scope:g.scope,target_ids:g.target_ids,source:operation.source}))};
 },verify:async(p:any)=>{verified++;assert.deepEqual(new Set(p.operations.flatMap((o:any)=>o.target_ids)),new Set(targets.slice(0,3).map(t=>t.id)));assert.ok(p.operations.some((o:any)=>o.subject==='user_and_Rowan'));return [];},embedBatch:async()=>[]};
 const p=await new Extractor(configFromEnv({MEMORY_MODE:'enhanced'}),models as any).prepare(req,{revision:1,facts:targets,tail:[],anchor:null} as any,AbortSignal.timeout(3000));assert.equal(repairs,1);assert.equal(verified,1);assert.equal(p.operations.length,3);assert.deepEqual(p.degraded,[]);
});
test('unchanged structural failures still exhaust exactly the existing repair budget',async()=>{
 let repairs=0,verified=0;
 const models={json:async(_system:string,input:string,_s:any,ctx:any)=>{const x=JSON.parse(input);if(ctx.purpose==='extraction')return {facts:[],operations:[{...operation,target_ids:x.EXISTING_FACTS.filter((f:any)=>f.subject!=='Morgan').map((f:any)=>f.id)}]};repairs++;return {};},verify:async()=>{verified++;return [];},embedBatch:async()=>{throw Error('No valid proposal');}};
 await assert.rejects(()=>new Extractor(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_MAX_REPAIR_ROUNDS:'2'}),models as any).prepare(req,{revision:1,facts:targets,tail:[],anchor:null} as any,AbortSignal.timeout(3000)),/Unresolved operation subject, property or scope/);assert.equal(repairs,2);assert.equal(verified,0);
});
test('a structurally grouped repair still needs independent semantic authorization',async()=>{
 let repairs=0,verified=0;
 const models={json:async(_system:string,input:string,_s:any,ctx:any)=>{
  const x=JSON.parse(input);if(ctx.purpose==='extraction')return {facts:[],operations:[{...operation,target_ids:x.EXISTING_FACTS.filter((f:any)=>f.subject!=='Morgan').map((f:any)=>f.id)}]};
  repairs++;if(repairs>1)return {};
  const problem=JSON.parse(x.REPAIR_FEEDBACK.slice(x.REPAIR_FEEDBACK.indexOf('{'),x.REPAIR_FEEDBACK.indexOf('. Reuse matching'))).operations[0];
  return {operation_edits:[{index:0,remove:true}],append_operations:problem.selected_target_groups.map((g:any)=>({type:'forget',subject:g.subject,predicate:g.predicate,scope:g.scope,target_ids:g.target_ids,source:operation.source}))};
 },verify:async()=>{verified++;return ['operation 0: The source does not authorize this record.'];},embedBatch:async()=>{throw Error('Rejected proposal must not embed');}};
 await assert.rejects(()=>new Extractor(configFromEnv({MEMORY_MODE:'enhanced'}),models as any).prepare(req,{revision:1,facts:targets,tail:[],anchor:null} as any,AbortSignal.timeout(3000)),/Evidence still fails semantic verification/);assert.equal(repairs,1);assert.equal(verified,1);
});
test('protected scopes remain separate and source edits cannot resolve coordinate conflicts',()=>{
 const p=proposal(),pool=[{...targets[0],scope:'',scopeHash:'one'},{...targets[1],scope:'',scopeHash:'two'}],before=structuredClone(pool);
 const problems=operationBindingProblems(p,pool);assert.deepEqual(problems[0].codes,['AMBIGUOUS_OPERATION']);assert.equal(problems[0].selected_target_groups.length,2);assert.deepEqual(problems[0].selected_target_groups.map(g=>g.scopeHash),['one','two']);assert.deepEqual(pool,before);
 p.operations[0].source.quote='A different source quote';assert.deepEqual(operationBindingProblems(p,pool),problems);
});
