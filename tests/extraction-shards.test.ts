import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {extractionShards,prepareExtractionShards} from '../dist/extraction-shards.js';
import {decodeGroupedExtraction} from '../dist/extraction-groups.js';import {decodeSourceReferences,sourceReferenceMessages} from '../dist/source-references.js';
import {Extractor,hash} from '../dist/extraction.js';import {configFromEnv} from '../dist/config.js';import {TenantStore} from '../dist/storage.js';
const timestamp='2026-01-01T00:00:00Z';
const request=(texts:string[])=>({user_id:'u',request_id:'shards',session_id:'s',messages:texts.map(content=>({role:'user',content,timestamp}))});
const req=request(['My access code is 9182.','My brother uses the access code 9182.','I use Firefox.','Forget my access code 9182.']);
const env={MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'message_groups',MEMORY_EXTRACTION_WORKERS:'3'};
const input=(r:any)=>JSON.stringify({PARTICIPANT_INDEX:r.messages.map((_:any,i:number)=>i),NEW_MESSAGES:r.messages,EXISTING_FACTS:[{id:'old',value:'context'}]});
const group=(message_index:number)=>({message_index,facts:[],operations:[]});
const empty=(x:any)=>({message_groups:x.PARTICIPANT_INDEX.map(group)});
test('bounded source balancing covers participants once without omitting shared context',async()=>{
 assert.equal(configFromEnv({}).extractionWorkers,1);assert.equal(configFromEnv(env).extractionWorkers,3);
 for(const value of ['0','4','1.5','NaN'])assert.throws(()=>configFromEnv({...env,MEMORY_EXTRACTION_WORKERS:value}));
 for(const override of [{MEMORY_MODE:'offline'},{MEMORY_EXTRACTION_FORMAT:'flat'}])assert.throws(()=>configFromEnv({...env,...override}));
 assert.deepEqual(extractionShards(request([]),3),[]);
 assert.deepEqual(await prepareExtractionShards(request([]),'prompt',input(request([])),3,AbortSignal.timeout(3000),async()=>{throw Error('No participant');}),{message_groups:[]});
 const shards=extractionShards(req,3);assert.equal(shards.length,3);assert.deepEqual(shards.flatMap(s=>s.participants).sort(),[0,1,2,3]);
 let active=0,max=0,release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
 const merged:any=await prepareExtractionShards(req,'prompt',input(req),3,AbortSignal.timeout(3000),async(system,user,_s,meta)=>{
  const x=JSON.parse(user);assert.match(system,/participant-shards-v1/);assert.deepEqual(x.NEW_MESSAGES,req.messages);assert.deepEqual(x.EXISTING_FACTS,[{id:'old',value:'context'}]);assert.deepEqual(x.ALL_PARTICIPANT_INDEX,[0,1,2,3]);assert.deepEqual(x.PARTICIPANT_INDEX,meta.participants);
  active++;max=Math.max(max,active);if(active===3)release();await barrier;active--;return empty(x);
 });assert.equal(max,3);assert.deepEqual(merged.message_groups.map((g:any)=>g.message_index),[0,1,2,3]);assert.deepEqual(decodeGroupedExtraction(merged,req),{facts:[],operations:[]});
});
test('foreign handles, omitted groups and duplicate ownership cannot become a partial merged result',async()=>{
 for(const mode of ['omit','duplicate','foreign','flat','envelope','null_failure'])await assert.rejects(()=>prepareExtractionShards(req,'prompt',input(req),3,AbortSignal.timeout(3000),async(_s,user)=>{
  const x=JSON.parse(user),p=empty(x);if(mode==='null_failure')throw null;
  if(mode==='omit')p.message_groups.pop();if(mode==='duplicate')p.message_groups.push(p.message_groups[0]);
  if(mode==='envelope')return {...p,facts:[]};
  if(mode==='foreign'||mode==='flat'){const foreign=x.ALL_PARTICIPANT_INDEX.find((i:number)=>!x.PARTICIPANT_INDEX.includes(i));p.message_groups[0].operations=[{target_ids:[mode==='flat'?'new:0':`new:${foreign}:0`]}];}
  return p;
 }),/Parallel extraction did not complete/);
 await assert.rejects(()=>prepareExtractionShards(req,'prompt','{"PARTICIPANT_INDEX":[0]}',3,AbortSignal.timeout(3000),async()=>({})),/complete participant roster/);
});
test('first failure cancels siblings and waits for their cleanup before rejection',async()=>{
 let started=0,cleaned=0,release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
 await assert.rejects(()=>prepareExtractionShards(req,'prompt',input(req),3,AbortSignal.timeout(3000),async(_system,_input,signal,meta)=>{
  started++;if(started===3)release();await barrier;
  if(meta.index===0)throw Error('first failure');
  await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
  await new Promise(r=>setImmediate(r));cleaned++;throw Error('cancelled sibling');
 }),/first failure/);assert.equal(started,3);assert.equal(cleaned,2);
});
test('external cancellation and pre-aborted requests cannot publish late successes',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(()=>prepareExtractionShards(req,'prompt',input(req),3,controller.signal,async(_s,user)=>{calls++;if(calls===3)controller.abort();return empty(JSON.parse(user));}));
 assert.equal(calls,3);calls=0;
 await assert.rejects(()=>prepareExtractionShards(req,'prompt',input(req),3,controller.signal,async()=>{calls++;return {};}));assert.equal(calls,0);
});
const proposalGroup=(i:number)=>i===3?{message_index:i,facts:[],operations:[{type:'forget',subject:'user',predicate:'access_code',scope:'door',value:'9182',boundary:'value',target_ids:[],source:{index:i,quote:req.messages[i].content}}]}:{message_index:i,operations:[],facts:[{subject:i===1?'brother':'user',predicate:i===2?'browser':'access_code',scope:i===2?'':'door',value:i===2?'Firefox':'9182',content:req.messages[i].content,sources:[{index:i,quote:req.messages[i].content}]}]};
test('cross-shard selector targets the earlier fact globally, preserves another actor, and commits atomically',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shard-commit-')),store=new TenantStore(dir,'u');let verified=0,checked:any;
 const config=configFromEnv(env),models={json:async(_s:string,user:string,_signal:any,ctx:any)=>{assert.equal(ctx.purpose,'extraction');assert.ok(ctx.extraction_shard);const x=JSON.parse(user);return {message_groups:x.PARTICIPANT_INDEX.map(proposalGroup)};},verify:async(p:any)=>{verified++;checked=structuredClone(p);return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 try{assert.ok(!extractionShards(req,3).some(s=>s.participants.includes(0)&&s.participants.includes(3)));
  const before=store.snapshot('s'),p=await new Extractor(config,models as any).prepare(req,before,AbortSignal.timeout(3000));assert.equal(verified,1);assert.deepEqual(p.degraded,[]);assert.equal(checked.facts.length,3);assert.deepEqual(checked.operations[0].target_ids,[p.facts[0].id]);
  assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),structuredClone(p),0,'indexes'));assert.deepEqual(store.snapshot('s'),before);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);
  store.commit(req,hash(JSON.stringify(req)),p,0);assert.equal(store.revision(),1);const facts=store.facts();assert.ok(facts.some(f=>f.subject==='user'&&f.predicate==='access_code'&&f.state==='erased'));assert.ok(facts.some(f=>f.subject==='brother'&&f.value==='9182'&&f.state==='active'));assert.ok(facts.some(f=>f.value==='Firefox'&&f.state==='active'));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('foreign shard ownership rejects preparation rather than publishing untrusted groups',async()=>{
 let verified=0,embedded=0;
 await assert.rejects(()=>new Extractor(configFromEnv(env),{json:async()=>({message_groups:[group(999)]}),verify:async()=>{verified++;return [];},embedBatch:async()=>{embedded++;return [];}} as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(3000)),/Parallel extraction did not complete/);assert.equal(verified,0);assert.equal(embedded,0);
});
test('merged source references still reject future support and retain earlier cross-shard context',async()=>{
 const user=JSON.stringify({...JSON.parse(input(req)),NEW_MESSAGES:sourceReferenceMessages(req)});
 const merge=async(future:boolean)=>prepareExtractionShards(req,'prompt',user,3,AbortSignal.timeout(3000),async(_s,text)=>{const x=JSON.parse(text);return {message_groups:x.PARTICIPANT_INDEX.map((i:number)=>i===2?{message_index:i,operations:[],facts:[{content:req.messages[2].content,subject:'user',predicate:'browser',value:'Firefox',source_refs:[[2,0],[future?3:0,0]]}]}:group(i))};});
 assert.equal(decodeSourceReferences(await merge(false),req).facts[0].sources.length,2);const future=await merge(true);assert.throws(()=>decodeSourceReferences(future,req),/only earlier human context/);
});
test('semantic repair sees the complete merged proposal and rechecks it globally',async()=>{
 let generations=0,verifications=0,repairs=0,repairPayload:any,repairContext:any;
 const models={json:async(_s:string,user:string,_signal:any,ctx:any)=>{generations++;const x=JSON.parse(user);if(ctx.purpose==='extraction')return empty(x);
  repairs++;repairPayload=x;repairContext=ctx;return {append_facts:[{...proposalGroup(2).facts[0],modality:'confirmed'}]};
 },verify:async()=>++verifications===1?['message 2: browser preference is missing']:[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 const r=request(['What is photosynthesis?','What is gravity?','I use Firefox.','What is a rainbow?']);
 const p=await new Extractor(configFromEnv(env),models as any).prepare(r,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(3000));assert.deepEqual(p.degraded,[]);assert.equal(p.facts.length,1);assert.equal(generations,4);assert.equal(repairs,1);assert.equal(verifications,2);assert.equal(repairContext.extraction_shard,undefined);assert.deepEqual(repairPayload.PARTICIPANT_INDEX,[0,1,2,3]);assert.deepEqual(repairPayload.FAILED_PROPOSAL,{facts:[],operations:[]});assert.equal(repairPayload.EXTRACTION_PROTOCOL,'flat-patch-v1');
});
test('small chunks keep a single extraction call without shard ownership metadata',async()=>{
 let calls=0;const r=request(['What is photosynthesis?','What is gravity?','What is a rainbow?']);
 const p=await new Extractor(configFromEnv(env),{json:async(_s:string,user:string,_signal:any,ctx:any)=>{calls++;assert.equal(ctx.extraction_shard,undefined);const x=JSON.parse(user);assert.equal(x.ALL_PARTICIPANT_INDEX,undefined);return empty(x);},verify:async()=>[],embedBatch:async()=>[]} as any).prepare(r,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(3000));assert.equal(calls,1);assert.deepEqual(p.degraded,[]);
});
test('an operation cannot use selector resolution to delete a future cross-shard fact',async()=>{
 const r=request(['Forget my access code 9182.','What is gravity?','What is a rainbow?','My access code is 9182.']);let verified=0;
 await assert.rejects(()=>new Extractor(configFromEnv(env),{json:async(_s:string,user:string,_signal:any,ctx:any)=>{if(ctx.purpose==='repair')return {};const x=JSON.parse(user);return {message_groups:x.PARTICIPANT_INDEX.map((i:number)=>i===0?{message_index:i,facts:[],operations:[{...proposalGroup(3).operations[0],source:{index:0,quote:r.messages[0].content}}]}:i===3?{message_index:i,operations:[],facts:[{...proposalGroup(0).facts[0],sources:[{index:3,quote:r.messages[3].content}]}]}:group(i))};},verify:async()=>{verified++;return [];}} as any).prepare(r,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(3000)),{code:'OPERATION_TARGET'});assert.equal(verified,0);
});

test('missing array fields survive merge unchanged and still fail the strict grouped decoder',async()=>{
 for(const field of ['facts','operations']){
  const merged:any=await prepareExtractionShards(req,'prompt',input(req),3,AbortSignal.timeout(3000),async(_s,user)=>{const x=JSON.parse(user),p=empty(x);for(const g of p.message_groups)if(g.message_index===3)delete g[field];return p;});
  assert.equal(Object.hasOwn(merged.message_groups[3],field),false);assert.deepEqual(merged.message_groups.map((g:any)=>g.message_index),[0,1,2,3]);assert.throws(()=>decodeGroupedExtraction(merged,req),/schema/);
 }
});
test('a missing operations field reaches bounded repair and still executes the real cross-shard operation atomically',async()=>{
 let extractionCalls=0,repairs=0,verified=0;const original=req;
 const models={json:async(_s:string,user:string,_signal:any,ctx:any)=>{
  const x=JSON.parse(user);if(ctx.purpose==='extraction'){extractionCalls++;return {message_groups:x.PARTICIPANT_INDEX.map((i:number)=>{const g:any=structuredClone(proposalGroup(i));if(i===3)delete g.operations;return g;})};}
  assert.equal(ctx.purpose,'repair');repairs++;assert.equal(ctx.extraction_shard,undefined);assert.deepEqual(x.PARTICIPANT_INDEX,[0,1,2,3]);assert.equal(Object.hasOwn(x.FAILED_PROPOSAL.message_groups[3],'operations'),false);
  assert.deepEqual(x.FAILED_PROPOSAL.message_groups.slice(0,3),[0,1,2].map(proposalGroup));return {message_groups:[0,1,2,3].map(proposalGroup)};
 },verify:async(p:any)=>{verified++;assert.equal(p.operations.length,1);return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 const dir=mkdtempSync(join(tmpdir(),'shard-array-repair-')),store=new TenantStore(dir,'u');
 try{const p=await new Extractor(configFromEnv(env),models as any).prepare(original,store.snapshot('s'),AbortSignal.timeout(3000));assert.equal(extractionCalls,3);assert.equal(repairs,1);assert.equal(verified,1);assert.deepEqual(p.degraded,[]);
  store.commit(original,hash(JSON.stringify(original)),p,0);assert.equal(store.revision(),1);assert.ok(store.facts().some(f=>f.subject==='user'&&f.predicate==='access_code'&&f.state==='erased'));assert.ok(store.facts().some(f=>f.subject==='brother'&&f.value==='9182'&&f.state==='active'));assert.ok(store.facts().some(f=>f.value==='Firefox'&&f.state==='active'));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('a still-malformed global repair cannot publish defaults, skip verification, or exceed the existing repair limit',async()=>{
 let repairs=0,verified=0,embedded=0;const models={json:async(_s:string,user:string,_signal:any,ctx:any)=>{const x=JSON.parse(user);if(ctx.purpose==='repair')repairs++;return {message_groups:x.PARTICIPANT_INDEX.map((i:number)=>{const g:any=group(i);if(i===3)delete g.operations;return g;})};},verify:async()=>{verified++;return [];},embedBatch:async()=>{embedded++;return [];}};
 await assert.rejects(()=>new Extractor(configFromEnv({...env,MEMORY_MAX_REPAIR_ROUNDS:'1'}),models as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(3000)),/bounded repair rounds/);assert.equal(repairs,1);assert.equal(verified,0);assert.equal(embedded,0);
});

test('unknown group fields preserve complete ownership and reach strict decoding without normalization',async()=>{
 const malformed='operations-corrupted-output';
 const merged:any=await prepareExtractionShards(req,'prompt',input(req),3,AbortSignal.timeout(3000),async(_s,user)=>{
  const x=JSON.parse(user);return {message_groups:x.PARTICIPANT_INDEX.map((i:number)=>({...group(i),...(i===3?{[malformed]:[]}: {})}))};
 });
 assert.deepEqual(merged.message_groups.map((g:any)=>g.message_index),[0,1,2,3]);assert.ok(Object.hasOwn(merged.message_groups[3],malformed));assert.throws(()=>decodeGroupedExtraction(merged,req),/schema/);
});
test('a corrupted operations key is repaired globally before verified atomic erasure, never silently renamed',async()=>{
 let repairs=0,verified=0,extractions=0;const malformed='operations-corrupted-output';
 const models={json:async(_s:string,user:string,_signal:any,ctx:any)=>{
  const x=JSON.parse(user);
  if(ctx.purpose==='extraction'){extractions++;return {message_groups:x.PARTICIPANT_INDEX.map((i:number)=>{const g:any=structuredClone(proposalGroup(i));if(i===3){g[malformed]=g.operations;delete g.operations;}return g;})};}
  repairs++;assert.ok(Object.hasOwn(x.FAILED_PROPOSAL.message_groups[3],malformed));assert.equal(Object.hasOwn(x.FAILED_PROPOSAL.message_groups[3],'operations'),false);assert.deepEqual(x.FAILED_PROPOSAL.message_groups.slice(0,3),[0,1,2].map(proposalGroup));return {message_groups:[0,1,2,3].map(proposalGroup)};
 },verify:async(p:any)=>{verified++;assert.equal(p.operations.length,1);return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 const dir=mkdtempSync(join(tmpdir(),'shard-key-repair-')),store=new TenantStore(dir,'u');
 try{
  const p=await new Extractor(configFromEnv(env),models as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(3000));assert.equal(extractions,3);assert.equal(repairs,1);assert.equal(verified,1);
  const before=store.snapshot('s');assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),structuredClone(p),0,'indexes'));assert.deepEqual(store.snapshot('s'),before);
  store.commit(req,hash(JSON.stringify(req)),p,0);assert.ok(store.facts().some(f=>f.subject==='user'&&f.predicate==='access_code'&&f.state==='erased'));assert.ok(store.facts().some(f=>f.subject==='brother'&&f.value==='9182'&&f.state==='active'));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('repeated corrupted keys exhaust the existing repair budget without verification or embedding',async()=>{
 let repairs=0,verified=0,embedded=0;
 const models={json:async(_s:string,user:string,_signal:any,ctx:any)=>{const x=JSON.parse(user);if(ctx.purpose==='repair')repairs++;return {message_groups:x.PARTICIPANT_INDEX.map((i:number)=>({...group(i),...(i===3?{'operations-corrupted-output':[]}: {})}))};},verify:async()=>{verified++;return [];},embedBatch:async()=>{embedded++;return [];}};
 await assert.rejects(()=>new Extractor(configFromEnv({...env,MEMORY_MAX_REPAIR_ROUNDS:'2'}),models as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(3000)),/bounded repair rounds/);assert.equal(repairs,2);assert.equal(verified,0);assert.equal(embedded,0);
});
