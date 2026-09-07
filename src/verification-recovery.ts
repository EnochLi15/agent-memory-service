import type {Config} from './config.js';
import type {AddRequest,Extraction} from './types.js';
import {verificationItemIssues,type VerificationScope} from './verification.js';
import {decodeCompactVerification} from './verification-compact.js';
import {decodeNamedVerification} from './verification-named.js';
import type {SourceCoverageWork} from './source-coverage.js';
const arrays=['fact_checks','operation_checks','replacement_checks','message_checks'] as const;
type Kind=typeof arrays[number];
type Check=Record<string,any>;
export type VerificationChecks=Record<Kind,Check[]>;
const empty=():VerificationChecks=>({fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[]});
const checkKey=(kind:Kind,row:Check)=>kind==='replacement_checks'?`${row.fact_index}:${row.target_id}`:String(row.index);

/** Only unique, requested, independently valid rows can be reused. An invalid
 * sibling with the same ID blocks reuse; an unidentifiable row taints its array. */
export function recoverVerificationChecks(raw:unknown,format:Config['verificationFormat'],req:AddRequest,proposal:Extraction,scope:VerificationScope,coverage?:SourceCoverageWork):VerificationChecks{
 const accepted=empty();
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return accepted;
 const object=raw as Record<string,unknown>;
 if(Object.keys(object).some(k=>!(arrays as readonly string[]).includes(k)))return accepted;
 const expected:Record<Kind,Set<string>>={fact_checks:new Set(scope.fact_indices.map(String)),operation_checks:new Set(scope.operation_indices.map(String)),replacement_checks:new Set(scope.replacements.map(r=>`${r.fact_index}:${r.target_id}`)),message_checks:new Set(scope.message_indices.map(String))};
 const keys={fact_checks:['fact_id','fact'],operation_checks:['operation_id','op'],replacement_checks:['replacement_id','replacement'],message_checks:['message_id','msg']} as const;
 for(const kind of arrays){
  const rows=object[kind];if(!Array.isArray(rows))continue;
  const identify=(row:any):string|undefined=>{
   if(!row||typeof row!=='object')return;
   if(format==='verbose'){
    if(kind==='replacement_checks')return Number.isInteger(row.fact_index)&&typeof row.target_id==='string'?`${row.fact_index}:${row.target_id}`:undefined;
    return Number.isInteger(row.index)?String(row.index):undefined;
   }
   let n:unknown;
   if(format==='compact')n=Array.isArray(row)?row[0]:undefined;
   else{
    const [field,prefix]=keys[kind],value=row[field];
    if(typeof value!=='string'||!new RegExp(`^${prefix}:(0|[1-9][0-9]*)$`).test(value))return;
    n=Number(value.slice(prefix.length+1));
   }
   if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)return;
   if(kind==='replacement_checks'){const replacement=scope.replacements[n];return replacement?`${replacement.fact_index}:${replacement.target_id}`:undefined;}
   return String(n);
  };
  const ids=rows.map(identify);
  if(ids.some(id=>id===undefined||!expected[kind].has(id)))continue;
  for(const [position,row] of rows.entries()){
   const id=ids[position]!;if(ids.filter(k=>k===id).length!==1)continue;
   const single=empty();single[kind]=[row];
   try{
    const decoded=format==='named'?decodeNamedVerification(single,proposal,scope,coverage):format==='compact'?decodeCompactVerification(single,proposal,scope,coverage):{canonical:single,protocolErrors:[]};
    if(decoded.protocolErrors.length||decoded.canonical[kind].length!==1||checkKey(kind,decoded.canonical[kind][0]!)!==id)continue;
    if(!verificationItemIssues(decoded.canonical,req,proposal,coverage).length)accepted[kind].push(structuredClone(decoded.canonical[kind][0]!));
   }catch{/* A malformed or ungrounded item is requested again, never certified. */}
  }
 }
 return accepted;
}
