import type {Fact,MemoryEvent} from './types.js';
import {propertyFamily} from './types.js';

/** Retained audit categories come from a closed vocabulary, never model values. */
export function eventCategory(f:Pick<Fact,'predicate'|'content'>):string{
 const family=propertyFamily(f.predicate,f.content);
 const categories=['current city','job title','manager','backup name','primary name','session cadence','access code','hobby','salary','quote','budget','schedule','preference','reflection','contact','project','appointment','storage','plan'];
 return categories.find(c=>family===c||family.includes(c))??'memory record';
}
export function projectEvents(events:MemoryEvent[],facts:Fact[],visible:Set<string>,correctedStatements=new Set<string>()):Fact[]{
 const byId=new Map(facts.map(f=>[f.id,f]));
 const describe=(ids:string[]):string=>ids.length?ids.map(id=>{
  const f=byId.get(id);
  if(f?.state==='retracted'&&correctedStatements.has(id))return `Statement later corrected (not a valid or current fact): ${f.content}${f.value?` [recorded value: ${f.value}]`:''}`;
  return f&&f.state!=='erased'&&f.state!=='retracted'&&visible.has(id)?`${f.content} (${f.modality}; ${f.state})`:'[value unavailable: removed, withdrawn, or dependent evidence no longer visible]';
 }).join(' | '):'[none]';
 return events.map(e=>{
  const forgotten=e.type==='forget';
  // A value-free descriptor from the instruction ("my previous city") names
  // WHAT was removed without leaking the removed value itself.
  const named=e.descriptor||e.category;
  const action=forgotten?`${named} entry was explicitly removed from memory (forgotten)`:`${e.type} ${e.category}`;
  const actor=e.actor==='user'?'The user':e.actor==='participant'?'The source participant':null;
  const authorization=actor&&forgotten?`${actor} explicitly asked the memory service to forget the ${named}. `:actor&&e.type==='restore'?`${actor} explicitly authorized remembering the new ${e.category} again. `:'';
  const content=`${authorization}Memory operation ${action}. Source order ${e.ordinal}. Before: ${forgotten?'[forgotten value not retained]':describe(e.before_ids)}. After: ${forgotten?'[absent]':describe(e.after_ids)}.`;
  // The operation happened when it was observed; its target may describe a
  // much earlier event. Never copy that target's date onto the operation.
  return {id:e.id,content,subject:'memory event',predicate:'memory_operation',scope:'',value:'',kind:'event',modality:'confirmed',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:e.source_ids,source_quotes:[],created_at:e.observed_at,observed_at:e.observed_at,time_basis:e.time_basis,state:'active',vector:null,entities:[],revision:e.revision};
 });
}
