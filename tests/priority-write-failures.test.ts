import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Extractor} from '../dist/extraction.js';
import {configFromEnv} from '../dist/config.js';
import {ServiceError} from '../dist/types.js';

const snapshot={revision:0,facts:[],tail:[],anchor:null};
const req={user_id:'diagnosis',request_id:'priority-failure',session_id:'s',messages:
 ['I use Firefox.','My brother uses Brave.','My laptop is silver.','My tablet is blue.']
 .map(content=>({role:'user',content,timestamp:'2026-01-01T00:00:00Z'}))};
const config=()=>configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'message_groups',MEMORY_EXTRACTION_WORKERS:'3'});

test('priority missing shard groups falls back with all original messages rather than rejecting the write',async()=>{
 let verified=0;
 const models={json:async()=>({message_groups:[]}),verify:async()=>{verified++;return [];},embedBatch:async()=>[]};
 const result=await new Extractor(config(),models as any).prepare(req,snapshot,AbortSignal.timeout(2000));
 assert.ok(result.degraded.includes('extraction_offline'));
 assert.equal(verified,0);
 assert.equal(result.facts.length,4);
});

test('priority internal shard budget expiry preserves the outer deadline for offline preparation',async()=>{
 let verified=0;
 const models={json:async(_s:string,_u:string,signal:AbortSignal)=>{
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(resolve,1500);
   const abort=()=>{clearTimeout(timer);reject(signal.reason);};
   if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
  throw Error('Expected internal budget expiry');
 },verify:async()=>{verified++;return [];},embedBatch:async()=>[]};
 const outer=AbortSignal.timeout(3000);
 const result=await new Extractor({...config(),addTimeout:25500},models as any).prepare(req,snapshot,outer);
 assert.equal(outer.aborted,false);
 assert.ok(result.degraded.includes('extraction_offline'));
 assert.equal(verified,0);
 assert.equal(result.facts.length,4);
});

test('priority out-of-scope repair is discarded and corrected within the existing remaining repair budget',async()=>{
 let calls=0,verified=0;
 const input={...req,messages:req.messages.slice(0,2)};
 const fact={content:'I use Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:'I use Firefox.'}]};
 let originalScope:any;
 const models={json:async(_s:string,user:string)=>{
  calls++;
  if(calls===1)return {facts:[fact],operations:[]};
  const data=JSON.parse(user);
  if(calls===2){originalScope=data.REPAIR_SCOPE;return {fact_edits:[{index:0,changes:{sources:[{index:1,quote:'My brother uses Brave.'}]}}]};}
  assert.deepEqual(data.REPAIR_SCOPE,originalScope,'a malformed patch cannot widen the allowed scope');
  assert.deepEqual(data.FAILED_PROPOSAL.facts[0].sources,fact.sources,'the rejected patch must not mutate the proposal');
  return {fact_edits:[{index:0,changes:{content:'The user uses Firefox.'}}]};
 },verify:async()=>++verified===1?['fact 0: Make the subject explicit.']:[],embedBatch:async()=>[]};
 const cfg=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_MAX_REPAIR_ROUNDS:'2'});
 const result=await new Extractor(cfg,models as any).prepare(input,snapshot,AbortSignal.timeout(2000));
 assert.equal(calls,3);assert.equal(verified,2);
 assert.ok(!result.degraded.includes('extraction_offline'));
 assert.deepEqual(result.facts[0]!.source_quotes,['I use Firefox.']);
});

test('priority repeated out-of-scope repairs exhaust the bound and still reject unsupported evidence',async()=>{
 let calls=0,verified=0;
 const models={json:async()=>++calls===1?
  {facts:[{content:'I use Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:'I use Firefox.'}]}],operations:[]}:
  {fact_edits:[{index:0,changes:{sources:[{index:1,quote:'My brother uses Brave.'}]}}]},
 verify:async()=>{verified++;return ['fact 0: Unsupported browser.'];},embedBatch:async()=>{throw Error('must not embed rejected evidence');}};
 await assert.rejects(new Extractor(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_MAX_REPAIR_ROUNDS:'2'}),models as any)
  .prepare({...req,messages:req.messages.slice(0,2)},snapshot,AbortSignal.timeout(2000)),/Edited repair fact is outside/);
 assert.equal(calls,3);assert.equal(verified,1);
});

test('priority explicit semantic shard rejection never becomes an offline success',async()=>{
 const models={json:async()=>{throw new ServiceError('EVIDENCE_VALIDATION','unsupported evidence');}};
 await assert.rejects(new Extractor(config(),models as any).prepare(req,snapshot,AbortSignal.timeout(2000)),{code:'EVIDENCE_VALIDATION'});
});

test('priority cancelled request cannot commit a fallback even when a shard is incomplete',async()=>{
 const controller=new AbortController();
 const models={json:async()=>{controller.abort(new Error('caller cancelled'));return {message_groups:[]};}};
 await assert.rejects(new Extractor(config(),models as any).prepare(req,snapshot,controller.signal),/caller cancelled/);
});
