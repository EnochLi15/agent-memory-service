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

test('verifier route changes invalidate certificates while extraction-only routing does not',async()=>{
 const config=configFromEnv({MEMORY_VERIFICATION_MODEL:'critic-a'}),m=new Models(config),state=session(),p=proposal();let calls=0;
 m.json=async(_s,input,signal,context)=>{calls++;assert.equal(context?.purpose,'verification');return success(JSON.parse(input));};
 assert.deepEqual(await verify(m,p,state),[]);config.llmStageModels.extraction='another-extractor';assert.deepEqual(await verify(m,p,state),[]);assert.equal(calls,1);
 config.llmStageModels.verification='critic-b';assert.deepEqual(await verify(m,p,state),[]);assert.equal(calls,2);
});

test('malformed extraction retries route to repair even when a complete object is required',async()=>{
 const config=configFromEnv({MEMORY_MODE:'enhanced'}),m=new Models(config),purposes:string[]=[];const p=proposal();p.facts[0]!.content=req.messages[0]!.content;
 m.json=async(_s,input,_signal,context)=>{purposes.push(context?.purpose??'unspecified');if(purposes.length===1)return {facts:'invalid'};if(context?.purpose==='repair')return p;return success(JSON.parse(input));};
 m.embedBatch=async texts=>texts.map(()=>Array(768).fill(0));const result=await new Extractor(config,m).prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000));
 assert.equal(result.facts.length,2);assert.deepEqual(purposes,['extraction','repair','verification']);
});

test('an explicit second repair round fills new omissions while preserving validated earlier evidence',async()=>{
 const combined={...req,messages:[{...req.messages[0]!,content:req.messages.map(m=>m.content).join(' ')}]};
 for(const rounds of [1,2]){
  const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_MAX_REPAIR_ROUNDS:String(rounds)}),m=new Models(config);let repairs=0,checks=0;
  m.json=async(_s,input,_signal,context)=>{
   if(context?.purpose==='extraction')return {facts:[],operations:[]};
   if(context?.purpose==='repair'){const f=structuredClone(proposal().facts[repairs++]!);if(repairs===1)f.content=req.messages[0]!.content;f.sources[0]!.index=0;return {append_facts:[f]};}
   checks++;const d=JSON.parse(input),out=success(d);if(checks<3)out.message_checks=[{index:0,disposition:'missing',quote:req.messages[checks-1]!.content,reason:'additional specific personal setup missing'}];
   if(checks===3){assert.deepEqual(d.CHECK_SCOPE.fact_indices,[1]);assert.deepEqual(d.CHECK_SCOPE.message_indices,[0]);}return out;
  };
  m.embedBatch=async texts=>texts.map(()=>Array(768).fill(0));const run=new Extractor(config,m).prepare(combined,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000));
  if(rounds===1)await assert.rejects(run,/semantic verification/);else assert.equal((await run).facts.length,2);
  assert.equal(repairs,rounds);assert.equal(checks,rounds+1);assert.equal(config.addTimeout,115000);
 }
});

test('two-round mode remains bounded and cannot resample an unchanged rejected proposal',async()=>{
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_MAX_REPAIR_ROUNDS:'2'}),m=new Models(config),counts={extraction:0,repair:0,verification:0};
 m.json=async(_s,input,_signal,context)=>{
  const purpose=context!.purpose! as keyof typeof counts;counts[purpose]++;
  if(purpose==='extraction')return {facts:[],operations:[]};if(purpose==='repair')return {};
  const out=success(JSON.parse(input));out.message_checks=out.message_checks.map((c:any)=>({index:c.index,disposition:'missing',quote:req.messages[c.index]!.content,reason:'setup missing'}));return out;
 };
 await assert.rejects(new Extractor(config,m).prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000)),/semantic verification/);
 assert.deepEqual(counts,{extraction:1,repair:2,verification:1});
 for(const value of ['0','3','1.5','NaN'])assert.throws(()=>configFromEnv({MEMORY_MAX_REPAIR_ROUNDS:value}),/MEMORY_MAX_REPAIR_ROUNDS/);
});

test('retention context is visible without target operations and invalidates cached coverage on state changes',async()=>{
 const model=new Models(configFromEnv({})),state=new VerificationSession(),request={...req,messages:[{...req.messages[0],content:'Keep my browser preference.'}]},empty=extractionSchema.parse({facts:[],operations:[]});
 const active={id:'browser',subject:'user',predicate:'browser',scope:'',content:'I use Firefox.',value:'Firefox',state:'active',modality:'confirmed',source_ids:['historical'],depends_on:[],supersedes:[]};let calls=0;
 model.json=async(_prompt,input)=>{calls++;const d=JSON.parse(input);assert.equal(d.TARGET_FACTS.length,0);const rows=d.EXISTING_ACTIVE_FACTS;assert.ok(Array.isArray(rows));return {fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[rows.length?{index:0,disposition:'not_memorable'}:{index:0,disposition:'missing',quote:request.messages[0].content,reason:'Existing active record is absent'}]};};
 assert.deepEqual(await model.verify(empty,request,[active] as any,[],AbortSignal.timeout(1000),state,[{slot:0}]),[]);assert.equal(calls,1);
 assert.deepEqual(await model.verify(empty,request,[active] as any,[],AbortSignal.timeout(1000),state,[{slot:0}]),[]);assert.equal(calls,1);
 const findings=await model.verify(empty,request,[{...active,state:'erased'}] as any,[],AbortSignal.timeout(1000),state,[{slot:0}]);assert.equal(calls,2);assert.match(findings[0],/^message 0:/);
});

