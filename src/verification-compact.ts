import type {Extraction} from './types.js';
import {VERIFICATION_SEMANTICS,type VerificationScope} from './verification.js';
import type {SourceCoverageWork} from './source-coverage.js';

export const COMPACT_VERIFICATION_PROTOCOL='source-reference-tuples-v1';
// Constrain the transport envelope. Tuple positions, source identity, check
// uniqueness, coverage and all semantic judgments still use the local decoder.
const tupleCell={anyOf:[{type:'integer'},{type:'boolean'},{type:'string'},{type:'null'},{type:'array',items:{type:'integer'}}]};
const checkArrays=['fact_checks','operation_checks','replacement_checks','message_checks'];
export const COMPACT_VERIFICATION_RESPONSE_FORMAT={type:'json_schema',json_schema:{name:'memory_verification_tuples_v1',strict:true,schema:{type:'object',properties:Object.fromEntries(checkArrays.map(k=>[k,{type:'array',items:{type:'array',items:tupleCell}}])),required:checkArrays,additionalProperties:false}}} as const;
// Share all semantic requirements with the verbose protocol; change only encoding.
export const COMPACT_VERIFICATION_PROMPT=VERIFICATION_SEMANTICS+`
Output protocol: source-reference-tuples-v1. Return exactly four JSON arrays using these tuples, including [] for empty scopes. Every requested item must appear exactly once; do not output checks outside CHECK_SCOPE.
The booleans are the executable decisions; explanations cannot override them. Resolve the evidence and context before choosing the booleans. If supplied human context uniquely resolves a reference and your final conclusion is supported, return supported=true, not false with an explanation that the fact is actually supported. A rejection reason must describe a remaining unsupported claim, modality, authorization or target, consistent with the false field. Never set a field true merely to avoid rejection.
fact_checks: [[fact_index, supported_boolean, modality_supported_boolean, source_slot, reason?]]. source_slot is the zero-based slot inside that fact's sources array, NOT a NEW_MESSAGES index. The input labels each source_slot explicitly. Select a declared human source witnessing the judgment; the server resolves the exact quote and message index itself. You must still judge ALL claims, qualifiers, actor, property, value, scope and modality against ALL declared sources and full context. A source reference is not proof that the fact is supported. For a rejected fact source_slot may be null if no declared source supports it. Rejections require a brief reason. Successful facts need no reason. Do not copy source quotes in this array.
operation_checks: [[operation_index, authorized_boolean, target_matches_boolean, reason?]]. Judge actual authorization and actual target meaning using the operation's declared human source. The server resolves that exact source quote, so do not repeat it. Either false requires a brief reason. Both true need no reason.
replacement_checks: [[check_index, supported_boolean, reason?]]. check_index is the explicit index in REPLACEMENT_TARGETS, NOT the fact index or a target ID. Judge that exact fact/target pair. False requires a reason, true needs none.
message_checks: use [message_index,"represented",[fact_indices],[operation_indices]], or [message_index,"not_memorable"], or [message_index,"missing","exact missing human quote","brief reason"]. represented means ALL memorable content is covered; cite only fact_indices and operation_indices allowed by that message’s MESSAGE_SOURCE_LINKS, with at least one reference. The map proves source linkage only, not semantic completeness; judge all memorable content and report missing details even when linked items exist. Keep both reference arrays, using [] where empty. An empty proposal can never represent a personal statement. not_memorable is for messages with no specific personal fact or actual memory instruction requiring storage; do not use it just because a personal plan has no explicit remember command. missing means some memorable content remains absent even if other content is represented. Its quote must be copied verbatim from the human message, not machine headers. Report the full set of missing details for a message in the reason rather than leaving another known omission for a later pass. Return no mutations or overall score.`;

const arrayNames=['fact_checks','operation_checks','replacement_checks','message_checks'] as const;
type Name=typeof arrayNames[number];
const integer=(x:unknown):x is number=>Number.isInteger(x)&&Number(x)>=0;
const reason=(x:unknown):x is string=>typeof x==='string'&&!!x.trim();

/** Resolve only references supplied in this request. A malformed sibling must
 * not erase a well-formed semantic rejection. Protocol errors are returned to
 * the session alongside canonical checks, so they cannot produce certificates. */
