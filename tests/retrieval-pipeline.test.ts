import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {retrieve,collectCandidates,packEvidence} from '../dist/retrieval.js';
import {Engine} from '../dist/engine.js';
import {estimateTokens} from '../dist/text.js';

const message=(content:string,timestamp='2026-01-01T00:00:00Z')=>({role:'user',content,timestamp});
const req=(id:string,content:string)=>({request_id:id,user_id:'u',session_id:'s',messages:[message(content)]});
async function fixture(fn:any){
 const dir=mkdtempSync(join(tmpdir(),'pipeline-'));const store=new TenantStore(dir,'u');
 const config={...configFromEnv({}),dataDir:dir,embeddingSpace:'test:2',embeddingDimensions:2};
 const x=new Extractor(config,{} as any);
 const add=async(id:string,content:string)=>{const r=req(id,content);const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(r,hash(JSON.stringify(r)),p,store.revision());return p;};
 try{await fn({dir,store,config,add});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('source vectors recover an unextracted detail with no lexical query overlap',()=>fixture(async({store,config}:any)=>{
 const r=req('raw','I carried a cerulean umbrella through the monsoon.');
 const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async()=>({facts:[],operations:[]}),embedBatch:async(texts:string[])=>texts.map(()=>[1,0])} as any);
 const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(r,hash(JSON.stringify(r)),p,store.revision());
 const q={user_id:'u',query:'rain protection hue',top_k:5};
 const frame=collectCandidates(store,q,[1,0],config);assert.ok(frame.ranked.some((c:any)=>c.signals.includes('source-semantic')));
 assert.match(JSON.stringify(packEvidence(store,q,config,frame)),/cerulean umbrella/);
 assert.deepEqual(retrieve(store,q,[1,0],{...config,rawFallback:false}),{data:[]});
 assert.deepEqual(retrieve(store,q,[1,0],{...config,embeddingSpace:'other:2'}),{data:[]});
}));
test('long messages keep bounded source passages and details omitted by extraction',()=>fixture(async({store,config}:any)=>{
 const content='This is generic background. '.repeat(150)+'I repaired the lantern with a cobalt screwdriver.';
 const r=req('long',content);const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async()=>({facts:[],operations:[]}),embedBatch:async()=>{throw Error('offline');}} as any);
 const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(r,hash(JSON.stringify(r)),p,store.revision());
 assert.ok(store.passages().every((p:any)=>p.content.length<=900));
 assert.match(JSON.stringify(retrieve(store,{user_id:'u',query:'cobalt screwdriver',top_k:5},null,config)),/cobalt screwdriver/);
}));
test('forget erases source intervals and vectors while preserving independent unextracted detail',()=>fixture(async({store,config}:any)=>{
 const content='My access code is ZX-482, and my umbrella is cerulean.';
 const r=req('mixed',content);const x=new Extractor({...config,mode:'enhanced'},{verify:async()=>[],json:async()=>({facts:[{content:'My access code is ZX-482.',subject:'user',predicate:'access_code',value:'ZX-482',sources:[{index:0,quote:'My access code is ZX-482'}]}],operations:[]}),embedBatch:async(texts:string[])=>texts.map(()=>[1,0])} as any);
 const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(r,hash(JSON.stringify(r)),p,store.revision());
 const deletion=req('erase','Forget my access code.');
 const offline=new Extractor(config,{} as any);const prepared=await offline.prepare(deletion,store.snapshot('s'),AbortSignal.timeout(1000));
 assert.throws(()=>store.commit(deletion,hash(JSON.stringify(deletion)),structuredClone(prepared),store.revision(),'indexes'));
 assert.ok(store.passages().some((p:any)=>p.content.includes('ZX-482')&&p.vector));
 store.commit(deletion,hash(JSON.stringify(deletion)),prepared,store.revision());
 assert.doesNotMatch(JSON.stringify(store.passages()),/ZX-482/);
 assert.ok(store.passages().some((p:any)=>p.content.includes('umbrella is cerulean')&&p.vector===null));
 assert.equal(store.lexicalPassages('ZX-482',20).length,0);
 const data=retrieve(store,{user_id:'u',query:'previous code umbrella cerulean',top_k:10},[1,0],config);
 assert.doesNotMatch(JSON.stringify(data),/ZX-482/);assert.match(JSON.stringify(data),/umbrella is cerulean/);
}));
test('source passages inherit current, historical and correction visibility',()=>fixture(async({store,config,add}:any)=>{
 await add('city-a','I live in Oslo. I like kayaking.');
 const r=req('city-b','I now live in Bergen.');r.messages[0]!.timestamp='2026-02-01T00:00:00Z';
 const x=new Extractor(config,{} as any);const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(r,hash(JSON.stringify(r)),p,store.revision());
 assert.doesNotMatch(JSON.stringify(retrieve(store,{user_id:'u',query:'current city Oslo',top_k:30},null,config)),/Oslo/);
 assert.match(JSON.stringify(retrieve(store,{user_id:'u',query:'previous city Oslo',top_k:30},null,config)),/Oslo/);
 assert.match(JSON.stringify(retrieve(store,{user_id:'u',query:'kayaking',top_k:30},null,config)),/kayaking/);
 const old=store.facts().find((f:any)=>f.value==='Oslo');const correction=req('correct','Correction: the old Oslo claim was wrong.');
 const cp=await x.prepare(correction,store.snapshot('s'),AbortSignal.timeout(1000));cp.facts=[];cp.passages=[];cp.operations=[{type:'correct',target_ids:[old.id],subject:'user',predicate:'current_city',scope:'',value:'Oslo',boundary:'value',source:{index:0,quote:correction.messages[0]!.content},reason:''}];store.commit(correction,hash(JSON.stringify(correction)),cp,store.revision());
 assert.doesNotMatch(JSON.stringify(retrieve(store,{user_id:'u',query:'previous city Oslo',top_k:30},null,config)),/Oslo/);
}));
test('reranking considers candidates beyond top_k and packs only the chosen evidence',()=>fixture(async({store,config,add}:any)=>{
 for(let i=0;i<45;i++)await add('candidate-'+i,`I like activity${i}.`);
 const engine=new Engine({...config,mode:'enhanced',rerank:true,rerankCandidates:80,maxEvidence:1,tokenBudget:200});
 const seen:{count:number;id?:string;label?:string}={count:0};
 (engine as any).models={embedBatch:async()=>{throw Error('offline');},json:async(_:string,user:string)=>{
  const rows=JSON.parse(user).evidence;seen.count=rows.length;assert.ok(rows.length>32);const chosen=rows.at(-1);assert.ok(chosen);seen.id=chosen.id;seen.label=chosen.content.match(/activity\d+/)[0];
  return {ranked:[{id:chosen.id,score:1}]};
 }};
 try{const result=await engine.search({user_id:'u',query:'hobby',top_k:1},AbortSignal.timeout(3000));assert.ok(seen.count>32);assert.equal(result.data.length,1);assert.equal(result.data[0]!.id,seen.id);assert.ok(result.data[0]!.content.includes(seen.label!));assert.ok(result.data.reduce((n,x)=>n+estimateTokens(x.content),0)<=200);}finally{await engine.close();}
}));
test('mutation during rerank invalidates its snapshot and rechecks all returned content',()=>fixture(async({config,add}:any)=>{
 await add('code','My access code is ZX-482. My manager is Alice.');
 const engine=new Engine({...config,mode:'enhanced',rerank:true,rerankPolicy:'selective',rerankFormat:'indices'});
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 (engine as any).models={embedBatch:async()=>{throw Error('offline');},json:async(_:string,user:string)=>{const rows=JSON.parse(user).evidence;assert.match(JSON.stringify(rows),/ZX-482/);entered();await gate;return {ranked:rows.map((x:any)=>[x.slot,1])};}};
 (engine as any).extractor=new Extractor(config,{} as any);
 try{const pending=engine.search({user_id:'u',query:'List all access code and manager records',top_k:10},AbortSignal.timeout(3000));await started;await engine.add(req('delete','Forget my access code.'),AbortSignal.timeout(3000));release();const result=await pending;assert.doesNotMatch(JSON.stringify(result),/ZX-482/);assert.match(JSON.stringify(result),/Alice/);}finally{release();await engine.close();}
}));
test('list packing prefers distinct items without increasing the terminal budget',()=>fixture(async({store,config,add}:any)=>{
 for(let i=0;i<4;i++)await add('item'+i,`I like item${i}.`);
 const q={user_id:'u',query:'List every hobby',top_k:2};const frame=collectCandidates(store,q,null,config);
 const atoms=frame.ranked.filter((c:any)=>c.fact.predicate==='hobby');assert.equal(atoms.length,4);
 const first=atoms[0];frame.ranked=[{...first,score:1},{fact:{...first.fact,id:'duplicate',content:'A second description of the same hobby.'},score:.99,signals:['fixture']},{...atoms[1],score:.9}];
 const rows=packEvidence(store,q,{...config,maxEvidence:2,tokenBudget:600},frame).data;
 assert.equal(rows.length,2);assert.ok(rows.some((r:any)=>r.id===atoms[1].fact.id));assert.ok(rows.every((r:any)=>r.id!=='duplicate'));
 assert.ok(rows.reduce((n:number,x:any)=>n+estimateTokens(x.content),0)<=600);
}));
test('stage audit contains identifiers and hashes, not secret-bearing content',()=>fixture(async({store,config,dir,add}:any)=>{
 await add('audit','My access code is ZX-482.');const old=process.env.MEMORY_RETRIEVAL_AUDIT;const path=join(dir,'stages.jsonl');process.env.MEMORY_RETRIEVAL_AUDIT=path;
 try{retrieve(store,{user_id:'u',query:'ZX-482',top_k:1},null,config);const text=readFileSync(path,'utf8');assert.doesNotMatch(text,/ZX-482|My access code/);const row=JSON.parse(text);assert.ok(row.candidate_ids.length);assert.ok(row.sources.length);assert.equal(row.selected.length,1);assert.ok(row.query_sha256);}finally{if(old===undefined)delete process.env.MEMORY_RETRIEVAL_AUDIT;else process.env.MEMORY_RETRIEVAL_AUDIT=old;}
}));
test('a representation switch requires fresh ingestion, even for a deletion-only chunk',()=>fixture(async({store,config,add}:any)=>{
 await add('before','My access code is ZX-482.');
 const r=req('switch','Forget my access code.');const x=new Extractor({...config,sourceIndex:false},{} as any);
 const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(p.passages.length,0);
 assert.throws(()=>store.commit(r,hash(JSON.stringify(r)),p,store.revision()),/Fresh data directory/);
 assert.ok(store.facts().some((f:any)=>f.value==='ZX-482'));assert.equal(store.revision(),1);
}));
test('a uniquely matching in-question candidate is forced to rank-1',()=>fixture(async({store,config,add}:any)=>{
 await add('door','My door code is 60148.');
 const q={user_id:'u',query:'Which of these two door codes would you choose, 60143 or 60148?',top_k:5};
 const frame=collectCandidates(store,q,null,config);
 const boosted=frame.ranked.find((c:any)=>c.signals.includes('candidate-exact'));
 assert.ok(boosted);assert.equal(frame.ranked[0].fact.id,boosted.fact.id);assert.match(boosted.fact.value,/60148/);
 // An unmatched digit near-duplicate never fuzzy-wins the stored code.
 const near=collectCandidates(store,{...q,query:'Which of these two door codes would you choose, 60143 or 60139?'},null,config);
 assert.ok(!near.ranked.some((c:any)=>c.signals.includes('candidate-exact')));
}));
test('self-referential queries rank the user above a named participant',()=>fixture(async({store,config,add}:any)=>{
 await add('mine','My favorite hobby is hiking.');
 const r=req('raj','Raj: My favorite hobby is chess.');const x=new Extractor(config,{} as any);
 const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(r,hash(JSON.stringify(r)),p,store.revision());
 const rows=retrieve(store,{user_id:'u',query:'my favorite hobby',top_k:5},null,config).data;
 assert.ok(rows.length>=2);assert.match(rows[0]!.content,/hiking/);assert.ok(rows.slice(1).some((row:any)=>/chess/.test(row.content)));
}));
