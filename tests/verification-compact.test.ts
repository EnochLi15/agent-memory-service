import {test} from 'node:test';import assert from 'node:assert/strict';
import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';import {extractionSchema} from '../dist/types.js';
import {VerificationSession} from '../dist/verification-session.js';import {decodeCompactVerification,COMPACT_VERIFICATION_PROTOCOL} from '../dist/verification-compact.js';import {verificationInput,verificationIssues} from '../dist/verification.js';
import {sourceCoverageWork} from '../dist/source-coverage.js';
const req={request_id:'compact',user_id:'u',session_id:'s',messages:[{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'},{role:'user',content:'Correct my city from Boston to Paris.',timestamp:'2026-01-02T00:00:00Z'}]};
const proposal=()=>extractionSchema.parse({facts:[{content:req.messages[0]!.content,subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:req.messages[0]!.content}]},{content:'User lives in Paris.',subject:'user',predicate:'city',value:'Paris',sources:[{index:1,quote:req.messages[1]!.content}],supersedes:['old']}],operations:[{type:'correct',subject:'user',predicate:'city',target_ids:['old'],source:{index:1,quote:req.messages[1]!.content}}]});
const old={...proposal().facts[1]!,supersedes:[],depends_on:[],id:'old',content:'User lives in Boston.',value:'Boston',state:'active',vector:null};
const scope=()=>verificationInput(req,proposal(),[],[]).CHECK_SCOPE;
const raw=()=>({fact_checks:[[0,true,true,0],[1,true,true,0]],operation_checks:[[0,true,true]],replacement_checks:[[0,true]],message_checks:[[0,'represented',[0],[]],[1,'represented',[1],[0]]]});
const m=()=>new Models(configFromEnv({MEMORY_VERIFICATION_FORMAT:'compact'}));
const run=(model:Models,p=proposal(),state=new VerificationSession(),r=req)=>model.verify(p,r,[old] as any,[],AbortSignal.timeout(1000),state);

test('null optional reasons pass positive checks without permitting null decisions or sources',async()=>{
 const out:any=raw();out.fact_checks.forEach((r:any[])=>r.push(null));out.operation_checks[0].push(null);out.replacement_checks[0].push(null);
 const model=m();model.json=async()=>out;assert.deepEqual(await run(model),[]);
 out.fact_checks[0][3]=null;assert.ok(decodeCompactVerification(out,proposal(),scope()).protocolErrors.length);
 out.fact_checks[0][3]=0;out.fact_checks[0][1]=null;assert.ok(decodeCompactVerification(out,proposal(),scope()).protocolErrors.length);
});
test('a rejection with null reason remains rejected and cannot be favorably resampled',async()=>{
 for(const type of ['fact_checks','operation_checks','replacement_checks']){
  const out:any=raw();out[type][0][1]=false;out[type][0].push(null);
  const model=m(),session=new VerificationSession();let calls=0;model.json=async()=>{calls++;return out;};
  const findings=await run(model,proposal(),session);assert.ok(findings.length);model.json=async()=>{calls++;return raw();};assert.deepEqual(await run(model,proposal(),session),findings);assert.equal(calls,1);
 }
});

test('source-backed mixed coverage permits an explanation without dropping checks or weakening references',()=>{
 const p=proposal(),work=sourceCoverageWork(req,p),out:any=raw();
 out.message_checks[0]=[0,'represented',[0],[],[],'All claims represented.'];
 const decoded=decodeCompactVerification(out,p,scope(),work);assert.deepEqual(decoded.protocolErrors,[]);assert.deepEqual(verificationIssues(decoded.canonical,req,p,work),[]);
 out.message_checks[0][2]=[1];assert.throws(()=>verificationIssues(decodeCompactVerification(out,p,scope(),work).canonical,req,p,work),/coverage references/);
 out.message_checks[0][2]=[0];out.message_checks[0][5]=true;assert.ok(decodeCompactVerification(out,p,scope(),work).protocolErrors.length);
});
test('malformed compact row feedback names the tuple rather than hiding it behind missing coverage',async()=>{
 const model=m();let calls=0;
 model.json=async(_system:string,input:string)=>{calls++;if(calls===1){const out:any=raw();out.message_checks[0]=[0,'represented',[0],[],'unexpected'];return out;}
  assert.match(input,/Invalid compact message tuple.*message_checks\[0\]/);assert.deepEqual(JSON.parse(input.split('\nPROTOCOL_REPAIR:')[0]!).CHECK_SCOPE.message_indices,[0]);return {fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[raw().message_checks[0]]};};
 assert.deepEqual(await run(model),[]);assert.equal(calls,2);
});

test('a false decision remains rejected even when its explanation claims the evidence is supported',async()=>{
 const model=m(),state=new VerificationSession();let calls=0;
 model.json=async()=>{calls++;const result=raw();result.fact_checks[0]=[0,false,true,0,'The context actually supports this fact.'];return result;};
 const findings=await run(model,proposal(),state);
 assert.equal(findings.length,1);assert.match(findings[0]!,/^fact 0:/);
 model.json=async()=>{calls++;return raw();};
 assert.deepEqual(await run(model,proposal(),state),findings);
 assert.equal(calls,1,'The contradictory explanation cannot unlock a favorable resample');
});

test('compact tuples resolve exact sources and replacement pairs into the full strict validator',()=>{
 const decoded=decodeCompactVerification(raw(),proposal(),scope());assert.deepEqual(decoded.protocolErrors,[]);assert.deepEqual(verificationIssues(decoded.canonical,req,proposal()),[]);
 assert.equal(decoded.canonical.fact_checks[1]!.source_index,1);assert.equal(decoded.canonical.fact_checks[1]!.quote,req.messages[1]!.content);
 assert.deepEqual(decoded.canonical.replacement_checks[0],{fact_index:1,target_id:'old',supported:true,reason:''});
 assert.ok(JSON.stringify(raw()).length<JSON.stringify(decoded.canonical).length*.55);
});
test('fact source slots select declared human sources, not message indexes or assistant evidence',()=>{
 const p=proposal();p.facts=p.facts.slice(0,1);p.operations=[];p.facts[0]!.sources=[{index:0,quote:'Your browser is Firefox.'},{index:1,quote:'My browser is Firefox.'}];
 const r={...req,messages:[{...req.messages[0]!,role:'assistant',content:'Your browser is Firefox.'},{...req.messages[1]!,content:'My browser is Firefox.'}]};
 const s=verificationInput(r,p,[],[]).CHECK_SCOPE;
 const output={fact_checks:[[0,true,true,1]],operation_checks:[],replacement_checks:[],message_checks:[[1,'represented',[0],[]]]};
 assert.deepEqual(verificationIssues(decodeCompactVerification(output,p,s).canonical,r,p),[]);
 output.fact_checks=[[0,true,true,0]];assert.match(verificationIssues(decodeCompactVerification(output,p,s).canonical,r,p)[0]!,/fact 0:/);
 output.fact_checks=[[0,true,true,9]];assert.match(decodeCompactVerification(output,p,s).protocolErrors.join(),/source slot/);
});
test('machine-only source references and unsupported modalities still reject a fact',()=>{
 const p=proposal();p.facts=p.facts.slice(0,1);p.operations=[];p.facts[0]!.sources=[{index:0,quote:'header-only'}];
 const r={...req,messages:[{...req.messages[0]!,content:'[Source id: header-only] Hello.'}]},s=verificationInput(r,p,[],[]).CHECK_SCOPE;
 const output={fact_checks:[[0,true,true,0]],operation_checks:[],replacement_checks:[],message_checks:[[0,'not_memorable']]};
 assert.match(verificationIssues(decodeCompactVerification(output,p,s).canonical,r,p)[0]!,/fact 0:/);
 const v=raw();v.fact_checks[0]=[0,true,false,null,'future plan is not current state'];const d=decodeCompactVerification(v,proposal(),scope());assert.deepEqual(d.protocolErrors,[]);assert.match(verificationIssues(d.canonical,req,proposal())[0]!,/future plan/);
});
test('out-of-range IDs, extra tuple fields and missing arrays cannot make positive certificates',async()=>{
 const invalids=[{...raw(),fact_checks:[[8,true,true,0],[1,true,true,0]]},{...raw(),replacement_checks:[[1,true]]},{...raw(),operation_checks:[[0,true,true,'',999]]},{...raw(),message_checks:undefined},{...raw(),overall_pass:true},{...raw(),fact_checks:[[0,true,true,0],[0,true,true,0],[1,true,true,0]]}];
 for(const output of invalids){const model=m(),state=new VerificationSession();let calls=0;model.json=async()=>{calls++;return output;};await assert.rejects(run(model,proposal(),state));assert.equal(calls,2);model.json=async(_s,input)=>{const d=JSON.parse(input);assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0,1]);assert.deepEqual(d.CHECK_SCOPE.operation_indices,[0]);return raw();};assert.deepEqual(await run(model,proposal(),state),[]);}
});
test('a malformed earlier array cannot erase a valid later missing-message rejection',async()=>{
 const model=m(),state=new VerificationSession();let calls=0;
 model.json=async()=>{calls++;return {...raw(),fact_checks:[[0,true,true,0],[0,true,true,0],[1,true,true,0]],message_checks:[[0,'missing',req.messages[0]!.content,'browser setup is missing'],[1,'represented',[1],[0]]]};};
 const issues=await run(model,proposal(),state);assert.ok(issues.some(x=>x.startsWith('message 0:')));assert.equal(calls,1);assert.deepEqual(await run(model,proposal(),state),issues);assert.equal(calls,1);
});
test('valid fact rejection survives a malformed sibling and creates no positive cache',async()=>{
 const model=m(),state=new VerificationSession();let calls=0;model.json=async()=>{calls++;return {...raw(),fact_checks:[[0,false,true,0,'unsupported claim'],[1,true,true,0]],operation_checks:'malformed'};};
 assert.match((await run(model,proposal(),state))[0]!,/fact 0:/);assert.equal(calls,1);
 const p=proposal();p.facts[0]!.content+=' Updated wording.';
 model.json=async(_s,input)=>{calls++;const d=JSON.parse(input);assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0,1]);return raw();};assert.deepEqual(await run(model,p,state),[]);assert.equal(calls,2);
});
test('a local repair uses compact scoped checks with full context and labeled source/target references',async()=>{
 const model=m(),state=new VerificationSession();let calls=0;
 model.json=async(_s,input,_signal,context)=>{const d=JSON.parse(input);calls++;assert.equal(d.VERIFICATION_PROTOCOL,COMPACT_VERIFICATION_PROTOCOL);assert.equal(context?.verification_format,COMPACT_VERIFICATION_PROTOCOL);assert.equal(d.PROPOSAL.facts.length,2);assert.equal(d.NEW_MESSAGES.length,2);assert.equal(d.PROPOSAL.facts[0].sources[0].source_slot,0);
  if(calls===1){assert.equal(d.REPLACEMENT_TARGETS[0].check_index,0);return {...raw(),fact_checks:[[0,false,true,0,'unsupported extra qualifier'],[1,true,true,0]]};}
  assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0]);assert.deepEqual(d.CHECK_SCOPE.message_indices,[0]);return {fact_checks:[[0,true,true,0]],operation_checks:[],replacement_checks:[],message_checks:[[0,'represented',[0],[]]]};
 };
 const p=proposal();assert.equal((await run(model,p,state)).length,1);p.facts[0]!.content+=' Corrected wording.';assert.deepEqual(await run(model,p,state),[]);assert.equal(calls,2);
});
test('format changes invalidate certificates and terse format cannot impersonate verbose output',async()=>{
 const config=configFromEnv({MEMORY_VERIFICATION_FORMAT:'compact'}),model=new Models(config),state=new VerificationSession();let calls=0;
 model.json=async()=>{calls++;return raw();};assert.deepEqual(await run(model,proposal(),state),[]);config.verificationFormat='verbose';
 model.json=async(_s,input)=>{calls++;assert.deepEqual(JSON.parse(input).CHECK_SCOPE.fact_indices,[0,1]);return decodeCompactVerification(raw(),proposal(),scope()).canonical;};assert.deepEqual(await run(model,proposal(),state),[]);assert.equal(calls,2);
 const compact=m();compact.json=async()=>decodeCompactVerification(raw(),proposal(),scope()).canonical;await assert.rejects(run(compact));
});

