import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeSourceReferences} from '../src/source-references.js';

const request={request_id:'r',user_id:'u',session_id:'s',messages:[
 {role:'user',content:'[Session time: 2026-01-01]\nI use Firefox.'},
 {role:'assistant',content:'Understood.'},
 {role:'user',content:'I prefer jasmine tea.'},
 {role:'assistant',content:'Noted.'},
 {role:'user',content:'I enjoy pottery.'}
]};
const fact=(source_refs:number[][])=>({content:'I prefer jasmine tea.',subject:'user',predicate:'preference',value:'jasmine tea',source_refs});
const group=(message_index:number,facts:any[]=[])=>({message_index,facts,operations:[]});
function feedback(raw:any){
 const before=JSON.stringify(raw);let result:any;
 assert.throws(()=>decodeSourceReferences(raw,request as any),(e:any)=>{
  assert.equal(e.code,'EXTRACTION_SCHEMA');
  assert.match(e.message,/SOURCE_REFERENCE_PROBLEMS:/);
  result=JSON.parse(e.message.split('SOURCE_REFERENCE_PROBLEMS: ')[1]);return true;
 });
 assert.equal(JSON.stringify(raw),before,'rejection must not silently relocate or remove references');
 return result;
}

test('one repair diagnostic identifies all absent slots with their exact fact positions',()=>{
 const result=feedback({message_groups:[group(0),group(2,[fact([[2,1]])]),group(4,[fact([[4,7]])])]});
 assert.equal(result.total,2);
 assert.deepEqual(result.problems.map((p:any)=>[p.group_message_index,p.fact_index,p.reference,p.reason,p.available_span_slots]),[
  [2,0,[2,1],'unknown_span',[0]], [4,0,[4,7],'unknown_span',[0]]
 ]);
});

test('feedback distinguishes duplicate, assistant and metadata references without admitting them',()=>{
 const result=feedback({message_groups:[group(0,[fact([[0,0],[0,1],[0,1],[1,0]])]),group(2),group(4)]});
 assert.deepEqual(result.problems.map((p:any)=>p.reason),['non_evidence_span','duplicate_reference','non_human_message']);
 assert.deepEqual(result.problems[0].available_span_slots,[1]);
 assert.deepEqual(result.problems[2].available_span_slots,[]);
});

test('reference feedback is bounded and reports when more defects remain',()=>{
 const result=feedback({message_groups:[group(0),group(2,[fact(Array.from({length:40},(_,i)=>[2,i+1]))]),group(4)]});
 assert.equal(result.total,40);assert.equal(result.problems.length,32);assert.equal(result.truncated,true);
});

test('valid references still expand to unchanged original source text and positions',()=>{
 const result=decodeSourceReferences({message_groups:[group(0),group(2,[fact([[2,0]])]),group(4)]},request as any);
 assert.deepEqual(result.facts[0]?.sources,[{index:2,quote:'I prefer jasmine tea.',start:0}]);
});