test('forget verification sees unselected historical properties and scopes certificate invalidation to the instruction',async()=>{
 const r={...req,messages:[{...req.messages[0],content:"Do not track Priya's food details."},req.messages[1]]};
 const p=extractionSchema.parse({facts:[{content:req.messages[1].content,subject:'user',predicate:'browser',value:'Firefox',sources:[{index:1,quote:req.messages[1].content}]}],operations:[{type:'forget',subject:'Priya',predicate:'subscription',scope:'hot sauce',value:'new subscription',target_ids:['new-subscription'],boundary:'property',source:{index:0,quote:r.messages[0].content}}]});
 const historical={...oldFact('historical-food'),subject:'Priya',predicate:'favorite_dish',content:'Priya likes spicy curry.',value:'spicy curry'};
 const selected={...oldFact('new-subscription'),subject:'Priya',predicate:'subscription',scope:'hot sauce',content:'Priya has a new subscription.',value:'new subscription'};
 const joint={...oldFact('joint'),subject:'user and Priya',content:'User and Priya have different spice preferences.'};
 const neighbor={...oldFact('neighbor'),subject:'Marcus',content:'Marcus likes ramen.'};
 const erased={...historical,id:'already-erased',state:'erased',content:'',value:''};
 const pool=[historical,selected,joint,neighbor,erased],state=session(),m=new Models(configFromEnv({}));let calls=0;
 m.json=async(_s,input)=>{calls++;const d=JSON.parse(input);assert.deepEqual(d.TARGET_FACTS.map((f:any)=>f.id),['new-subscription']);
  assert.deepEqual(d.FORGET_SCOPE_CONTEXT[0].facts.map((f:any)=>f.id),['historical-food','new-subscription','joint']);
  assert.deepEqual(d.FORGET_SCOPE_CONTEXT[0].facts.map((f:any)=>f.forget_operation_indices),[[],[0],[]]);
  if(calls===2)assert.deepEqual(d.CHECK_SCOPE,{fact_indices:[],operation_indices:[],replacements:[],message_indices:[0]});
  return success(d);
 };
 assert.deepEqual(await verify(m,p,state,r,pool as any),[]);
 historical.content='Priya likes extra-hot curry.';assert.deepEqual(await verify(m,p,state,r,pool as any),[]);assert.equal(calls,2);
 neighbor.content='Marcus now likes noodles.';historical.vector=[1,2] as any;assert.deepEqual(await verify(m,p,state,r,pool as any),[]);assert.equal(calls,2);
});

test('missing historical erasure coverage stays rejected until the proposal changes',async()=>{
 const r={...req,messages:[{...req.messages[0],content:"Forget Priya's food details."}]};
 const op=(id:string,predicate:string)=>({type:'forget',subject:'Priya',predicate,value:'food',target_ids:[id],boundary:'property',source:{index:0,quote:r.messages[0].content}});
 const p=extractionSchema.parse({facts:[],operations:[op('new','subscription')]});
 const pool=[{...oldFact('old'),subject:'Priya',predicate:'favorite_dish',content:'Priya likes spicy curry.'},{...oldFact('new'),subject:'Priya',predicate:'subscription',content:'Priya has a hot sauce subscription.'}];
 const state=session(),m=new Models(configFromEnv({}));let calls=0;
 m.json=async(_s,input)=>{calls++;const d=JSON.parse(input);assert.ok(d.FORGET_SCOPE_CONTEXT[0].facts.some((f:any)=>f.id==='old'));const out=success(d);
  if(!d.PROPOSAL.operations.some((o:any)=>o.target_ids.includes('old')))out.message_checks=[{index:0,disposition:'missing',quote:r.messages[0].content,reason:'Historical food preference remains outside the proposed erasure.'}];
  return out;
 };
 assert.match((await verify(m,p,state,r,pool as any)).join(' '),/Historical food preference/);
 assert.match((await verify(m,p,state,r,pool as any)).join(' '),/Historical food preference/);assert.equal(calls,1);
 p.operations.push(extractionSchema.parse({facts:[],operations:[op('old','favorite_dish')]}).operations[0]);assert.deepEqual(await verify(m,p,state,r,pool as any),[]);assert.equal(calls,2);
});

