import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Extractor} from '../src/extraction.js';
import {Models} from '../src/models.js';
import {configFromEnv} from '../src/config.js';
import {extractionSchema,ServiceError} from '../src/types.js';
import {splitForgetScopeProposal} from '../src/repair.js';
import {VerificationSession} from '../src/verification-session.js';

const command='Forget my preferred name and name reason.';
const req=()=>({request_id:'split',user_id:'u',session_id:'s',messages:[{role:'user',content:command}]});
const records=()=>[
 {id:'name',predicate:'preferred_name',scope:'family',value:'Jan'},
 {id:'reason',predicate:'name_reason',scope:'',value:'The shorter name feels informal'},
].map(f=>({...extractionSchema.parse({facts:[{content:`My ${f.predicate} is ${f.value}.`,subject:'user',predicate:f.predicate,scope:f.scope,value:f.value,sources:[{index:0,quote:command}]}],operations:[]}).facts[0]!,id:f.id,source_ids:[`source-${f.id}`],source_quotes:[`My ${f.predicate} is ${f.value}.`],source_spans:[],state:'active',vector:null,revision:1,created_at:'',observed_at:'',entities:[]}));
const proposal=()=>extractionSchema.parse({facts:[],operations:[{type:'forget',target_ids:['name','reason'],subject:'user',predicate:'preferred_name',scope:'family',value:'Jan',boundary:'value',source:{index:0,quote:command}}]});
const config=()=>({...configFromEnv({MEMORY_MODE:'enhanced',MEMORY_VERIFICATION_FORMAT:'compact'}),maxRepairRounds:0 as any});

test('a bounded split preserves selected records and needs fresh standard semantic acceptance on the last attempt',async()=>{
 const cfg=config(),models=new Models(cfg),p=proposal();let checks=0,calls=0;
 models.json=async(_system,input,_signal,context)=>{
  calls++;
  if(context?.purpose==='extraction')return structuredClone(p);
  assert.equal(context?.purpose,'verification');checks++;
  const d=JSON.parse(input);
  assert.deepEqual(d.PROPOSAL.operations.map((o:any)=>({ids:o.target_ids,predicate:o.predicate,scope:o.scope,value:o.value,source:o.source})),[
   {ids:['name'],predicate:'preferred_name',scope:'family',value:'Jan',source:p.operations[0]!.source},
   {ids:['reason'],predicate:'name_reason',scope:'',value:'The shorter name feels informal',source:p.operations[0]!.source},
  ]);
  assert.deepEqual(d.CHECK_SCOPE.operation_indices,[0,1]);assert.deepEqual(d.CHECK_SCOPE.message_indices,[0]);
  // Authored refusal tests the real decoder; this is no recovered B30 verdict.
  return {fact_checks:[],operation_checks:[[0,false,false,'Scope authorization remains unproved.'],[1,false,false,'Scope authorization remains unproved.']],replacement_checks:[],message_checks:[[0,'represented',[],[0,1]]]};
 };
 models.embedBatch=async()=>assert.fail('A split is not an authorization or prepared write');
 await assert.rejects(new Extractor(cfg,models).prepare(req(),{facts:records(),tail:[],anchor:null,revision:1} as any,AbortSignal.timeout(2000)),(e:any)=>e.code==='EVIDENCE_VALIDATION');
 assert.equal(checks,1);assert.equal(calls,2);
});

for(const derived of ['reflection','dependency'])test(`${derived} targets retain the existing repair path`,()=>{
 const stored=records();if(derived==='reflection')stored[1]!.kind='reflection';else stored[1]!.depends_on=['name'];
 assert.equal(splitForgetScopeProposal(req(),proposal(),stored as any),null);
});

for(const blocked of ['other-owner','hidden-scope','multi-value','no-original-slot','unknown','empty','duplicate-id','property-boundary','two-commands','repeated-source'])test(`${blocked} is not a bounded split`,()=>{
 const stored=records(),p=proposal(),r=req();
 if(blocked==='other-owner')stored[1]!.subject='another person';
 if(blocked==='hidden-scope')(stored[1] as any).scopeHash='private';
 if(blocked==='multi-value'){stored.push({...stored[1]!,id:'other-reason',value:'Different explanation'});p.operations[0]!.target_ids.push('other-reason');}
 if(blocked==='no-original-slot')p.operations[0]!.scope='work';
 if(blocked==='unknown')p.operations[0]!.target_ids.push('missing');
 if(blocked==='empty')p.operations[0]!.target_ids=[];
 if(blocked==='duplicate-id')p.operations[0]!.target_ids.push('name');
 if(blocked==='property-boundary')p.operations[0]!.boundary='property';
 if(blocked==='two-commands')r.messages[0]!.content+=' Forget my browser.';
 if(blocked==='repeated-source')r.messages[0]!.content+=` ${command}`;
 assert.equal(splitForgetScopeProposal(r,p,stored as any),null);
});

