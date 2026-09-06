import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Models} from '../dist/models.js';
import {configFromEnv} from '../dist/config.js';
import {extractionSchema} from '../dist/types.js';
import {createHash} from 'node:crypto';import {verificationInput} from '../dist/verification.js';
import {VerificationSession} from '../dist/verification-session.js';
import {indexedProposal} from '../dist/proposal-input.js';
import {applyRepair,scopeForFindings} from '../dist/repair.js';

const req={request_id:'indexed',user_id:'u',session_id:'s',messages:[{role:'user',content:"Cooking is slowly becoming one of my favorite hobbies. It is really relaxing.",timestamp:'2026-01-01T00:00:00Z'}]};
const proposal=()=>extractionSchema.parse({facts:Array.from({length:71},(_,i)=>({content:i===62?'Cooking is slowly becoming a favorite hobby.':'Cooking is really relaxing.',subject:'user',predicate:i===62?'favorite_hobby':'cooking_benefit',value:i===62?'cooking':'relaxing',modality:i===62?'tentative':'confirmed',sources:[{index:0,quote:req.messages[0]!.content}]})),operations:[]});
for(const format of ['verbose','compact'] as const)test(`${format} labels survive a sparse recheck at index 62 without mutating the proposal`,async()=>{
 const model=new Models(configFromEnv({MEMORY_VERIFICATION_FORMAT:format})),state=new VerificationSession(),p=proposal(),before=structuredClone(p);let calls=0;
 model.json=async(_system,input)=>{
  const data=JSON.parse(input),scope=data.CHECK_SCOPE;calls++;
  assert.equal(data.PROPOSAL.facts[62].fact_index,62);assert.equal(data.PROPOSAL.facts[63].fact_index,63);
  assert.equal(data.PROPOSAL.facts[62].predicate,'favorite_hobby');assert.equal(data.PROPOSAL.facts[63].predicate,'cooking_benefit');
  if(calls===2)assert.deepEqual(scope.fact_indices,[62]);
  const checks=scope.fact_indices.map((index:number)=>format==='compact'?[index,true,index!==62||calls===2,0,...(index===62&&calls===1?['Current hobby is confirmed.']:[])]:{index,supported:true,modality_supported:index!==62||calls===2,source_index:0,quote:req.messages[0]!.content,reason:index===62&&calls===1?'Current hobby is confirmed.':''});
  return {fact_checks:checks,operation_checks:[],replacement_checks:[],message_checks:scope.message_indices.map((index:number)=>format==='compact'?[index,'represented',p.facts.map((_,i)=>i),[]]:{index,disposition:'represented',fact_indices:p.facts.map((_,i)=>i)})};
 };
 const issues=await model.verify(p,req,[],[],AbortSignal.timeout(2000),state);assert.match(issues[0]!,/^fact 62:/);assert.deepEqual(p,before);
 const repaired=applyRepair(p,{fact_edits:[{index:62,changes:{modality:'confirmed'}}]},scopeForFindings(p,issues));
 assert.deepEqual(await model.verify(repaired,req,[],[],AbortSignal.timeout(2000),state),[]);assert.equal(calls,2);
 assert.equal('fact_index' in repaired.facts[62]!,false);
});
test('input labels cannot change patch permissions or become editable fact metadata',()=>{
 const p=proposal();p.operations=extractionSchema.parse({facts:[],operations:[{type:'forget',subject:'user',predicate:'hobby',target_ids:[],source:{index:0,quote:req.messages[0]!.content}}]}).operations;
 const input=indexedProposal(p);assert.equal(input.operations[0]!.operation_index,0);assert.equal('operation_index' in p.operations[0]!,false);
 const scope=scopeForFindings(p,['fact 63: reason refers to a neighboring item']);
 assert.deepEqual(scope.fact_indices,[63]);
 assert.throws(()=>applyRepair(p,{fact_edits:[{index:62,changes:{modality:'confirmed'}}]},scope),/unflagged/);
 assert.throws(()=>applyRepair(p,{fact_edits:[{index:63,changes:{fact_index:62}}]},scope));
 assert.throws(()=>applyRepair(p,{operation_edits:[{index:0,changes:{operation_index:9}}]},{fact_indices:[],operation_indices:[0],source_indices:[0]}));
});

test('verification proposal directly links current fact positions to exact deletion targets after an unrelated removal',()=>{
 const request={...req,request_id:'shifted-facts'};
 const id=(i:number)=>createHash('sha256').update(`${request.user_id}\0${request.request_id}\0fact\0${i}`).digest('hex');
 const p=extractionSchema.parse({facts:[
  {content:'Can you suggest a recipe?',subject:'user',predicate:'question',value:'recipe',sources:[{index:0,quote:req.messages[0].content}]},
  {content:'Morgan likes curry.',subject:'Morgan',predicate:'food',value:'curry',sources:[{index:0,quote:req.messages[0].content}]},
  {content:'Morgan likes soup.',subject:'Morgan',predicate:'food',value:'soup',sources:[{index:0,quote:req.messages[0].content}]}
 ],operations:[{type:'forget',target_ids:['new:1'],subject:'Morgan',predicate:'food',source:{index:0,quote:req.messages[0].content}}]});
 const shifted=applyRepair(p,{fact_edits:[{index:0,remove:true}]},{fact_indices:[0],operation_indices:[],source_indices:[0]});
 assert.deepEqual(shifted.operations[0]!.target_ids,['new:0']);
 shifted.operations[0]!.target_ids=[id(0)];
 const before=structuredClone(shifted),rows=verificationInput(request,shifted,[],[]).PROPOSAL.facts;
 assert.equal(rows[0].fact_index,0);assert.equal(rows[0].fact_id,id(0));assert.deepEqual(rows[0].forget_operation_indices,[0]);
 assert.equal(rows[1].fact_id,id(1));assert.deepEqual(rows[1].forget_operation_indices,[],'same subject/property alone cannot count as deletion coverage');
 assert.deepEqual(shifted,before);assert.equal('fact_id' in shifted.facts[0],false);
});
