import {test} from 'node:test';import assert from 'node:assert/strict';
import {erasureWork,decodeErasure,validateErasurePlan,protectBoundary} from '../dist/erasure.js';
import {sourceErasureWork} from '../dist/source-erasure.js';
import {factSchema,operationSchema} from '../dist/types.js';
const req={request_id:'forget',user_id:'u',session_id:'s',messages:[{role:'user',content:"Forget Rowan's outing details.",timestamp:'2026-01-02T00:00:00Z'}]};
const fact=(id:string,content:string,quote:string,fields:any={})=>({...factSchema.parse({content,subject:'user',predicate:'preference',scope:'',value:'hiking',sources:[{index:0,quote}],...fields}),id,source_ids:[id+'-source'],source_quotes:[quote],source_spans:[],created_at:'2026-01-01T00:00:00Z',observed_at:'2026-01-01T00:00:00Z',state:'active',vector:null,entities:[],revision:1});
const target=fact('target','Rowan visited the cafe with the user.','I went to Cafe North with Rowan.',{subject:'Rowan',predicate:'outing_companion',scope:'Cafe North',value:'user'});
const op=operationSchema.parse({type:'forget',subject:'Rowan',predicate:target.predicate,scope:target.scope,value:'user',target_ids:['target'],source:{index:0,quote:req.messages[0].content}});
const independent=(i:number)=>fact('independent-'+i,i%3===2?`Hiking trail ${i} helps the user relax.`:`${i%2?'The user':'User'} likes hiking trail ${i}.`,i%3===2?`Hiking trail ${i} helps me relax.`:`I like hiking trail ${i}.`,{value:'hiking trail '+i});
test('generated User labels do not exhaust erasure capacity for unrelated sourced preferences',()=>{
 const prior=[target,...Array.from({length:70},(_,i)=>independent(i))];
 const work=erasureWork(req,prior,[],[op],[]);assert.deepEqual(work.candidates,[]);assert.deepEqual(work.automatic,[]);
 const sourceWork=sourceErasureWork(req,prior,[],[op],[],[],[]);assert.deepEqual(sourceWork.candidates,[],'the source erasure stage must not reintroduce role-only fact collisions');
});
test('inverse relations, same-context facts, shared witnesses and dependencies still require an erasure decision',()=>{
 const inverse=fact('inverse','User visited the cafe with Rowan.','I went with Rowan.',{predicate:'visit_company',scope:'',value:'Rowan'});
 const sameScope=fact('scope','User ordered tea.','I ordered tea.',{scope:'Cafe North',value:'tea'});
 const shared=fact('shared','User enjoyed the outing.','I enjoyed the outing.',{value:'enjoyed it',source_ids:[]});shared.source_ids=target.source_ids;
 const dependent=fact('dependent','The user enjoyed it.','I enjoyed it.',{value:'enjoyed it',depends_on:['target']});
 const work=erasureWork(req,[target,independent(0),inverse,sameScope,shared,dependent],[],[op],[]);
 assert.deepEqual(new Set(work.candidates.map(c=>c.fact_id)),new Set(['inverse','scope','shared','dependent']));
 const raw={decisions:work.candidates.map((c,index)=>({index,effect:c.fact_id==='scope'?'retain':'erase',quote:c.fact.source_quotes[0],reason:c.fact_id==='scope'?'Separately supported tea order.':'The authorized outing relationship or dependent claim.'}))};
 const plan=decodeErasure(raw,work);assert.doesNotThrow(()=>validateErasurePlan(plan,work));
 const sourceWork=sourceErasureWork(req,[target,independent(0),inverse,sameScope,shared,dependent],[],[op],[],[],[]);
 assert.ok(sourceWork.candidates.some(c=>c.id==='inverse'));assert.ok(!sourceWork.candidates.some(c=>c.id==='independent-0'));
});
test('authored user literals and actual user values cannot be hidden by a generated subject prefix',()=>{
 const literal=fact('literal','User uses the code user.','My code is user.',{predicate:'access_code',value:'user'});
 const quoted=fact('quote','The user recalls a label.','The label was user.',{value:'label'});
 const value=fact('value','User is the selected account.','That is the selected account.',{predicate:'account_name',value:'user'});
 const work=erasureWork(req,[target,literal,quoted,value],[],[op],[]);
 assert.deepEqual(new Set(work.candidates.map(c=>c.fact_id)),new Set(['literal','quote','value']));
 assert.throws(()=>decodeErasure({decisions:work.candidates.map((c,index)=>({index,effect:'retain',quote:c.fact_id==='value'?'That is the selected account.':c.fact.source_quotes[0],reason:'Claimed different literal.'}))},work),/Independent-value witness/);
});
test('genuine same-value evidence remains subject to the unchanged 64-pair admission guard',()=>{
 const prior=[target,...Array.from({length:65},(_,i)=>fact('literal-'+i,`Account ${i} has label user.`,`Account ${i} has label user.`,{subject:'account '+i,value:'user'}))];
 assert.throws(()=>erasureWork(req,prior,[],[op],[]),/64 ambiguous evidence pairs/);
});
test('protected historical relationship boundaries still review named and same-scope echoes',()=>{
 const initial=erasureWork(req,[target,fact('echo','User visited Cafe North with Rowan.','I went with Rowan.',{value:'Rowan',scope:'Cafe North'})],[],[op],[]);
 const boundary=protectBoundary(initial.candidates[0].boundary);
 const incoming=[independent(0),fact('later','The user went with Rowan.','I went with Rowan.',{value:'Rowan'})];
 const work=erasureWork(req,[],incoming,[],[boundary]);assert.deepEqual(work.candidates.map(c=>c.fact_id),['later']);
});

