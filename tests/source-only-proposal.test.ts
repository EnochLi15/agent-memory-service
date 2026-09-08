import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../src/extraction.js';
import {Models} from '../src/models.js';
import {TenantStore} from '../src/storage.js';
import {configFromEnv} from '../src/config.js';
import {ServiceError,extractionSchema} from '../src/types.js';
import {VerificationSession} from '../src/verification-session.js';
import {uniqueSourceOnlyProposal} from '../src/repair.js';

const old='My access code is ZX-123.',neighbor='My browser is Firefox.',reason='The old code issue is resolved.',command='No need to worry about tracking my access code anymore.';
const config=()=>({...configFromEnv({MEMORY_MODE:'enhanced',MEMORY_VERIFICATION_FORMAT:'compact'}),maxRepairRounds:0 as any});
const request=(text=`${old} ${neighbor} ${reason} ${command}`)=>({request_id:'source-only',user_id:'u',session_id:'s',messages:[{role:'user',content:text}]});
const proposal=(source=reason)=>({facts:[{content:old,subject:'user',predicate:'access_code',value:'ZX-123',sources:[{index:0,quote:old}]},{content:neighbor,subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:neighbor}]}],operations:[{type:'forget',target_ids:['new:0'],subject:'user',predicate:'access_code',scope:'',value:'ZX-123',boundary:'value',source:{index:0,quote:source}}]});
function positive(d:any){return {fact_checks:d.CHECK_SCOPE.fact_indices.map((i:number)=>[i,true,true,0,null]),operation_checks:d.CHECK_SCOPE.operation_indices.map((i:number)=>[i,true,true,null]),replacement_checks:[],message_checks:d.CHECK_SCOPE.message_indices.map((i:number)=>[i,'represented',[0,1],[0]])};}

test('a unique source-only proposal reaches standard verification on the last allowed attempt and commits only after acceptance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-only-')),store=new TenantStore(dir,'u'),req=request(),models=new Models(config());let checks=0,calls=0;
 models.json=async(_s,input,_signal,context)=>{
  calls++;if(context?.purpose==='extraction')return proposal();assert.equal(context?.purpose,'verification');checks++;
  const d=JSON.parse(input);assert.equal(d.PROPOSAL.operations[0].source.quote,command);assert.equal(d.PROPOSAL.operations[0].source.start,undefined);
  assert.equal(d.PROPOSAL.operations[0].predicate,'access_code');assert.deepEqual(d.CHECK_SCOPE.operation_indices,[0]);
  return positive(d); // Authored generic fixture, never a recorded B30 verdict.
 };
 models.embedBatch=async texts=>texts.map(()=>[1,0]);
 try{
  const prepared=await new Extractor(config(),models).prepare(req,store.snapshot('s'),AbortSignal.timeout(2000));
  assert.equal(checks,1);assert.equal(calls,2);assert.deepEqual(prepared.degraded,[]);
  store.commit(req,hash(JSON.stringify(req)),prepared,0);
  assert.equal(store.facts().find(f=>f.predicate==='access_code')?.state,'erased');
  assert.equal(store.facts().find(f=>f.predicate==='browser')?.state,'active');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

for(const failure of ['semantic','unavailable','network','malformed','embedding'])test(`source-only ${failure} failure cannot produce a degraded prepared write`,async()=>{
 const req=request(),models=new Models(config());let checks=0,embeddings=0;
 models.json=async(_s,input,_signal,context)=>{
  if(context?.purpose==='extraction')return proposal();assert.equal(context?.purpose,'verification');checks++;
  if(failure==='unavailable')throw new ServiceError('VERIFICATION_UNAVAILABLE','Unavailable fixture');
  if(failure==='network')throw Error('Network fixture');
  if(failure==='malformed')return {};
  const d=JSON.parse(input),out=positive(d);if(failure==='semantic')out.operation_checks=[[0,false,false,'The instruction does not authorize this target.']];return out;
 };
 models.embedBatch=async()=>{embeddings++;throw Error('Embedding fixture');};
 await assert.rejects(new Extractor(config(),models).prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(2000)),(e:any)=>e.code==='EVIDENCE_VALIDATION');
 assert.ok(checks>0);assert.equal(embeddings,failure==='embedding'?1:0);
});

