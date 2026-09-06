import {test} from 'node:test';import assert from 'node:assert/strict';
import {Models} from '../dist/models.js';import {VerificationSession} from '../dist/verification-session.js';import {configFromEnv} from '../dist/config.js';import {extractionSchema} from '../dist/types.js';
import {Extractor} from '../dist/extraction.js';
const req={request_id:'v',user_id:'u',session_id:'s',messages:[{role:'user',content:'My salary is 85000.',timestamp:'2026-01-01T00:00:00Z'},{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:01Z'}]};
const proposal=()=>extractionSchema.parse({facts:[{content:'My salary is 85000, later corrected to 90000.',subject:'user',predicate:'salary',value:'85000',sources:[{index:0,quote:'My salary is 85000.'}]},{content:'My browser is Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:1,quote:'My browser is Firefox.'}]}],operations:[]});
const check=(index:number,supported=true)=>({index,supported,modality_supported:true,source_index:index,quote:req.messages[index]!.content,reason:supported?'':'The cited source does not support the later correction.'});
const verdict=(pass:boolean)=>({fact_checks:[check(0,pass),check(1)],operation_checks:[],replacement_checks:[],message_checks:[{index:0,disposition:'represented',fact_indices:[0]},{index:1,disposition:'represented',fact_indices:[1]}]});
const session=()=>new VerificationSession();

test('one repaired fact rechecks that fact and its message while preserving full input context',async()=>{
 const state=session(),model=new Models(configFromEnv({}));let calls=0;
 model.json=async(_s,input)=>{const data=JSON.parse(input);calls++;
  if(calls===1)return verdict(false);
  assert.deepEqual(data.CHECK_SCOPE.fact_indices,[0]);assert.deepEqual(data.CHECK_SCOPE.message_indices,[0]);assert.equal(data.NEW_MESSAGES.length,2);assert.equal(data.PROPOSAL.facts.length,2);
  return {fact_checks:[check(0)],operation_checks:[],replacement_checks:[],message_checks:[{index:0,disposition:'represented',fact_indices:[0]}]};
 };
 const p=proposal();assert.equal((await (model.verify as any)(p,req,[],[],AbortSignal.timeout(1000),state)).length,1);
 p.facts[0]!.content='My salary is 85000.';
 assert.deepEqual(await (model.verify as any)(p,req,[],[],AbortSignal.timeout(1000),state),[]);assert.equal(calls,2);
});
test('an unchanged rejected item cannot be passed by resampling the checker',async()=>{
 const state=session(),model=new Models(configFromEnv({}));let calls=0;
 model.json=async()=>{calls++;return verdict(calls>1);};
 const p=proposal();assert.equal((await (model.verify as any)(p,req,[],[],AbortSignal.timeout(1000),state)).length,1);
 assert.equal((await (model.verify as any)(p,req,[],[],AbortSignal.timeout(1000),state)).length,1);assert.equal(calls,1);
});

function success(data:any):any{
 const p=data.PROPOSAL,s=data.CHECK_SCOPE;
 return {
  fact_checks:s.fact_indices.map((index:number)=>({index,supported:true,modality_supported:true,source_index:p.facts[index].sources[0].index,quote:p.facts[index].sources[0].quote})),
  operation_checks:s.operation_indices.map((index:number)=>({index,authorized:true,target_matches:true,source_quote:p.operations[index].source.quote,reason:''})),
  replacement_checks:s.replacements.map((r:any)=>({...r,supported:true,reason:''})),
  message_checks:s.message_indices.map((index:number)=>{const fs=p.facts.flatMap((f:any,i:number)=>f.sources.some((x:any)=>x.index===index)?[i]:[]),os=p.operations.flatMap((o:any,i:number)=>o.source.index===index?[i]:[]);return {index,disposition:fs.length||os.length?'represented':'not_memorable',fact_indices:fs,operation_indices:os};})
 };
}
const verify=(m:Models,p:any,state:VerificationSession,r=req,facts:any[]=[])=>m.verify(p,r,facts,[],AbortSignal.timeout(1000),state);
const oldFact=(id:string,depends_on:string[]=[])=>({...proposal().facts[0],content:'old budget',id,depends_on,supersedes:[],vector:null,source_ids:['source'],source_quotes:['old budget'],state:'active',revision:1});

test('transitive target changes invalidate dependent facts, operations, replacements and coverage',async()=>{
 const state=session(),m=new Models(configFromEnv({})),p=proposal();p.facts[1]!.depends_on=['b'];p.facts[1]!.supersedes=['old'];
 p.operations=extractionSchema.parse({facts:[],operations:[{type:'correct',subject:'user',predicate:'browser',target_ids:['old'],source:{index:1,quote:req.messages[1]!.content}}]}).operations;
 const pool=[oldFact('a'),oldFact('b',['a']),oldFact('old',['b'])];let calls=0;
 m.json=async(_s,input)=>{const d=JSON.parse(input);calls++;if(calls===2){assert.deepEqual(d.CHECK_SCOPE,{fact_indices:[1],operation_indices:[0],replacements:[{fact_index:1,target_id:'old'}],message_indices:[1]});assert.equal(d.TARGET_FACTS.some((f:any)=>f.id==='a'),true);}return success(d);};
 assert.deepEqual(await verify(m,p,state,req,pool),[]);
 pool[0]!.content='changed evidence';assert.deepEqual(await verify(m,p,state,req,pool),[]);assert.equal(calls,2);
 pool[0]!.vector=[1,2] as any;assert.deepEqual(await verify(m,p,state,req,pool),[]);assert.equal(calls,2);
});

test('request, tenant, source and model identity changes cannot reuse certificates',async()=>{
 const state=session(),p=proposal(),config=configFromEnv({}),m=new Models(config);let calls=0;
 m.json=async(_s,input)=>{calls++;const d=JSON.parse(input);assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0,1]);return success(d);};
 for(const r of [req,{...req,request_id:'different'},{...req,user_id:'other'},{...req,session_id:'other'},{...req,messages:req.messages.map(x=>({...x,timestamp:'2026-01-02T00:00:00Z'}))}])assert.deepEqual(await verify(m,p,state,r),[]);
 config.llmModel='another-model';assert.deepEqual(await verify(m,p,state),[]);assert.equal(calls,6);
 const plan=state.plan(req,p,[],{protocol:'v3'});assert.equal(plan.reused,0);
});

test('deletion and index remapping recheck the remaining fact and removed message coverage',async()=>{
 const state=session(),m=new Models(configFromEnv({})),p=proposal();let calls=0;
 m.json=async(_s,input)=>{const d=JSON.parse(input);calls++;const out=success(d);if(calls===2){assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0]);assert.deepEqual(d.CHECK_SCOPE.message_indices,[0,1]);assert.equal(d.PROPOSAL.facts[0].value,'Firefox');out.message_checks[0]={index:0,disposition:'missing',quote:req.messages[0]!.content,reason:'salary was removed'};}return out;};
 assert.deepEqual(await verify(m,p,state),[]);p.facts.shift();assert.match((await verify(m,p,state))[0]!,/message 0:/);assert.equal(calls,2);
});

test('adding a fact invalidates its message coverage even when old facts remain unchanged',async()=>{
 const state=session(),m=new Models(configFromEnv({})),p=proposal();let calls=0;
 m.json=async(_s,input)=>{calls++;const d=JSON.parse(input);if(calls===2){assert.deepEqual(d.CHECK_SCOPE.fact_indices,[2]);assert.deepEqual(d.CHECK_SCOPE.message_indices,[1]);}return success(d);};
 assert.deepEqual(await verify(m,p,state),[]);p.facts.push({...p.facts[1]!,predicate:'preference'});assert.deepEqual(await verify(m,p,state),[]);assert.equal(calls,2);
});

test('malformed checks create no positive certificate; omitted scoped checks cannot be filled by stale results',async()=>{
 const state=session(),m=new Models(configFromEnv({})),p=proposal();let calls=0;
 m.json=async()=>{calls++;const out=verdict(true);out.fact_checks.pop();return out;};
 await assert.rejects(verify(m,p,state),/coverage/);assert.equal(calls,2);
 m.json=async(_s,input)=>{calls++;const d=JSON.parse(input);assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0,1]);return success(d);};
 assert.deepEqual(await verify(m,p,state),[]);p.facts[0]!.content='My salary is 85000.';
 m.json=async()=>({fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[]});await assert.rejects(verify(m,p,state),/coverage/);
});

test('model output cannot replace a cached check or inject a forged certificate',async()=>{
 const state=session(),m=new Models(configFromEnv({})),p=proposal();m.json=async()=>verdict(false);assert.equal((await verify(m,p,state)).length,1);
 p.facts[0]!.content='My salary is 85000.';
 m.json=async()=>({...verdict(true),certificates:[{index:0,passed:true}]});await assert.rejects(verify(m,p,state),/fact verification/);
});

test('missing and cyclic referenced evidence is rejected before model invocation',async()=>{
 const m=new Models(configFromEnv({})),p=proposal();m.json=async()=>{throw Error('must not call model');};p.facts[0]!.depends_on=['a'];
 for(const pool of [[],[oldFact('a',['b']),oldFact('b',['a'])]])assert.match((await verify(m,p,session(),req,pool))[0]!,/missing or cyclic/);
});

test('concurrent misuse of one session cannot certify a stale in-flight request',async()=>{
 const state=session(),m=new Models(configFromEnv({})),p=proposal(),pending:{resolve:(x:any)=>void,data:any}[]=[];
 m.json=async(_s,input)=>new Promise(resolve=>pending.push({resolve,data:JSON.parse(input)}));
 const first=verify(m,p,state),rejection=assert.rejects(first,/in-flight/),second=verify(m,p,state,{...req,user_id:'other'});
 pending[1]!.resolve(success(pending[1]!.data));assert.deepEqual(await second,[]);pending[0]!.resolve(success(pending[0]!.data));await rejection;
});

test('disabling positive reuse retains semantic rejection locks',async()=>{
 const state=new VerificationSession(false),m=new Models(configFromEnv({})),p=proposal();let calls=0;m.json=async()=>{calls++;return verdict(false);};
 assert.equal((await verify(m,p,state)).length,1);assert.equal((await verify(m,p,state)).length,1);assert.equal(calls,1);
 p.facts[0]!.content='My salary is 85000.';m.json=async(_s,input)=>{calls++;const d=JSON.parse(input);assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0,1]);return success(d);};assert.deepEqual(await verify(m,p,state),[]);assert.equal(calls,2);
});

test('Extractor shares a session only within prepare and honors the reuse ablation',async()=>{
 for(const enabled of [true,false]){
  const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_INCREMENTAL_VERIFICATION:String(enabled)}),m=new Models(config);let checks=0,extracts=0;
  m.json=async(system,input)=>{
   if(system.includes('PATCH_SCHEMA'))return {fact_edits:[{index:0,changes:{content:'My salary is 85000.'}}]};
   if(!system.startsWith('Validate memory evidence')){extracts++;return proposal();}
   checks++;const d=JSON.parse(input);if(checks%2===1){assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0,1]);return verdict(false);}
   assert.deepEqual(d.CHECK_SCOPE.fact_indices,enabled?[0]:[0,1]);return success(d);
  };
  m.embedBatch=async texts=>texts.map(()=>Array(768).fill(0));const x=new Extractor(config,m),snapshot={facts:[],tail:[],anchor:null,revision:0};
  for(let i=0;i<2;i++){const out=await x.prepare(req,snapshot,AbortSignal.timeout(1000));assert.equal(out.facts.length,2);assert.equal(out.facts[0]!.content,'My salary is 85000.');}
  assert.equal(extracts,2);assert.equal(checks,4);
 }
});
