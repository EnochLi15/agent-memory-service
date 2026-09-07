import {test} from 'node:test';import assert from 'node:assert/strict';
import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';import {extractionSchema} from '../dist/types.js';import {VerificationSession} from '../dist/verification-session.js';
const req={user_id:'u',request_id:'repair',session_id:'s',messages:[{role:'user',content:'My manager is Clara.',timestamp:'2026-01-01T00:00:00Z'},{role:'user',content:'I live in Portland.',timestamp:'2026-01-01T00:00:00Z'}]};
const proposal=()=>extractionSchema.parse({facts:req.messages.map((m,i)=>({subject:'user',predicate:i?'city':'manager',value:i?'Portland':'Clara',content:m.content,sources:[{index:i,quote:m.content}]})),operations:[]});
const full=()=>({fact_checks:[[0,true,true,0],[1,true,true,0]],operation_checks:[],replacement_checks:[],message_checks:[[0,'represented',[0],[]],[1,'represented',[1],[]]]});
const model=()=>new Models(configFromEnv({MEMORY_VERIFICATION_FORMAT:'compact'}));
const run=(m:Models,session=new VerificationSession(),signal=AbortSignal.timeout(2000))=>m.verify(proposal(),req,[],[],signal,session);
const input=(s:string)=>JSON.parse(s.split('\nPROTOCOL_REPAIR:')[0]!);

test('malformed message only requests that message and keeps validated sibling checks',async()=>{
 const m=model();let calls=0;m.json=async(_s,text)=>{
  calls++;const d=input(text);
  if(calls===1)return {...full(),message_checks:[[0,'represented',[0],[]],[1,'represented',[1],[],'bad slot']]};
  assert.deepEqual(d.CHECK_SCOPE,{fact_indices:[],operation_indices:[],replacements:[],message_indices:[1]});
  assert.match(text,/message_checks\[1\]/);
  return {fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[[1,'represented',[1],[]]]};
 };assert.deepEqual(await run(m),[]);assert.equal(calls,2);
});
test('duplicate checks and malformed siblings sharing an ID cannot supply a reusable pass',async()=>{
 const m=model();let calls=0;m.json=async(_s,text)=>{
  calls++;if(calls===1)return {...full(),fact_checks:[[0,true,true,0],[0,true,true,999],[1,true,true,0]]};
  assert.deepEqual(input(text).CHECK_SCOPE.fact_indices,[0]);assert.deepEqual(input(text).CHECK_SCOPE.message_indices,[]);
  return {fact_checks:[[0,true,true,0]],operation_checks:[],replacement_checks:[],message_checks:[]};
 };assert.deepEqual(await run(m),[]);assert.equal(calls,2);
});
test('a second response cannot replace an already validated check',async()=>{
 const m=model();let calls=0;m.json=async()=>{calls++;return calls===1?{...full(),message_checks:full().message_checks.slice(0,1)}:full();};
 await assert.rejects(run(m));assert.equal(calls,2);
});
test('new semantic rejection during targeted repair is retained without resampling',async()=>{
 const m=model(),state=new VerificationSession();let calls=0;m.json=async()=>{
  calls++;return calls===1?{...full(),message_checks:full().message_checks.slice(0,1)}:{fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[[1,'missing',req.messages[1]!.content,'City is omitted']]};
 };const findings=await run(m,state);assert.ok(findings.some(f=>f.startsWith('message 1:')));assert.equal(calls,2);
 m.json=async()=>{calls++;return full();};assert.deepEqual(await run(m,state),findings);assert.equal(calls,2);
});
test('exhausted repair keeps partial successes out of later verification certificates',async()=>{
 const m=model(),state=new VerificationSession();let calls=0;m.json=async()=>{calls++;return {...full(),message_checks:full().message_checks.slice(0,1)};};
 await assert.rejects(run(m,state));assert.equal(calls,2);
 m.json=async(_s,text)=>{calls++;assert.deepEqual(input(text).CHECK_SCOPE.fact_indices,[0,1]);assert.deepEqual(input(text).CHECK_SCOPE.message_indices,[0,1]);return full();};
 assert.deepEqual(await run(m,state),[]);assert.equal(calls,3);
});
test('deadline exhaustion prevents an additional protocol request',async()=>{
 const m=model(),controller=new AbortController();let calls=0;m.json=async()=>{calls++;controller.abort(new DOMException('deadline','TimeoutError'));return {...full(),message_checks:[]};};
 await assert.rejects(run(m,new VerificationSession(),controller.signal));assert.equal(calls,1);
});
test('named recovery only asks for the missing named message',async()=>{
 const m=new Models(configFromEnv({MEMORY_VERIFICATION_FORMAT:'named'}));let calls=0;
 const message=(n:number)=>({message_id:`msg:${n}`,verdict:'represented',fact_ids:[`fact:${n}`],operation_ids:[],passage_ids:[],quote:null,reason:null});
 m.json=async(_s,text)=>{calls++;if(calls===1)return {fact_checks:[0,1].map(n=>({fact_id:`fact:${n}`,supported:true,modality_supported:true,source_id:`fact:${n}/source:0`,reason:null})),operation_checks:[],replacement_checks:[],message_checks:[message(0)]};
  assert.deepEqual(input(text).CHECK_SCOPE,{fact_ids:[],operation_ids:[],replacement_ids:[],message_ids:['msg:1']});
  return {fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[message(1)]};
 };assert.deepEqual(await run(m),[]);assert.equal(calls,2);
});

test('a missing verbose array cannot hide an explicit negative in another array',async()=>{
 const m=new Models(configFromEnv({MEMORY_VERIFICATION_FORMAT:'verbose'})),state=new VerificationSession();let calls=0;
 m.json=async()=>{calls++;return {fact_checks:[{index:0,supported:false,modality_supported:true,source_index:0,quote:req.messages[0]!.content,reason:'Unsupported claim'}],operation_checks:[],message_checks:[]};};
 const findings=await run(m,state);assert.ok(findings.some(f=>f.startsWith('fact 0:')));assert.equal(calls,1);
 assert.deepEqual(await run(m,state),findings);assert.equal(calls,1);
});

test('targeted replacement checks use the new sparse ordinal without changing target identity',async()=>{
 const p=proposal();p.facts[0]!.supersedes=['a','b'];
 const facts=['a','b'].map(id=>({...p.facts[0]!,id,supersedes:[],state:'active',vector:null}));
 const m=model();let calls=0;m.json=async(_s,text)=>{
  calls++;if(calls===1)return {...full(),replacement_checks:[[0,true]]};
  assert.deepEqual(input(text).CHECK_SCOPE,{fact_indices:[],operation_indices:[],replacements:[{fact_index:0,target_id:'b'}],message_indices:[]});
  assert.deepEqual(input(text).REPLACEMENT_TARGETS,[{fact_index:0,target_id:'b',check_index:0}]);
  return {fact_checks:[],operation_checks:[],replacement_checks:[[0,true]],message_checks:[]};
 };assert.deepEqual(await m.verify(p,req,facts as any,[],AbortSignal.timeout(2000)),[]);assert.equal(calls,2);
});
