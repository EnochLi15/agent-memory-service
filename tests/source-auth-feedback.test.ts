import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Extractor} from '../src/extraction.js';
import {Models} from '../src/models.js';
import {configFromEnv} from '../src/config.js';
import {PATCH_PROMPT,sourceAuthorizationCandidates} from '../src/repair.js';
import {ServiceError} from '../src/types.js';

const state='My aunt now accepts either familiar name.';
const command='No need to worry about tracking my aunt’s specific name preference anymore.';
const facts=[
 {id:'preference',subject:'my aunt',predicate:'preferred_name',scope:'family',value:'Jan'},
 {id:'reason',subject:'my aunt',predicate:'name_reason',scope:'',value:'Janet feels formal'},
 {id:'legal-name',subject:'my aunt',predicate:'legal_name',scope:'legal',value:'Janet'},
 {id:'other-person',subject:'my colleague',predicate:'preferred_name',scope:'family',value:'Jan'},
 {id:'other-scope',subject:'my aunt',predicate:'preferred_name',scope:'work',value:'Jan'},
].map(f=>({...f,content:`${f.subject}: ${f.predicate} ${f.value} (${f.scope}).`,kind:'state',cardinality:'single',modality:'confirmed',time_text:'',valid_from:null,valid_to:null,source_ids:[],source_quotes:[],created_at:'',observed_at:'',state:'active',vector:null,entities:[],depends_on:[],supersedes:[],revision:1}));
const operation=(target:typeof facts[number],quote:string,index=0)=>({type:'forget',target_ids:[target.id],subject:target.subject,predicate:target.predicate,scope:target.scope,value:target.value,boundary:'value',source:{index,quote}});

async function run(targetId:string,mode='same'){
 const target=facts.find(f=>f.id===targetId)!;
 const text=mode==='same'?state+' '+command:mode==='different'?state:state+' '+({quoted:'"'+command+'"',negative:'Do not forget my aunt’s name preference.',conditional:'If I ask later, forget my aunt’s name preference.'}[mode]??'');
 const req={request_id:'source-feedback',user_id:'u',session_id:'s',messages:[{role:'user',content:text},...(mode==='different'?[{role:'user',content:command}]:[])]};
 const snapshot={facts:structuredClone(facts),tail:[],anchor:null,revision:1};
 const config={...configFromEnv({MEMORY_MODE:'enhanced',MEMORY_VERIFICATION_FORMAT:'compact'}),extractionFormat:'flat' as const,maxRepairRounds:1};
 const proposal={facts:[],operations:[...(mode==='same'||mode==='different'?[operation(facts[0]!,command,mode==='different'?1:0)]:[]),operation(target,state)]};
 const rejected=proposal.operations.length-1,models=new Models(config);let repairs=0,checks=0;
 // Keep exercising the model-driven hint path with a custom verification
 // wrapper; automatic proposals require the unmodified standard method.
 const standardVerify=models.verify.bind(models);models.verify=(...args)=>standardVerify(...args);
 models.json=async(system,input,_signal,context)=>{
  const d=JSON.parse(input);
  if(context?.purpose==='extraction')return structuredClone(proposal);
  if(context?.purpose==='repair'){
   repairs++;
   assert.deepEqual(d.REPAIR_SCOPE,{fact_indices:[],operation_indices:[rejected],source_indices:[0]});
   assert.equal(d.MISSING_OPERATION_INSTRUCTIONS,undefined);
   assert.equal(d.AT_RISK_OPERATION_INSTRUCTIONS,undefined);
   assert.deepEqual(d.FAILED_PROPOSAL.operations[rejected].source,proposal.operations[rejected]!.source);
   if(mode!=='same'){
    assert.equal(d.SOURCE_AUTHORIZATION_CANDIDATES,undefined);
    assert.equal(system,PATCH_PROMPT,'empty candidates do not change the repair prompt');
    throw new ServiceError('EVIDENCE_VALIDATION','Fixture stops with unchanged empty-candidate repair');
   }
   assert.deepEqual(d.SOURCE_AUTHORIZATION_CANDIDATES,[{operation_index:rejected,source:{index:0,quote:command}}]);
   assert.match(system,/candidate citations, not authorization/i);
   return {operation_edits:[{index:rejected,changes:{source:{index:0,quote:command}}}]};
  }
  assert.equal(context?.purpose,'verification');checks++;
  assert.deepEqual(d.PROPOSAL.operations.map((o:any)=>o.target_ids),proposal.operations.map(o=>o.target_ids));
  assert.deepEqual(d.PROPOSAL.operations.map((o:any)=>[o.subject,o.predicate,o.scope]),proposal.operations.map(o=>[o.subject,o.predicate,o.scope]));
  assert.equal(d.PROPOSAL.operations[0].source.quote,command);
  assert.ok(d.TARGET_FACTS.some((f:any)=>f.id===target.id));
  assert.equal(d.NEW_MESSAGES[0].content,text);
  return {fact_checks:[],operation_checks:[[0,true,true,null],[1,false,false,'Authored fixture: the candidate source does not authorize this target.']],replacement_checks:[],message_checks:[[0,'represented',[],[0,1]]]};
 };
 models.embedBatch=async()=>assert.fail('semantic refusal must not reach embedding or commit');
 const before=structuredClone(snapshot);
 await assert.rejects(new Extractor(config,models).prepare(req,snapshot as any,AbortSignal.timeout(2000)),(e:any)=>e.code==='EVIDENCE_VALIDATION'&&e.message===(mode==='same'?'Evidence still fails semantic verification after repair':'Fixture stops with unchanged empty-candidate repair'));
 assert.equal(repairs,1);assert.equal(checks,mode==='same'?1:0);assert.deepEqual(snapshot,before);
}

