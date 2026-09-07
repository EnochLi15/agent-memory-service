import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Models} from '../dist/models.js';
import {configFromEnv} from '../dist/config.js';
import {extractionSchema} from '../dist/types.js';
import {VerificationSession} from '../dist/verification-session.js';
import {verificationInput,verificationIssues} from '../dist/verification.js';
import {sourceCoverageWork} from '../dist/source-coverage.js';
import {decodeNamedVerification,namedVerificationInput,NAMED_VERIFICATION_PROTOCOL} from '../dist/verification-named.js';
const req={request_id:'named',user_id:'u',session_id:'s',messages:[{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'},{role:'user',content:'Correct my city from Boston to Paris.',timestamp:'2026-01-02T00:00:00Z'}]};
const proposal=()=>extractionSchema.parse({facts:[{content:req.messages[0]!.content,subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:req.messages[0]!.content}]},{content:'User lives in Paris.',subject:'user',predicate:'city',value:'Paris',sources:[{index:1,quote:req.messages[1]!.content}],supersedes:['old']}],operations:[{type:'correct',subject:'user',predicate:'city',target_ids:['old'],source:{index:1,quote:req.messages[1]!.content}}]});
const old={...proposal().facts[1]!,id:'old',supersedes:[],content:'User lives in Boston.',value:'Boston',state:'active',vector:null};
const scope=()=>verificationInput(req,proposal(),[],[]).CHECK_SCOPE;
const raw=():any=>({fact_checks:[{fact_id:'fact:0',supported:true,modality_supported:true,source_id:'fact:0/source:0',reason:null},{fact_id:'fact:1',supported:true,modality_supported:true,source_id:'fact:1/source:0',reason:null}],operation_checks:[{operation_id:'op:0',authorized:true,target_matches:true,reason:null}],replacement_checks:[{replacement_id:'replacement:0',supported:true,reason:null}],message_checks:[{message_id:'msg:0',verdict:'represented',fact_ids:['fact:0'],operation_ids:[],passage_ids:[],quote:null,reason:null},{message_id:'msg:1',verdict:'represented',fact_ids:['fact:1'],operation_ids:['op:0'],passage_ids:[],quote:null,reason:null}]});
const model=()=>new Models(configFromEnv({MEMORY_VERIFICATION_FORMAT:'named'}));
const run=(m:Models,p=proposal(),session=new VerificationSession())=>m.verify(p,req,[old] as any,[],AbortSignal.timeout(1000),session);

test('named fields resolve through unchanged evidence and replacement validators',()=>{
 const decoded=decodeNamedVerification(raw(),proposal(),scope());
 assert.deepEqual(decoded.protocolErrors,[]);assert.deepEqual(verificationIssues(decoded.canonical,req,proposal()),[]);
 assert.equal(decoded.canonical.fact_checks[1]!.source_index,1);assert.equal(decoded.canonical.replacement_checks[0]!.target_id,'old');
});
test('named input labels sparse scopes, sources and persistent IDs without changing evidence',()=>{
 const data=verificationInput(req,proposal(),[old] as any,[],{...scope(),fact_indices:[1],message_indices:[1]});
 const out=namedVerificationInput(data);
 assert.equal(out.VERIFICATION_PROTOCOL,NAMED_VERIFICATION_PROTOCOL);assert.deepEqual(out.CHECK_SCOPE.fact_ids,['fact:1']);
 assert.equal(out.PROPOSAL.facts[1].fact_id,'fact:1');assert.equal(out.PROPOSAL.facts[1].memory_id,data.PROPOSAL.facts[1]!.fact_id);
 assert.equal(out.PROPOSAL.facts[1].sources[0].source_id,'fact:1/source:0');assert.equal(out.PROPOSAL.facts[1].sources[0].quote,req.messages[1]!.content);
 assert.equal(out.REPLACEMENT_TARGETS[0].replacement_id,'replacement:0');assert.equal(out.REPLACEMENT_TARGETS[0].target_id,'old');
 assert.deepEqual(data.CHECK_SCOPE.fact_indices,[1]);assert.equal(data.NEW_MESSAGES[1]!.index,1);
});
test('named invalid identifiers, booleans, missing arrays and unknown fields cannot certify',async()=>{
 const invalids=[(r:any)=>r.fact_checks[0].source_id='fact:1/source:0',(r:any)=>r.fact_checks[0].supported=null,(r:any)=>r.fact_checks[0].fact_id='fact:00',(r:any)=>r.message_checks.pop(),(r:any)=>delete r.operation_checks,(r:any)=>r.overall_pass=true,(r:any)=>r.fact_checks.push(r.fact_checks[0]),(r:any)=>r.message_checks[0].fact_ids=['msg:0'],(r:any)=>r.message_checks[0].verdict='uncertain',(r:any)=>r.fact_checks[0].extra='ignored?'];
 for(const mutate of invalids){const out=raw();mutate(out);const m=model();let calls=0;m.json=async()=>{calls++;return out;};await assert.rejects(run(m));assert.equal(calls,2);}
});
test('named negative decisions survive malformed siblings and cannot be resampled',async()=>{
 for(const kind of ['fact_checks','operation_checks','replacement_checks']){
  const r=raw();r[kind][0][kind==='operation_checks'?'authorized':'supported']=false;r[kind][0].reason=null;r[kind][0].extra='protocol error';r.message_checks.push('malformed');
  const m=model(),session=new VerificationSession();let calls=0;m.json=async()=>{calls++;return r;};const findings=await run(m,proposal(),session);assert.ok(findings.length);
  m.json=async()=>{calls++;return raw();};assert.deepEqual(await run(m,proposal(),session),findings);assert.equal(calls,1);
 }
});
test('named missing evidence remains a semantic failure beside malformed structure',async()=>{
 const r=raw();r.operation_checks='broken';r.message_checks[0]={...r.message_checks[0],verdict:'missing',fact_ids:[],quote:req.messages[0]!.content,reason:'Browser omitted'};
 const m=model();let calls=0;m.json=async()=>{calls++;return r;};assert.match((await run(m))[0]!,/^message 0:/);assert.equal(calls,1);
});
test('named protocol repairs stay bounded and include precise feedback',async()=>{
 const m=model();let calls=0;m.json=async(system,input)=>{calls++;assert.ok(!system.includes('source-reference-tuples-v1'));assert.ok(!system.includes('source-first-coverage-tuples-v1'));
  if(calls===1){const r=raw();r.message_checks[0].fact_ids=['msg:0'];return r;}assert.match(input,/PROTOCOL_REPAIR/);assert.match(input,/message_checks\[0\]/);return {fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[raw().message_checks[0]]};};
 assert.deepEqual(await run(m),[]);assert.equal(calls,2);
});
test('named source-only coverage still requires real same-message passage references',()=>{
 const p=extractionSchema.parse({facts:[],operations:[]}),r={...req,messages:[{...req.messages[0]!,content:'That was quite an experience.'}]};
 const coverage=sourceCoverageWork(r,p),s=verificationInput(r,p,[],[]).CHECK_SCOPE;
 assert.ok(coverage.candidates.length);
 const out={fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[{message_id:'msg:0',verdict:'represented',fact_ids:[],operation_ids:[],passage_ids:['passage:0'],quote:null,reason:'Incidental reaction; no durable state.'}]};
 const d=decodeNamedVerification(out,p,s,coverage);assert.deepEqual(d.protocolErrors,[]);assert.deepEqual(verificationIssues(d.canonical,r,p,coverage),[]);
 out.message_checks[0]!.passage_ids=['passage:99'];assert.throws(()=>verificationIssues(decodeNamedVerification(out,p,s,coverage).canonical,r,p,coverage));
});
test('named session reuses only unchanged checks and invalidates on format change',async()=>{
 const c=configFromEnv({MEMORY_VERIFICATION_FORMAT:'named'}),m=new Models(c),session=new VerificationSession();let calls=0;
 m.json=async(_s,input)=>{calls++;const data=JSON.parse(input);assert.equal(data.VERIFICATION_PROTOCOL,NAMED_VERIFICATION_PROTOCOL);return raw();};assert.deepEqual(await run(m,proposal(),session),[]);assert.deepEqual(await run(m,proposal(),session),[]);assert.equal(calls,1);
 c.verificationFormat='compact';m.json=async()=>{calls++;return {fact_checks:[[0,true,true,0],[1,true,true,0]],operation_checks:[[0,true,true]],replacement_checks:[[0,true]],message_checks:[[0,'represented',[0],[]],[1,'represented',[1],[0]]]};};
 assert.deepEqual(await run(m,proposal(),session),[]);assert.equal(calls,2);
});
