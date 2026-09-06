import {test} from 'node:test';import assert from 'node:assert/strict';
import {verificationIssues} from '../dist/verification.js';
import {scopeForFindings,applyRepair} from '../dist/repair.js';
import {extractionSchema} from '../dist/types.js';
import {Extractor} from '../dist/extraction.js';
import {configFromEnv} from '../dist/config.js';
const req={request_id:'v',user_id:'u',session_id:'s',messages:[{role:'user',content:'I might move to Paris. My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'}]};
const proposal=()=>extractionSchema.parse({facts:[{content:'I live in Paris.',subject:'user',predicate:'city',value:'Paris',modality:'confirmed',sources:[{index:0,quote:'I might move to Paris.'}]},{content:'My browser is Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:'My browser is Firefox.'}]}],operations:[]});
const verdict=()=>({fact_checks:[{index:0,supported:true,modality_supported:true,source_index:0,quote:'I might move to Paris.'},{index:1,supported:true,modality_supported:true,source_index:0,quote:'My browser is Firefox.'}],operation_checks:[],replacement_checks:[],message_checks:[{index:0,disposition:'represented',fact_indices:[0,1]}]});
test('per-fact semantic and modality rejection cannot be hidden by complete message coverage',()=>{
 const raw=verdict();raw.fact_checks[0]!.modality_supported=false;
 assert.match(verificationIssues(raw,req,proposal())[0]!,/^fact 0:/);
 raw.fact_checks[0]!.modality_supported=true;raw.fact_checks[0]!.supported=false;
 assert.match(verificationIssues(raw,req,proposal())[0]!,/^fact 0:/);
});
test('fact verdicts require complete unique coverage and actual declared human evidence',()=>{
 const p=proposal(),raw=verdict();assert.deepEqual(verificationIssues(raw,req,p),[]);
 assert.throws(()=>verificationIssues({...raw,fact_checks:[]},req,p),/coverage/);
 assert.throws(()=>verificationIssues({...raw,fact_checks:[raw.fact_checks[0],raw.fact_checks[0]]},req,p),/fact verification/);
 raw.fact_checks[0]!.quote='My browser is Firefox.';assert.match(verificationIssues(raw,req,p)[0]!,/^fact 0:/);
 raw.fact_checks[0]!.quote='I might move to Paris.';raw.fact_checks[0]!.source_index=4;assert.match(verificationIssues(raw,req,p)[0]!,/^fact 0:/);
});
test('fact-specific repair cannot rewrite another fact sharing the same message',()=>{
 const p=proposal(),scope=scopeForFindings(p,['fact 0: A plan is not current residence']);
 assert.deepEqual(scope.fact_indices,[0]);
 const fixed=applyRepair(p,{fact_edits:[{index:0,changes:{content:'I might move to Paris.',predicate:'move_plan',modality:'tentative'}}]},scope);
 assert.deepEqual(fixed.facts[1],p.facts[1]);
 assert.throws(()=>applyRepair(p,{fact_edits:[{index:1,remove:true}]},scope),/unflagged/);
});
test('extractor repairs a rejected fact and rechecks it without rewriting its grounded neighbor',async()=>{
 let calls=0,checks=0;
 const x=new Extractor(configFromEnv({MEMORY_MODE:'enhanced'}),{
  json:async(system:string,input:string)=>{
   if(++calls===1)return proposal();
   assert.match(system,/PATCH_SCHEMA/);const payload=JSON.parse(input);
   assert.deepEqual(payload.REPAIR_SCOPE.fact_indices,[0]);
   return {fact_edits:[{index:0,changes:{content:'I might move to Paris.',predicate:'move_plan',modality:'tentative'}}]};
  },
  verify:async(p:any)=>{checks++;const raw=verdict();raw.fact_checks[0]!.modality_supported=p.facts[0].modality==='tentative';return verificationIssues(raw,req,p);},
  embedBatch:async()=>{throw Error('fixture lexical');},
 } as any);
 const p=await x.prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000));
 assert.equal(calls,2);assert.equal(checks,2);assert.equal(p.facts[0]!.modality,'tentative');
 assert.equal(p.facts[1]!.value,'Firefox');assert.ok(!p.degraded.includes('extraction_offline'));
});
