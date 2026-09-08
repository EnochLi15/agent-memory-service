import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authorizesForget,forgetObligations,missingForgetObligations,realControl} from '../src/operation-intent.js';
import {Extractor} from '../src/extraction.js';
import {Models} from '../src/models.js';
import {configFromEnv} from '../src/config.js';
import {extractionSchema} from '../src/types.js';

const request=(content:string)=>({request_id:'tracking',user_id:'u',session_id:'s',messages:[{role:'user',content}]});
const command='No need to worry about tracking a specific preference for her anymore.';

test('a complete no-need-to-worry-about-tracking statement creates one retirement obligation',()=>{
 for(const text of [command,'No need to worry about tracking my old appointment anymore.','No need for you to worry about tracking the old access code anymore.','There is no need to worry about tracking her previous preference anymore.']){
  const req=request(text),op={type:'forget',source:{index:0,quote:text}} as any;
  assert.equal(realControl(text),true,text);
  assert.equal(authorizesForget(op,req),true,text);
  assert.equal(forgetObligations(req).length,1,text);
  assert.equal(missingForgetObligations(req,{facts:[],operations:[]}).length,1,text);
  assert.equal(missingForgetObligations(req,{facts:[],operations:[op]}).length,0,text);
 }
});

test('the new tracking form rejects negation reversals and tracking the management of forgetting',()=>{
 for(const text of [
  'No need to worry about not tracking my appointment anymore.',
  'No need to worry about tracking whether I stop forgetting my appointment anymore.',
  'No need to worry about stopping forgetting my appointment anymore.',
  'No need to worry about tracking my attempts at stopping forgetting the appointment anymore.',
  'No need to worry about tracking the question of whether I should delete my appointment anymore.',
  'No need to worry about tracking my preference for not forgetting the appointment anymore.',
 ]){
  assert.equal(realControl(text),false,text);
  assert.equal(authorizesForget({source:{index:0,quote:text}} as any,request(text)),false,text);
 }
});

test('the new tracking form stays inside a complete direct statement',()=>{
 for(const text of [
  'Maybe '+command,'Perhaps '+command,'I am not saying '+command,"I'm not saying "+command,
  'Maybe: '+command,'Perhaps: '+command,'Not sure: '+command,'Not saying: '+command,
  'Morgan said: '+command,'If the trip ends, '+command,'Unless I ask again, '+command,
  'When the trip ends, '+command,'"'+command+'"','“'+command+'”',
  command.replace('.','?'),command.replace('.','？'),command.replace('.',', necessarily.'),
  command.replace('.',', if I cancel.'),command.replace('.',' is not an instruction.'),
  command.replace('anymore.','yet.'),'No need to worry about storing my appointment anymore.',
 ])assert.equal(realControl(text),false,text);
});

test('an unrelated report cannot authorize its quote, while a separate direct statement still can',()=>{
 const quoted='No need to worry about tracking my appointment anymore.';
 const req=request('Morgan said "'+quoted+'" '+command);
 assert.equal(authorizesForget({source:{index:0,quote:quoted}} as any,req),false);
 assert.equal(authorizesForget({source:{index:0,quote:command}} as any,req),true);
 assert.equal(forgetObligations(req).length,1);
 assert.ok(forgetObligations(req)[0]!.span.quote.endsWith(command));
});

test('source authorization does not convert a retract into a complete erasure',()=>{
 const req=request(command),op={type:'retract',boundary:'property',source:{index:0,quote:command}} as any;
 assert.equal(authorizesForget(op,req),true);
 assert.equal(missingForgetObligations(req,{facts:[],operations:[op]}).length,1);
});

// Authored semantic refusals exercise the actual verification decoder and
// prepare boundary. Lexical recognition alone cannot certify an owner/property.
const facts=[
 {id:'preference',subject:'my aunt',predicate:'preferred_name',scope:'family',value:'Jan'},
 {id:'reason',subject:'my aunt',predicate:'name_reason',scope:'',value:'shorter'},
 {id:'legal-name',subject:'my aunt',predicate:'legal_name',scope:'legal',value:'Janet'},
 {id:'other-person',subject:'my colleague',predicate:'preferred_name',scope:'work',value:'Jan'},
 {id:'other-scope',subject:'my aunt',predicate:'preferred_name',scope:'work',value:'Jan'},
].map(f=>({...f,content:`${f.subject}: ${f.predicate} ${f.value} (${f.scope}).`,kind:'state',cardinality:'single',modality:'confirmed',time_text:'',valid_from:null,valid_to:null,source_ids:[],source_quotes:[],created_at:'',observed_at:'',state:'active',vector:null,entities:[],depends_on:[],supersedes:[],revision:1}));

for(const target of facts)test(`recognized source still requires semantic authorization of ${target.id}`,async()=>{
 const text='No need to worry about tracking my aunt’s family name preference anymore.';
 const req=request(text),snapshot={facts:structuredClone(facts),tail:[],anchor:null,revision:1};
 const config={...configFromEnv({MEMORY_MODE:'enhanced',MEMORY_VERIFICATION_FORMAT:'compact'}),extractionFormat:'flat' as const,maxRepairRounds:0};
 const models=new Models(config);let checks=0,calls=0;
 const proposal=extractionSchema.parse({facts:[],operations:[{type:'forget',target_ids:[target.id],subject:target.subject,predicate:target.predicate,scope:target.scope,value:target.value,boundary:'value',source:{index:0,quote:text}}]});
 models.json=async(_system,input,_signal,context)=>{
  calls++;const data=JSON.parse(input);
  if(context?.purpose==='extraction')return structuredClone(proposal);
  assert.equal(context?.purpose,'verification');checks++;
  assert.deepEqual(data.CHECK_SCOPE.operation_indices,[0]);
  assert.equal(data.PROPOSAL.operations.length,1);
  assert.deepEqual(data.PROPOSAL.operations[0].target_ids,[target.id]);
  assert.deepEqual(data.TARGET_FACTS.map((f:any)=>f.id),[target.id]);
  assert.equal(data.NEW_MESSAGES[0].content,text);
  return {fact_checks:[],operation_checks:[[0,false,false,'Authored fixture: target authorization is rejected.']],replacement_checks:[],message_checks:[[0,'represented',[],[0]]]};
 };
 models.embedBatch=async()=>assert.fail('semantic refusal must not reach embedding or commit');
 const before=structuredClone(snapshot);
 await assert.rejects(new Extractor(config,models).prepare(req,snapshot as any,AbortSignal.timeout(2000)),(e:any)=>e.code==='EVIDENCE_VALIDATION'&&e.message==='Evidence still fails semantic verification after repair');
 assert.equal(checks,1);assert.equal(calls,2);assert.deepEqual(snapshot,before);
});