export function decodeCompactVerification(raw:unknown,proposal:Extraction,scope:VerificationScope,sourceCoverage?:SourceCoverageWork){
 const canonical:Record<Name,Record<string,unknown>[]>=Object.fromEntries(arrayNames.map(k=>[k,[]])) as any;
 const protocolErrors:string[]=[];const invalid=(message:string)=>protocolErrors.push(message);
 const object=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 if(Object.keys(object).some(k=>!arrayNames.includes(k as Name)))invalid('Unknown compact verification field');
 for(const name of arrayNames){
  const values=object[name];if(!Array.isArray(values)){invalid(`Missing compact ${name}`);continue;}
  for(const [position,row] of values.entries()){
   if(!Array.isArray(row)||!integer(row[0])){invalid(`Invalid compact ${name} tuple`);continue;}
   const index=row[0];
   if(name==='fact_checks'){
    const fact=proposal.facts[index];
    if(!fact||!scope.fact_indices.includes(index)||![4,5].includes(row.length)||typeof row[1]!=='boolean'||typeof row[2]!=='boolean'||(row.length===5&&typeof row[4]!=='string')){invalid('Invalid compact fact tuple');continue;}
    const rejected=!row[1]||!row[2],source=integer(row[3])?fact.sources[row[3]]:undefined;
    if(!source&&!(row[3]===null&&rejected)){invalid('Unknown compact fact source slot');if(!rejected)continue;}
    if(rejected&&!reason(row[4]))invalid('Compact fact rejection needs a reason');
    canonical.fact_checks.push({index,supported:row[1],modality_supported:row[2],source_index:source?.index??-1,quote:source?.quote??'',reason:row[4]??''});
   }else if(name==='operation_checks'){
    const op=proposal.operations[index];
    if(!op||!scope.operation_indices.includes(index)||![3,4].includes(row.length)||typeof row[1]!=='boolean'||typeof row[2]!=='boolean'||(row.length===4&&typeof row[3]!=='string')){invalid('Invalid compact operation tuple');continue;}
    if((!row[1]||!row[2])&&!reason(row[3]))invalid('Compact operation rejection needs a reason');
    canonical.operation_checks.push({index,authorized:row[1],target_matches:row[2],source_quote:op.source.quote,reason:row[3]??''});
   }else if(name==='replacement_checks'){
    const replacement=scope.replacements[index];
    if(!replacement||![2,3].includes(row.length)||typeof row[1]!=='boolean'||(row.length===3&&typeof row[2]!=='string')){invalid('Invalid compact replacement tuple');continue;}
    if(!row[1]&&!reason(row[2]))invalid('Compact replacement rejection needs a reason');
    canonical.replacement_checks.push({...replacement,supported:row[1],reason:row[2]??''});
   }else{
    if(!scope.message_indices.includes(index)){invalid('Message outside compact check scope');continue;}
    if(row[1]==='not_memorable'&&row.length===2)canonical.message_checks.push({index,disposition:row[1]});
    else if(row[1]==='represented'&&row.length===4&&Array.isArray(row[2])&&Array.isArray(row[3])&&[...row[2],...row[3]].every(integer))canonical.message_checks.push({index,disposition:row[1],fact_indices:row[2],operation_indices:row[3]});
    else if(sourceCoverage&&row[1]==='represented'&&(row.length===5||row.length===6&&typeof row[5]==='string')&&[row[2],row[3],row[4]].every(Array.isArray)&&[...row[2],...row[3],...row[4]].every(integer)&&row[2].length+row[3].length>0)canonical.message_checks.push({index,disposition:row[1],fact_indices:row[2],operation_indices:row[3],raw_slots:row[4],...(row.length===6?{reason:row[5]}:{})});
    else if(sourceCoverage&&row[1]==='source_backed'&&row.length===4&&Array.isArray(row[2])&&row[2].length&&row[2].every(integer)&&reason(row[3]))canonical.message_checks.push({index,disposition:'represented',fact_indices:[],operation_indices:[],raw_slots:row[2],reason:row[3]});
    else if(row[1]==='missing'&&row.length===4&&reason(row[2])&&reason(row[3]))canonical.message_checks.push({index,disposition:row[1],quote:row[2],reason:row[3]});
    else invalid(`Invalid compact message tuple at message_checks[${position}] (message ${index}, length ${row.length}); use the exact disposition tuple from the output protocol`);
   }
  }
 }
 // Process explicit, structurally valid rejections before duplicate/coverage
 // errors, preserving them even if a later successful sibling is malformed.
 canonical.fact_checks.sort((a,b)=>Number(a.supported&&a.modality_supported)-Number(b.supported&&b.modality_supported));
 canonical.operation_checks.sort((a,b)=>Number(a.authorized&&a.target_matches)-Number(b.authorized&&b.target_matches));
 canonical.replacement_checks.sort((a,b)=>Number(a.supported)-Number(b.supported));
 return {canonical,protocolErrors};
}
