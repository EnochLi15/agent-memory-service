import {test} from 'node:test';import assert from 'node:assert/strict';
import {Extractor,hash} from '../dist/extraction.js';import {configFromEnv} from '../dist/config.js';import type {Fact} from '../dist/types.js';
import {TenantStore} from '../dist/storage.js';import {retrieve} from '../dist/retrieval.js';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const config=configFromEnv({MEMORY_MODE:'enhanced'});
const stored=(id:string,value:string,scope='work laptop'):Fact=>({id,content:`User uses ${value} on their ${scope}.`,subject:'user',predicate:'default_browser',value,scope,kind:'fact',modality:'confirmed',cardinality:'single',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:['old'],source_quotes:[`User uses ${value} on their ${scope}.`],created_at:'2026-01-01T00:00:00Z',observed_at:'2026-01-01T00:00:00Z',state:'active',vector:null,entities:[],revision:1});
const request=(text:string)=>({request_id:hash(text),user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-02-01T00:00:00Z'}]});

test('a selector operation exposes its actual target to the semantic verifier before commit',async()=>{
 const req=request('Forget my default browser on my work laptop.');const target=stored('browser','Firefox');let checked=false;
 const x=new Extractor(config,{json:async()=>({facts:[],operations:[{type:'forget',target_ids:[],subject:'user',predicate:'default_browser',scope:'work laptop',boundary:'property',source:{index:0,quote:req.messages[0]!.content}}]}),verify:async(p:any)=>{checked=true;assert.deepEqual(p.operations[0].target_ids,['browser']);return [];}} as any);
 const p=await x.prepare(req,{facts:[target],tail:[],anchor:null,revision:1},AbortSignal.timeout(1000));assert.ok(checked);assert.deepEqual(p.operations[0]!.target_ids,['browser']);
});
test('equivalent targets are verified too, while another device and person stay outside the binding',async()=>{
 const req=request('Forget Firefox on my work laptop.');const a=stored('a','Firefox'),duplicate=stored('duplicate','Firefox'),phone=stored('phone','Firefox','phone'),other={...stored('other','Firefox'),subject:'Kevin'};
 const x=new Extractor(config,{json:async()=>({facts:[],operations:[{type:'forget',target_ids:['a'],subject:'user',predicate:'default_browser',scope:'work laptop',value:'Firefox',source:{index:0,quote:req.messages[0]!.content}}]}),verify:async(p:any)=>{assert.deepEqual(p.operations[0].target_ids,['a','duplicate']);return [];}} as any);
 await x.prepare(req,{facts:[a,duplicate,phone,other],tail:[],anchor:null,revision:1},AbortSignal.timeout(1000));
});
test('operation-specific candidates can repair a target excluded from the first 120 chunk-wide facts',async()=>{
 const req=request('Forget my default browser on my work laptop.');const target=stored('hidden','Firefox');const distractors=Array.from({length:130},(_,i)=>({...stored('d'+i,'noise'),predicate:'unrelated_'+i,content:'Forget my default browser on my work laptop.',scope:'other'}));let calls=0;
 const x=new Extractor(config,{json:async(system:string,input:string)=>{
  const payload=JSON.parse(input);calls++;
  if(calls===1){assert.ok(!payload.EXISTING_FACTS.some((f:any)=>f.value==='Firefox'));return {facts:[],operations:[{type:'forget',target_ids:['unknown'],subject:'user',predicate:'default_browser',scope:'work laptop',source:{index:0,quote:req.messages[0]!.content}}]};}
  assert.match(system,/PATCH_SCHEMA/);const match=payload.EXISTING_FACTS.find((f:any)=>f.value==='Firefox');assert.ok(match,'targeted repair must expand the relevant target');
  return {operation_edits:[{index:0,changes:{target_ids:[match.id]}}]};
 },verify:async()=>[]} as any);
 const p=await x.prepare(req,{facts:[...distractors,target],tail:[],anchor:null,revision:1},AbortSignal.timeout(1000));assert.equal(calls,2);assert.deepEqual(p.operations[0]!.target_ids,['hidden']);
});
for(const boundary of ['property','value'] as const)test(boundary==='property'?'forgetting a property binds and erases its legitimate historical values as well as the current value':'forgetting a single value preserves other legitimate history of the same property',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'binding-history-')),store=new TenantStore(dir,'u');
 const offline=new Extractor(configFromEnv({MEMORY_MODE:'offline'}),{} as any);
 try{
  for(const [index,city] of ['Seattle','Boston'].entries()){
   const req=request(`I live in ${city}.`);req.messages[0]!.timestamp=`2026-01-0${index+1}T00:00:00Z`;
   const p=await offline.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(req,hash(JSON.stringify(req)),p,store.revision());
  }
  const all=store.facts(),current=all.find(f=>f.state==='active')!;
  const req=request(boundary==='property'?'Forget every city I have lived in.':'Forget Boston, but keep the rest of my city history.');let seen:string[]=[];
  const x=new Extractor(config,{json:async()=>({facts:[],operations:[{type:'forget',target_ids:[current.id],subject:'user',predicate:current.predicate,scope:current.scope,boundary,value:boundary==='value'?'Boston':'',source:{index:0,quote:req.messages[0]!.content}}]}),verify:async(p:any)=>{seen=p.operations[0].target_ids;return [];}} as any);
  const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));
  store.commit(req,hash(JSON.stringify(req)),p,store.revision());
  const ids=boundary==='property'?all.map(f=>f.id):[current.id];
  assert.ok(store.facts().filter(f=>ids.includes(f.id)).every(f=>f.state==='erased'));
  assert.deepEqual([...seen].sort(),ids.sort());
  const returned=JSON.stringify(retrieve(store,{user_id:'u',query:'previous city history',top_k:100},null,config));
  assert.doesNotMatch(returned,boundary==='property'?/Seattle|Boston/:/Boston/);
  if(boundary==='value')assert.match(returned,/Seattle/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