test('an invalid coverage reference is a protocol error when grounded source-linked items exist',async()=>{
 const model=m();let calls=0;model.json=async(_s,input)=>{calls++;const d=JSON.parse(input.split('\nPROTOCOL_REPAIR:')[0]!);assert.deepEqual(d.MESSAGE_SOURCE_LINKS,[{index:0,fact_indices:[0],operation_indices:[]},{index:1,fact_indices:[1],operation_indices:[0]}]);
  if(calls===1)return {...raw(),message_checks:[[0,'represented',[0,1],[]],[1,'represented',[1],[0]]]};
  assert.match(input,/PROTOCOL_REPAIR/);assert.deepEqual(d.CHECK_SCOPE.fact_indices,[]);return {fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[raw().message_checks[0]]};
 };assert.deepEqual(await run(model),[]);assert.equal(calls,2);
});
test('true missing content survives a sibling coverage-reference protocol failure without resampling',async()=>{
 const model=m(),state=new VerificationSession();let calls=0;model.json=async()=>{calls++;return {...raw(),message_checks:[[0,'missing',req.messages[0]!.content,'browser setup missing'],[1,'represented',[0,1],[0]]]};};
 const issues=await run(model,proposal(),state);assert.equal(calls,1);assert.equal(issues.length,1);assert.match(issues[0]!,/^message 0:/);
 assert.deepEqual(await run(model,proposal(),state),issues);assert.equal(calls,1);
 const p=proposal();p.facts[0]!.content+=' Restated browser setup.';
 model.json=async(_s,input)=>{calls++;const d=JSON.parse(input);assert.deepEqual(d.CHECK_SCOPE.fact_indices,[0,1]);assert.deepEqual(d.CHECK_SCOPE.message_indices,[0,1]);return raw();};
 assert.deepEqual(await run(model,p,state),[]);assert.equal(calls,2);
});
