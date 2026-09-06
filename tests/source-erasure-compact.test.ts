import {test} from 'node:test';import assert from 'node:assert/strict';
import {decodeSourceErasureResponse,validateSourceErasure,maskSource} from '../dist/source-erasure.js';
const work=(text:string,kind='source')=>({fingerprint:'fixed-source-identity',candidates:[{id:'source-1',kind,start:0,text,key:'boundary',boundary:{},authorization:null,matching_words:[],context:{}}]}) as any;
const row=(effect:string,erase_quotes:string[]=[])=>({index:0,effect,erase_quotes,reason:'Fixture scope decision.'});
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
 for(const raw of [{decisions:[]},{decisions:[valid,valid]},{decisions:[{...valid,index:-1}]},{decisions:[{...valid,parts:[]}]},{decisions:[{...valid,reason:''}]},{decisions:[{...valid,erase_quotes:null}]},{decisions:[valid],ignore_all:true}])assert.throws(()=>decodeSourceErasureResponse(raw,w));
 const two={...w,candidates:[...w.candidates,{...w.candidates[0],id:'other'}]};assert.throws(()=>decodeSourceErasureResponse({decisions:[valid,valid]},two),/Invalid/);
});
