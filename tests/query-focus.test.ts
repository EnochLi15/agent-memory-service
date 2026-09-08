import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeQueryFocus,QueryFocusClassifier} from '../dist/query-focus.js';
import {configFromEnv} from '../dist/config.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantStore} from '../dist/storage.js';
import {Extractor,hash} from '../dist/extraction.js';
import {collectCandidates,retrieve} from '../dist/retrieval.js';

test('query focus retains exact UTF-16 evidence for a non-self request',()=>{
 const query='📝 请总结我告诉过你的朋友们各自的旅行计划。';
 const quote='朋友们各自的旅行计划';
 assert.deepEqual(decodeQueryFocus({focus:'other_people',evidence:[{quote}]},query),{
  focus:'other_people',evidence:[{quote,start:query.indexOf(quote),end:query.indexOf(quote)+quote.length}],
 });
});

test('invalid, invented, repeated or ambiguous protocol evidence never yields an expanded scope',()=>{
 for(const raw of [null,{focus:'all',evidence:[]},{focus:'other_people',evidence:[]},{focus:'other_people',evidence:[{quote:'missing'}]},{focus:'other_people',evidence:[{quote:'friends'}]},{focus:'unknown',evidence:[{quote:'my'}]},{focus:'other_people',evidence:[{quote:'my',start:0}]},{focus:'other_people',evidence:[{quote:'my'}],reason:'extra'}])assert.throws(()=>decodeQueryFocus(raw,'my friends and friends'));
 assert.deepEqual(decodeQueryFocus({focus:'unknown',evidence:[]},'our plans'),{focus:'unknown',evidence:[]});
});

test('query-only classifier caches valid decisions without sending facts or answers',async()=>{
 const query='Summarize the plans of the colleagues I told you about.';let calls=0;
 const cfg={...configFromEnv({MEMORY_MODE:'enhanced',MEMORY_QUERY_FOCUS:'true'}),queryFocusTimeout:100};
 const classifier=new QueryFocusClassifier(cfg,{json:async(system:string,input:string)=>{
  calls++;assert.match(system,/untrusted data/i);assert.deepEqual(JSON.parse(input),{query});
  return {focus:'other_people',evidence:[{quote:'the plans of the colleagues'}]};
 }} as any);
 assert.equal((await classifier.classify(query,AbortSignal.timeout(1000))).focus,'other_people');
 assert.equal((await classifier.classify(query,AbortSignal.timeout(1000))).outcome,'cache');assert.equal(calls,1);
 classifier.clear();await classifier.classify(query,AbortSignal.timeout(1000));assert.equal(calls,2);
});

