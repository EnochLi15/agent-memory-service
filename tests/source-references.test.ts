import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {sourceReferenceWork,sourceReferenceMessages,decodeSourceReferences} from '../dist/source-references.js';
import {sourceSpans} from '../dist/passages.js';import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';
const timestamp='2026-01-01T00:00:00Z',snapshot={facts:[],tail:[],anchor:null,revision:0};
const request=(...contents:string[])=>({user_id:'u',request_id:'refs',session_id:'s',messages:contents.map(content=>({role:'user',content,timestamp}))});
const fact=(refs:number[][],content='I use Firefox.',predicate='browser',value='Firefox')=>({content,subject:'user',predicate,value,source_refs:refs});
const group=(message_index:number,facts:any[]=[],operations:any[]=[])=>({message_index,facts,operations});
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'source_refs',MEMORY_MAX_REPAIR_ROUNDS:'1'});
const models=(raw:any,verify:any=async()=>[])=>({json:async()=>structuredClone(raw),verify,embedBatch:async(xs:string[])=>xs.map(()=>[1,0])});

test('source tables losslessly partition original UTF-16 text, including metadata, long sentences and surrogate boundaries',()=>{
 const req=request('  [Session time: 2026-01-01]\n你好。😀 Still here!  \n', 'x'.repeat(899)+'😀'+'z'.repeat(1200), 'word '.repeat(600), '   ', '');
 const work=sourceReferenceWork(req);assert.deepEqual(work,sourceReferenceWork(req));
 for(const m of work.messages){assert.equal(m.spans.map(s=>s.text).join(''),req.messages[m.index].content);let end=0;for(const s of m.spans){assert.equal(s.start,end);assert.equal(s.slot,m.spans.indexOf(s));assert.equal(s.text,req.messages[m.index].content.slice(s.start,s.end));assert.ok(s.text.length<=900);assert.doesNotMatch(s.text,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);end=s.end;}}
 assert.notEqual(work.fingerprint,sourceReferenceWork({...req,request_id:'another'}).fingerprint);
 assert.notEqual(work.fingerprint,sourceReferenceWork(request('different text')).fingerprint);
 assert.ok(sourceReferenceMessages(req).every(m=>m.spans.every(s=>!('start' in s)&&!('end' in s))));
});

test('expanded references retain the complete qualification and selected offsets for independent verification',async()=>{
 const text='I want to offer them relevant promotions based on previous purchases and interests.',req=request(text);
 const raw={message_groups:[group(0,[fact([[0,0]],text,'promotion_preference',text)])]};let checked=0;
 const p=await new Extractor(config,models(raw,async(p:any)=>{checked++;assert.deepEqual(p.facts[0].sources,[{index:0,quote:text,start:0}]);return [];}) as any).prepare(req,snapshot,AbortSignal.timeout(1000));
 assert.equal(checked,1);assert.deepEqual(p.facts[0].source_quotes,[text]);assert.deepEqual(p.facts[0].source_spans,[{source_id:p.messages[0].id,start:0,end:text.length}]);
});

test('references reject forged, repeated, future, assistant, metadata-only and mixed-encoding witnesses',()=>{
 const req=request('I use Firefox.','Understood.','I prefer local storage.');req.messages[1].role='assistant';
 const valid=()=>({message_groups:[group(0,[fact([[0,0]])]),group(2,[fact([[2,0],[0,0]],'I prefer local storage.','storage','local')])]});
 assert.equal(decodeSourceReferences(valid(),req).facts[1].sources.length,2);
 for(const refs of [[[9,0]],[[0,9]],[[0,0],[0,0]],[[0,0],[1,0]],[[0,0],[2,0]]]){const r=valid();r.message_groups[0].facts[0].source_refs=refs;assert.throws(()=>decodeSourceReferences(r,req));}
 const both=valid();both.message_groups[0].facts[0].sources=[{index:0,quote:'I use Firefox.'}];assert.throws(()=>decodeSourceReferences(both,req));
 assert.throws(()=>decodeSourceReferences({message_groups:[group(0,[fact([[0,0]])])]},request('[Source id: meta]')));
 assert.throws(()=>decodeSourceReferences({message_groups:valid().message_groups.slice(0,1)},req));
});

test('literal subclause escape requires an actual unique same-message target and never relocates an absent quote',()=>{
 const req=request('My salary is 90000, but forget my salary.');
 const f={content:'My salary is 90000',subject:'user',predicate:'salary',value:'90000',sources:[{index:0,quote:'My salary is 90000'}]};
 const op={type:'forget',target_ids:['new:0:0'],subject:'user',predicate:'salary',source:{index:0,quote:'forget my salary'}};
 const raw=()=>({message_groups:[group(0,[structuredClone(f)],[structuredClone(op)])]});
 assert.equal(decodeSourceReferences(raw(),req).operations[0].target_ids[0],'new:0');
 for(const mode of ['missing','untargeted','offset','ambiguous']){const r=raw();let q=req;if(mode==='missing')r.message_groups[0].facts[0].sources[0].quote='My salary is 80000';if(mode==='untargeted')r.message_groups[0].operations=[];if(mode==='offset')r.message_groups[0].facts[0].sources[0].start=0;if(mode==='ambiguous')q=request('My salary is 90000, My salary is 90000, but forget my salary.');assert.throws(()=>decodeSourceReferences(r,q),mode);}
});