for(const blocked of ['multiple','duplicate-quote','source-duplicate','source-missing','chronology','lifecycle','custom-verifier'])test(`${blocked} retains the original source-repair path`,async()=>{
 let text=`${old} ${neighbor} ${reason} ${command}`;const p=proposal();const cfg=config();
 if(blocked==='multiple')text+=' Forget my browser.';
 if(blocked==='duplicate-quote')text=`"${command}" ${text}`;
 if(blocked==='source-duplicate')text=reason+' '+text;
 if(blocked==='source-missing')p.operations[0]!.source.quote='A nonexistent reason.';
 if(blocked==='chronology')text=`${command} ${old} ${neighbor} ${reason}`;
 if(blocked==='lifecycle')cfg.experimental.lifecycle=false;
 const models=new Models(cfg);let checks=0;
 models.json=async(_s,_input,_signal,context)=>{assert.equal(context?.purpose,'extraction');return p;};
 if(blocked==='custom-verifier')models.verify=async()=>{checks++;return [];};
 else {const original=models.json;models.json=async(...args)=>{if(args[3]?.purpose==='verification')checks++;return original(...args);};}
 models.embedBatch=async()=>assert.fail('No unverified proposal may reach embedding');
 await assert.rejects(new Extractor(cfg,models).prepare(request(text),{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(2000)));
 assert.equal(checks,0);
});

test('a later fact repair sees the actual source-only proposal rather than its stale citation',async()=>{
 const cfg={...config(),maxRepairRounds:1 as any},models=new Models(cfg);let checks=0,repairs=0;
 models.json=async(_s,input,_signal,context)=>{
  const d=JSON.parse(input);if(context?.purpose==='extraction')return proposal();
  if(context?.purpose==='repair'){
   repairs++;assert.equal(d.FAILED_PROPOSAL.operations[0].source.quote,command);
   assert.deepEqual(d.REPAIR_SCOPE.operation_indices,[]);
   return {fact_edits:[{index:1,changes:{content:'My browser preference is Firefox.'}}]};
  }
  assert.equal(context?.purpose,'verification');checks++;
  if(checks===1){const out=positive(d);out.fact_checks[1]=[1,false,true,0,'Fixture requests a narrower browser description.'];return out;}
  assert.equal(d.PROPOSAL.operations[0].source.quote,command);
  throw new ServiceError('EVIDENCE_VALIDATION','Stop before an unseen second semantic verdict');
 };
 await assert.rejects(new Extractor(cfg,models).prepare(request(),{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(2000)),/Stop before an unseen/);
 assert.equal(repairs,1);assert.equal(checks,2);
});

test('source-only proposals discard old offsets and require explicit targets without changing the input',()=>{
 const req=request(),p=extractionSchema.parse(proposal());p.operations[0]!.target_ids=['old'];
 (p.operations[0]!.source as any).start=req.messages[0]!.content.indexOf(reason);
 const before=structuredClone(p),scope={fact_indices:[],operation_indices:[0],source_indices:[0]};
 const result=uniqueSourceOnlyProposal(req,p,scope)!;
 assert.deepEqual(result.candidate.operations[0]!.source,{index:0,quote:command});assert.deepEqual(p,before);
 p.operations[0]!.target_ids=[];assert.equal(uniqueSourceOnlyProposal(req,p,scope),null);
});

test('normal source recovery cannot move a model citation to another message and unlock an automatic proposal',async()=>{
 const req={request_id:'cross-message',user_id:'u',session_id:'s',messages:[{role:'user',content:old+' '+neighbor},{role:'user',content:reason+' '+command}]};
 const models=new Models(config());let checks=0;
 models.json=async(_s,_input,_signal,context)=>{if(context?.purpose==='verification'){checks++;throw new ServiceError('EVIDENCE_VALIDATION','Unwanted cross-message automatic proposal');}return proposal();};
 await assert.rejects(new Extractor(config(),models).prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(2000)));
 assert.equal(checks,0);
});

for(const rejectedFact of [false,true])test(`source changes recheck operation/message without clearing an unrelated rejection, rejected=${rejectedFact}`,async()=>{
 const req={request_id:'cache',user_id:'u',session_id:'s',messages:[{role:'user',content:reason+' '+command},{role:'user',content:neighbor}]};
 const p=extractionSchema.parse({facts:[{content:neighbor,subject:'user',predicate:'browser',value:'Firefox',sources:[{index:1,quote:neighbor}]}],operations:[{...proposal().operations[0],target_ids:['old'],source:{index:0,quote:reason}}]});
 const target={...extractionSchema.parse(proposal()).facts[0]!,id:'old',source_ids:['old-source'],source_quotes:[old],state:'active',vector:null,revision:1} as any;
 const models=new Models(config()),session=new VerificationSession();let calls=0;
 models.json=async(_s,input)=>{
  calls++;const d=JSON.parse(input);
  if(calls===2)assert.deepEqual(d.CHECK_SCOPE,{fact_indices:[],operation_indices:[0],replacements:[],message_indices:[0]});
  return {fact_checks:d.CHECK_SCOPE.fact_indices.map((i:number)=>[i,!rejectedFact,true,0,rejectedFact?'Existing unrelated rejection':null]),operation_checks:[[0,true,true,null]],replacement_checks:[],message_checks:d.CHECK_SCOPE.message_indices.map((i:number)=>i===0?[0,'represented',[],[0]]:[1,'represented',[0],[]])};
 };
 const first=await models.verify(p,req,[target],[],AbortSignal.timeout(1000),session);assert.equal(first.length,rejectedFact?1:0);
 p.operations[0]!.source={index:0,quote:command};
 const second=await models.verify(p,req,[target],[],AbortSignal.timeout(1000),session);
 assert.equal(second.length,rejectedFact?1:0);assert.equal(calls,rejectedFact?1:2);
});
