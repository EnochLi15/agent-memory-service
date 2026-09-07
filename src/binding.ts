import {canonical,sameScope,sameSlot as matchesSlot,propertyFamily,operationScopeProblem,type Fact,type Operation} from './types.js';
import {overlap} from './text.js';

export type TargetBinding =
 | {status:'resolved';target_ids:string[];evidence:{target_id:string;via:'explicit_id'|'property_selector'|'equivalent_value'|'property_boundary'}[]}
 | {status:'missing_evidence'|'ambiguous';code:string;reason:string;candidate_ids:string[]};

/** Pure target selection. This never authorizes an action: semantic verification
 * receives the resolved records before commit, and commit repeats this selection. */
export function resolveOperationTargets(operation:Operation,pool:Fact[],allowEmpty=false):TargetBinding{
 const byId=new Map(pool.map(f=>[f.id,f]));
 if(new Set(operation.target_ids).size!==operation.target_ids.length)return {status:'ambiguous',code:'OPERATION_TARGET',reason:'Duplicate target suggestions',candidate_ids:[]};
 if(operation.target_ids.some(id=>!byId.has(id)))return {status:'missing_evidence',code:'OPERATION_TARGET',reason:'A target is missing or unavailable at the operation source position',candidate_ids:[]};
 const explicit=operation.target_ids.length>0;
 let selected=explicit?operation.target_ids.map(id=>byId.get(id)!):pool.filter(f=>matchesSlot(f,operation)&&f.predicate!=='memory_operation'&&(
  ['correct','update'].includes(operation.type)?['active','conflicted'].includes(f.state):!operation.value||canonical(f.value)===canonical(operation.value)));
 if(selected.some(f=>f.predicate==='memory_operation'))return {status:'missing_evidence',code:'OPERATION_TARGET',reason:'An operation trace is not the underlying target',candidate_ids:[]};
 const scopeProblem=operationScopeProblem(operation,selected);
 if(scopeProblem)return {status:scopeProblem==='AMBIGUOUS_OPERATION'?'ambiguous':'missing_evidence',code:scopeProblem,reason:'Operation subject, property or scope does not match its suggested targets',candidate_ids:selected.map(f=>f.id)};
 if(!explicit&&['correct','update'].includes(operation.type)&&new Set(selected.map(f=>canonical(f.value))).size>1)return {status:'ambiguous',code:'OPERATION_TARGET',reason:'More than one old value matches; choose actual targets explicitly',candidate_ids:selected.map(f=>f.id)};
 if(!selected.length&&!allowEmpty)return {status:'missing_evidence',code:'OPERATION_TARGET',reason:'No grounded record matches the operation selector',candidate_ids:[]};
 const evidence:Extract<TargetBinding,{status:'resolved'}>['evidence']=selected.map(f=>({target_id:f.id,via:explicit?'explicit_id':'property_selector'}));
 const initial=[...selected];
 for(const f of pool){
  if(selected.some(t=>t.id===f.id)||f.predicate==='memory_operation')continue;
  const sameSlot=(t:Fact)=>canonical(t.subject)===canonical(f.subject)&&sameScope(t,f)&&propertyFamily(t.predicate,t.content)===propertyFamily(f.predicate,f.content);
  const propertyBoundary=operation.type==='forget'&&operation.boundary==='property'&&initial.some(sameSlot);
  const equivalent=f.state==='active'&&f.kind!=='event'&&initial.some(t=>t.value&&canonical(t.value)===canonical(f.value)&&sameSlot(t));
  if(propertyBoundary||equivalent){selected.push(f);evidence.push({target_id:f.id,via:propertyBoundary?'property_boundary':'equivalent_value'});}
 }
 if(selected.length>256)return {status:'ambiguous',code:'OPERATION_TARGET',reason:'Target set exceeds the bounded verification capacity; refine the operation scope',candidate_ids:selected.slice(0,24).map(f=>f.id)};
 return {status:'resolved',target_ids:selected.map(f=>f.id),evidence};
}

/** Bounded repair candidates use the operation rather than unrelated chunk text.
 * Ranking is a suggestion only; it cannot silently replace model target IDs. */
export function bindingCandidates(operation:Operation,facts:Fact[],limit=24):Fact[]{
 return facts.filter(f=>f.predicate!=='memory_operation'&&canonical(f.subject)===canonical(operation.subject)).map(f=>{
  const sameProperty=propertyFamily(f.predicate,f.content)===propertyFamily(operation.predicate);
  const matchingScope=sameScope(f,operation);
  const lexical=overlap(operation.source.quote,`${f.subject} ${f.predicate} ${f.scope} ${f.content}`);
  return {f,score:(sameProperty?4:0)+(sameProperty&&matchingScope?6:0)+lexical*2,relevant:sameProperty||lexical>.15};
 }).filter(x=>x.relevant).sort((a,b)=>b.score-a.score||a.f.id.localeCompare(b.f.id)).slice(0,Math.max(0,Math.min(32,limit))).map(x=>x.f);
}
