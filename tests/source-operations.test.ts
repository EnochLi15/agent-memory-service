import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {sourceOperationWork,decodeSourceOperations,validateSourceOperations} from '../dist/source-operations.js';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';import {forgetObligations} from '../dist/operation-intent.js';
const timestamp='2026-01-01T00:00:00Z';
const req={user_id:'u',request_id:'reject',session_id:'s',messages:[{role:'user',content:'What gym routine do you have for me?',timestamp},{role:'assistant',content:'You attend Tuesday classes at Peak Gym. Water is available there.',timestamp},{role:'user',content:"No, that is inaccurate. Please don't store that. I use Firefox.",timestamp},{role:'assistant',content:'Sorry, Tuesday classes at Peak Gym was my mistake. Firefox is a browser.',timestamp}]};
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_SOURCE_OPERATIONS:'true',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SEMANTIC_TRANSITIONS:'true'});
const decision=()=>({decisions:[{instruction:0,action:'reject_source',target_slots:[1],cuts:[{message:1,quote:'You attend Tuesday classes at Peak Gym.'},{message:2,quote:"Please don't store that."},{message:3,quote:'Sorry, Tuesday classes at Peak Gym was my mistake.'}]}]});
const fact=(text:string,predicate:string,value:string,index=0)=>({content:text,subject:'user',predicate,value,sources:[{index,quote:text}]});
const empty={facts:[],tail:[],anchor:null,revision:0};
const fake=(observed:any[]=[])=>({json:async(_s:string,input:string,_signal:AbortSignal,ctx:any)=>{
 observed.push(ctx.purpose);if(ctx.purpose==='source_operation')return decision();
 if(ctx.purpose==='extraction'){const data=JSON.parse(input);if(data.RESOLVED_SOURCE_ACTIONS){assert.equal(data.RESOLVED_SOURCE_ACTIONS.length,1);return {facts:[fact('I use Firefox.','browser','Firefox',2)],operations:[]};}return {facts:[fact('I swim on Mondays.','exercise','swim on Mondays')],operations:[]};}
 throw new Error('Unexpected semantic stage '+ctx.purpose);
},verify:async(_p:any,_r:any,_f:any,_o:any,_s:any,_session:any,actions:any[])=>{if(_r.request_id==='reject')assert.equal(actions.length,1);return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])});

