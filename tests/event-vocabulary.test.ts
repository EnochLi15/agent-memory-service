import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../src/extraction.js';
import {TenantStore} from '../src/storage.js';
import {configFromEnv} from '../src/config.js';
import {projectEvents} from '../src/events.js';
import {retrieve} from '../src/retrieval.js';
import type {MemoryEvent} from '../src/types.js';

const config=configFromEnv({MEMORY_MODE:'offline'});
async function forgottenCity(reason:string,check:(store:TenantStore)=>void,city='Toronto'){
 const dir=mkdtempSync(join(tmpdir(),'event-vocabulary-')),store=new TenantStore(dir,'u');
 const extractor=new Extractor(config,{} as any);
 try{
  for(const [index,content] of [`My current city is ${city}.`,'Please forget my current city.'].entries()){
   const req={user_id:'u',request_id:String(index),session_id:'s',messages:[{role:'user',content,timestamp:`2026-01-0${index+1}T00:00:00Z`}]};
   const prepared=await extractor.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));
   if(index===1){assert.equal(prepared.operations.length,1);prepared.operations[0]!.reason=reason;}
   store.commit(req,hash(JSON.stringify(req)),prepared,store.revision());
  }
  assert.equal(store.facts().find(f=>f.predicate==='current_city')?.state,'erased');
  check(store);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test('forget commits do not retain a translated private value as an event descriptor',async()=>{
 await forgottenCity('请删除多伦多居住记录',store=>{
  const event=store.events().find(e=>e.type==='forget');assert.ok(event);
  assert.equal(event.descriptor,undefined);
  assert.equal(event.category,'current city');assert.equal(event.actor,'user');
  assert.equal(event.observed_at,'2026-01-02T00:00:00Z');
 });
});

for(const reason of ["Please remove Canada's largest city",'Mara Ellison separation history','请删除私人姓名玛拉',' previous city','Previous city','previous city\n','previ\u200bous city','previous-city','previous city: private detail']){
 test(`forget rejects free text or a non-exact descriptor: ${JSON.stringify(reason)}`,async()=>{
  await forgottenCity(reason,store=>assert.equal(store.events().find(e=>e.type==='forget')?.descriptor,undefined));
 });
}
test('previous city remains an available value-free forget description',async()=>{
 await forgottenCity('previous city',store=>{
  const event=store.events().find(e=>e.type==='forget');assert.equal(event?.descriptor,'previous city');
  const projected=projectEvents(store.events(),store.facts(),new Set());
  assert.match(projected.find(f=>f.id===event!.id)!.content,/forget the previous city/);
 });
});
test('even an allowed descriptor is rejected when it overlaps an erased value',async()=>{
 await forgottenCity('previous city',store=>assert.equal(store.events().find(e=>e.type==='forget')?.descriptor,undefined),'city');
});

function legacyEvent(patch:Partial<MemoryEvent>={}):MemoryEvent{
 return {id:'old-event',type:'forget',category:'current city',descriptor:'请删除多伦多居住记录',actor:'user',slot_hash:'slot',source_ids:['old-source'],before_ids:['erased-fact'],after_ids:[],ordinal:1230000005,observed_at:'2026-01-02T00:00:00Z',time_basis:'source',revision:2,...patch};
}
test('legacy event projection rejects arbitrary descriptors without changing operation provenance or the old row',()=>{
 const old=legacyEvent(),before=structuredClone(old);
 const [view]=projectEvents([old],[],new Set());assert.ok(view);
 assert.doesNotMatch(view.content,/多伦多/);
 assert.match(view.content,/The user explicitly asked the memory service to forget the current city/);
 assert.match(view.content,/Source order 1230000005/);
 assert.equal(view.id,old.id);assert.deepEqual(view.source_ids,old.source_ids);
 assert.equal(view.observed_at,old.observed_at);assert.equal(view.time_basis,old.time_basis);assert.equal(view.revision,old.revision);
 assert.deepEqual(old,before,'read projection does not rewrite legacy storage');
});

for(const type of ['forget','restore','update','remember','reflection','correct','retract'] as const){
 test(`legacy ${type} category falls back safely and retains the operation and participant role`,()=>{
  const old=legacyEvent({type,actor:'participant',category:'Mara Ellison private history',descriptor:'Canada\'s largest city'});
  const [view]=projectEvents([old],[],new Set());assert.ok(view);
  assert.doesNotMatch(view.content,/Mara|Ellison|Canada/);
  assert.match(view.content,/memory record/);assert.match(view.content,/Source order 1230000005/);
  assert.match(view.content,type==='forget'?/explicitly removed from memory \(forgotten\)/:new RegExp(`Memory operation ${type}`));
  if(type==='forget'||type==='restore')assert.match(view.content,/The source participant explicitly/);
 });
}
test('legacy category and descriptor matching neither extracts nor normalizes a safe label',()=>{
 for(const label of [' previous city','Previous city','previous city\n','previ\u200bous city','previous-city','memory record: private detail','current city\n',' current city','Current City','current-city']){
  const [view]=projectEvents([legacyEvent({descriptor:label,category:label})],[],new Set());
  assert.match(view!.content,/forget the memory record\./);
 }
});
test('all existing code-defined event categories and previous city stay available',()=>{
 const labels=['current city','job title','manager','backup name','primary name','session cadence','access code','hobby','salary','quote','budget','schedule','preference','reflection','contact','project','appointment','storage','plan','memory record'];
 for(const category of labels){
  const [view]=projectEvents([legacyEvent({category,descriptor:undefined})],[],new Set());
  assert.ok(view!.content.includes(`forget the ${category}.`));
 }
 const [previous]=projectEvents([legacyEvent({descriptor:'previous city'})],[],new Set());
 assert.match(previous!.content,/forget the previous city\./);
});
test('Search sanitizes a stored legacy descriptor while the original event bytes remain untouched',async()=>{
 await forgottenCity('previous city',store=>{
  const event=store.events().find(e=>e.type==='forget')!;
  const legacy={...event,descriptor:'Mara Ellison separation history',category:'private contact Mara Ellison'};
  const body=JSON.stringify(legacy);
  // Seed a pre-fix storage row, as opening an existing tenant would observe it.
  store.db.prepare('UPDATE memory_events SET body=? WHERE id=?').run(body,event.id);
  const response=retrieve(store,{user_id:'u',query:'What did I ask you to forget?',top_k:100},null,{...config,eventView:true,maxEvidence:100,tokenBudget:18000});
  const visible=response.data.find(f=>f.id===event.id);assert.ok(visible,'the forget operation remains searchable');
  assert.match(visible.content,/forget the memory record\./);
  assert.doesNotMatch(JSON.stringify(response),/Mara|Ellison|separation/);
  assert.equal((store.db.prepare('SELECT body FROM memory_events WHERE id=?').get(event.id) as {body:string}).body,body);
 });
});
