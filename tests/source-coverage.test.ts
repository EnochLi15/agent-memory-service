import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {sourceCoverageWork,makeSourceCoveragePlan,validateSourceCoveragePlan,assertSourceCoverageStored} from '../dist/source-coverage.js';
import {preparePassages,redactPassage} from '../dist/passages.js';
import {decodeCompactVerification} from '../dist/verification-compact.js';import {verificationIssues} from '../dist/verification.js';import {VerificationSession} from '../dist/verification-session.js';
import {extractionSchema} from '../dist/types.js';import {configFromEnv} from '../dist/config.js';import {Models} from '../dist/models.js';import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';
const timestamp='2026-01-01T00:00:00Z',req={user_id:'u',request_id:'context',session_id:'s',messages:[{role:'user',content:'That makes me feel relieved.',timestamp}]},empty={facts:[],operations:[]};
const env={MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SEMANTIC_TRANSITIONS:'true',MEMORY_SOURCE_OPERATIONS:'true',MEMORY_SOURCE_OPERATION_HISTORY:'true',MEMORY_SOURCE_OPERATION_BATCHES:'true',MEMORY_SOURCE_OPERATION_ROUTING:'true',MEMORY_EXTRACTION_FORMAT:'source_refs',MEMORY_VERIFICATION_FORMAT:'compact',MEMORY_SOURCE_FIRST:'true'};
const response=(rows:any[])=>({fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:rows});
test('raw coverage candidates exclude assistants, commands and all declared fact witnesses',()=>{
 const r={...req,messages:[...req.messages,{role:'assistant',content:'You use Firefox.',timestamp},{role:'user',content:'My browser is Firefox. That is a relief.',timestamp},{role:'user',content:'Forget my access code 9182.',timestamp}]},p=extractionSchema.parse({facts:[{content:'My browser is Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:2,quote:'My browser is Firefox.'}]}],operations:[]}),w=sourceCoverageWork(r,p);
 assert.equal(w.candidates.length,2);assert.ok(w.candidates.every(c=>c.message===0||c.message===2));assert.ok(w.candidates.every(c=>!c.quote.includes('Firefox')&&!c.quote.includes('9182')));
 for(const c of w.candidates)assert.equal(r.messages[c.message].content.slice(c.start,c.end),c.quote);
 assert.equal(sourceCoverageWork({...req,messages:[{...req.messages[0],content:'[Source id: header-only]'}]},empty).candidates.length,0);
});
test('source-backed tuples require opted-in exact human references and an explicit classification',()=>{
 const w=sourceCoverageWork(req,empty),scope={fact_indices:[],operation_indices:[],replacements:[],message_indices:[0]},raw=response([[0,'source_backed',[0],'Incidental emotional reaction, no new enduring state.']]);
 assert.ok(decodeCompactVerification(raw,empty,scope).protocolErrors.length);const d=decodeCompactVerification(raw,empty,scope,w);assert.deepEqual(d.protocolErrors,[]);assert.deepEqual(verificationIssues(d.canonical,req,empty,w),[]);assert.throws(()=>verificationIssues(d.canonical,req,empty),/Unexpected raw/);
 for(const row of [[0,'source_backed',[],'context'],[0,'source_backed',[0],''],[0,'represented',[],[],[0]]])assert.ok(decodeCompactVerification(response([row]),empty,scope,w).protocolErrors.length);
 const wrong=structuredClone(d.canonical);wrong.message_checks[0].raw_slots=[999];assert.throws(()=>verificationIssues(wrong,req,empty,w),/Invalid raw/);
});
test('one participant raw witness cannot cover another participant or replace missing core facts',()=>{
 const r={...req,messages:[...req.messages,{role:'user',content:'My favorite browser is Firefox.',timestamp}]},w=sourceCoverageWork(r,empty),raw=response([{index:0,disposition:'represented',raw_slots:[0],reason:'Incidental context.'},{index:1,disposition:'represented',raw_slots:[0],reason:'context'}]);assert.throws(()=>verificationIssues(raw,r,empty,w),/Invalid raw/);
 const session=new VerificationSession(),plan=session.plan(r,empty,[],{protocol:'test'},w),reject=response([{index:0,disposition:'represented',raw_slots:[0],reason:'Incidental context.'},{index:1,disposition:'missing',quote:'My favorite browser is Firefox.',reason:'A lasting preference needs a structured fact.'}]);assert.match(session.evaluate(plan,reject).join(' '),/lasting preference/);assert.throws(()=>session.acceptedSourceCoverage(r,empty),/lacks an accepted/);assert.ok(session.plan(r,empty,[],{protocol:'test'},w).blockedFindings.length);
});
test('coverage certificates bind candidate changes and cannot survive a rejected sibling',()=>{
 const session=new VerificationSession(),w=sourceCoverageWork(req,empty),plan=session.plan(req,empty,[],{},w),rows=[{index:0,disposition:'represented',raw_slots:[0],reason:'Incidental context.'}];assert.deepEqual(session.evaluate(plan,response(rows)),[]);assert.equal(session.acceptedSourceCoverage(req,empty).length,1);
 const changed=extractionSchema.parse({facts:[{subject:'user',predicate:'reaction',value:'relieved',content:req.messages[0].content,sources:[{index:0,quote:req.messages[0].content}]}],operations:[]}),next=session.plan(req,changed,[],{},sourceCoverageWork(req,changed));assert.equal(next.reused,0);assert.throws(()=>session.acceptedSourceCoverage(req,empty),/lacks an accepted/);
});
test('source-first configuration requires indexed hybrid raw evidence and the coverage protocol',()=>{
 assert.equal(configFromEnv({}).sourceFirst,false);assert.equal(configFromEnv(env).sourceFirst,true);
 for(const override of [{MEMORY_RAW_FALLBACK:'false'},{MEMORY_SOURCE_INDEX:'false'},{MEMORY_RETRIEVAL:'classic'},{MEMORY_RETRIEVAL:'lexical'},{MEMORY_VERIFICATION_FORMAT:'verbose'},{MEMORY_EXTRACTION_FORMAT:'flat'}])assert.throws(()=>configFromEnv({...env,...override}),/Source-first requires/);
});
test('v10 real preparation flow requires independent raw coverage and atomic indexed witnesses',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-first-')),store=new TenantStore(dir,'u'),config=configFromEnv(env),models=new Models(config);let sawPrompt=false;
 models.json=async(system:string,input:string,_s:AbortSignal,ctx:any)=>{const x=JSON.parse(input);if(ctx.purpose==='extraction'){assert.match(system,/Source-first representation/);return {message_groups:[{message_index:0,facts:[],operations:[]}]};}assert.equal(ctx.purpose,'verification');assert.match(system,/Necessary durable preferences/);assert.equal(x.VERIFICATION_PROTOCOL,'source-first-coverage-tuples-v1');sawPrompt=true;return response([[0,'source_backed',[x.SOURCE_COVERAGE_CANDIDATES[0].slot],'Incidental reaction without a durable state or instruction.']]);};models.embedBatch=async(xs:string[])=>xs.map(()=>[1,0]);
 try{const before=store.snapshot('s'),p=await new Extractor(config,models).prepare(req,before,AbortSignal.timeout(3000));assert.ok(sawPrompt);assert.equal(p.sourceFormat,'dual-source-v10-s1');assert.equal(p.facts.length,0);assert.ok(p.sourceCoveragePlan);
 const tampered=structuredClone(p);tampered.sourceCoveragePlan!.rows[0].raw_slots=[];assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),tampered,0),/identity/);assert.deepEqual(store.snapshot('s'),before);
 const absent=structuredClone(p);absent.passages=[];assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),absent,0),/not indexed/);assert.deepEqual(store.snapshot('s'),before);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);
 const redacted=structuredClone(p);redacted.passages![0].fragments[0].text='Removed.';redacted.passages![0].content='Removed.';assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),redacted,0),/not indexed/);assert.deepEqual(store.snapshot('s'),before);
 assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),p,0,'indexes'));assert.deepEqual(store.snapshot('s'),before);store.commit(req,hash(JSON.stringify(req)),p,0);assert.equal(store.meta('source_format'),'dual-source-v10-s1');assert.ok(store.lexicalPassages('relieved',5).length);assert.equal(store.revision(),1);
 const shifted=structuredClone(p);shifted.messages[0].content+=' Changed.';assert.throws(()=>validateSourceCoveragePlan(p.sourceCoveragePlan,req,shifted),/identity/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('coverage cannot be fabricated by bypassing the independent verifier',async()=>{
 const config=configFromEnv(env),models={json:async()=>({message_groups:[{message_index:0,facts:[],operations:[]}]}),verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 await assert.rejects(()=>new Extractor(config,models as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(3000)),/coverage|Coverage/);
});

// Exact source coverage after an independently authorized erasure. Supplying
// these cuts is internal to the transaction; no model coverage verdict grants it.
function coverageFixture(){
 const r={...req,messages:[{role:'user',content:'Appointment context; independent context.',timestamp}]};
 const message={...r.messages[0],id:hash(`${r.user_id}\0${r.request_id}\0${0}`),session_id:r.session_id,ordinal:0,searchable:true};
 const p:any={facts:[],operations:[],messages:[message],passages:preparePassages([message],[],[],1),degraded:[],anchor:null};
 const plan=makeSourceCoveragePlan(r,p,[{index:0,disposition:'represented',raw_slots:[0],reason:'Incidental context.'}]);
 return {r,p,plan,id:message.id};
}
test('authorized full erasure discharges raw coverage without requiring the forgotten witness to remain indexed',()=>{
 const {r,p,plan,id}=coverageFixture(),cuts=new Map([[id,[{start:0,end:r.messages[0].content.length}]]]);
 for(const passage of p.passages)redactPassage(passage,cuts.get(id)!);
 assert.doesNotThrow(()=>assertSourceCoverageStored(plan,r,p,p.passages,new Set(),cuts));
 const leaked=structuredClone(p.passages);leaked[0].content=r.messages[0].content;
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,leaked,new Set(),cuts),/retained an authorized erasure/);
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,p.passages,new Set([p.passages[0].id]),cuts),/retained an authorized erasure/);
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,p.passages,new Set()),/not indexed/);
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,p.passages,new Set(),new Map([['another-source',cuts.get(id)!]])),/not indexed/);
});
test('partial authorized erasure still requires the exact independent survivor in the index',()=>{
 const {r,p,plan,id}=coverageFixture(),end=r.messages[0].content.indexOf('independent'),cuts=new Map([[id,[{start:0,end}]]]);
 for(const passage of p.passages)redactPassage(passage,cuts.get(id)!);
 const indexed=new Set<string>(p.passages.map((x:any)=>x.id));
 const original=preparePassages(p.messages,[],[],1);
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,original,indexed,cuts),/retained an authorized erasure/);
 assert.doesNotThrow(()=>assertSourceCoverageStored(plan,r,p,p.passages,indexed,cuts));
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,p.passages,new Set(),cuts),/not indexed/);
 const changed=structuredClone(p.passages);changed[0].fragments[0].text='fabricated survivor';
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,changed,indexed,cuts),/not indexed/);
 const linked=structuredClone(p.passages);linked[0].fact_ids=['unrelated-state'];
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,linked,indexed,cuts),/not indexed/);
});
test('removing more than the authorized raw interval is still rejected',()=>{
 const {r,p,plan,id}=coverageFixture(),end=r.messages[0].content.indexOf('independent'),cuts=new Map([[id,[{start:0,end}]]]);
 for(const passage of p.passages)redactPassage(passage,[{start:0,end:r.messages[0].content.length}]);
 assert.throws(()=>assertSourceCoverageStored(plan,r,p,p.passages,new Set(),cuts),/not indexed/);
});