test('a historical omission outside initial retrieval is exposed to the existing bounded repair',async()=>{
 const r={...req,messages:[{...req.messages[0],content:"Forget Priya's food details, please do not track her restaurant notes or sauce subscription anymore."}]};
 const selected={...oldFact('selected'),subject:'Priya',predicate:'subscription',scope:'',value:'sauce subscription',content:r.messages[0].content};
 const historical={...oldFact('historical'),subject:'Priya',predicate:'spice_preference_difference',scope:'curry',value:'different spices',content:'Different spice spectrum.'};
 const distractors=Array.from({length:121},(_,i)=>({...oldFact('d'+i),subject:'other'+i,content:r.messages[0].content}));
 const snapshot={facts:[selected,...distractors,historical],tail:[],anchor:null,revision:1} as any;
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_MAX_REPAIR_ROUNDS:'2'}),m=new Models(config);let repairs=0,checks=0;
 m.json=async(_s,input,_signal,ctx)=>{
  const d=JSON.parse(input);
  if(ctx?.purpose==='extraction'){assert.ok(!d.EXISTING_FACTS.some((f:any)=>f.predicate===historical.predicate));return {facts:[],operations:[{type:'forget',target_ids:['selected'],subject:selected.subject,predicate:selected.predicate,scope:'',value:selected.value,boundary:'property',source:{index:0,quote:r.messages[0].content}}]};}
  if(ctx?.purpose==='repair'){repairs++;const exposed=d.EXISTING_FACTS.find((f:any)=>f.predicate===historical.predicate);assert.ok(exposed,'repair must receive the historical record and its usable alias');assert.ok(/^m\d+$/.test(exposed.id));assert.ok(d.FORGET_SCOPE_CONTEXT[0].facts.some((f:any)=>f.id===exposed.id&&f.forget_operation_indices.length===0));
   return {append_operations:[{type:'forget',target_ids:[exposed.id],subject:historical.subject,predicate:historical.predicate,scope:historical.scope,value:historical.value,boundary:'property',source:{index:0,quote:r.messages[0].content}}]};}
  checks++;const out=success(d);if(checks===1)out.message_checks=[{index:0,disposition:'missing',quote:r.messages[0].content,reason:'Historical spice preference difference was omitted.'}];return out;
 };
 m.embedBatch=async xs=>xs.map(()=>[1,0]);
 const prepared=await new Extractor(config,m).prepare(r,snapshot,AbortSignal.timeout(3000));assert.equal(repairs,1);assert.equal(checks,2);assert.ok(prepared.operations.some(o=>o.target_ids.includes('historical')));
});

test('repair coverage links resolve same-request handles without confusing them with stored aliases',async()=>{
 const r={...req,messages:[{...req.messages[0],content:'Priya has a sauce subscription.'},{...req.messages[1],content:"Forget Priya's food details."}]};
 const historical={...oldFact('historical-food'),subject:'Priya',predicate:'favorite_dish',scope:'',value:'curry',content:'Priya likes curry.'};
 const config=configFromEnv({MEMORY_MODE:'enhanced'}),m=new Models(config);let checks=0,repairs=0;
 m.json=async(_s,input,_signal,ctx)=>{const d=JSON.parse(input);
  if(ctx?.purpose==='extraction')return {facts:[{subject:'Priya',predicate:'subscription',scope:'',value:'sauce subscription',content:r.messages[0].content,sources:[{index:0,quote:r.messages[0].content}]}],operations:[{type:'forget',target_ids:['new:0'],subject:'Priya',predicate:'subscription',scope:'',value:'sauce subscription',boundary:'property',source:{index:1,quote:r.messages[1].content}}]};
  if(ctx?.purpose==='repair'){repairs++;const records=d.FORGET_SCOPE_CONTEXT[0].facts;assert.deepEqual(records.find((f:any)=>f.id==='new:0').forget_operation_indices,[0]);const old=records.find((f:any)=>f.predicate==='favorite_dish');assert.ok(/^m\d+$/.test(old.id));assert.deepEqual(old.forget_operation_indices,[]);
   return {append_operations:[{type:'forget',target_ids:[old.id],subject:'Priya',predicate:old.predicate,scope:old.scope,value:old.value,boundary:'property',source:{index:1,quote:r.messages[1].content}}]};}
  checks++;const out=success(d);if(checks===1)out.message_checks=out.message_checks.map((c:any)=>c.index===1?{index:1,disposition:'missing',quote:r.messages[1].content,reason:'Earlier favorite dish remains uncovered.'}:c);return out;
 };
 m.embedBatch=async xs=>xs.map(()=>[1,0]);const prepared=await new Extractor(config,m).prepare(r,{facts:[historical],tail:[],anchor:null,revision:1} as any,AbortSignal.timeout(3000));assert.equal(repairs,1);assert.equal(checks,2);assert.ok(prepared.operations.some(o=>o.target_ids.includes(prepared.facts[0].id)));assert.ok(prepared.operations.some(o=>o.target_ids.includes(historical.id)));
});