test('committing and restarting after erasing literal code user preserves normalized user facts but blocks code replay',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {TenantStore}=await import('../dist/storage.js'),{Extractor,hash}=await import('../dist/extraction.js'),{configFromEnv}=await import('../dist/config.js');
 const dir=mkdtempSync(join(tmpdir(),'role-erasure-')),config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true'});let store=new TenantStore(dir,'u');
 const prepare=async(r:any,proposal:any)=>new Extractor(config,{verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,_i:string,_signal:any,context:any)=>{assert.notEqual(context.purpose,'erasure_binding','an independent role label is not an ambiguous literal');return structuredClone(proposal);}} as any).prepare(r,store.snapshot('s'),AbortSignal.timeout(2000));
 const make=(request_id:string,contents:string[])=>({request_id,user_id:'u',session_id:'s',messages:contents.map(content=>({role:'user',content,timestamp:'2026-01-01T00:00:00Z'}))});
 const city={content:'The user lives in Oslo.',subject:'user',predicate:'city',scope:'',value:'Oslo',sources:[{index:1,quote:'I live in Oslo.'}]};
 const code={content:'User uses access code user.',subject:'user',predicate:'access_code',scope:'',value:'user',sources:[{index:0,quote:'My access code is user.'}]};
 try{
  const seed=make('seed',['My access code is user.','I live in Oslo.']);store.commit(seed,hash(JSON.stringify(seed)),await prepare(seed,{facts:[code,city],operations:[]}),0);
  const target=store.facts().find(f=>f.predicate==='access_code')!;const del=make('delete',['Forget my access code user.']);
  store.commit(del,hash(JSON.stringify(del)),await prepare(del,{facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'access_code',scope:'',value:'user',source:{index:0,quote:del.messages[0].content}}]}),1);store.close();store=new TenantStore(dir,'u');
  assert.ok(store.facts().some(f=>f.predicate==='city'&&f.state==='active'&&f.value==='Oslo'));
  assert.ok(store.facts().some(f=>f.predicate==='access_code'&&f.state==='erased'&&!f.value&&!f.content&&!f.source_quotes.length));
  const echo=make('echo',['My access code is user.']);store.commit(echo,hash(JSON.stringify(echo)),await prepare(echo,{facts:[code],operations:[]}),2);
  assert.ok(store.facts().filter(f=>f.predicate==='access_code').every(f=>f.state==='erased'));assert.ok(store.facts().some(f=>f.predicate==='city'&&f.state==='active'&&f.value==='Oslo'));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
