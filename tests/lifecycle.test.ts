import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantStore} from '../dist/storage.js';
import {Extractor,hash} from '../dist/extraction.js';
import {Models} from '../dist/models.js';
import {configFromEnv} from '../dist/config.js';
import {retrieve} from '../dist/retrieval.js';
import {buildServer} from '../dist/server.js';

async function fixture(fn:any){const dir=mkdtempSync(join(tmpdir(),'memory-life-'));const s=new TenantStore(dir,'u');const c={...configFromEnv({}),maxEvidence:100};const x=new Extractor(c,new Models(c));let i=0;
 const prepare=async(content:string,date='2026-01-01T00:00:00Z')=>{const req={request_id:String(++i),user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp:date}]};return {req,p:await x.prepare(req,s.snapshot('s'),AbortSignal.timeout(1000))};};
 const commit=({req,p}:any)=>s.commit(req,hash(JSON.stringify(req)),p,s.revision());
 const add=async(content:string,date?:string)=>{const v=await prepare(content,date);commit(v);return v;};
 const find=(query:string)=>retrieve(s,{query,user_id:'u',top_k:100},null,c).data.map(f=>f.content).join('\n');
 try{await fn({s,c,x,prepare,commit,add,find});}finally{s.close();rmSync(dir,{recursive:true,force:true});}
}
test('same-time conflict stays explicit; later state resolves it; as-of honors day boundary',()=>fixture(async({add,find}:any)=>{
 await add('I live in Seattle.');await add('I live in Boston.');const conflict=find('current city');assert.match(conflict,/Seattle/);assert.match(conflict,/Boston/);assert.match(conflict,/conflicting confirmed claims/);
 await add('I live in Portland.','2026-02-01T00:00:00Z');assert.doesNotMatch(find('current city'),/Seattle|Boston/);assert.match(find('city as of 2026-01-01'),/Seattle/);assert.doesNotMatch(find('city as of 2026-01-01'),/Portland/);
}));
test('new raw replay and differently named fact cannot recover erased value',()=>fixture(async({add,prepare,commit,find,s}:any)=>{
 await add('My access code is ZX-482. My manager is Alice.');await add('Forget my access code.');
 const replay=await prepare('I recall my code ZX-482.');replay.p.facts=[];commit(replay);
 await add('I once used ZX-482 at the gate.');assert.doesNotMatch(find('previous code ZX-482 gate'),/ZX-482/);assert.match(find('manager'),/Alice/);
 assert.ok(s.raw().every((m:any)=>!m.content.includes('ZX-482')));assert.ok(s.snapshot('s').tail.every((m:any)=>!m.content.includes('ZX-482')));
}));
test('erasure invalidates transitive derived facts but retains independent same-message neighbor',()=>fixture(async({add,prepare,commit,find,s}:any)=>{
 await add('My access code is ZX-482. My manager is Alice.');const root=s.facts().find((f:any)=>f.predicate==='access_code');
 const a=await prepare('I infer a security habit from the code.');a.p.facts[0].modality='inferred';a.p.facts[0].depends_on=[root.id];commit(a);
 const b=await prepare('I infer a broader pattern from that habit.');b.p.facts[0].modality='inferred';b.p.facts[0].depends_on=[a.p.facts[0].id];commit(b);
 await add('Forget my access code.');assert.doesNotMatch(find('history habit broader pattern code'),/ZX-482|security habit|broader pattern/);assert.match(find('manager'),/Alice/);
}));
test('explicit restore grants only new value and leaves old replay blocked',()=>fixture(async({add,find}:any)=>{
 await add('My access code is ZX-482.');await add('Forget my access code.');
 await add('Remember again: my access code is NEW-927.','2026-02-01T00:00:00Z');assert.match(find('access code'),/NEW-927/);
 await add('My access code is ZX-482.','2026-03-01T00:00:00Z');assert.doesNotMatch(find('history access code'),/ZX-482/);assert.match(find('access code'),/NEW-927/);
}));
test('correction retracts false history; scoped current relation removal preserves real history',()=>fixture(async({add,prepare,commit,s,find}:any)=>{
 await add('My manager is Alice.');const old=s.facts()[0];const v=await prepare('Correction: my manager is Beth.','2026-02-01T00:00:00Z');v.p.operations=[{type:'correct',target_ids:[old.id],subject:old.subject,predicate:old.predicate,scope:old.scope,value:old.value,boundary:'value',source:{index:0,quote:v.req.messages[0].content},reason:'Wrong name'}];v.p.facts[0].subject=old.subject;commit(v);assert.doesNotMatch(find('previous manager history'),/Alice/);assert.match(find('manager'),/Beth/);
 const current=s.facts().find((f:any)=>f.state==='active');const r=await prepare('Remove Beth from my current colleagues.','2026-03-01T00:00:00Z');r.p.facts=[];r.p.operations=[{type:'retract',target_ids:[current.id],subject:current.subject,predicate:current.predicate,scope:current.scope,value:current.value,boundary:'current_relation',source:{index:0,quote:r.req.messages[0].content},reason:'Transfer'}];commit(r);assert.doesNotMatch(find('current manager'),/Beth/);assert.match(find('previous manager'),/Beth/);
}));
test('embedding space mismatch rolls back request and original source',()=>fixture(async({prepare,commit,s}:any)=>{
 const a=await prepare('I like painting.');a.p.facts[0].vector=[1,0];a.p.embeddingSpace='a:2';commit(a);
 const b=await prepare('I like hiking.');b.p.facts[0].vector=[0,1];b.p.embeddingSpace='b:2';assert.throws(()=>commit(b),/Rebuild required/);assert.equal(s.revision(),1);assert.equal(s.facts().length,1);assert.equal(s.snapshot('s').tail.length,1);
}));
test('invalid extraction schema and wrong vector dimensions degrade without fabricated vectors',()=>fixture(async({s,c}:any)=>{
 let calls=0;const models={json:async()=>{calls++;return {bad:true};},embedBatch:async()=>{throw new Error('dimension');}};
 const x=new Extractor({...c,mode:'enhanced'},models as any);const p=await x.prepare({request_id:'a',user_id:'u',session_id:'s',messages:[{role:'user',content:'I like hiking.',timestamp:'2026-01-01T00:00:00Z'}]},s.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,2);assert.deepEqual(p.degraded,['extraction_offline','embedding_lexical']);assert.ok(p.facts.every(f=>f.vector===null));
}));
test('fabricated source falls back to grounded extraction; unknown operation ID is rejected',()=>fixture(async({s,c}:any)=>{
 const req={request_id:'a',user_id:'u',session_id:'s',messages:[{role:'user',content:'I like hiking.',timestamp:'2026-01-01T00:00:00Z'}]};
 const x=new Extractor({...c,mode:'enhanced'},{json:async()=>({facts:[{content:'I like swimming.',subject:'user',predicate:'hobby',value:'swimming',sources:[{index:0,quote:'swimming'}]}],operations:[]})} as any);
 const p=await x.prepare(req,s.snapshot('s'),AbortSignal.timeout(1000));assert.ok(p.degraded.includes('extraction_offline'));assert.ok(p.facts.every(f=>!f.content.includes('swimming')));assert.ok(p.facts.some(f=>f.content.includes('hiking')));
 const bad=new Extractor({...c,mode:'enhanced'},{json:async()=>({facts:[],operations:[{type:'forget',target_ids:['other-tenant-id'],subject:'user',predicate:'hobby',source:{index:0,quote:'I like hiking.'}}]})} as any);await assert.rejects(()=>bad.prepare(req,s.snapshot('s'),AbortSignal.timeout(1000)),/Unknown memory operation target/);assert.equal(s.revision(),0);
}));

