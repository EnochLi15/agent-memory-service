import {test} from 'node:test';import assert from 'node:assert/strict';
import {decodeSourceErasureResponse,validateSourceErasure,maskSource} from '../dist/source-erasure.js';
const work=(text:string,kind='source')=>({fingerprint:'fixed-source-identity',candidates:[{id:'source-1',kind,start:0,text,key:'boundary',boundary:{},authorization:null,matching_words:[],context:{}}]}) as any;
const row=(effect:string,erase_quotes:string[]=[])=>({index:0,effect,erase_quotes,reason:({erase:'same_erased_record',retain:'independent_record',mixed:'mixed_source',uncertain:'uncertain_scope'} as any)[effect]});
const decode=(text:string,decision:any,kind='source')=>decodeSourceErasureResponse({decisions:[decision]},work(text,kind));
test('uniform compact decisions resolve the untouched original text, including Unicode and whitespace',()=>{
 const text='甲😀\n  Original\ttext.\r\n';
 for(const effect of ['erase','retain']){const plan=decode(text,row(effect));assert.deepEqual(plan.decisions[0].parts,[{text,effect}]);const result=validateSourceErasure(plan,work(text));assert.equal(result.cuts.has('source-1'),effect==='erase');}
});
test('mixed compact decisions erase all selected spans and retain independent same-name neighbors',()=>{
 const text='My backup name is Iris.\nMy colleague Iris lives in Paris.\nKeeping the backup was hedging.';
 const plan=decode(text,row('mixed',['Keeping the backup was hedging.','My backup name is Iris.']));
 assert.equal(plan.decisions[0].parts.map(p=>p.text).join(''),text);
 const result=validateSourceErasure(plan,work(text)),masked=maskSource(text,result.cuts.get('source-1')!);
 assert.match(masked,/My colleague Iris lives in Paris/);assert.doesNotMatch(masked,/backup|hedging/);assert.equal(masked.length,text.length);
});
test('missing, repeated, overlapping, rewritten and Unicode-splitting erasure quotes reject',()=>{
 const text='甲😀: Iris is my backup; colleague Iris stays.';
 for(const quotes of [[],['Iris'],['not present'],['my backup','backup'],['my backup','my backup'],['\uD83D'],[text]])assert.throws(()=>decode(text,row('mixed',quotes)));
 assert.throws(()=>decode(text,row('retain',['Iris'])),/Whole-source/);assert.throws(()=>decode(text,row('erase',['my backup'])),/Whole-source/);
});
test('compact uncertainty and mixed facts cannot produce a deletion plan',()=>{
 assert.throws(()=>decode('Mixed record.',row('uncertain')),/Uncertain/);
 assert.throws(()=>decode('Erase detail; keep neighbor.',row('mixed',['Erase detail']),'fact'),/Mixed erasure/);
});
test('compact protocol requires every candidate exactly once and rejects extra decision fields',()=>{
 const w=work('detail'),valid=row('retain');
 for(const raw of [{decisions:[]},{decisions:[valid,valid]},{decisions:[{...valid,index:-1}]},{decisions:[{...valid,parts:[]}]},{decisions:[{...valid,reason:''}]},{decisions:[{...valid,reason:'unlisted_reason'}]},{decisions:[{...valid,reason:'same_erased_record'}]},{decisions:[{...valid,erase_quotes:null}]},{decisions:[valid],ignore_all:true}])assert.throws(()=>decodeSourceErasureResponse(raw,w));
 const two={...w,candidates:[...w.candidates,{...w.candidates[0],id:'other'}]};assert.throws(()=>decodeSourceErasureResponse({decisions:[valid,valid]},two),/Invalid/);
});
import {sourceErasureInput,sourceErasureBatches} from '../dist/source-erasure.js';
test('total transmitted capacity counts repeated tables across batches and rejects before any model call',()=>{
 const candidates=Array.from({length:70},(_,i)=>({kind:'source',id:String(i),start:0,text:'Pham '+('unique '+i+' ').repeat(450),key:'b',boundary:{subject:'user'},authorization:null,matching_words:['Pham'],context:{}}));
 assert.throws(()=>sourceErasureBatches({fingerprint:'f',candidates}),/transmitted capacity/);
 assert.throws(()=>sourceErasureBatches({fingerprint:'f',candidates:[{...candidates[0],text:'Pham '+('x'.repeat(64000))}]}),/batch capacity/);
});
test('reference tables reconstruct every candidate including different boundaries on the same source',()=>{
 const base=work('My backup is Iris. My colleague Iris stays.').candidates[0];
 const candidates=[{...base,boundary:{subject:'user',scope:'backup'},authorization:{source:{quote:'Forget my backup.'}},matching_words:['backup']},{...base,key:'other-boundary',boundary:{subject:'user',scope:'old note'},authorization:null,matching_words:['note']},{...base,id:'different-source',boundary:{subject:'user',scope:'backup'},authorization:{source:{quote:'Forget my backup.'}},matching_words:['backup']}];
 const packed=sourceErasureInput({candidates});assert.equal(packed.SOURCES.length,2);assert.equal(packed.BOUNDARIES.length,2);
 const restored=packed.CANDIDATES.map(c=>({...packed.SOURCES[c.source_slot],...packed.BOUNDARIES[c.boundary_slot],matching_words:c.matching_words}));assert.deepEqual(restored,candidates);assert.deepEqual(packed.CANDIDATES.map(c=>c.index),[0,1,2]);
});
test('packed batch capacity is checked on transmitted JSON and never drops repeated source-boundary pairs',()=>{
 const base=work('Context '+('long detail '.repeat(250))).candidates[0];
 const candidates=Array.from({length:90},(_,i)=>({...base,key:'boundary-'+(i%3),boundary:{scope:String(i%3)},matching_words:[String(i)]}));
 const batches=sourceErasureBatches({fingerprint:'f',candidates});assert.equal(batches.length,2);assert.deepEqual(batches.flatMap(b=>b.candidates),candidates);
 for(const batch of batches){assert.ok(batch.candidates.length<=64);assert.ok(JSON.stringify(sourceErasureInput(batch)).length<=64000);}
 assert.ok(JSON.stringify(sourceErasureInput({candidates})).length<JSON.stringify({CANDIDATES:candidates}).length/3);
});

