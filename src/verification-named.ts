import type {Extraction} from './types.js';
import {VERIFICATION_SEMANTICS,type VerificationScope} from './verification.js';
import {decodeCompactVerification} from './verification-compact.js';
import {SOURCE_COVERAGE_SEMANTICS,type SourceCoverageWork} from './source-coverage.js';

export const NAMED_VERIFICATION_PROTOCOL='named-evidence-checks-v1';
const arrays=['fact_checks','operation_checks','replacement_checks','message_checks'] as const;
const fields={
 fact_checks:['fact_id','supported','modality_supported','source_id','reason'],
 operation_checks:['operation_id','authorized','target_matches','reason'],
 replacement_checks:['replacement_id','supported','reason'],
 message_checks:['message_id','verdict','fact_ids','operation_ids','passage_ids','quote','reason'],
};
const text={type:'string'},nullableText={type:['string','null']},boolean={type:'boolean'},ids={type:'array',items:text};
const properties={
 fact_checks:{fact_id:text,supported:boolean,modality_supported:boolean,source_id:nullableText,reason:nullableText},
 operation_checks:{operation_id:text,authorized:boolean,target_matches:boolean,reason:nullableText},
 replacement_checks:{replacement_id:text,supported:boolean,reason:nullableText},
 message_checks:{message_id:text,verdict:{type:'string',enum:['represented','not_memorable','missing']},fact_ids:ids,operation_ids:ids,passage_ids:ids,quote:nullableText,reason:nullableText},
};
export const NAMED_VERIFICATION_RESPONSE_FORMAT={type:'json_schema' as const,json_schema:{name:'memory_verification_named_v1',strict:true,schema:{type:'object',properties:Object.fromEntries(arrays.map(k=>[k,{type:'array',items:{type:'object',properties:properties[k],required:fields[k],additionalProperties:false}}])),required:[...arrays],additionalProperties:false}}};

// Only terminology changes; retain the same evidence/authorization requirements.
const terminology=(s:string)=>s.replaceAll('fact_id','memory_id').replaceAll('fact_index','fact_id').replaceAll('forget_operation_indices','forget_operation_ids').replaceAll('matching_scope_operation_indices','matching_scope_operation_ids').replaceAll('PARTICIPANT_INDEX','PARTICIPANT_IDS');
export const NAMED_VERIFICATION_PROMPT=terminology(VERIFICATION_SEMANTICS)+`
Output protocol: named-evidence-checks-v1. Return one object with exactly fact_checks, operation_checks, replacement_checks and message_checks arrays. Use [] for empty check scopes. Return each requested ID in CHECK_SCOPE exactly once and no unrequested checks. All rows are named objects, never positional tuples. IDs are issued for this exact proposal and cannot be invented or copied from an earlier proposal. Persistent memory_id/target_id values are not fact_id/check IDs.
fact_checks rows: {"fact_id":"fact:0","supported":true,"modality_supported":true,"source_id":"fact:0/source:0","reason":null}. Select a source_id declared under that exact fact, checking all claims and sources. The server resolves its exact quote and human message. A false boolean remains a rejection regardless of explanatory wording. A rejected fact may use source_id:null; a positive fact must select a declared source. Rejections need a nonempty reason. Omit a successful reason or use null.
operation_checks rows: {"operation_id":"op:0","authorized":true,"target_matches":true,"reason":null}. Judge the full instruction and actual target meaning using its declared source. Either false requires a nonempty reason. Do not return mutations or copy source quotes.
replacement_checks rows: {"replacement_id":"replacement:0","supported":true,"reason":null}. Use the replacement_id explicitly supplied in REPLACEMENT_TARGETS for that exact fact/target pair. A rejection needs a nonempty reason.
message_checks rows: {"message_id":"msg:0","verdict":"represented","fact_ids":["fact:0"],"operation_ids":[],"passage_ids":[],"quote":null,"reason":null}. Always keep all three reference arrays, using [] where empty. represented means ALL memorable content is covered; use only facts/operations linked to this message in MESSAGE_SOURCE_LINKS, and any explicitly permitted same-message passages. At least one valid reference is required. Source linkage alone does not prove completeness. not_memorable means no durable personal information or actual memory instruction needs storage; all reference arrays must be empty. missing means memorable content is absent even if other details are covered; use empty reference arrays, quote the exact missing human statement in quote, and explain ALL remaining omissions in reason. No mutations or overall score. For represented/not_memorable use quote:null. For not_memorable a reason is optional.
The examples illustrate field shapes only. Copy IDs and conclusions from the actual input, not the examples.`;
export const NAMED_SOURCE_COVERAGE_PROMPT=SOURCE_COVERAGE_SEMANTICS+`
For named message checks, passage_ids may reference only the supplied SOURCE_COVERAGE_CANDIDATES, belonging to that message. Pure incidental source coverage uses verdict:represented, empty fact_ids and operation_ids, nonempty passage_ids and a reason explaining why no additional durable fact or operation is needed. Mixed coverage combines actual linked fact_ids/operation_ids with any required passage_ids. It must cover all memorable content, not merely one reference. No source_backed verdict or positional tuple is used.`;

