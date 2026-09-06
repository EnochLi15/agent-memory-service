import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';
import {extractionSchema} from '../dist/types.js';import {missingForgetObligations,realControl,authorizesForget} from '../dist/operation-intent.js';import {retrieve} from '../dist/retrieval.js';
const config=configFromEnv({MEMORY_MODE:'enhanced'}),date='2026-01-01T00:00:00Z';
const request=(text:string)=>({request_id:'retire',user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:date}]});
const command='No need to track anything about the tablet.';
const req=request('My work laptop uses Firefox. My old tablet had a bookmark sync issue. I sold the tablet in April. '+command);
const fact=(content:string,predicate:string,value:string,scope='')=>({content,predicate,value,scope,subject:'user',sources:[{index:0,quote:content}]});
const proposal=()=>extractionSchema.parse({facts:[fact('My work laptop uses Firefox.','browser','Firefox','work laptop'),fact('My old tablet had a bookmark sync issue.','sync_issue','bookmark sync issue','old tablet'),fact('I sold the tablet in April.','sold_device','sold in April','old tablet')],operations:[{type:'retract',target_ids:['new:1'],subject:'user',predicate:'sync_issue',scope:'old tablet',boundary:'property',source:{index:0,quote:command}}]});

test('source-linked retraction cannot acknowledge erasure; only explicit current-list removal permits retained history',()=>{
 assert.equal(missingForgetObligations(req,proposal()).length,1);
 for(const [text,type,boundary,missing] of [
  ['Remove Beth from my current colleagues.','retract','current_relation',0],
  ['Remove Beth from my current colleagues.','retract','property',1],
  ['Forget everything about my current colleague Beth.','retract','current_relation',1],
  ['No need to track my access code anymore.','retract','property',1],
  ['No need to track my access code anymore.','forget','property',0],
  ['Do not stop tracking my tablet.','retract','property',0],
  ['Alice said: no need to track the tablet.','retract','property',0],
 ] as const){
  const r=request(text),p=extractionSchema.parse({facts:[],operations:[{type,boundary,target_ids:['m0'],subject:'user',predicate:'item',source:{index:0,quote:text}}]});
  assert.equal(missingForgetObligations(r,p).length,missing,text);
 }
});

test('wrong retirement effect requires a repair before checking and erases all selected entity facts and raw sources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'retirement-effect-')),store=new TenantStore(dir,'u');let calls=0,checks=0;
 const x=new Extractor(config,{json:async(_s:string,input:string)=>{
  calls++;if(calls===1)return proposal();assert.match(JSON.parse(input).REPAIR_FEEDBACK,/forget.*retract/);
  return {operation_edits:[{index:0,changes:{type:'forget',target_ids:['new:1','new:2'],predicate:'entity',boundary:'property'}}]};
 },verify:async(p:any)=>{checks++;assert.equal(p.operations[0].type,'forget');return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 try{
  const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(calls,2);assert.equal(checks,1);
  store.commit(req,hash(JSON.stringify(req)),p,0);assert.equal(store.facts().filter(f=>f.state==='erased').length,2);
  const evidence=JSON.stringify(retrieve(store,{user_id:'u',query:'tablet bookmark sync April Firefox',top_k:100},null,config).data);
  assert.doesNotMatch(evidence,/bookmark sync|sold.*April/);assert.match(evidence,/Firefox/);
  assert.ok(store.passages().every(p=>!p.content.includes('bookmark sync')&&!p.content.includes('sold the tablet')));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('unrepaired retirement effect fails closed even when the checker would approve',async()=>{
 let checks=0,calls=0;const x=new Extractor(config,{json:async()=>++calls===1?proposal():{},verify:async()=>{checks++;return [];},embedBatch:async()=>[]} as any);
 await assert.rejects(()=>x.prepare(req,{facts:[],tail:[],anchor:null,revision:0},AbortSignal.timeout(1000)),(e:any)=>e.code==='OPERATION_INTENT');
 assert.equal(checks,0);
});

test('transaction independently rejects a prepared retraction substituted for a forget operation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'retirement-commit-')),store=new TenantStore(dir,'u');const good=proposal();Object.assign(good.operations[0]!,{type:'forget',target_ids:['new:1','new:2'],predicate:'entity'});
 try{
  const x=new Extractor(config,{json:async()=>structuredClone(good),verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
  const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));p.operations[0]!.type='retract';
  assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),p,0),(e:any)=>e.code==='OPERATION_INTENT');
  assert.equal(store.revision(),0);assert.equal(store.facts().length,0);assert.equal(store.passages().length,0);assert.equal(store.receipt(req.request_id,hash(JSON.stringify(req))),null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('second-person no-longer-needed tracking is direct retirement, preserving negative and reported boundaries',()=>{
 const text="I had a dentist appointment with Dr. Pham on April 9th, so you don't need to keep track of that anymore.";
 const quote="you don't need to keep track of that anymore";
 const r=request(text),p=extractionSchema.parse({facts:[],operations:[{type:'forget',target_ids:['m0'],subject:'user',predicate:'appointment',source:{index:0,quote}}]});
 assert.equal(realControl(text),true);assert.equal(authorizesForget(p.operations[0]!,r),true);
 assert.equal(missingForgetObligations(r,{facts:[],operations:[]}).length,1);
 assert.equal(missingForgetObligations(r,p).length,0);
 assert.equal(realControl('You do not need to retain my appointment anymore.'),true);
 for(const s of [
  'You do not need to stop tracking my appointment.',
  "You don't need to forget my appointment.",
  "If I cancel, you don't need to keep track of my appointment anymore.",
  'She said: "You do not need to retain my appointment anymore."',
  '"You do not need to retain my appointment anymore."',
  'The dentist appointment is completed.',
 ])assert.equal(realControl(s),false,s);
});

test('a valid same-message tracking retirement reaches verification without being told to remove its operation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tracking-retirement-')),store=new TenantStore(dir,'u');let calls=0,checks=0;
 const before="I had a dentist appointment with Dr. Pham on April 9th";
 const command="you don't need to keep track of that anymore";
 const r=request('My work laptop uses Firefox. '+before+', so '+command+'.');
 const proposal=extractionSchema.parse({facts:[fact('My work laptop uses Firefox.','browser','Firefox','work laptop'),fact(before,'appointment','Dr. Pham on April 9th','dentist')],operations:[{type:'forget',target_ids:['new:1'],subject:'user',predicate:'appointment',scope:'dentist',boundary:'property',source:{index:0,quote:command}}]});
 const x=new Extractor(config,{json:async()=>{calls++;assert.equal(calls,1,'A valid retirement must not consume a repair removing it');return structuredClone(proposal);},verify:async(p:any)=>{checks++;assert.equal(p.operations[0].type,'forget');return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])} as any);
 try{
  const p=await x.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));assert.equal(checks,1);
  store.commit(r,hash(JSON.stringify(r)),p,0);
  assert.equal(store.facts().filter(f=>f.state==='erased').length,1);
  assert.ok(store.passages().every(p=>!p.content.includes('Dr. Pham')));
  const evidence=JSON.stringify(retrieve(store,{user_id:'u',query:'Dr. Pham April dentist Firefox',top_k:100},null,config).data);
  assert.doesNotMatch(evidence,/Dr\. Pham/);assert.match(evidence,/Firefox/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