test('reference offsets select one occurrence; legacy quote-only witnesses retain all occurrences',()=>{
 const quote='I use Firefox. ',text=quote+'Forget my browser. '+quote,messages=[{id:'source',content:text}] as any;
 assert.deepEqual(sourceSpans({sources:[{index:0,quote,start:0}]},messages),[{source_id:'source',start:0,end:quote.length}]);
 assert.equal(sourceSpans({sources:[{index:0,quote}]},messages).length,2);
 for(const start of [-1,1,0.5,text.length])assert.throws(()=>sourceSpans({sources:[{index:0,quote,start}]},messages));
});

test('semantic patches receive original messages and keep resolved reference offsets on unchanged facts',async()=>{
 const req=request('I use Firefox. I prefer local storage.'),cfg={...config,maxRepairRounds:1};let calls=0,checks=0;
 const p=await new Extractor(cfg,{...models({}),json:async(_s:string,input:string)=>{const d=JSON.parse(input);if(++calls===1){assert.equal(d.EXTRACTION_PROTOCOL,'message-groups-source-refs-v1');assert.ok(d.NEW_MESSAGES[0].spans);assert.equal(d.NEW_MESSAGES[0].content,undefined);return {message_groups:[group(0,[fact([[0,0]])])]};}assert.equal(d.EXTRACTION_PROTOCOL,'flat-patch-v1');assert.equal(d.NEW_MESSAGES[0].content,req.messages[0].content);return {append_facts:[{content:'I prefer local storage.',subject:'user',predicate:'storage',value:'local',modality:'confirmed',sources:[{index:0,quote:'I prefer local storage.'}]}]};},verify:async()=>++checks===1?['message 0: local storage preference is missing']:[]} as any).prepare(req,snapshot,AbortSignal.timeout(1000));
 assert.equal(calls,2);assert.equal(checks,2);assert.equal(p.facts.length,2);assert.equal(p.facts[0].source_spans[0].start,0);
});

test('earlier repeated source can bind a same-chunk retirement; later occurrence fails preparation and transaction chronology',async()=>{
 const req=request('Beth is my current colleague. Remove Beth from my current colleagues. Beth is my current colleague. ');
 const op={type:'retract',boundary:'current_relation',target_ids:['new:0:0'],subject:'user',predicate:'colleague',source:{index:0,quote:'Remove Beth from my current colleagues.'}};
 const raw=(slot:number)=>({message_groups:[group(0,[fact([[0,slot]],'Beth is my current colleague.','colleague','Beth')],[op])]});
 const dir=mkdtempSync(join(tmpdir(),'source-refs-')),store=new TenantStore(dir,'u');
 try{const p=await new Extractor(config,models(raw(0)) as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));
  await assert.rejects(()=>new Extractor(config,models(raw(2)) as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(1000)),/chronology|target/i);
  const forged=structuredClone(p),last=sourceReferenceWork(req).messages[0].spans[2];forged.facts[0].source_spans=[{source_id:p.messages[0].id,start:last.start,end:last.end}];
  assert.throws(()=>store.commit(req,hash(JSON.stringify(req)),forged,0));assert.equal(store.revision(),0);
  store.commit(req,hash(JSON.stringify(req)),p,0);assert.equal(store.revision(),1);assert.equal(store.facts()[0].state,'superseded');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('same-sentence remember-and-forget escape erases its target and preserves an independent neighboring fact',async()=>{
 const before='I had a dentist appointment with Dr. Pham on April 9th',command="you don't need to keep track of that anymore";
 const req=request('I use Firefox. '+before+', so '+command+'.');
 const raw={message_groups:[group(0,[fact([[0,0]]),{content:before,subject:'user',predicate:'appointment',scope:'dentist',value:'Dr. Pham on April 9th',sources:[{index:0,quote:before}]}],[{type:'forget',subject:'user',predicate:'appointment',scope:'dentist',target_ids:['new:0:1'],source:{index:0,quote:command}}])]};
 const dir=mkdtempSync(join(tmpdir(),'source-refs-forget-')),store=new TenantStore(dir,'u');
 try{const p=await new Extractor(config,models(raw) as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(req,hash(JSON.stringify(req)),p,0);assert.equal(store.facts().filter(f=>f.state==='erased').length,1);assert.ok(store.facts().some(f=>f.value==='Firefox'&&f.state==='active'));assert.ok(store.passages().some(p=>p.content.includes('Firefox')));assert.ok(store.passages().every(p=>!p.content.includes('Dr. Pham')));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