/** Stable within the current request/proposal; storage IDs remain separate. */
export function namedVerificationInput(data:any):any{
 const out=structuredClone(data),id=(kind:string,n:number)=>`${kind}:${n}`;
 out.VERIFICATION_PROTOCOL=NAMED_VERIFICATION_PROTOCOL;
 out.NEW_MESSAGES=out.NEW_MESSAGES.map(({index,...m}:any)=>({message_id:id('msg',index),...m}));
 out.PARTICIPANT_IDS=out.PARTICIPANT_INDEX.map((n:number)=>id('msg',n));delete out.PARTICIPANT_INDEX;
 out.OMISSION_HINTS=out.OMISSION_HINTS.map((n:number)=>id('msg',n));
 out.MESSAGE_SOURCE_LINKS=out.MESSAGE_SOURCE_LINKS.map(({index,fact_indices,operation_indices}:any)=>({message_id:id('msg',index),fact_ids:fact_indices.map((n:number)=>id('fact',n)),operation_ids:operation_indices.map((n:number)=>id('op',n))}));
 const {fact_indices,operation_indices,message_indices,replacements}=out.CHECK_SCOPE;
 out.CHECK_SCOPE={fact_ids:fact_indices.map((n:number)=>id('fact',n)),operation_ids:operation_indices.map((n:number)=>id('op',n)),replacement_ids:replacements.map((_:unknown,n:number)=>id('replacement',n)),message_ids:message_indices.map((n:number)=>id('msg',n))};
 out.REPLACEMENT_TARGETS=replacements.map(({fact_index,target_id}:any,n:number)=>({replacement_id:id('replacement',n),fact_id:id('fact',fact_index),target_id}));
 const operationLinks=(row:any)=>{
  for(const key of ['forget_operation_indices','matching_scope_operation_indices'])if(row[key]){row[key.replace('indices','ids')]=row[key].map((n:number)=>id('op',n));delete row[key];}
  return row;
 };
 out.PROPOSAL.facts=out.PROPOSAL.facts.map(({fact_index,fact_id,sources,...f}:any)=>operationLinks({...f,memory_id:fact_id,fact_id:id('fact',fact_index),sources:sources.map(({index,...s}:any,n:number)=>({...s,source_id:`fact:${fact_index}/source:${n}`,message_id:id('msg',index)}))}));
 out.PROPOSAL.operations=out.PROPOSAL.operations.map(({operation_index,source,...o}:any)=>({...o,operation_id:id('op',operation_index),source:{message_id:id('msg',source.index),quote:source.quote}}));
 out.TARGET_FACTS=out.TARGET_FACTS.map(operationLinks);
 if(out.FORGET_SCOPE_CONTEXT)out.FORGET_SCOPE_CONTEXT=out.FORGET_SCOPE_CONTEXT.map(({message,facts,...c}:any)=>({...c,message_id:id('msg',message),facts:facts.map(operationLinks)}));
 if(out.SOURCE_COVERAGE_CANDIDATES)out.SOURCE_COVERAGE_CANDIDATES=out.SOURCE_COVERAGE_CANDIDATES.map(({slot,message,...s}:any)=>({...s,passage_id:id('passage',slot),message_id:id('msg',message)}));
 return out;
}

