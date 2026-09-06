import {test} from 'node:test';import assert from 'node:assert/strict';
import {applyRepair,scopeForFindings} from '../dist/repair.js';
import {extractionSchema} from '../dist/types.js';
const fact=(value:string,index:number)=>({content:value,subject:'user',predicate:value,value,sources:[{index,quote:value}]});
const base=()=>extractionSchema.parse({facts:[fact('unrelated',0),fact('retired',1),{...fact('derived',2),depends_on:['new:1']}],operations:[{type:'forget',subject:'user',predicate:'retired',target_ids:['new:1'],source:{index:3,quote:'forget retired'}}]});
const all={fact_indices:[0,1,2],operation_indices:[0],source_indices:[0,1,2,3,4]};
test('removing an earlier slot keeps every remaining reference bound to the same fact',()=>{
 const original=base();const p=applyRepair(original,{fact_edits:[{index:0,remove:true}]},all);
 assert.equal(p.facts[0]!.value,'retired');assert.deepEqual(p.facts[1]!.depends_on,['new:0']);assert.deepEqual(p.operations[0]!.target_ids,['new:0']);assert.equal(original.facts[0]!.value,'unrelated');
});
test('removing a referenced target cannot silently redirect a dependency or delete operation',()=>{
 assert.throws(()=>applyRepair(base(),{fact_edits:[{index:1,remove:true}]},all),/target/);
 const p=applyRepair(base(),{fact_edits:[{index:1,remove:true},{index:2,changes:{depends_on:[]}}],operation_edits:[{index:0,remove:true}]},all);assert.equal(p.operations.length,0);assert.equal(p.facts[1]!.value,'derived');
});
test('appended slots are based on original length and remapped after deletions',()=>{
 const p=applyRepair(base(),{fact_edits:[{index:0,remove:true}],append_facts:[fact('new item',4)],operation_edits:[{index:0,changes:{target_ids:['new:3']}}]},all);
 assert.equal(p.facts[2]!.value,'new item');assert.deepEqual(p.operations[0]!.target_ids,['new:2']);
});
test('a localized missing message cannot modify unrelated facts or add content from other messages',()=>{
 const original=base(),scope=scopeForFindings(original,['message 1: Missing detail']);assert.deepEqual(scope,{fact_indices:[1],operation_indices:[],source_indices:[1]});
 assert.throws(()=>applyRepair(original,{fact_edits:[{index:0,remove:true}]},scope),/unflagged/);
 assert.throws(()=>applyRepair(original,{append_facts:[fact('wrong source',0)]},scope),/sources/);
 assert.throws(()=>applyRepair(original,{fact_edits:[{index:1,changes:{sources:[{index:0,quote:'unrelated'}]}}]},scope),/sources/);
 assert.throws(()=>applyRepair(original,{operation_edits:[{index:0,remove:true}]},scope),/unflagged/);
 const patched=applyRepair(original,{fact_edits:[{index:1,changes:{value:'more precise'}}]},scope);assert.deepEqual(patched.facts[0],original.facts[0]);assert.deepEqual(patched.facts[2],original.facts[2]);
});
test('duplicate edits, full-object regeneration and unknown fields are rejected',()=>{
 assert.throws(()=>applyRepair(base(),{fact_edits:[{index:0,changes:{value:'x'}},{index:0,changes:{value:'y'}}]},all),/unflagged|unavailable/);
 assert.throws(()=>applyRepair(base(),{facts:[],operations:[]},all),/patch/);
 assert.throws(()=>applyRepair(base(),{fact_edits:[{index:0,changes:{database_id:'other'}}]},all),/patch/);
});
