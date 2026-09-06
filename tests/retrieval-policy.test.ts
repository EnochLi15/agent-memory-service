import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {configFromEnv} from '../dist/config.js';import {intent,estimateTokens} from '../dist/text.js';
import {relationDecision,expandTypedRelations,rerankDecision} from '../dist/retrieval-policy.js';
import {collectCandidates,compactCandidates,retrieve} from '../dist/retrieval.js';import {TenantStore} from '../dist/storage.js';import {Engine} from '../dist/engine.js';
import type {Fact,Candidate} from '../dist/types.js';
const fact=(id:string,subject:string,predicate:string,value:string,more:Partial<Fact>={}):Fact=>({id,subject,predicate,value,content:`${subject}: ${predicate} is ${value}.`,scope:'',state:'active',kind:'fact',modality:'confirmed',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:['source-'+id],source_quotes:[`${subject}: ${predicate} is ${value}.`],created_at:'2026-01-01T00:00:00Z',observed_at:'2026-01-01T00:00:00Z',vector:null,entities:[subject,value],revision:1,...more});
const candidate=(f:Fact,score=.02):Candidate=>({fact:f,score,signals:['fixture']});
const config=()=>configFromEnv({MEMORY_MODE:'enhanced',MEMORY_RELATION_MODE:'conditional',MEMORY_RERANK:'true',MEMORY_RERANK_POLICY:'selective',MEMORY_RAW_FALLBACK:'false',MEMORY_EVENT_VIEW:'false'});
const chain=[fact('ab','Alice','friend','Bob'),fact('bc','Bob','employer','Cedar'),fact('cc','Cedar','location','Oslo'),fact('bh','Bob','hobby','kayaking'),fact('noise','Carol','hobby','skiing',{entities:['Alice','Bob','Cedar','Carol']})];
test('conditional expansion follows declared direction and requested relation, not co-occurrence',()=>{
 const query="Where does Alice's friend work?",qi=intent(query),input=[...chain,fact('wrong','Alice','manager','Diane')];
 const expanded=expandTypedRelations(query,qi,input,[candidate(chain[0])]);assert.ok(expanded.hits.some(h=>h.id==='ab'));assert.ok(expanded.hits.some(h=>h.id==='bc'));assert.ok(expanded.hits.some(h=>h.id==='cc'));assert.ok(expanded.hits.every(h=>!['noise','wrong'].includes(h.id)));
 const incoming=expandTypedRelations('Who is a friend of Bob?',intent('Who is a friend of Bob?'),chain,[]);assert.ok(incoming.hits.some(h=>h.id==='ab'&&h.direction==='incoming'));
});
test('relation gates respect master switch, direct evidence and bounded fallback',()=>{
 const c=config(),f=fact('browser','user','browser','Firefox'),q='What is my browser?';assert.equal(intent(q).list,false);assert.equal(intent('What hobbies does Alice have?').list,true);assert.equal(intent('Which city is my home?').list,false);
 assert.equal(relationDecision(q,intent(q),[candidate(f)],c).enabled,false);
 assert.equal(relationDecision('How are Alice and Bob connected?',intent('How are Alice and Bob connected?'),[],c).reason,'multiple_entities');
 assert.equal(relationDecision('What is my browser?',intent(q),[],c).reason,'weak_initial_evidence');
 assert.equal(relationDecision('Who is my manager?',intent('Who is my manager?'),[],{...c,experimental:{...c.experimental,multiHop:false}}).enabled,false);
 assert.equal(expandTypedRelations('Unrelated query',intent('Unrelated query'),chain,[]).hits.length,0);
});
test('time-incompatible, hypothetical and erased bridges cannot extend the relation path',()=>{
 const a=fact('ab','Alice','friend','Bob',{valid_from:'2020-01-01',valid_to:'2021-01-01'}),b=fact('bc','Bob','employer','Cedar',{valid_from:'2022-01-01'}),q="Where did Alice's friend work previously?";
 assert.ok(!expandTypedRelations(q,intent(q),[a,b],[]).hits.some(h=>h.id==='bc'));
 for(const more of [{modality:'hypothetical' as const},{state:'erased' as const},{state:'conflicted' as const},{source_ids:[],source_quotes:[]}])assert.equal(expandTypedRelations(q,intent(q),[{...a,...more},b],[]).hits.length,0);
});
test('relation traversal stays within node and evidence limits on a branching graph',()=>{
 const facts=Array.from({length:100},(_,i)=>fact('a'+i,'Alice','friend','Person'+i)).concat(Array.from({length:100},(_,i)=>fact('b'+i,'Person'+i,'employer','Firm'+i)));
 const r=expandTypedRelations("Where do Alice's friends work?",intent("Where do Alice's friends work?"),facts,[]);assert.ok(r.hits.length<=40);assert.ok(r.visited<=24);assert.equal(r.limit_reached,true);
});
test('selective rerank skips complete direct evidence but keeps ambiguous and complex cases',()=>{
 const c=config(),req={user_id:'u',query:'What is my browser?',top_k:32},ranked=[candidate(fact('a','user','browser','Firefox')),candidate(fact('b','user','color','blue'),.01)];
 const compact={data:ranked.map(r=>({id:r.fact.id,content:r.fact.content,score:r.score,created_at:r.fact.created_at}))};
 assert.equal(rerankDecision(req,intent(req.query),ranked,compact,c).reason,'fits_budget');
 assert.equal(rerankDecision({...req,query:'List all my browsers'},intent('List all my browsers'),ranked,compact,c).reason,'complex_query');
 assert.equal(rerankDecision(req,intent(req.query),ranked,compact,{...c,rerankPolicy:'always'}).enabled,true);
 const ambiguous=ranked.map(r=>({...r,score:.02}));assert.equal(rerankDecision({...req,top_k:1},intent(req.query),ambiguous,compact,c).reason,'ambiguous_candidates');
 assert.equal(rerankDecision(req,intent(req.query),ranked,{data:compact.data.slice(0,1)},c).reason,'too_few_candidates');
});
async function fixture(fn:(s:TenantStore,c:ReturnType<typeof config>,dir:string)=>Promise<void>){const dir=mkdtempSync(join(tmpdir(),'query-policy-')),c={...config(),dataDir:dir},s=new TenantStore(dir,'u');try{await fn(s,c,dir);}finally{s.close();rmSync(dir,{recursive:true,force:true});}}
test('conditional retrieval uses only visible grounded paths and returns evidence without invented conclusions',()=>fixture(async(s,c)=>{
 chain.forEach(f=>s.put(f));const q={user_id:'u',query:"What hobby does Alice's friend enjoy?",top_k:32};const frame=collectCandidates(s,q,null,c);
 assert.ok(frame.trace.relation_expansion?.hits.some(h=>h.id==='bh'));assert.ok(!frame.trace.relation_expansion?.hits.some(h=>h.id==='noise'));
 assert.match(JSON.stringify(retrieve(s,q,null,c)),/kayaking/);assert.doesNotMatch(JSON.stringify(retrieve(s,q,null,c)),/Alice likes kayaking/);
 s.put({...chain[0],state:'erased',content:'',value:'',source_quotes:[],source_ids:[]});const after=collectCandidates(s,q,null,c);assert.ok(!after.trace.relation_expansion?.hits.some(h=>h.id==='bh'));
}));
test('engine skips model rerank for direct evidence, reranks complex evidence and audits both decisions',()=>fixture(async(s,c,dir)=>{
 s.put(fact('a','user','browser','Firefox'));s.put(fact('b','user','browser','Safari'));const trace=join(dir,'trace.jsonl'),old=process.env.MEMORY_RETRIEVAL_AUDIT;process.env.MEMORY_RETRIEVAL_AUDIT=trace;const engine=new Engine(c);let calls=0;
 (engine as any).models={embedBatch:async()=>{throw Error('no embedding in deterministic test');},json:async(_p:string,input:string)=>{calls++;return {ranked:JSON.parse(input).evidence.map((x:any)=>({id:x.id,score:1}))};}};
 try{const direct=await engine.search({user_id:'u',query:'What is my browser?',top_k:32},AbortSignal.timeout(3000));assert.equal(calls,0);assert.equal(direct.data.length,2);const list=await engine.search({user_id:'u',query:'List all my browser preferences',top_k:32},AbortSignal.timeout(3000));assert.equal(calls,1);assert.ok(list.data.reduce((n,x)=>n+estimateTokens(x.content),0)<=c.tokenBudget);const logs=readFileSync(trace,'utf8');assert.doesNotMatch(logs,/Firefox|Safari|What is my browser/);const decisions=logs.trim().split('\n').map(JSON.parse).filter(x=>x.event==='retrieval_policy');assert.deepEqual(decisions.map(x=>x.rerank_outcome),['skipped','ok']);}finally{await engine.close();if(old===undefined)delete process.env.MEMORY_RETRIEVAL_AUDIT;else process.env.MEMORY_RETRIEVAL_AUDIT=old;}
}));
test('unsupported query policy configurations fail at startup',()=>{assert.throws(()=>configFromEnv({MEMORY_RELATION_MODE:'magic'}),/MEMORY_RELATION_MODE/);assert.throws(()=>configFromEnv({MEMORY_RERANK_POLICY:'sometimes'}),/MEMORY_RERANK_POLICY/);});
test('selective rerank malformed output falls back without exposing a foreign or erased ID',()=>fixture(async(s,c)=>{
 s.put(fact('a','user','browser','Firefox'));s.put(fact('b','user','browser','Safari'));s.put(fact('old','user','browser','SecretBrowser',{state:'erased'}));const engine=new Engine(c);let calls=0;
 (engine as any).models={embedBatch:async()=>{throw Error('no embedding');},json:async()=>{calls++;return {ranked:[{id:'foreign-tenant',score:1},{id:'old',score:1}]};}};
 try{const result=await engine.search({user_id:'u',query:'List all my browser preferences',top_k:32},AbortSignal.timeout(3000));assert.equal(calls,1);assert.equal(result.data.length,2);assert.doesNotMatch(JSON.stringify(result),/foreign-tenant|SecretBrowser/);}finally{await engine.close();}
}));