test('explicit no-store is retirement; reported, quoted and conditional requests cannot authorize source operations',()=>{
 assert.equal(forgetObligations(req).length,1);
 for(const content of ['If that is wrong, please do not store it.','She said: "Please do not store that."','"Please do not store that."','Please do not forget that.'])assert.equal(forgetObligations({...req,messages:[{role:'user',content,timestamp}]}).length,0,content);
});
test('source operation rejects incomplete/uncertain decisions, future targets and malformed cuts',()=>{
 const work=sourceOperationWork(req,[]);assert.ok(work.enabled);assert.equal(decodeSourceOperations(decision(),work).decisions.length,1);
 for(const mode of ['missing','duplicate','uncertain','future','unknown','missing_cut','absent_quote','duplicate_cut','instruction_cut','ordinary_cut']){
  const raw=decision() as any,d=raw.decisions[0];
  if(mode==='missing')raw.decisions=[];if(mode==='duplicate')raw.decisions.push(structuredClone(d));if(mode==='uncertain')d.action='uncertain';if(mode==='future')d.target_slots=[3];if(mode==='unknown')d.target_slots=[50];if(mode==='missing_cut')d.cuts=d.cuts.filter((c:any)=>c.message!==1);if(mode==='absent_quote')d.cuts[0].quote='Invented';if(mode==='duplicate_cut')d.cuts.push({...d.cuts[0]});if(mode==='instruction_cut')d.cuts=d.cuts.filter((c:any)=>c.message!==2);if(mode==='ordinary_cut')d.action='ordinary';assert.throws(()=>decodeSourceOperations(raw,work),mode);
 }
 const repeat={...req,messages:req.messages.map((m,i)=>i===1?{...m,content:m.content+' You attend Tuesday classes at Peak Gym.'}:m)};assert.throws(()=>decodeSourceOperations(decision(),sourceOperationWork(repeat,[])));
});
test('source plan binds tenant/request/content and refuses overlap with a fact witness',()=>{
 const plan=decodeSourceOperations(decision(),sourceOperationWork(req,[])),messages=req.messages.map((m,i)=>({...m,id:hash(`${req.user_id}\0${req.request_id}\0${i}`),session_id:'s',ordinal:i,searchable:true}));assert.equal(validateSourceOperations(plan,req,[],[],messages).cuts.size,3);
 for(const r of [{...req,user_id:'other'},{...req,request_id:'other'},{...req,messages:req.messages.map((m,i)=>i===1?{...m,content:'changed'}:m)}])assert.throws(()=>validateSourceOperations(plan,r,[],[],messages));
 assert.throws(()=>validateSourceOperations(plan,req,[],[{state:'active',source_ids:[messages[1].id],source_spans:[{source_id:messages[1].id,start:0,end:20}]}] as any,messages),/overlaps a fact witness/);
});
test('source-only removal preserves true facts through rollback, retry, restart and every stored retrieval surface',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-op-'));let store=new TenantStore(dir,'u');const calls:any[]=[],extractor=new Extractor(config,fake(calls) as any);
 const initial={...req,request_id:'initial',messages:[{role:'user',content:'I swim on Mondays.',timestamp}]};
 try{
  const a=await extractor.prepare(initial,store.snapshot('s'),AbortSignal.timeout(2000));store.commit(initial,hash(JSON.stringify(initial)),a,0);assert.equal(store.meta('source_format'),'dual-source-v6-s1');const before=structuredClone(store.facts());
  const p=await extractor.prepare(req,store.snapshot('s'),AbortSignal.timeout(2000));assert.ok(p.sourceOperationPlan);const fingerprint=JSON.stringify(p);
  for(const boundary of ['operations','indexes']){assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),p,1,boundary));assert.equal(store.revision(),1);assert.deepEqual(store.facts(),before);assert.equal(store.receipt(req.request_id,hash(JSON.stringify(req))),null);assert.equal(JSON.stringify(p),fingerprint);}
  const receipt=store.commit(req,hash(JSON.stringify(req)),p,1);assert.deepEqual(store.commit(req,hash(JSON.stringify(req)),p,1),receipt);assert.equal(store.revision(),2);
  store.close();store=new TenantStore(dir,'u');assert.ok(store.facts().some(f=>f.value==='swim on Mondays'&&f.state==='active'));assert.ok(store.facts().some(f=>f.value==='Firefox'&&f.state==='active'));
  const visible=JSON.stringify({facts:store.facts(),raw:store.raw(),tail:store.snapshot('s').tail,passages:store.passages(),events:store.events()});assert.doesNotMatch(visible,/Peak Gym|Tuesday classes/);assert.match(visible,/Water is available|Firefox/);assert.equal(store.lexical('Peak Gym',50).length,0);assert.equal(store.events().filter(e=>e.type==='forget').length,1);assert.equal(calls.filter(p=>p==='source_operation').length,1);
  const other=new TenantStore(dir,'other');try{assert.equal(other.raw().length,0);}finally{other.close();}
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('v6 rejects missing/tampered plans and existing v5 directories',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-op-identity-')),store=new TenantStore(dir,'u'),extractor=new Extractor(config,fake() as any);
 try{const p=await extractor.prepare(req,empty,AbortSignal.timeout(2000));const missing=structuredClone(p);delete missing.sourceOperationPlan;assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),missing,0));const bad=structuredClone(p);bad.sourceOperationPlan!.fingerprint='forged';assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),bad,0));assert.equal(store.revision(),0);
  store.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('source_format','dual-source-v5-s1');assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),p,0),/Fresh data directory/);assert.equal(store.revision(),0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('ordinary decisions cannot satisfy missing genuine forget operations',async()=>{
 const x=new Extractor(config,{...fake(),json:async(_s:string,_i:string,_sig:AbortSignal,c:any)=>c.purpose==='source_operation'?{decisions:[{instruction:0,action:'ordinary',target_slots:[],cuts:[]}]}:{facts:[],operations:[]}} as any);await assert.rejects(()=>x.prepare(req,empty,AbortSignal.timeout(2000)));
});

import {sourceOperationInput} from '../dist/source-operations.js';
import {Models} from '../dist/models.js';import {VerificationSession} from '../dist/verification-session.js';
test('source operation input bounds the transmitted facts, not hidden embedding vectors',()=>{
 const facts=Array.from({length:50},(_,i)=>({id:String(i),content:'I swim.',subject:'user',predicate:'exercise',scope:'',state:'active',vector:Array(768).fill(0.123456789)}));
 const input=sourceOperationInput(sourceOperationWork(req,facts as any));assert.equal(input.EXISTING_FACTS.length,50);assert.ok(input.EXISTING_FACTS.every(f=>!('vector' in f)));
 assert.throws(()=>sourceOperationInput(sourceOperationWork({...req,messages:[{role:'user',content:'x'.repeat(180001),timestamp}]},[])),/bounded model input/);
});
test('resolved source context is sent to the checker and invalidates reuse when it changes',async()=>{
 const cfg={...config,verificationFormat:'verbose' as const},m=new Models(cfg);let calls=0;
 const r={...req,messages:[{role:'assistant',content:'A false claim.',timestamp},{role:'user',content:"Please don't store that.",timestamp}]};
 const sourceActions=[{message:1,target_slots:[0],cuts:[{message:0,quote:'A false claim.'}]}];
 m.json=async(system:string,input:string)=>{calls++;const d=JSON.parse(input);assert.ok(d.RESOLVED_SOURCE_ACTIONS.length);assert.match(system,/remaining personal assertion/);return {fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[{index:1,disposition:'not_memorable',fact_indices:[],operation_indices:[],quote:'',reason:'The sole instruction has a verified separate source action.'}]};};
 const session=new VerificationSession(),p={facts:[],operations:[]};assert.deepEqual(await m.verify(p,r,[],[],AbortSignal.timeout(1000),session,sourceActions),[]);await m.verify(p,r,[],[],AbortSignal.timeout(1000),session,sourceActions);assert.equal(calls,1);await m.verify(p,r,[],[],AbortSignal.timeout(1000),session,[{...sourceActions[0],target_slots:[0,2]}]);assert.equal(calls,2);
});

import {sourceRejectionFindings} from '../dist/source-operations.js';
test('negated summaries cannot reintroduce assistant-only details; independently stated user details are preserved',()=>{
 const plan=decodeSourceOperations(decision(),sourceOperationWork(req,[]));
 const facts=[{content:'User does not attend Peak Gym.',value:'Peak Gym',subject:'user',predicate:'not_gym',scope:'',time_text:''},{content:'User uses Firefox.',value:'Firefox',subject:'user',predicate:'browser',scope:'',time_text:''}];assert.equal(sourceRejectionFindings(plan,req,facts).length,1);
 const grounded={...req,messages:[...req.messages,{role:'user',content:'My brother goes to Peak Gym.',timestamp}]};assert.deepEqual(sourceRejectionFindings(plan,grounded,[{...facts[0],content:'My brother goes to Peak Gym.',subject:'brother',predicate:'gym'}]),[]);
});
