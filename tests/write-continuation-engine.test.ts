import {test} from 'node:test';import assert from 'node:assert/strict';import OpenAI from 'openai';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Engine} from '../dist/engine.js';import {configFromEnv} from '../dist/config.js';
const req={user_id:'u',request_id:'r',session_id:'s',messages:[{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'}]};
const signal=()=>AbortSignal.timeout(5000);
async function fixture(options:{alwaysFail?:boolean;semanticOnly?:boolean}={}){
 const dir=mkdtempSync(join(tmpdir(),'continuation-engine-')),config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_WRITE_CONTINUATION:'true',MEMORY_DATA_DIR:dir,MEMORY_SOURCE_INDEX:'false'}),engine=new Engine(config);await engine.ready;
 const calls:string[]=[];let repair=0;
 (engine as any).models.generateJson=async(_system:string,input:string,_signal:AbortSignal,context:any)=>{
  calls.push(context.purpose);
  if(context.purpose==='extraction')return {facts:[{subject:'user',predicate:'default_browser',value:'Safari',content:'My browser is Safari.',sources:[{index:0,quote:'My browser is Firefox.'}]}],operations:[]};
  if(context.purpose==='repair'){
   if(++repair===1&&!options.semanticOnly||options.alwaysFail)throw new OpenAI.APIConnectionError({message:'fixture socket unavailable'});
   return {fact_edits:[{index:0,changes:options.semanticOnly?{content:'My browser is Safari.'}:{value:'Firefox',content:'My browser is Firefox.'}}]};
  }
  assert.equal(context.purpose,'verification');const x=JSON.parse(input),supported=x.PROPOSAL.facts[0].value==='Firefox';
  return {fact_checks:[{index:0,supported,modality_supported:true,source_index:0,quote:'My browser is Firefox.',...(!supported?{reason:'The stated browser is Firefox, not Safari.'}:{})}],operation_checks:[],replacement_checks:[],message_checks:[{index:0,disposition:'represented',fact_indices:[0]}]};
 };
 (engine as any).models.embedBatch=async(texts:string[])=>texts.map(()=>[1,0]);
 return {engine,calls,dir,config,close:async()=>{await engine.close();rmSync(dir,{recursive:true,force:true});}};
}
test('same HTTP-shaped request resumes the original rejection and commits exactly once',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='WRITE_CONTINUATION_PENDING');
  const before=await (f.engine as any).call('snapshot','u',['s']);assert.equal(before.revision,0);assert.equal(before.facts.length,0);
  await assert.rejects(()=>f.engine.add({...req,messages:[{...req.messages[0],content:'Changed payload.'}]},signal()),(e:any)=>e.code==='REQUEST_CONFLICT');
  await f.engine.add(req,signal());const after=await (f.engine as any).call('snapshot','u',['s']);assert.equal(after.revision,1);assert.equal(after.facts[0].value,'Firefox');
  assert.deepEqual(f.calls,['extraction','verification','repair','repair','verification']);
  await f.engine.add(req,signal());assert.equal(f.calls.length,5);
 }finally{await f.close();}
});
test('three continuation attempts remain bounded and cannot regenerate the rejected prefix',async()=>{
 const f=await fixture({alwaysFail:true});try{
  for(let i=0;i<2;i++)await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='WRITE_CONTINUATION_PENDING');
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');
  const calls=f.calls.length;await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');assert.equal(f.calls.length,calls);
  assert.equal(f.calls.filter(x=>x==='extraction').length,1);assert.equal(f.calls.filter(x=>x==='verification').length,1);assert.equal(f.calls.filter(x=>x==='repair').length,3);
 }finally{await f.close();}
});
test('semantic exhaustion is terminal and is not retried as a transport interruption',async()=>{
 const f=await fixture({semanticOnly:true});try{
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');const count=f.calls.length;
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');assert.equal(f.calls.length,count);
 }finally{await f.close();}
});
test('server restart cannot replace a lost rejected prefix with a new model vote',async()=>{
 const f=await fixture();let restarted:Engine|undefined;try{
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='WRITE_CONTINUATION_PENDING');await f.engine.close();
  restarted=new Engine(f.config);await restarted.ready;let calls=0;(restarted as any).models.generateJson=async()=>{calls++;throw Error('must not generate');};
  await assert.rejects(()=>restarted!.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');assert.equal(calls,0);
 }finally{if(restarted)await restarted.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('another committed write invalidates stale continuation before it can regenerate',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='WRITE_CONTINUATION_PENDING');
  await f.engine.add({...req,request_id:'new-write'},signal());const count=f.calls.length;
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');assert.equal(f.calls.length,count);
 }finally{await f.close();}
});
test('a different tenant commit cannot invalidate or consume this tenant prefix',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='WRITE_CONTINUATION_PENDING');
  await f.engine.add({...req,user_id:'other'},signal());const count=f.calls.length;
  await f.engine.add(req,signal());assert.deepEqual(f.calls.slice(count),['repair','verification']);
 }finally{await f.close();}
});


test('permanent initial model failure cannot commit the ordinary offline fallback in continuation mode',async()=>{
 const f=await fixture();try{
  (f.engine as any).models.generateJson=async()=>{throw new OpenAI.APIError(400,{},'permanent fixture',new Headers());};
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');
  const state=await (f.engine as any).call('snapshot','u',['s']);assert.equal(state.revision,0);assert.equal(state.facts.length,0);
 }finally{await f.close();}
});
test('bounded malformed output repairs cannot become an offline success in continuation mode',async()=>{
 const f=await fixture();try{
  (f.engine as any).models.generateJson=async()=>({unexpected:'malformed object'});
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');
  const state=await (f.engine as any).call('snapshot','u',['s']);assert.equal(state.revision,0);assert.equal(state.facts.length,0);
 }finally{await f.close();}
});


test('disabling continuation after restart cannot bypass a recorded rejected preparation',async()=>{
 const f=await fixture();let restarted:Engine|undefined;try{
  await assert.rejects(()=>f.engine.add(req,signal()),(e:any)=>e.code==='WRITE_CONTINUATION_PENDING');await f.engine.close();
  restarted=new Engine({...f.config,writeContinuation:false});await restarted.ready;
  await assert.rejects(()=>restarted!.add({...req,messages:[{...req.messages[0],content:'Changed payload.'}]},signal()),(e:any)=>e.code==='REQUEST_CONFLICT');
  let calls=0;(restarted as any).models.generateJson=async()=>{calls++;throw Error('must not generate');};
  await assert.rejects(()=>restarted!.add(req,signal()),(e:any)=>e.code==='EVIDENCE_VALIDATION');assert.equal(calls,0);
 }finally{if(restarted)await restarted.close();rmSync(f.dir,{recursive:true,force:true});}
});