/** Decode row-by-row so a malformed sibling never hides an explicit rejection.
 * All coverage, evidence and semantic validation still runs in the existing session. */
export function decodeNamedVerification(raw:unknown,proposal:Extraction,scope:VerificationScope,coverage?:SourceCoverageWork){
 const errors:string[]=[],tuples:Record<string,unknown>={};
 const object=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 if(Object.keys(object).some(k=>!(arrays as readonly string[]).includes(k)))errors.push('Unknown named verification field');
 const parseId=(value:unknown,kind:string,path:string)=>{
  if(typeof value==='string'&&new RegExp(`^${kind}:(0|[1-9][0-9]*)$`).test(value)){
   const n=Number(value.slice(kind.length+1));if(Number.isSafeInteger(n))return n;
  }
  errors.push(`Invalid named ${path}; use an issued ${kind}: ID`);return -1;
 };
 for(const name of arrays){
  const rows=object[name];if(!Array.isArray(rows)){errors.push(`Missing named ${name} array`);continue;}
  const mapped:unknown[][]=[];tuples[name]=mapped;
  for(const [position,value] of rows.entries()){
   const path=`${name}[${position}]`;
   if(!value||typeof value!=='object'||Array.isArray(value)){errors.push(`Invalid named ${path}; expected an object`);continue;}
   const row=value as Record<string,unknown>;
   if(Object.keys(row).some(k=>!fields[name].includes(k)))errors.push(`Unknown named ${path} field`);
   if(row.reason!==undefined&&row.reason!==null&&typeof row.reason!=='string')errors.push(`Invalid named ${path}.reason`);
   const reason=typeof row.reason==='string'?row.reason:'';
   if(name==='fact_checks'){
    const index=parseId(row.fact_id,'fact',`${path}.fact_id`);
    let source:unknown=null;
    if(typeof row.source_id==='string'&&row.source_id.startsWith(`fact:${index}/`))source=parseId(row.source_id.slice(`fact:${index}/`.length),'source',`${path}.source_id`);
    else if(row.source_id!==null)errors.push(`Invalid named ${path}.source_id; select a source declared under this fact`);
    mapped.push([index,row.supported,row.modality_supported,source,reason]);
   }else if(name==='operation_checks')mapped.push([parseId(row.operation_id,'op',`${path}.operation_id`),row.authorized,row.target_matches,reason]);
   else if(name==='replacement_checks')mapped.push([parseId(row.replacement_id,'replacement',`${path}.replacement_id`),row.supported,reason]);
   else{
    const index=parseId(row.message_id,'msg',`${path}.message_id`);
    const refs=(key:string,kind:string)=>{
     if(!Array.isArray(row[key])){errors.push(`Missing named ${path}.${key} array`);return [];}
     return row[key].map((v:unknown)=>parseId(v,kind,`${path}.${key}`));
    };
    const fs=refs('fact_ids','fact'),os=refs('operation_ids','op'),ps=refs('passage_ids','passage');
    if(ps.length&&!coverage)errors.push(`Unexpected named ${path}.passage_ids`);
    if(row.verdict!=='represented'&&(fs.length||os.length||ps.length))errors.push(`Only represented checks may carry references at ${path}`);
    if(row.verdict==='missing')mapped.push([index,'missing',row.quote,reason]);
    else{
     if(row.quote!==undefined&&row.quote!==null&&row.quote!=='')errors.push(`Unexpected named ${path}.quote`);
     if(row.verdict==='not_memorable')mapped.push([index,'not_memorable']);
     else if(row.verdict==='represented'){
      if(coverage&&ps.length&&!fs.length&&!os.length)mapped.push([index,'source_backed',ps,reason]);
      else mapped.push(coverage?[index,'represented',fs,os,ps,reason]:[index,'represented',fs,os]);
     }else errors.push(`Invalid named ${path}.verdict`);
    }
   }
  }
 }
 const decoded=decodeCompactVerification(tuples,proposal,scope,coverage);
 return {canonical:decoded.canonical,protocolErrors:[...errors,...decoded.protocolErrors.map(e=>e.replaceAll('compact','named').replaceAll('tuple','check'))]};
}
