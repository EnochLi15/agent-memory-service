import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';
import {decodeTransitions,transitionWork} from '../dist/transitions.js';import {retrieve} from '../dist/retrieval.js';
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SEMANTIC_TRANSITIONS:'true'});
const req=(id:string,content:string,date='2026-01-01')=>({user_id:'u',request_id:id,session_id:'s',messages:[{role:'user',content,timestamp:date+'T00:00:00Z'}]});
const fact=(content:string,value:string,predicate='coffee_preference',more:any={})=>({content,value,subject:'user',predicate,scope:'',modality:'confirmed',cardinality:'single',sources:[{index:0,quote:content}],...more});
async function fixture(body:any){
 const dir=mkdtempSync(join(tmpdir(),'transitions-')),store=new TenantStore(dir,'u');let calls=0;
 const prepare=async(r:any,facts:any[],relation='compatible',operations:any[]=[])=>new Extractor(config,{verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_system:string,input:string,_signal:any,ctx:any)=>{
  const data=JSON.parse(input);
  if(ctx.purpose==='state_transition'){calls++;return {decisions:data.CANDIDATES.map((c:any,index:number)=>({index,relation,old_quote:c.old.source_quotes[0],new_quote:c.incoming.source_quotes[0],reason:'Fixture relationship supported by the cited statements.'}))};}
  if(ctx.purpose==='erasure_binding')return {decisions:data.CANDIDATES.map((c:any,index:number)=>({index,effect:'erase',quote:c.fact.source_quotes[0],reason:'Fixture forget scope.'}))};
  if(ctx.purpose==='source_erasure')return {decisions:data.CANDIDATES.map((c:any,index:number)=>({index,parts:[{text:c.text,effect:'erase'}],reason:'Fixture authorized forgotten property.'}))};
  return {facts,operations};
 }} as any).prepare(r,store.snapshot('s'),AbortSignal.timeout(2000));
 const commit=(r:any,p:any,failAt?:string)=>store.commit(r,hash(JSON.stringify(r)),p,store.revision(),failAt);
 try{await body({store,prepare,commit,calls:()=>calls});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('compatible detail survives duplicate-source merging followed by a single-valued routine',()=>fixture(async({store,prepare,commit,calls}:any)=>{
 const detail='I drink black drip coffee every morning, no milk, no sugar.',routine='I like a plain cup of coffee routine.';
 const a=req('a',detail);commit(a,await prepare(a,[fact(detail,'black drip coffee')]));
 const b=req('b',detail+' '+routine,'2026-01-02');const p=await prepare(b,[fact(detail,'black drip coffee'),fact(routine,'plain cup of coffee routine')]);
 assert.equal(p.transitionPlan.decisions[0].relation,'compatible');commit(b,p);assert.equal(calls(),1);assert.equal(store.meta('source_format'),'dual-source-v5');
 assert.ok(store.facts().every((f:any)=>f.state==='active'));assert.equal(store.facts().length,2);assert.ok(store.snapshot('s').erasureSources);
 const data=retrieve(store,{query:'coffee milk sugar',user_id:'u',top_k:32},null,config).data;
 assert.match(JSON.stringify(data),/black drip coffee/);assert.match(JSON.stringify(data),/no milk, no sugar/);
 assert.ok(!store.events().some((e:any)=>e.type==='update'));
}));
test('exclusive later state replaces the old value while preserving its legitimate history',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','I live in Paris.');commit(a,await prepare(a,[fact(a.messages[0].content,'Paris','current_city')]));
 const b=req('b','I now live in Berlin.','2026-02-01');commit(b,await prepare(b,[fact(b.messages[0].content,'Berlin','current_city')],'exclusive'));
 assert.equal(store.facts().find((f:any)=>f.value==='Paris').state,'superseded');assert.equal(store.facts().find((f:any)=>f.value==='Berlin').state,'active');
 assert.ok(store.events().some((e:any)=>e.type==='update'));assert.match(JSON.stringify(retrieve(store,{query:'Paris previous history',user_id:'u',top_k:32},null,config).data),/Paris/);
}));
test('exclusive backdated information cannot displace a later known state',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','I live in Berlin.','2026-02-01');commit(a,await prepare(a,[fact(a.messages[0].content,'Berlin','current_city')]));
 const b=req('b','I live in Paris.','2026-01-01');commit(b,await prepare(b,[fact(b.messages[0].content,'Paris','current_city')],'exclusive'));
 assert.equal(store.facts().find((f:any)=>f.value==='Berlin').state,'active');assert.equal(store.facts().find((f:any)=>f.value==='Paris').state,'superseded');
}));
test('exclusive states at the same effective time remain conflicted rather than picking a winner',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','I live in Paris.');commit(a,await prepare(a,[fact(a.messages[0].content,'Paris','current_city')]));
 const b=req('b','I live in Berlin.');commit(b,await prepare(b,[fact(b.messages[0].content,'Berlin','current_city')],'exclusive'));
 assert.ok(store.facts().every((f:any)=>f.state==='conflicted'));
}));
test('uncertainty rejects the new write without changing the old state',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','My coffee is black drip.');commit(a,await prepare(a,[fact(a.messages[0].content,'black drip')]));
 const before=store.snapshot('s'),b=req('b','I like simple coffee.','2026-02-01');
 await assert.rejects(prepare(b,[fact(b.messages[0].content,'simple coffee')],'uncertain'),/uncertain/);assert.deepEqual(store.snapshot('s'),before);
}));
test('a missing or stale transition plan cannot publish facts, sources, events or a receipt',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','My coffee is black drip.');commit(a,await prepare(a,[fact(a.messages[0].content,'black drip')]));
 const b=req('b','I like simple coffee.','2026-02-01'),p=await prepare(b,[fact(b.messages[0].content,'simple coffee')]);
 const before=store.snapshot('s'),events=store.events();
 assert.throws(()=>commit(b,{...p,transitionPlan:undefined}),/transition plan/);
 const changed=structuredClone(p);changed.facts[0].value='latte';assert.throws(()=>commit(b,changed),/stale/);
 assert.deepEqual(store.snapshot('s'),before);assert.deepEqual(store.events(),events);assert.equal(store.receipt(b.request_id,hash(JSON.stringify(b))),null);
 assert.throws(()=>commit(b,p,'indexes'),/Fault injection/);assert.deepEqual(store.snapshot('s'),before);commit(b,p);assert.equal(store.revision(),2);
}));
test('v5 rejects reuse of an existing v4 directory',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','I like tea.'),p=await prepare(a,[fact(a.messages[0].content,'tea')]);p.sourceFormat='dual-source-v4';delete p.transitionPlan;commit(a,p);
 const b=req('b','I also enjoy its routine.','2026-01-02');
 const next=await prepare(b,[fact(b.messages[0].content,'routine')]);assert.throws(()=>commit(b,next),/Fresh data directory/);assert.equal(store.revision(),1);
}));
test('transition witnesses and exact coverage cannot be forged or truncated',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','My coffee is black drip.');commit(a,await prepare(a,[fact(a.messages[0].content,'black drip')]));
 const b=req('b','I like simple coffee.','2026-02-01'),p=await prepare(b,[fact(b.messages[0].content,'simple coffee')]),work=transitionWork(b,store.facts(),p.facts,p.operations),d=p.transitionPlan.decisions[0];
 for(const decisions of [[],[d,d],[{...d,index:77}],[{...d,old_quote:'invented evidence'}],[{...d,new_quote:'invented evidence'}]])assert.throws(()=>decodeTransitions({decisions},work),/Incomplete|Invalid/);
}));
test('all implicit pairs are bounded without silently dropping excess comparisons',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','My coffee is black drip.');commit(a,await prepare(a,[fact(a.messages[0].content,'black drip')]));
 const b=req('b','I like simple coffee.','2026-02-01'),p=await prepare(b,[fact(b.messages[0].content,'simple coffee')]);
 const prior=Array.from({length:65},(_,i)=>({...store.facts()[0],id:'old-'+i,value:'value-'+i}));assert.throws(()=>transitionWork(b,prior,p.facts,[]),/bounded capacity/);
}));
test('verified explicit correction and a tentative future state retain their existing lifecycle semantics',()=>fixture(async({store,prepare,commit,calls}:any)=>{
 const a=req('a','I live in Paris.');commit(a,await prepare(a,[fact(a.messages[0].content,'Paris','current_city')]));
 const old=store.facts()[0],b=req('b','Correction: I live in Berlin.','2026-02-01');
 const operation={type:'correct',subject:'user',predicate:'current_city',target_ids:[old.id],source:{index:0,quote:b.messages[0].content}};
 commit(b,await prepare(b,[fact(b.messages[0].content,'Berlin','current_city',{supersedes:[old.id]})],'compatible',[operation]));
 assert.equal(store.facts().find((f:any)=>f.id===old.id).state,'retracted');assert.equal(calls(),0);
 const c=req('c','I might move to Rome.','2026-03-01');commit(c,await prepare(c,[fact(c.messages[0].content,'Rome','current_city',{modality:'tentative'})]));
 assert.equal(store.facts().find((f:any)=>f.value==='Berlin').state,'active');assert.equal(calls(),0);
}));
test('forget and explicit restore still erase raw details without resurrecting old sources in v5',()=>fixture(async({store,prepare,commit}:any)=>{
 const a=req('a','My coffee is black drip.');commit(a,await prepare(a,[fact(a.messages[0].content,'black drip')]));
 const old=store.facts()[0],b=req('b','Forget my coffee preference.','2026-02-01');
 commit(b,await prepare(b,[],'compatible',[{type:'forget',subject:'user',predicate:'coffee_preference',target_ids:[old.id],boundary:'property',source:{index:0,quote:b.messages[0].content}}]));
 assert.equal(store.facts()[0].state,'erased');assert.doesNotMatch(JSON.stringify(store.snapshot('s').erasureSources),/black drip/);
 const c=req('c','Remember my coffee preference again: black drip.','2026-03-01');
 commit(c,await prepare(c,[fact(c.messages[0].content,'black drip')],'compatible',[{type:'restore',subject:'user',predicate:'coffee_preference',target_ids:[],value:'black drip',boundary:'property',source:{index:0,quote:c.messages[0].content}}]));
 assert.equal(store.facts().filter((f:any)=>f.state==='active'&&f.value==='black drip').length,1);
 assert.ok(store.snapshot('s').erasureSources.filter((m:any)=>m.content.includes('black drip')).every((m:any)=>m.content===c.messages[0].content));
}));
