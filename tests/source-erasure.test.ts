import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';
import {decodeSourceErasure,maskSource,sourceErasureWork,sourceErasureBatches,sourceErasureInput} from '../dist/source-erasure.js';
import {valueDigest} from '../dist/erasure.js';
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true'});
const request=(id:string,text:string)=>({request_id:id,user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-01-01T00:00:00Z'}]});
const fact=(quote:string,subject='user',scope='dentist')=>({content:quote,subject,predicate:'appointment',value:"dentist appointment with Dr. Pham's office on Elm Street",scope,sources:[{index:0,quote}]});
const compactFixture=(raw:any)=>({decisions:raw.decisions.map((r:any)=>({index:r.index,effect:r.parts.some((p:any)=>p.effect==='uncertain')?'uncertain':r.parts.every((p:any)=>p.effect===r.parts[0].effect)?r.parts[0].effect:'mixed',erase_quotes:r.parts.some((p:any)=>p.effect==='retain')&&r.parts.some((p:any)=>p.effect==='erase')?r.parts.filter((p:any)=>p.effect==='erase').map((p:any)=>p.text):[],reason:r.parts.some((p:any)=>p.effect==='uncertain')?'uncertain_scope':r.parts.some((p:any)=>p.effect==='retain')&&r.parts.some((p:any)=>p.effect==='erase')?'mixed_source':r.parts[0].effect==='erase'?'same_erased_record':'independent_record'}))});
async function fixture(fn:any,sourceErasureWorkers=1){
 const dir=mkdtempSync(join(tmpdir(),'source-erasure-')),store=new TenantStore(dir,'u');let calls=0;
 const prepare=(req:any,p:any,override?:any)=>new Extractor({...config,sourceErasureWorkers},{verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,input:string,_signal:any,ctx:any)=>{
  if(ctx?.purpose==='source_erasure'){
   calls++;const packed=JSON.parse(input),data={CANDIDATES:packed.CANDIDATES.map((c:any)=>({...packed.SOURCES[c.source_slot],...packed.BOUNDARIES[c.boundary_slot],index:c.index,matching_words:c.matching_words}))};if(override)return compactFixture(override(data));
   return compactFixture({decisions:data.CANDIDATES.map((c:any,index:number)=>{
    if(c.text.includes('Kevin'))return {index,parts:[{text:c.text,effect:'retain'}],reason:'Explicitly a different person.'};
    const split=c.text.indexOf('; I still use Firefox');
    return {index,parts:split>=0?[{text:c.text.slice(0,split),effect:'erase'},{text:c.text.slice(split),effect:'retain'}]:[{text:c.text,effect:'erase'}],reason:'Same appointment; retain only independent browser information.'};
   })});
  }
  if(ctx?.purpose==='erasure_binding'){const data=JSON.parse(input);return {decisions:data.CANDIDATES.map((c:any,index:number)=>({index,effect:c.fact.subject==='Kevin'?'retain':'erase',quote:c.fact.source_quotes[0],reason:'Actor-specific appointment.'}))};}
  return structuredClone(p);
 }} as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(2000));
 const commit=(r:any,p:any,fail?:string)=>store.commit(r,hash(JSON.stringify(r)),p,store.revision(),fail);
 try{await fn({dir,store,prepare,commit,calls:()=>calls});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
const seedText="I have a dentist appointment with Dr. Pham's office on Elm Street.";
const echo='Your dentist appointment is with Dr. Pham on Elm Street; I still use Firefox.';
async function seed(f:any){const r=request('seed',seedText);r.messages.push({role:'assistant',content:echo,timestamp:'2026-01-01T00:00:01Z'});f.commit(r,await f.prepare(r,{facts:[fact(seedText)],operations:[]}));return f.store.facts()[0];}
const deletion=(target:any)=>({facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'appointment',scope:'dentist',value:target.value,boundary:'value',source:{index:0,quote:'Forget my dentist appointment.'}}]});
test('source erasure removes old assistant paraphrases and preserves unextracted mixed-sentence neighbors',()=>fixture(async(f:any)=>{
 const target=await seed(f),r=request('delete','Forget my dentist appointment.');f.commit(r,await f.prepare(r,deletion(target)));
 assert.ok(f.calls()>0);assert.equal(f.store.meta('source_format'),'dual-source-v4');
 const all=f.store.db.prepare('SELECT body FROM messages').all().map((x:any)=>JSON.parse(x.body));
 assert.doesNotMatch(JSON.stringify(all),/Pham/);assert.match(JSON.stringify(all),/I still use Firefox/);
 assert.doesNotMatch(JSON.stringify(f.store.snapshot('s').tail),/Pham/);
 assert.ok(f.store.passages().every((p:any)=>!p.content.includes('Pham')));
}));
test('missing or uncertain source partitions cannot be committed and later echoes remain checked',()=>fixture(async(f:any)=>{
 const target=await seed(f),r=request('delete','Forget my dentist appointment.'),before=f.store.snapshot('s');
 for(const override of [()=>({decisions:[]}), (d:any)=>({decisions:d.CANDIDATES.map((c:any,index:number)=>({index,parts:[{text:c.text,effect:'uncertain'}],reason:'Unresolved.'}))})]){
  await assert.rejects(()=>f.prepare(r,deletion(target),override));assert.deepEqual(f.store.snapshot('s'),before);
 }
 f.commit(r,await f.prepare(r,deletion(target)));
 const later=request('later','Your appointment was with Dr. Pham on Elm Street.');later.messages[0].role='assistant';
 f.commit(later,await f.prepare(later,{facts:[],operations:[]}));
 assert.doesNotMatch(JSON.stringify(f.store.snapshot('s')),/Your appointment was with Dr/);
 const unrelated=request('other','My colleague Kevin has an appointment with Dr. Pham on Elm Street. It is his, not mine.');
 f.commit(unrelated,await f.prepare(unrelated,{facts:[fact(unrelated.messages[0].content,'Kevin','Kevin dentist')],operations:[]}));
 assert.ok(f.store.facts().some((x:any)=>x.subject==='Kevin'&&x.state==='active'));
}));
test('source plan rejects stale raw evidence and rolls back source cuts with the transaction',()=>fixture(async(f:any)=>{
 const target=await seed(f),r=request('delete','Forget my dentist appointment.'),p=await f.prepare(r,deletion(target)),before=f.store.snapshot('s');
 assert.ok(p.sourceErasurePlan);assert.throws(()=>f.commit(r,{...p,sourceErasurePlan:undefined}));
 for(const stage of ['operations','indexes']){assert.throws(()=>f.commit(r,p,stage));assert.deepEqual(f.store.snapshot('s'),before);}
 const record=f.store.db.prepare('SELECT id,body FROM messages WHERE id=?').get(before.erasureSources[1].id);
 f.store.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(record.body),content:echo+' changed'}),record.id);
 assert.throws(()=>f.commit(r,p),/stale/);f.store.db.prepare('UPDATE messages SET body=? WHERE id=?').run(record.body,record.id);
 const changed={...p,messages:p.messages.map((m:any)=>({...m,content:m.content+' changed'}))};assert.throws(()=>f.commit(r,changed));
 f.commit(r,p);assert.equal(f.store.revision(),2);
}));