test('an already-covered direct command is a candidate for a rejected same-message source, not a missing obligation',()=>run('reason'));
for(const mode of ['different','quoted','negative','conditional'])test(`no source hint is borrowed from ${mode} instructions`,()=>run('reason',mode));
for(const target of ['legal-name','other-person','other-scope'])test(`a suggested citation still requires independent semantic approval for ${target}`,()=>run(target));

test('candidate enumeration respects both scope dimensions and never mutates proposals',()=>{
 const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:state+' '+command}]};
 const proposal={facts:[],operations:[operation(facts[1]!,state)]} as any;
 const before=structuredClone(proposal),scope={fact_indices:[],operation_indices:[0],source_indices:[0]};
 assert.deepEqual(sourceAuthorizationCandidates(req,proposal,scope),[{operation_index:0,source:{index:0,quote:command}}]);
 assert.deepEqual(sourceAuthorizationCandidates(req,proposal,{...scope,operation_indices:[]}),[]);
 assert.deepEqual(sourceAuthorizationCandidates(req,proposal,{...scope,source_indices:[]}),[]);
 assert.deepEqual(sourceAuthorizationCandidates(req,{facts:[],operations:[operation(facts[1]!,command)]} as any,scope),[]);
 assert.deepEqual(proposal,before);
});

test('more than eight candidate rows omit the hint without selecting or truncating instructions',()=>{
 const scope={fact_indices:[],operation_indices:[0],source_indices:[0]},proposal={facts:[],operations:[operation(facts[1]!,state)]} as any;
 for(const n of [8,9]){
  const commands=Array.from({length:n},(_,i)=>`Forget my obsolete record ${i}.`);
  const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:state+' '+commands.join(' ')}]};
  const hints=sourceAuthorizationCandidates(req,proposal,scope);
  assert.deepEqual(hints.map(x=>x.source.quote),n===8?commands:[]);
 }
});

test('the 4096-character JSON budget preserves complete literal quotes or omits the whole hint',()=>{
 const scope={fact_indices:[],operation_indices:[0],source_indices:[0]},proposal={facts:[],operations:[operation(facts[1]!,state)]} as any;
 for(const n of [3900,4200]){
  const quote=`Forget my ${'x'.repeat(n)} record.`;
  const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:state+' '+quote}]};
  const hints=sourceAuthorizationCandidates(req,proposal,scope);
  assert.deepEqual(hints,n===3900?[{operation_index:0,source:{index:0,quote}}]:[]);
  assert.ok(JSON.stringify(hints).length<=4096);
 }
});