import {sourceQuoteProblems,applySourceQuoteRepairs} from '../dist/source-erasure.js';
test('quote repair preserves verdicts, valid siblings and the original response',()=>{
 const text='Iris works as a strong second option; I prefer June. Old hedging.',w=work(text);
 w.candidates.push({...w.candidates[0],id:'independent',text:'My colleague Iris stays.'});
 const raw={decisions:[row('mixed',['Iris as a strong second option','Old hedging.']),{...row('retain'),index:1}]},before=structuredClone(raw);
 const problems=sourceQuoteProblems(raw,w);assert.equal(problems.length,1);assert.equal(problems[0].quote_index,0);assert.deepEqual(problems[0].unchanged_quotes,['Old hedging.']);assert.deepEqual(problems[0].candidate,w.candidates[0]);
 const patched=applySourceQuoteRepairs(raw,w,{repairs:[{index:0,status:'resolved',quote:'Iris works as a strong second option'}]}) as any;
 assert.deepEqual(raw,before);const expected=structuredClone(before);expected.decisions[0].erase_quotes[0]='Iris works as a strong second option';assert.deepEqual(patched,expected);
 const result=validateSourceErasure(decodeSourceErasureResponse(patched,w),w);assert.match(maskSource(text,result.cuts.get('source-1')!),/I prefer June/);assert.equal(result.cuts.has('independent'),false);
});
test('all semantic decisions must be resolved before any quote defect is repairable',()=>{
 const w=work('Erase old value; keep current.');w.candidates.push({...w.candidates[0],id:'later'});
 const raw={decisions:[row('mixed',['missing word']),{...row('uncertain'),index:1}]};
 assert.throws(()=>sourceQuoteProblems(raw,w),/Uncertain/);assert.throws(()=>applySourceQuoteRepairs(raw,w,{repairs:[{index:0,status:'resolved',quote:'Erase old value'}]}),/Uncertain/);
});
test('quote patches reject omitted, duplicate, uncertain, nonliteral and overlapping repairs',()=>{
 const w=work('Erase old value; delete old detail; keep current.'),raw={decisions:[row('mixed',['Erase value','delete detail'])]};
 const valid={repairs:[{index:0,status:'resolved',quote:'Erase old value'},{index:1,status:'resolved',quote:'delete old detail'}]};
 for(const patch of [{repairs:[]},{repairs:[valid.repairs[0],valid.repairs[0]]},{repairs:[{...valid.repairs[0],status:'uncertain',quote:''},valid.repairs[1]]},{...valid,decisions:[]},{repairs:[{...valid.repairs[0],effect:'erase'},valid.repairs[1]]},{repairs:[{...valid.repairs[0],quote:'not present'},valid.repairs[1]]},{repairs:[{...valid.repairs[0],quote:'Erase old value; delete old detail'},valid.repairs[1]]}])assert.throws(()=>applySourceQuoteRepairs(raw,w,patch));
 assert.doesNotThrow(()=>applySourceQuoteRepairs(raw,w,valid));
 assert.throws(()=>sourceQuoteProblems({decisions:[row('mixed',Array.from({length:9},(_,i)=>'missing-'+i))]},w),/Too many/);
});