test('exact partitions reject changed text, duplicates, missing coverage, mixed facts and split Unicode',()=>{
 const candidate={kind:'source',id:'s',start:7,text:'甲😀old; keep',key:'k',boundary:{},authorization:null,matching_words:[],context:{}};
 const work={fingerprint:'f',candidates:[candidate]} as any;
 const decision={index:0,parts:[{text:candidate.text,effect:'erase'}],reason:'Same record.'};
 assert.equal(decodeSourceErasure({decisions:[decision]},work).decisions.length,1);
 for(const rows of [[],[decision,decision],[{...decision,index:1}],[{...decision,parts:[{text:'changed',effect:'erase'}]}],[{...decision,parts:[{text:'甲\uD83D',effect:'erase'},{text:'\uDE00old; keep',effect:'retain'}]}]])assert.throws(()=>decodeSourceErasure({decisions:rows},work));
 const mixed={...decision,parts:[{text:'甲😀old',effect:'erase'},{text:'; keep',effect:'retain'}]};
 assert.throws(()=>decodeSourceErasure({decisions:[mixed]},{...work,candidates:[{...candidate,kind:'fact'}]}));
 const masked=maskSource(candidate.text,[{start:7,end:13}],7);assert.equal(masked.length,candidate.text.length);assert.ok(masked.endsWith('; keep'));
});
test('v4 cannot silently reuse a pre-existing v3 directory',async()=>{
 assert.throws(()=>configFromEnv({MEMORY_SOURCE_ERASURE:'true'}),/requires/);
 const extractor=new Extractor(config,{} as any);
 await assert.rejects(()=>extractor.prepare(request('x','hello'),{revision:1,facts:[],tail:[],anchor:null},AbortSignal.timeout(1000)),(e:any)=>e.code==='SOURCE_FORMAT');
});

