import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeTime,temporalEvidenceText} from '../dist/temporal.js';
import {projectEvents} from '../dist/events.js';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {retrieve} from '../dist/retrieval.js';
import {intent} from '../dist/text.js';

const msg=(content:string,timestamp='2026-01-01T00:00:00Z')=>({role:'user',content,timestamp});
const fact=(content:string,value:string,time_text='',index=0,predicate='current_city')=>({content,subject:'user',predicate,value,cardinality:'single',time_text,sources:[{index,quote:content}]});
async function fixture(fn:any){
 const dir=mkdtempSync(join(tmpdir(),'temporal-events-'));const store=new TenantStore(dir,'u');const config=configFromEnv({});let counter=0;
 const prepare=async(messages:any[],facts?:any[],operations:any[]=[])=>{
  const req={request_id:String(++counter),user_id:'u',session_id:'s',messages};
  const x=new Extractor(facts?{...config,mode:'enhanced'}:config,{verify:async()=>[],json:async()=>({facts:structuredClone(facts),operations:structuredClone(operations)}),embedBatch:async()=>{throw Error('test embedding unavailable');}} as any);
  const p=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));return {req,p};
 };
 const commit=({req,p}:any)=>store.commit(req,hash(JSON.stringify(req)),p,store.revision());
 const add=async(content:string,date?:string)=>{const prepared=await prepare([msg(content,date)]);commit(prepared);return prepared;};
 const search=(query:string)=>retrieve(store,{user_id:'u',query,top_k:100},null,{...config,maxEvidence:100,tokenBudget:18000}).data.map(r=>r.content).join('\n');
 try{await fn({store,config,prepare,commit,add,search});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('calendar normalization preserves day/month/year/week precision and calendar boundaries',()=>{
 assert.equal(normalizeTime('yesterday','1:56 pm on 1 March 2024').start,'2024-02-29');
 assert.equal(normalizeTime('yesterday morning','2024-03-01').start,'2024-02-29');
 assert.equal(normalizeTime('last Monday','2026-01-05').start,'2025-12-29');
 assert.equal(normalizeTime('next Monday','2026-01-05').start,'2026-01-12');
 assert.equal(normalizeTime('tomorrow','2025-12-31T23:00:00-08:00').start,'2026-01-01');
 const month=normalizeTime('March 2024',null);assert.equal(month.precision,'month');assert.equal(month.start,'2024-03-01');assert.equal(month.end_exclusive,'2024-04-01');
 const year=normalizeTime('last year','2026-05-10');assert.equal(year.precision,'year');assert.equal(year.start,'2025-01-01');assert.equal(year.end_exclusive,'2026-01-01');
 const week=normalizeTime('last week','2026-01-05');assert.equal(week.start,'2025-12-29');assert.equal(week.end_exclusive,'2026-01-05');
 assert.equal(normalizeTime('2026-02-30',null).resolution,'unresolved');assert.equal(normalizeTime('May 2024 or June 2024',null).resolution,'unresolved');
 assert.equal(normalizeTime('yesterday','May 2024').resolution,'unresolved');
});
test('evidence states an event date without displaying the next day as a competing event date',()=>{
 const text=temporalEvidenceText(normalizeTime('yesterday','1 March 2024'));
 assert.match(text,/Event date: 2024-02-29/);assert.match(text,/relative to source date 2024-03-01/);assert.doesNotMatch(text,/to 2024-03-01 \(end/);
 assert.equal(temporalEvidenceText(normalizeTime('November 2024',null)),'Event month: 2024-11; exact day unknown.');
 assert.doesNotMatch(temporalEvidenceText(normalizeTime('yesterday','synthetic ordering marker 2000-01-01',true)),/1999|2000/);
});
test('remember event observation time is separate from the historical date described by its target',()=>fixture(async({prepare,commit,store}:any)=>{
 const content='I visited Paris in 2020.';commit(await prepare([msg(content,'2026-02-01T00:00:00Z')],[{...fact(content,'Paris','2020',0,'visit'),cardinality:'multiple'}]));
 const projected=projectEvents(store.events(),store.facts(),new Set(store.facts().map((f:any)=>f.id)));
 assert.equal(projected[0]?.observed_at,'2026-02-01T00:00:00Z');assert.equal(projected[0]?.event_time,undefined);assert.equal(projected[0]?.time_text,'');
 assert.match(projected[0]!.content,/Paris in 2020/);
}));
test('per-message session anchors survive chunking without applying the last header to earlier facts',()=>fixture(async({prepare,commit,store}:any)=>{
 const a='I visited Paris yesterday.',b='I visited Rome yesterday.';
 const v=await prepare([msg('[Session time: 8 May 2023] '+a),msg('[Session time: 10 May 2023] '+b)],[{...fact(a,'Paris','yesterday',0,'visit'),cardinality:'multiple'},{...fact(b,'Rome','yesterday',1,'visit'),cardinality:'multiple'}]);
 assert.equal(v.p.facts[0].event_time.start,'2023-05-07');assert.equal(v.p.facts[1].event_time.start,'2023-05-09');commit(v);
 const c='I visited Bern yesterday.';const next=await prepare([msg(c)],[{...fact(c,'Bern','yesterday',0,'visit'),cardinality:'multiple'}]);assert.equal(next.p.facts[0].event_time.start,'2023-05-09');assert.equal(store.snapshot('s').anchor,'10 May 2023');
}));
test('ordinary timestamps advance the anchor; synthetic labels never anchor relative event dates',()=>fixture(async({prepare,commit}:any)=>{
 const a='I visited Paris yesterday.';commit(await prepare([msg(a,'2026-05-08T00:00:00Z')],[{...fact(a,'Paris','yesterday',0,'visit'),cardinality:'multiple'}]));
 const b='I visited Rome yesterday.';const next=await prepare([msg(b,'2026-05-10T00:00:00Z')],[{...fact(b,'Rome','yesterday',0,'visit'),cardinality:'multiple'}]);assert.equal(next.p.facts[0].event_time.start,'2026-05-09');
 const synthetic=await prepare([msg('[Session time: synthetic ordering marker 2000-01-01; not an event date] '+b)],[{...fact(b,'Rome','yesterday'),valid_from:'2000-01-01'}]);
 assert.equal(synthetic.p.facts[0].event_time.resolution,'ordering');assert.equal(synthetic.p.facts[0].event_time.start,null);assert.equal(synthetic.p.facts[0].valid_from,null);
}));
test('month precision does not invent a day or choose one state within an uncertain transition',()=>fixture(async({prepare,commit,search}:any)=>{
 commit(await prepare([msg('I live in Oslo.','2026-06-01T00:00:00Z')],[fact('I live in Oslo.','Oslo')]));
 const content='I moved to Bergen in August 2026.';const v=await prepare([msg(content,'2026-09-10T00:00:00Z')],[fact(content,'Bergen','August 2026')]);assert.equal(v.p.facts[0].valid_from,'2026-08');commit(v);
 const during=search('city as of 2026-08-15');assert.match(during,/Oslo/);assert.match(during,/Bergen/);assert.match(during,/exact boundary unknown/);
 assert.doesNotMatch(search('city as of 2026-09-05'),/Oslo/);
}));
test('late narration cannot replace a newer state and a plan remains tentative after its date',()=>fixture(async({prepare,commit,search}:any)=>{
 commit(await prepare([msg('I live in Oslo.','2026-01-01T00:00:00Z')],[fact('I live in Oslo.','Oslo')]));
 const past='I lived in Paris in 2020.';commit(await prepare([msg(past,'2026-02-01T00:00:00Z')],[fact(past,'Paris','2020')]));
 const plan='I might move to Rome next month.';commit(await prepare([msg(plan,'2026-02-02T00:00:00Z')],[{...fact(plan,'Rome','next month'),modality:'tentative'}]));
 const current=search('current city');assert.match(current,/Oslo/);assert.doesNotMatch(current,/Paris/);assert.match(current,/tentative/);
 assert.match(search('previous city'),/Paris/);
}));
test('operation events retain intermediate updates and distinguish corrections from true history',()=>fixture(async({add,prepare,commit,store,search}:any)=>{
 await add('My manager is Alice.');await add('My manager is Beth.','2026-02-01T00:00:00Z');
 const old=store.facts().find((f:any)=>f.value==='Beth');
 const v=await prepare([msg('Correction: my manager is Clara.','2026-03-01T00:00:00Z')]);v.p.operations=[{type:'correct',target_ids:[old.id],subject:'user',predicate:'manager',scope:'',value:'Beth',boundary:'value',source:{index:0,quote:v.req.messages[0].content},reason:''}];commit(v);
 assert.deepEqual(store.events().map((e:any)=>e.type),['remember','update','correct']);
 const history=search('manager history sequence correction');assert.match(history,/Alice/);assert.match(history,/Clara/);assert.doesNotMatch(history,/Beth/);assert.match(history,/Before:/);assert.match(history,/withdrawn/);
 assert.doesNotMatch(JSON.stringify(store.events()),/Alice|Beth|Clara/);
}));
test('forget removes values and derived reflection from every event view; restore includes only new authorization',()=>fixture(async({add,prepare,commit,store,search}:any)=>{
 await add('My access code is ZX-482.');const root=store.facts()[0];
 const v=await prepare([msg('I infer a pattern from the code.')]);v.p.facts[0].kind='reflection';v.p.facts[0].modality='inferred';v.p.facts[0].depends_on=[root.id];commit(v);
 await add('Forget my access code.','2026-02-01T00:00:00Z');
 assert.doesNotMatch(search('history operation sequence code pattern'),/ZX-482|infer a pattern/);
 assert.match(search('What did I ask you to do with the code?'),/user explicitly asked the memory service to forget the access code/i);
 await add('Remember again: my access code is NEW-927.','2026-03-01T00:00:00Z');
 assert.ok(store.events().some((e:any)=>e.type==='restore'));assert.match(search('restore code operation'),/NEW-927/);assert.doesNotMatch(search('history code operation'),/ZX-482/);
 assert.doesNotMatch(JSON.stringify(store.events()),/ZX-482|NEW-927|infer a pattern/);
}));
test('event projection is transactional and query planning selects explicit operation and trajectory views',()=>fixture(async({add,prepare,store}:any)=>{
 await add('I live in Oslo.');const before=store.events();const v=await prepare([msg('I live in Bergen.','2026-02-01T00:00:00Z')]);
 assert.throws(()=>store.commit(v.req,hash(JSON.stringify(v.req)),v.p,store.revision(),'indexes'));assert.deepEqual(store.events(),before);
 assert.equal(intent('What did I ask you to forget?').mode,'operation');assert.equal(intent('How has my city changed over our conversation?').mode,'trajectory');assert.equal(intent('List all hobbies').mode,'list');assert.equal(intent('current city').mode,'current');
}));
