import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verificationIssues,humanQuote} from '../dist/verification.js';
import {extractionSchema} from '../dist/types.js';
import {Extractor} from '../dist/extraction.js';
import {Models} from '../dist/models.js';
import {configFromEnv} from '../dist/config.js';

const req={request_id:'verify',user_id:'u',session_id:'s',messages:[{role:'user',content:'[Session time: synthetic ordering only; use dates stated by speakers] My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'}]};
const proposal=extractionSchema.parse({facts:[],operations:[{type:'correct',target_ids:[],subject:'user',predicate:'investment_plan',source:{index:0,quote:'use dates stated by speakers'}}]});
test('machine metadata is not human authorization, even if a model approves it',()=>{
 assert.equal(humanQuote(req,0,'use dates stated by speakers'),false);
 const out={operation_checks:[{index:0,authorized:true,target_matches:true,source_quote:'use dates stated by speakers',reason:'approved'}],replacement_checks:[],message_checks:[{index:0,disposition:'not_memorable',fact_indices:[],operation_indices:[],quote:'',reason:'no durable claim'}]};
 assert.equal(verificationIssues(out,req,proposal).length,1);
});
test('every operation, replacement and participant message needs a distinct verdict',()=>{
 assert.throws(()=>verificationIssues({operation_checks:[],replacement_checks:[],message_checks:[]},req,proposal),/coverage/);
 const out={operation_checks:[{index:0,authorized:false,target_matches:false,source_quote:'',reason:'unrelated'}],replacement_checks:[],message_checks:[{index:0,disposition:'missing',fact_indices:[],operation_indices:[],quote:'My browser is Firefox.',reason:'browser missing'}]};
 assert.equal(verificationIssues(out,req,proposal).length,2);
 out.message_checks[0]!.quote='My browser is Safari.';assert.throws(()=>verificationIssues(out,req,proposal),/grounded/);
});
test('extra assistant acknowledgements cannot substitute for required participant checks',()=>{
 const messages={...req,messages:[...req.messages,{role:'assistant',content:'Okay.',timestamp:'2026-01-01T00:00:01Z'}]};
 const empty=extractionSchema.parse({facts:[],operations:[]});
 const extra={index:1,disposition:'not_memorable',fact_indices:[],operation_indices:[],quote:'',reason:'assistant only'};
 assert.deepEqual(verificationIssues({operation_checks:[],replacement_checks:[],message_checks:[extra,{index:0,disposition:'not_memorable',fact_indices:[],operation_indices:[],quote:'',reason:'no durable claim'}]},messages,empty),[]);
 assert.throws(()=>verificationIssues({operation_checks:[],replacement_checks:[],message_checks:[extra]},messages,empty),/coverage/);
});
test('semantic rejection repairs an otherwise structurally valid proposal; repeated rejection fails before commit',async()=>{
 let calls=0,checks=0;const config=configFromEnv({MEMORY_MODE:'enhanced'});const snapshot={facts:[],tail:[],anchor:null,revision:0};
 const good={content:'My browser is Firefox.',subject:'user',predicate:'default_browser',value:'Firefox',sources:[{index:0,quote:'My browser is Firefox.'}]};
 const x=new Extractor(config,{json:async()=>{calls++;return {facts:calls===1?[]:[good],operations:[]};},verify:async()=>{checks++;return checks===1?['Missing browser setup']:[];},embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 const p=await x.prepare(req,snapshot,AbortSignal.timeout(1000));assert.equal(calls,2);assert.equal(checks,2);assert.equal(p.facts[0]?.value,'Firefox');
 const bad=new Extractor(config,{json:async()=>({facts:[],operations:[]}),verify:async()=>['Missing required information']} as any);
 await assert.rejects(bad.prepare(req,snapshot,AbortSignal.timeout(1000)),/semantic verification/);
});

test('represented personal statement must cite a proposal item sourced to that message',()=>{
 const empty=extractionSchema.parse({facts:[],operations:[]});
 const check={index:0,disposition:'represented',fact_indices:[],operation_indices:[],quote:'My browser is Firefox.',reason:'present'};
 const out={operation_checks:[],replacement_checks:[],message_checks:[check]};
 assert.match(verificationIssues(out,req,empty)[0]!,/reference/);
 const facts=extractionSchema.parse({facts:[{content:'My browser is Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:'My browser is Firefox.'}]}],operations:[]});
 check.fact_indices=[0] as never[];assert.deepEqual(verificationIssues(out,req,facts),[]);
 const other={...req,messages:[...req.messages,{role:'user',content:'I like skiing.',timestamp:'2026-01-01T00:00:01Z'}]};
 out.message_checks.push({...check,index:1});assert.match(verificationIssues(out,other,facts)[0]!,/reference/);
});
test('ambiguous covered protocol is repaired once without rerunning extraction or hiding semantic rejection',async()=>{
 const m=new Models(configFromEnv({}));let calls=0;const empty=extractionSchema.parse({facts:[],operations:[]});
 m.json=async(_system,input,signal)=>{calls++;assert.equal(signal.aborted,false);if(calls===1)return {operation_checks:[],replacement_checks:[],message_checks:[{index:0,covered:true,quote:'',reason:'Personal future intent stated.'}]};
 assert.match(input,/PROTOCOL_REPAIR/);return {operation_checks:[],replacement_checks:[],message_checks:[{index:0,disposition:'missing',fact_indices:[],operation_indices:[],quote:'My browser is Firefox.',reason:'No browser fact proposed'}]};};
 assert.equal((await m.verify(empty,req,[],[],AbortSignal.timeout(1000))).length,1);assert.equal(calls,2);
 calls=0;m.json=async()=>{calls++;return {operation_checks:[],replacement_checks:[],message_checks:[{index:0,covered:false,quote:'',reason:'Generic question only'}]};};
 await assert.rejects(m.verify(empty,req,[],[],AbortSignal.timeout(1000)),/verification/);assert.equal(calls,2);
});

test('a failed repair after semantic rejection cannot escape through offline fallback',async()=>{
 let calls=0;const x=new Extractor(configFromEnv({MEMORY_MODE:'enhanced'}),{json:async()=>{if(++calls===1)return {facts:[],operations:[]};throw new Error('repair transport failure');},verify:async()=>['Missing browser setup'],embedBatch:async()=>{throw Error('fixture embedding unavailable');}} as any);
 await assert.rejects(x.prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000)),/rejected proposal/i);assert.equal(calls,2);
});