test('candidate capacity fails instead of truncating source coverage',()=>{
 const r=request('capacity','hi'),boundary={subject:'user',predicate:'appointment',scope:'',boundary:'value',valueHash:valueDigest('Pham'),tokenCount:1,revision:1};
 const m=(i:number,text='Pham')=>({id:String(i),session_id:'s',ordinal:i,role:'user',content:text,timestamp:'2026-01-01T00:00:00Z',searchable:true});
 assert.throws(()=>sourceErasureBatches(sourceErasureWork(r,[],[],[],[boundary],[],Array.from({length:257},(_,i)=>m(i)))),/capacity/);
 assert.throws(()=>sourceErasureBatches(sourceErasureWork(r,[],[],[],[boundary],[],[m(0,'Pham '.repeat(14000))])),/capacity/);
});
test('source work capacity uses complete transmitted batches instead of repeated authorization copies',()=>{
 const r=request('deduplicated-capacity','Forget Pham.'),target={id:'target',content:'Appointment with Pham. '+('detail '.repeat(800)),value:'Pham',subject:'user',predicate:'appointment',scope:'dentist',state:'active',source_ids:[],source_quotes:['Appointment with Pham.'],vector:null} as any;
 const operation={type:'forget',target_ids:['target'],subject:'user',predicate:'appointment',scope:'dentist',value:'Pham',boundary:'value',source:{index:0,quote:'Forget Pham.'}} as any;
 const messages=Array.from({length:80},(_,i)=>({id:String(i),session_id:'s',ordinal:i,role:'assistant',content:'You have an appointment with Pham.',timestamp:'2026-01-01T00:00:00Z',searchable:true}));
 const work=sourceErasureWork(r,[target],[],[operation],[],messages,[]),batches=sourceErasureBatches(work);assert.ok(JSON.stringify(work.candidates).length>256000);assert.equal(work.candidates.length,80);assert.deepEqual(batches.flatMap(b=>b.candidates),work.candidates);assert.ok(batches.reduce((n,b)=>n+JSON.stringify(sourceErasureInput(b)).length,0)<256000);assert.equal(batches.length,2);
 const decisions=batches.flatMap(b=>decodeSourceErasure({decisions:b.candidates.map((c,index)=>({index,parts:[{text:c.text,effect:'erase'}],reason:'Already authorized.'}))},b).decisions.map(d=>({...d,index:d.index+b.offset})));assert.equal(decodeSourceErasure({decisions},work).decisions.length,80);assert.throws(()=>decodeSourceErasure({decisions:decisions.slice(0,-1)},work),/Incomplete/);
});
test('explicit restoration of the authorized value survives v4 source checks without reviving old raw text',()=>fixture(async(f:any)=>{
 const target=await seed(f),del=request('delete','Forget my dentist appointment.');f.commit(del,await f.prepare(del,deletion(target)));
 const r=request('restore',"Remember my dentist appointment with Dr. Pham's office on Elm Street again.");
 const p={facts:[fact(r.messages[0].content)],operations:[{type:'restore',target_ids:[target.id],subject:'user',predicate:'appointment',scope:'dentist',value:target.value,source:{index:0,quote:r.messages[0].content}}]};
 f.commit(r,await f.prepare(r,p));assert.ok(f.store.facts().some((x:any)=>x.state==='active'&&x.value===target.value));
 const old=f.store.db.prepare('SELECT body FROM messages WHERE id=?').get(target.source_ids[0]);assert.doesNotMatch(old.body,/Pham/);
}));