test('the original slot stays in place, with exact per-record values and untouched siblings and facts',()=>{
 const stored=records(),p=proposal();stored.reverse();
 p.operations.push({...p.operations[0]!,target_ids:['name']});
 const before=structuredClone(p),result=splitForgetScopeProposal(req(),p,stored as any)!;
 assert.deepEqual(result.origins,[0,1,0]);
 assert.deepEqual(result.candidate.operations.map(o=>o.target_ids),[['name'],['name'],['reason']]);
 assert.deepEqual(result.candidate.operations[1],p.operations[1]);
 assert.deepEqual(result.candidate.facts,p.facts);assert.deepEqual(p,before);
});

for(const blocked of ['selector-expansion','cross-message','lifecycle','custom-verifier','non-human'])test(`${blocked} cannot enter the automatic split verification path`,async()=>{
 const stored=records(),p=proposal(),r=req(),cfg=config();
 if(blocked==='selector-expansion')stored.push({...stored[0]!,id:'equivalent-unselected'});
 if(blocked==='cross-message')r.messages=[{role:'user',content:'Another message.'},{role:'user',content:command}];
 if(blocked==='lifecycle')cfg.experimental.lifecycle=false;
 if(blocked==='non-human')r.messages[0]!.role='assistant';
 const models=new Models(cfg);let checks=0;
 models.json=async(_s,_input,_signal,context)=>{if(context?.purpose==='verification'){checks++;throw new ServiceError('EVIDENCE_VALIDATION','Unwanted split');}assert.equal(context?.purpose,'extraction');return p;};
 if(blocked==='custom-verifier')models.verify=async()=>{checks++;return [];};
 models.embedBatch=async()=>assert.fail('No unsupported automatic split');
 await assert.rejects(new Extractor(cfg,models).prepare(r,{facts:stored,tail:[],anchor:null,revision:1} as any,AbortSignal.timeout(2000)));
 assert.equal(checks,0);
});

for(const failure of ['network','unavailable','malformed'])test(`split ${failure} verification cannot fall back to an offline prepared write`,async()=>{
 const cfg=config(),models=new Models(cfg);let calls=0;
 models.json=async(_s,_input,_signal,context)=>{
  if(context?.purpose==='extraction')return proposal();assert.equal(context?.purpose,'verification');calls++;
  if(failure==='malformed')return {};
  if(failure==='unavailable')throw new ServiceError('VERIFICATION_UNAVAILABLE','Unavailable fixture');
  throw Error('Network fixture');
 };
 models.embedBatch=async()=>assert.fail('No degraded authorization');
 await assert.rejects(new Extractor(cfg,models).prepare(req(),{facts:records(),tail:[],anchor:null,revision:1} as any,AbortSignal.timeout(2000)),(e:any)=>e.code==='EVIDENCE_VALIDATION');
 assert.ok(calls>0);
});

