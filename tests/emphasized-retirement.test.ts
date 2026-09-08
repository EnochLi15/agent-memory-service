import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {instructionSpans,forgetObligations,missingForgetObligations,authorizesForget,realControl} from '../src/operation-intent.js';
import {Extractor} from '../src/extraction.js';
import {TenantStore} from '../src/storage.js';
import {configFromEnv} from '../src/config.js';
import {ServiceError} from '../src/types.js';

test('really emphasizes an otherwise direct second-person retirement',()=>{
 for(const text of ["You don't really need to track my retired badge anymore.",'You do not really need to keep track of my retired badge anymore.',"The visit is finished, so you don't really need to remember that appointment anymore."]){
  assert.equal(realControl(text),true,text);
  const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:text}]};
  const obligations=forgetObligations(req);assert.equal(obligations.length,1);assert.equal(obligations[0]?.span.quote,text);
  const operation={type:'forget',source:{index:0,quote:text}} as any;
  assert.ok(authorizesForget(operation,req));
  assert.equal(missingForgetObligations(req,{facts:[],operations:[]}).length,1);
  assert.equal(missingForgetObligations(req,{facts:[],operations:[operation]}).length,0);
 }
});

test('emphasis does not relax quotation, reporting, conditions or negative intent',()=>{
 for(const text of [
  '"You do not really need to track my badge anymore."',
  "Morgan said: you don't really need to track my badge anymore.",
  "If the visit is over, you don't really need to track my badge anymore.",
  "Unless I ask again, you don't really need to track my badge anymore.",
  "When the visit ends, you don't really need to track my badge anymore.",
  "You don't really need to stop tracking my badge anymore.",
  "You don't really need to not track my badge anymore.",
  "You don't really want to track my badge anymore.",
  "You don't necessarily need to track my badge anymore.",
  "You don't really necessarily need to track my badge anymore.",
  "You don't really need to track my badge yet.",
 ])assert.equal(realControl(text),false,text);
});

test('new emphasized recognition does not authorize tentative statements or confirmation questions',()=>{
 for(const text of [
  "Maybe you don't really need to track my badge anymore.",
  "Perhaps you don't really need to track my badge anymore.",
  "You don't really need to track my badge anymore?",
  'You do not really need to track my badge anymore？',
  "You don't really need to track my badge anymore, necessarily.",
  "I'm not sure you don't really need to track my badge anymore.",
  "I'm not saying you don't really need to track my badge anymore.",
 ])assert.equal(realControl(text),false,text);
});

test('the new keep form never turns a request to stop deleting into deletion authority',()=>{
 for(const action of ['forgetting','deleting','erasing','removing']){
  const text=`You don't really need to keep ${action} my badge anymore.`;
  const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:text}]};
  assert.equal(realControl(text),false,text);assert.equal(forgetObligations(req).length,0);
  assert.equal(authorizesForget({source:{index:0,quote:text}} as any,req),false);
 }
});

test('only the separate unquoted emphasized instruction creates an obligation',()=>{
 const text='Morgan said "you do not really need to track my badge anymore". You do not really need to track my old pass anymore.';
 assert.deepEqual(instructionSpans(text).filter(s=>s.intent==='forget').map(s=>s.quote),['You do not really need to track my old pass anymore.']);
});

for(const overlap of [false,true])test(`same-chunk emphasis retains chronology and stops at unknown semantic verification, overlap=${overlap}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'emphasized-retirement-')),store=new TenantStore(dir,'u');
 const factQuote='My old badge code is ZX-281',operationQuote="so you don't really need to track it anymore.",text=`${factQuote}, ${operationQuote}`;
 const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:text}]};
 let verified=0;
 const extractor=new Extractor({...configFromEnv({MEMORY_MODE:'enhanced'}),extractionFormat:'flat',maxRepairRounds:0},{
  json:async()=>({facts:[{content:factQuote,subject:'user',predicate:'badge_code',value:'ZX-281',sources:[{index:0,quote:overlap?text:factQuote}]}],operations:[{type:'forget',target_ids:['new:0'],subject:'user',predicate:'badge_code',value:'ZX-281',boundary:'value',source:{index:0,quote:operationQuote}}]}),
  verify:async()=>{verified++;throw new ServiceError('EVIDENCE_VALIDATION','Local boundary: semantic verdict not supplied');},
  embedBatch:async()=>{assert.fail('no embedding or commit is authorized by the fixture');}
 } as any);
 try{
  const before=store.snapshot('s');
  await assert.rejects(extractor.prepare(req,before,AbortSignal.timeout(2000)),(e:any)=>overlap?e.code==='OPERATION_TARGET':e.code==='EVIDENCE_VALIDATION'&&e.message==='Local boundary: semantic verdict not supplied');
  assert.equal(verified,overlap?0:1);assert.deepEqual(store.snapshot('s'),before);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