test('source batches obey payload limits and preserve every original candidate index',()=>{
 const r=request('batch-capacity','hi'),boundary={subject:'user',predicate:'appointment',scope:'',boundary:'value',valueHash:valueDigest('Pham'),tokenCount:1,revision:1};
 const messages=Array.from({length:100},(_,i)=>({id:String(i),session_id:'s',ordinal:i,role:'user',content:'Pham '+('word '.repeat(100)),timestamp:'2026-01-01T00:00:00Z',searchable:true}));
 const work=sourceErasureWork(r,[],[],[],[boundary],[],messages),batches=sourceErasureBatches(work);assert.ok(batches.length>1);
 assert.deepEqual(batches.flatMap(b=>b.candidates),work.candidates);
 for(const batch of batches){assert.ok(batch.candidates.length<=64);assert.ok(JSON.stringify(sourceErasureInput(batch)).length<=64000);}
 const decisions=batches.flatMap(b=>decodeSourceErasure({decisions:b.candidates.map((c,index)=>({index,parts:[{text:c.text,effect:'erase'}],reason:'Authorized.'}))},b).decisions.map(d=>({...d,index:d.index+b.offset})));
 assert.equal(decodeSourceErasure({decisions},work).decisions.length,100);assert.throws(()=>decodeSourceErasure({decisions:decisions.slice(0,-1)},work),/Incomplete/);
});
for(const workers of [1,3])for(const rejectTail of [false,true])test(`large source cleanup is atomic across batches; workers=${workers}, reject final batch=${rejectTail}`,()=>fixture(async(f:any)=>{
 const r=request('bulk-seed',seedText);
 for(let i=0;i<70;i++)r.messages.push({role:'assistant',content:`Your dentist appointment with Dr. Pham on Elm Street. Echo ${i}.`,timestamp:'2026-01-01T00:00:01Z'});
 f.commit(r,await f.prepare(r,{facts:[fact(seedText)],operations:[]},workers));
 const target=f.store.facts()[0],del=request('bulk-delete','Forget my dentist appointment.'),before=f.store.snapshot('s');let batches=0;
 const prepare=()=>f.prepare(del,deletion(target),(d:any)=>{batches++;return {decisions:d.CANDIDATES.map((c:any,index:number)=>({index,parts:[{text:c.text,effect:rejectTail&&c.text.includes('Echo 69.')?'uncertain':'erase'}],reason:'Fixture appointment cleanup.'}))};});
 if(rejectTail){await assert.rejects(prepare,/Uncertain/);assert.deepEqual(f.store.snapshot('s'),before);assert.equal(f.store.receipt(del.request_id,hash(JSON.stringify(del))),null);}
 else{const p=await prepare();assert.ok(p.sourceErasurePlan.decisions.length>64);const partial=structuredClone(p);partial.sourceErasurePlan.decisions.pop();assert.throws(()=>f.commit(del,partial),/Incomplete/);assert.deepEqual(f.store.snapshot('s'),before);f.commit(del,p);assert.equal(f.store.revision(),2);assert.doesNotMatch(JSON.stringify(f.store.snapshot('s')),/Pham/);}
 assert.ok(batches>=2);
},workers));
test('verified erased facts are not rejudged, while all their original sources still undergo cleanup',()=>fixture(async(f:any)=>{
 const r=request('seed-dependent',seedText);
 f.commit(r,await f.prepare(r,{facts:[fact(seedText),{...fact(seedText),predicate:'appointment_note',scope:'record detail'}],operations:[]}));
 const target=f.store.facts().find((x:any)=>x.predicate==='appointment'),related=f.store.facts().find((x:any)=>x.predicate==='appointment_note'),del=request('forget-dependent','Forget my dentist appointment.');let sourceCandidates:any[]=[];
 const p=await f.prepare(del,deletion(target),(d:any)=>{sourceCandidates.push(...d.CANDIDATES);return {decisions:d.CANDIDATES.map((c:any,index:number)=>({index,parts:[{text:c.text,effect:c.kind==='fact'?'uncertain':'erase'}],reason:'Fixture source cleanup.'}))};});
 assert.ok(p.erasurePlan.decisions.some((d:any)=>d.fact_id===related.id&&d.effect==='erase'));assert.ok(sourceCandidates.length>0);assert.ok(sourceCandidates.every((c:any)=>c.kind==='source'));assert.ok(sourceCandidates.some((c:any)=>c.text===seedText));
 const forged=structuredClone(p);for(const d of forged.erasurePlan.decisions)if(d.fact_id===related.id)d.effect='retain';assert.throws(()=>f.commit(del,forged),/stale|Missing/);assert.equal(f.store.revision(),1);
 f.commit(del,p);assert.ok(f.store.facts().every((x:any)=>x.state==='erased'));assert.doesNotMatch(JSON.stringify(f.store.snapshot('s')),/Pham/);
}));
test('source scope receives surviving fact meanings while never exempting a retired witness',()=>fixture(async(f:any)=>{
 const target=await seed(f),r=request('delete-context','Forget my dentist appointment. I prefer SMS.');let seen:any[]=[];
 const p=await f.prepare(r,{...deletion(target),facts:[{content:'I prefer SMS.',subject:'user',predicate:'contact_preference',value:'SMS',sources:[{index:0,quote:'I prefer SMS.'}]}]},(d:any)=>{seen.push(...d.CANDIDATES);return {decisions:d.CANDIDATES.map((c:any,index:number)=>{
  const split=c.text.indexOf(' I prefer SMS.');const oldSplit=c.text.indexOf('; I still use Firefox');
  return {index,parts:split>=0?[{text:c.text.slice(0,split),effect:'erase'},{text:c.text.slice(split),effect:'retain'}]:oldSplit>=0?[{text:c.text.slice(0,oldSplit),effect:'erase'},{text:c.text.slice(oldSplit),effect:'retain'}]:[{text:c.text,effect:'erase'}],reason:'Fixture scope partition.'};
 })};});
 const current=seen.find(c=>c.kind==='source'&&c.text===r.messages[0].content);assert.ok(current.context.linked_facts.some((x:any)=>x.predicate==='contact_preference'&&x.source_quotes.includes('I prefer SMS.')));assert.ok(seen.filter(c=>c.kind==='source').every(c=>c.context.linked_facts.every((x:any)=>x.id!==target.id)));assert.ok(seen.some(c=>c.context.linked_erased_facts?.some((x:any)=>x.id===target.id)));
 f.commit(r,p);assert.ok(f.store.facts().some((x:any)=>x.state==='active'&&x.value==='SMS'));assert.doesNotMatch(JSON.stringify(f.store.snapshot('s').erasureSources),/Pham/);
}));