test('later repairs see the split with original aliases and stable sibling indexes',async()=>{
 const cfg={...config(),maxRepairRounds:1 as any},models=new Models(cfg),p=proposal();let checks=0,repairs=0,aliases:string[]=[];
 p.operations.push({...p.operations[0]!,target_ids:['name']});
 models.json=async(_s,input,_signal,context)=>{
  const d=JSON.parse(input);
  if(context?.purpose==='extraction'){
   aliases=['preferred_name','name_reason'].map(predicate=>d.EXISTING_FACTS.find((f:any)=>f.predicate===predicate).id);
   const copy=structuredClone(p);copy.operations[0]!.target_ids=[...aliases];copy.operations[1]!.target_ids=[aliases[0]!];return copy;
  }
  if(context?.purpose==='repair'){
   repairs++;assert.deepEqual(d.FAILED_PROPOSAL.operations.map((o:any)=>[o.operation_index,o.target_ids,o.value]),[[0,[aliases[0]],'Jan'],[1,[aliases[0]],'Jan'],[2,[aliases[1]],'The shorter name feels informal']]);
   assert.deepEqual(d.REPAIR_SCOPE.operation_indices,[2]);
   return {operation_edits:[{index:2,changes:{reason:'A revised proposal still requires authorization.'}}]};
  }
  assert.equal(context?.purpose,'verification');checks++;
  if(checks===2)throw new ServiceError('EVIDENCE_VALIDATION','Stop before an unseen revised verdict');
  return {fact_checks:[],operation_checks:[[0,true,true,null],[1,true,true,null],[2,false,false,'This record is not authorized.']],replacement_checks:[],message_checks:[[0,'represented',[],[0,1,2]]]};
 };
 await assert.rejects(new Extractor(cfg,models).prepare(req(),{facts:records(),tail:[],anchor:null,revision:1} as any,AbortSignal.timeout(2000)),/Stop before an unseen revised verdict/);
 assert.equal(checks,2);assert.equal(repairs,1);
});

for(const scenario of ['identical-first','changed-first','unrelated-refusal'])test(`split certificate scope: ${scenario}`,async()=>{
 const r={...req(),messages:[...req().messages,{role:'user',content:'My browser is Firefox.'}]};
 const p=proposal();p.operations[0]!.target_ids=['name'];
 p.facts=extractionSchema.parse({facts:[{content:r.messages[1]!.content,subject:'user',predicate:'browser',value:'Firefox',sources:[{index:1,quote:r.messages[1]!.content}]}]}).facts;
 const models=new Models(config()),session=new VerificationSession(),stored=records();let calls=0;
 models.json=async(_s,input)=>{
  calls++;const d=JSON.parse(input);
  if(calls===2)assert.deepEqual(d.CHECK_SCOPE,{fact_indices:[],operation_indices:scenario==='changed-first'?[0,1]:[1],replacements:[],message_indices:[0]});
  return {fact_checks:d.CHECK_SCOPE.fact_indices.map((i:number)=>[i,scenario!=='unrelated-refusal',true,0,scenario==='unrelated-refusal'?'Unrelated rejected browser statement':null]),operation_checks:d.CHECK_SCOPE.operation_indices.map((i:number)=>[i,true,true,null]),replacement_checks:[],message_checks:d.CHECK_SCOPE.message_indices.map((i:number)=>i===0?[0,'represented',[],calls===1?[0]:[0,1]]:[1,'represented',[0],[]])};
 };
 const first=await models.verify(p,r,stored as any,[],AbortSignal.timeout(2000),session);assert.equal(first.length,scenario==='unrelated-refusal'?1:0);
 p.operations[0]!.target_ids=['name','reason'];if(scenario==='changed-first')p.operations[0]!.reason='The model changed its proposal.';
 const split=splitForgetScopeProposal(r,p,stored as any)!;
 const second=await models.verify(split.candidate,r,stored as any,[],AbortSignal.timeout(2000),session);
 assert.equal(second.length,scenario==='unrelated-refusal'?1:0);assert.equal(calls,scenario==='unrelated-refusal'?1:2);
});

test('an explicit keep exception remains in full semantic input and an unauthorized group still rejects',async()=>{
 const r=req();r.messages[0]!.content+=' Keep the name reason; it is independent.';
 const cfg=config(),models=new Models(cfg);let checks=0;
 models.json=async(_s,input,_signal,context)=>{
  if(context?.purpose==='extraction')return proposal();assert.equal(context?.purpose,'verification');checks++;
  const d=JSON.parse(input);assert.ok(input.includes('Keep the name reason; it is independent.'));assert.equal(d.PROPOSAL.operations.length,2);
  return {fact_checks:[],operation_checks:[[0,true,true,null],[1,false,false,'The explicit keep exception forbids this deletion.']],replacement_checks:[],message_checks:[[0,'represented',[],[0]]]};
 };
 models.embedBatch=async()=>assert.fail('A split cannot overrule the keep exception');
 await assert.rejects(new Extractor(cfg,models).prepare(r,{facts:records(),tail:[],anchor:null,revision:1} as any,AbortSignal.timeout(2000)),(e:any)=>e.code==='EVIDENCE_VALIDATION');
 assert.equal(checks,1);
});