test('bounded entity expansion retrieves the second hop without inventing a conclusion',()=>fixture(async({prepare,commit,s,c}:any)=>{
 const a=await prepare('Alice: My friend is Bob.');a.p.facts[0].entities=['Alice','Bob'];commit(a);
 const b=await prepare('Bob: I like kayaking.');b.p.facts[0].entities=['Bob'];commit(b);
 const rows=retrieve(s,{query:"What hobby does Alice's friend enjoy?",user_id:'u',top_k:100},null,c).data;
 assert.ok(rows.some((x:any)=>x.content.includes('friend is Bob')));assert.ok(rows.some((x:any)=>x.content.includes('kayaking')));assert.ok(rows.every((x:any)=>!x.content.includes('Alice likes kayaking')));
}));

test('querying with another embedding space uses lexical fallback rather than mixing vectors',()=>fixture(async({prepare,commit,s,c}:any)=>{
 const a=await prepare('I like kayaking.');a.p.facts[0].vector=[1,0];a.p.embeddingSpace='old:2';commit(a);
 assert.equal(retrieve(s,{query:'unrelated-nonce',user_id:'u',top_k:10},[1,0],{...c,embeddingSpace:'new:2'}).data.length,0);
 assert.ok(retrieve(s,{query:'unrelated-nonce',user_id:'u',top_k:10},[1,0],{...c,embeddingSpace:'old:2'}).data.length>0);
}));

test('a valid but unrelated target ID cannot authorize deletion',()=>fixture(async({s,c,add}:any)=>{
 await add('I like coffee.');const f=s.facts()[0];const req={request_id:'bad',user_id:'u',session_id:'s',messages:[{role:'user',content:'That gym schedule is wrong. Do not store that.',timestamp:'2026-01-02T00:00:00Z'}]};
 const x=new Extractor({...c,mode:'enhanced'},{json:async()=>({facts:[],operations:[{type:'forget',target_ids:[f.id],subject:f.subject,predicate:f.predicate,source:{index:0,quote:req.messages[0].content}}]})} as any);
 const p=await x.prepare(req,s.snapshot('s'),AbortSignal.timeout(1000));assert.equal(p.operations.length,0);assert.ok(p.degraded.includes('extraction_offline'));assert.equal(s.facts()[0].state,'active');
}));