for(const workers of [1,3])for(const repeatDefect of [false,true])test(`source quote repair shares cancellation and permits one global repair: workers=${workers}, repeat=${repeatDefect}`,()=>fixture(async(f:any)=>{
 const r=request('quote-seed',seedText);
 for(let i=0;i<70;i++)r.messages.push({role:'assistant',content:`Echo ${i}: appointment with Pham; I still use Firefox.`,timestamp:'2026-01-01T00:00:00Z'});
 f.commit(r,await f.prepare(r,{facts:[fact(seedText)],operations:[]}));
 const target=f.store.facts()[0],del=request('quote-delete','Forget my dentist appointment.'),before=f.store.snapshot('s');let batches=0,repairs=0;const signals:AbortSignal[]=[];
 const model={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,input:string,signal:AbortSignal,ctx:any)=>{
  signals.push(signal);const d=JSON.parse(input);
  if(ctx.purpose==='source_erasure'){
   batches++;let damaged=false;
   return {decisions:d.CANDIDATES.map((c:any)=>{
    const text=d.SOURCES[c.source_slot].text,split=text.indexOf(';');if(split<0)return {index:c.index,effect:'erase',erase_quotes:[],reason:'same_erased_record'};
    const damage=!damaged&&(batches===1||repeatDefect);if(damage)damaged=true;
    return {index:c.index,effect:'mixed',erase_quotes:[damage?'appointment Pham':text.slice(0,split)],reason:'mixed_source'};
   })};
  }
  if(ctx.purpose==='source_erasure_repair'){repairs++;return {repairs:d.PROBLEMS.map((p:any)=>({index:p.index,status:'resolved',quote:p.candidate.text.split(';')[0]}))};}
  if(ctx.purpose==='erasure_binding')return {decisions:d.CANDIDATES.map((c:any,index:number)=>({index,effect:'erase',quote:c.fact.source_quotes[0],reason:'Same appointment.'}))};
  return deletion(target);
 }};
 const outer=new AbortController(),prepare=()=>new Extractor({...config,sourceErasureWorkers:workers},model as any).prepare(del,before,outer.signal);
 const p=await prepare();f.commit(del,p);assert.doesNotMatch(JSON.stringify(f.store.snapshot('s')),/Pham/);assert.match(JSON.stringify(f.store.snapshot('s')),/Firefox/);
 assert.equal(repairs,1);assert.ok(batches>=2);outer.abort();assert.ok(signals.every(s=>s.aborted),'All child signals remain bound to the original cancellation');
}));

