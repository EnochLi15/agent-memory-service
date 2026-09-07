import {test} from 'node:test';import assert from 'node:assert/strict';
import {rerankPayload,decodeRerank} from '../dist/reranking.js';
const evidence=Array.from({length:80},(_,i)=>({id:i.toString().padStart(64,'0'),content:`Original evidence ${i}.`,score:1/(i+1),created_at:'2026-01-01T00:00:00Z'}));
test('compact reranking preserves original evidence and resolves only supplied slots',()=>{
 const full=rerankPayload('query',evidence,'ids'),compact=rerankPayload('query',evidence,'indices');const rows=JSON.parse(compact.input).evidence;
 assert.deepEqual(rows.map(({slot,...r}:any)=>({...r,id:evidence[slot].id})),evidence);assert.ok(compact.input.length<full.input.length);assert.match(compact.prompt,/JSON/);
 assert.deepEqual(decodeRerank({ranked:[[79,1],[0,.2]]},evidence,'indices'),[{id:evidence[79].id,score:1},{id:evidence[0].id,score:.2}]);
 const ids=JSON.stringify({ranked:evidence.map(e=>({id:e.id,score:1}))}),slots=JSON.stringify({ranked:evidence.map((_,i)=>[i,1])});assert.ok(slots.length<ids.length/4);
});
test('compact reranker rejects omitted structure, foreign or duplicate slots and unbounded scores',()=>{
 for(const ranked of [[[80,1]],[[-1,1]],[[.5,1]],[['1',1]],[[0,1],[0,.2]],[[0,1.01]],[[0,-1]],[[0,'1']],[[0,1,'extra']]])assert.throws(()=>decodeRerank({ranked},evidence,'indices'));
 assert.throws(()=>decodeRerank({},evidence,'indices'));assert.throws(()=>decodeRerank({ranked:[{id:evidence[0].id,score:1}]},evidence,'indices'));
 assert.deepEqual(decodeRerank({ranked:[]},evidence,'indices'),[]);assert.deepEqual(decodeRerank({ranked:[{id:evidence[0].id,score:1}]},evidence,'ids'),[{id:evidence[0].id,score:1}]);
});
