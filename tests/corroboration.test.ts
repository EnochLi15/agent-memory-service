import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';import {retrieve} from '../dist/retrieval.js';

// R3 multi-source corroboration: a ranking signal only. A conflicted value
// restated by >=2 independent statements ranks above its single-source rival,
// but the chain never auto-resolves — the conflict wording and states stay,
// because two echoes of a stale value must not outvote one correction.
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SEMANTIC_TRANSITIONS:'true',MEMORY_EXPERIMENT_CORROBORATION:'true'});
const req=(id:string,content:string,date='2026-01-01')=>({user_id:'u',request_id:id,session_id:'s',messages:[{role:'user',content,timestamp:date+'T00:00:00Z'}]});
const fact=(content:string,value:string,predicate='current_city',more:any={})=>({content,value,subject:'user',predicate,scope:'',modality:'confirmed',cardinality:'single',sources:[{index:0,quote:content}],...more});
async function fixture(body:any){
  const dir=mkdtempSync(join(tmpdir(),'corroboration-')),store=new TenantStore(dir,'u');
  const prepare=async(r:any,facts:any[],relation='compatible')=>new Extractor(config,{verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_system:string,input:string,_signal:any,ctx:any)=>{
    const data=JSON.parse(input);
    if(ctx.purpose==='state_transition')return {decisions:data.CANDIDATES.map((c:any,index:number)=>({index,relation,old_source_slot:0,new_source_slot:0,reason:'Fixture relationship.'}))};
    if(ctx.purpose==='erasure_binding')return {decisions:[]};
    return {facts,operations:[]};
  }} as any).prepare(r,store.snapshot('s'),AbortSignal.timeout(2000));
  const commit=(r:any,p:any)=>store.commit(r,hash(JSON.stringify(r)),p,store.revision());
  try{await body({store,prepare,commit});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test('a conflicted value restated by two independent statements outranks its single-source rival',async()=>fixture(async({store,prepare,commit}:any)=>{
  const a=req('a','I live in Paris.');commit(a,await prepare(a,[fact(a.messages[0].content,'Paris')]));
  // The second independent statement of Paris duplicate-merges, so the Paris
  // row carries two distinct source ids while Berlin keeps one.
  const b=req('b','I live in Paris.','2026-01-02');commit(b,await prepare(b,[fact(b.messages[0].content,'Paris')]));
  const c=req('c','I live in Berlin.','2026-01-03');commit(c,await prepare(c,[fact(c.messages[0].content,'Berlin')],'uncertain'));
  const states=store.facts().filter((f:any)=>f.predicate==='current_city').map((f:any)=>f.state);
  assert.ok(states.every(s=>s==='conflicted'),'both values stay conflicted');
  const data=retrieve(store,{query:'current city',user_id:'u',top_k:32},null,config).data;
  const paris=data.findIndex(d=>d.content.includes('Paris')),berlin=data.findIndex(d=>d.content.includes('Berlin'));
  assert.ok(paris>=0&&berlin>=0,'both values remain visible');
  assert.ok(paris<berlin,'corroborated value ranks first');
  assert.match(data[paris]!.content,/corroborated by 2 independent statements/);
  assert.doesNotMatch(data[berlin]!.content,/corroborated by/);
  assert.match(data[paris]!.content,/Conflicting statements recorded/);
  // Ranking signal only: retrieval left every state untouched.
  assert.deepEqual(store.facts().filter((f:any)=>f.predicate==='current_city').map((f:any)=>f.state),['conflicted','conflicted']);
}));

test('a restated tentative value never outranks the confirmed current state',async()=>fixture(async({store,prepare,commit}:any)=>{
  const a=req('a','I live in Boston.');commit(a,await prepare(a,[fact(a.messages[0].content,'Boston')]));
  const b=req('b','I might live in Denver.','2026-01-02');commit(b,await prepare(b,[fact(b.messages[0].content,'Denver','current_city',{modality:'tentative'})]));
  const c=req('c','I might live in Denver.','2026-01-03');commit(c,await prepare(c,[fact(c.messages[0].content,'Denver','current_city',{modality:'tentative'})]));
  const denver=store.facts().find((f:any)=>f.value==='Denver');
  assert.equal(denver.state,'active');assert.equal(denver.modality,'tentative');
  assert.equal(new Set(denver.source_ids).size,2,'restated tentative carries two sources');
  const data=retrieve(store,{query:'current city',user_id:'u',top_k:32},null,config).data;
  const boston=data.findIndex(d=>d.content.includes('Boston')),denverIdx=data.findIndex(d=>d.content.includes('Denver'));
  assert.ok(boston>=0&&denverIdx>=0);
  assert.ok(boston<denverIdx,'confirmed current value outranks the corroborated tentative');
  assert.doesNotMatch(data[denverIdx]!.content,/corroborated by/,'corroboration never annotates non-conflicted rows');
  assert.equal(store.facts().find((f:any)=>f.value==='Boston').state,'active');
  assert.equal(store.facts().find((f:any)=>f.value==='Denver').state,'active');
}));