test('a certified erased fact cannot keep every original witness intact behind a reviewed source',()=>fixture(async(f:any)=>{
 const target=await seed(f),del=request('contradictory-source','Forget my dentist appointment.'),before=f.store.snapshot('s');
 const p=await f.prepare(del,deletion(target),(d:any)=>({decisions:d.CANDIDATES.map((c:any,index:number)=>({index,parts:[{text:c.text,effect:'retain'}],reason:'Erroneous independent-source verdict.'}))}));
 assert.throws(()=>f.commit(del,p),/every original witness intact/);assert.deepEqual(f.store.snapshot('s'),before);assert.equal(f.store.receipt(del.request_id,hash(JSON.stringify(del))),null);
}));

test('later writes never reapply a historical erased span over a retained mixed-source neighbor',()=>fixture(async(f:any)=>{
 const mixed=seedText+'; I still use Firefox.',r=request('mixed-target-seed',mixed);
 f.commit(r,await f.prepare(r,{facts:[{...fact(mixed),content:seedText},{content:'I still use Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:'I still use Firefox.'}]}],operations:[]}));
 const target=f.store.facts().find((x:any)=>x.predicate==='appointment'),del=request('mixed-target-delete','Forget my dentist appointment.');f.commit(del,await f.prepare(del,deletion(target)));
 const sourceId=target.source_ids[0],safe=f.store.snapshot('s').erasureSources.find((m:any)=>m.id===sourceId).content;assert.match(safe,/Firefox/);assert.doesNotMatch(safe,/Pham/);
 for(const [id,text,role] of [['ordinary-after-delete','What is gravity?','user'],['echo-after-delete','Your dentist appointment is with Dr. Pham on Elm Street.','assistant']]){
  const next=request(id,text);next.messages[0].role=role;const before=f.store.revision();f.commit(next,await f.prepare(next,{facts:[],operations:[]}));assert.equal(f.store.revision(),before+1);
  assert.equal(f.store.snapshot('s').erasureSources.find((m:any)=>m.id===sourceId).content,safe);assert.ok(f.store.facts().some((x:any)=>x.state==='active'&&x.value==='Firefox'));assert.ok(f.store.passages().some((p:any)=>p.content.includes('Firefox')));assert.doesNotMatch(JSON.stringify(f.store.snapshot('s').erasureSources),/Pham/);
 }
 const reopened=new TenantStore(f.dir,'u');try{assert.equal(reopened.snapshot('s').erasureSources.find((m:any)=>m.id===sourceId).content,safe);assert.ok(reopened.facts().some((x:any)=>x.value==='Firefox'&&x.state==='active'));}finally{reopened.close();}
}));

test('a newly erased nonlexical value still receives deterministic unreviewed source cleanup',()=>fixture(async(f:any)=>{
 const r=request('symbol-seed','I like 😀.');f.commit(r,await f.prepare(r,{facts:[{content:'😀',subject:'user',predicate:'symbol',value:'😀',scope:'symbol',sources:[{index:0,quote:r.messages[0].content}]}],operations:[]}));
 const target=f.store.facts()[0],del=request('symbol-delete','Forget my symbol.'),p=await f.prepare(del,{facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'symbol',scope:'symbol',value:'😀',boundary:'value',source:{index:0,quote:del.messages[0].content}}]});
 assert.equal(p.sourceErasurePlan.decisions.length,0);f.commit(del,p);assert.equal(f.store.facts().find((x:any)=>x.id===target.id).state,'erased');assert.doesNotMatch(JSON.stringify(f.store.snapshot('s').erasureSources),/😀/);
}));