async function retrievalFixture(fn:(store:TenantStore,config:any)=>unknown){
 const dir=mkdtempSync(join(tmpdir(),'query-focus-'));const store=new TenantStore(dir,'u');const offline={...configFromEnv({}),dataDir:dir};
 try{
  for(const [i,content] of ['My favorite hobby is hiking.','Mara: My favorite hobby is chess.','Noel: My favorite hobby is pottery.'].entries()){
   const req={request_id:`r${i}`,user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp:'2026-01-01T00:00:00Z'}]};
   const prepared=await new Extractor(offline,{} as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(req,hash(JSON.stringify(req)),prepared,store.revision());
  }
  await fn(store,{...offline,mode:'enhanced',queryFocus:true});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('other_people changes actual third-party fact scores but leaves source and operation-event scores intact',()=>retrievalFixture((store,config)=>{
 const req={user_id:'u',query:'what hobbies did I tell you about?',top_k:32};
 const baseline=collectCandidates(store,req,null,config),expanded=collectCandidates(store,req,null,config,'other_people');
 const scores=new Map(expanded.ranked.map(c=>[c.fact.id,c.score]));let changed=0,unchanged=0;
 for(const c of baseline.ranked){
  const thirdParty=!['user','assistant'].includes(c.fact.subject.toLowerCase())&&c.fact.predicate!=='raw_evidence'&&!c.signals.includes('operation-event');
  if(thirdParty){assert.ok(Math.abs(scores.get(c.fact.id)!-c.score/.3)<1e-12);changed++;}
  else {assert.equal(scores.get(c.fact.id),c.score);unchanged++;}
 }
 assert.ok(changed>0);assert.ok(unchanged>0);
}));

test('self, unknown and feature-off preserve complete baseline evidence, scores and order',()=>retrievalFixture((store,config)=>{
 for(const query of ['my favorite hobby','list my own hobbies','我的爱好有哪些？','our plans with friends']){
  const req={user_id:'u',query,top_k:32},baseline=retrieve(store,req,null,{...config,queryFocus:false});
  for(const focus of ['self_state','unknown'] as const)assert.deepEqual(retrieve(store,req,null,config,focus),baseline);
  assert.deepEqual(retrieve(store,req,null,{...config,queryFocus:false},'other_people'),baseline);
 }
 const rows=retrieve(store,{user_id:'u',query:'my favorite hobby',top_k:32},null,config,'self_state').data;
 assert.match(rows[0]!.content,/hiking/);assert.ok(rows.slice(1).some(r=>/chess|pottery/.test(r.content)));
}));

test('a specifically requested person must still outrank unrelated-person distractors',()=>retrievalFixture((store,config)=>{
 const rows=retrieve(store,{user_id:'u',query:"What is Mara's favorite hobby?",top_k:32},null,config,'other_people').data;
 assert.match(rows[0]!.content,/chess/);assert.ok(rows.slice(1).some(r=>/pottery/.test(r.content)));
 assert.ok(rows.length<=32);assert.ok(rows.every(r=>Number.isFinite(r.score)));
}));

test('authored English/Chinese scope fixtures exercise the wire contract, not model semantic accuracy',()=>{
 const fixtures:[string,'self_state'|'other_people'|'unknown',string?][]=[
  ['What plans do my friends have?','other_people','my friends'],
  ['What are my plans with friends?','self_state','my plans'],
  ['Summarize the preferences of the people I told you about.','other_people','preferences of the people'],
  ['List my preferences for contacting people.','self_state','my preferences'],
  ['请列出我告诉你的同事们各自的爱好。','other_people','同事们各自的爱好'],
  ['请列出我与同事一起进行的个人计划。','self_state','我与同事一起进行的个人计划'],
  ['our plans','unknown'],['my family updates','unknown'],['引用：“列出我的爱好。”','unknown'],['List only my plans and only their plans.','unknown'],
 ];
 // The model must solve ownership; local authored packets certify only enum/evidence behavior.
 for(const [query,focus,quote] of fixtures){
  const raw={focus,evidence:quote?[{quote}]:[]};
  assert.equal(decodeQueryFocus(raw,query).focus,focus);
 }
});

test('LRU capacity, TTL and model identity bound cached query-only decisions',async()=>{
 let calls=0,now=0;const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_QUERY_FOCUS:'true'});
 const classifier=new QueryFocusClassifier(config,{json:async(_system:string,input:string)=>{calls++;return {focus:'self_state',evidence:[{quote:JSON.parse(input).query}]};}} as any,()=>now);
 const ask=(i:number)=>classifier.classify(`my own plan ${i}`,AbortSignal.timeout(1000));
 for(let i=0;i<128;i++)await ask(i);
 assert.equal((await ask(0)).outcome,'cache');await ask(128);assert.equal((await ask(0)).outcome,'cache');
 assert.equal((await ask(1)).outcome,'model');assert.equal(calls,130);
 now=300001;assert.equal((await ask(0)).outcome,'model');config.llmModel='another-model';assert.equal((await ask(0)).outcome,'model');assert.equal(calls,132);
});

test('timeout and invalid output yield unknown, while parent abort is propagated and not cached',async()=>{
 const config={...configFromEnv({MEMORY_MODE:'enhanced',MEMORY_QUERY_FOCUS:'true'}),queryFocusTimeout:20};let calls=0;let mode='timeout';
 const classifier=new QueryFocusClassifier(config,{json:async()=>{calls++;if(mode==='timeout')return new Promise(()=>{});return {focus:'other_people',evidence:[{quote:'not in query'}]};}} as any);
 assert.deepEqual(await classifier.classify('my plans',AbortSignal.timeout(1000)),{focus:'unknown',evidence:[],outcome:'fallback'});
 mode='bad';assert.equal((await classifier.classify('my plans',AbortSignal.timeout(1000))).focus,'unknown');assert.equal(calls,2);
 const abort=new AbortController();abort.abort(Error('caller stopped'));await assert.rejects(()=>classifier.classify('my plans',abort.signal),/caller stopped/);assert.equal(calls,2);
 const running=new AbortController();mode='timeout';const result=classifier.classify('my plans',running.signal);running.abort(Error('caller stopped later'));await assert.rejects(()=>result,/caller stopped later/);
 mode='bad';await classifier.classify('my plans',AbortSignal.timeout(1000));assert.equal(calls,4);
});

test('disabled, offline, raw-only, non-hybrid and oversized queries make no classification call',async()=>{
 const enabled=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_QUERY_FOCUS:'true'});let calls=0;const models={json:async()=>{calls++;throw Error('must not call');}} as any;
 for(const config of [{...enabled,queryFocus:false},{...enabled,mode:'offline' as const},{...enabled,retrieval:'lexical' as const},{...enabled,experimental:{...enabled.experimental,rawOnly:true}}])assert.equal((await new QueryFocusClassifier(config,models).classify('my plans',AbortSignal.timeout(1000))).focus,'unknown');
 assert.equal((await new QueryFocusClassifier(enabled,models).classify('x'.repeat(8193),AbortSignal.timeout(1000))).outcome,'oversized');assert.equal(calls,0);
});
