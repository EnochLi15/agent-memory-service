import {transientModelError} from './model-retry.js';
import {createHash} from 'node:crypto';
import {participantIndices} from './verification.js';
import {ServiceError,type AddRequest} from './types.js';
export type ExtractionShard={index:number;participants:number[];source_chars:number};
class MissingShardParticipant extends ServiceError {
 constructor(){super('EXTRACTION_SCHEMA','Extraction shard omitted a participant');}
}
export function extractionShards(req:AddRequest,workers:number):ExtractionShard[]{
 if(!Number.isInteger(workers)||workers<1||workers>3)throw new ServiceError('EXTRACTION_SCHEMA','Extraction concurrency must be one to three');
 const participants=participantIndices(req),count=Math.min(workers,participants.length);
 const shards=Array.from({length:count},(_,index)=>({index,participants:[] as number[],source_chars:0}));
 // Balance source characters, never discard messages or infer memorability from
 // that estimate. Every call still receives the complete original context.
 for(const index of [...participants].sort((a,b)=>req.messages[b]!.content.length-req.messages[a]!.content.length||a-b)){
  const shard=[...shards].sort((a,b)=>a.source_chars-b.source_chars||a.index-b.index)[0]!;
  shard.participants.push(index);shard.source_chars+=req.messages[index]!.content.length;
 }
 return shards.map(s=>({...s,participants:s.participants.sort((a,b)=>a-b)})).sort((a,b)=>a.participants[0]!-b.participants[0]!).map((s,index)=>({...s,index}));
}
export const EXTRACTION_SHARD_PROMPT=`
Extraction ownership protocol participant-shards-v1: produce exactly the message groups listed in this call's PARTICIPANT_INDEX, in chronological order. ALL_PARTICIPANT_INDEX and the complete NEW_MESSAGES remain context for ownership, chronology, meaning and operation targets; do not omit or invent information from your assigned messages because a related message belongs to another shard. Do not output another shard's groups.
Existing memory IDs keep their meaning. Same-response new:<message_index>:<local_fact_index> references are allowed ONLY for groups assigned to this call. Never guess another shard's fact count, ordering or handles. For an actual operation on an earlier current message outside this shard, give an accurate subject/property/scope/value selector with target_ids=[]; the server resolves it against the complete merged proposal and checks chronology and authorization. If a reference cannot be established, do not invent an unrelated existing target. Dependencies/replacements across shards require global validation, not guessed handles. All operations and necessary state changes still need representation. The server merges all groups before the existing independent verification, erasure checks and atomic commit; partial shards are never published.`;
function checkedGroups(raw:unknown,shard:ExtractionShard):any[]{
 const x=raw as any,owned=new Set(shard.participants);
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>k!=='message_groups')||!Array.isArray(x.message_groups))throw new ServiceError('EXTRACTION_SCHEMA','Invalid extraction shard envelope');
 const groups=x.message_groups,seen=new Set<number>();
 for(const g of groups){
  if(!g||typeof g!=='object'||!owned.has(g.message_index)||seen.has(g.message_index))throw new ServiceError('EXTRACTION_SCHEMA','Extraction shard omitted or invented a participant group');seen.add(g.message_index);
  // A complete owned roster with missing or unknown fields is malformed,
  // not an ownership failure. Preserve the original fields for strict grouped
  // decoding and bounded global repair; never drop or rename damaged keys,
  // and never infer an empty array. Duplicate/foreign ownership still fails here.
  for(const field of ['facts','operations'])if(Object.hasOwn(g,field)&&!Array.isArray(g[field]))throw new ServiceError('EXTRACTION_SCHEMA','Extraction shard contains a non-array '+field+' field');
  for(const refs of [...(g.facts??[]).flatMap((f:any)=>[f?.supersedes??[],f?.depends_on??[]]),...(g.operations??[]).map((o:any)=>o?.target_ids??[])]){
   if(!Array.isArray(refs))throw new ServiceError('EXTRACTION_SCHEMA','Invalid extraction shard references');
   for(const ref of refs)if(typeof ref==='string'&&ref.startsWith('new:')){const match=ref.match(/^new:(\d+):(\d+)$/);if(!match||!owned.has(Number(match[1])))throw new ServiceError('EXTRACTION_SCHEMA','Extraction shard guessed a foreign or flat fact handle');}
  }
 }
 if(seen.size!==owned.size)throw new MissingShardParticipant();
 return structuredClone(groups);
}
export async function prepareExtractionShards(req:AddRequest,system:string,user:string,workers:number,signal:AbortSignal,call:(system:string,input:string,signal:AbortSignal,shard:{index:number;count:number;participants:number[]})=>Promise<unknown>):Promise<unknown>{
 const input=JSON.parse(user),participants=participantIndices(req);
 if(JSON.stringify(input.PARTICIPANT_INDEX)!==JSON.stringify(participants))throw new ServiceError('EXTRACTION_SCHEMA','Extraction shard input lost the complete participant roster');
 const shards=extractionShards(req,workers),controller=new AbortController(),shared=AbortSignal.any([signal,controller.signal]);let failure:unknown,failed=false;
 const fingerprint=createHash('sha256').update(JSON.stringify({protocol:'participant-shards-v1',req,input,shards})).digest('hex');
 const results=await Promise.allSettled(shards.map(async shard=>{
  try{shared.throwIfAborted();const metadata={index:shard.index,count:shards.length,participants:shard.participants};
   return checkedGroups(await call(system+EXTRACTION_SHARD_PROMPT,JSON.stringify({...input,ALL_PARTICIPANT_INDEX:participants,PARTICIPANT_INDEX:shard.participants,EXTRACTION_SHARD:{...metadata,fingerprint}}),shared,metadata),shard);
  }catch(e){if(!failed){failed=true;failure=e;}controller.abort();throw e;}
 }));
 if(failed){
  // Preserve the model-budget cancellation for the caller, which owns the
  // separate request deadline and reserved offline/commit budget. Do not
  // replace an explicit semantic rejection with a concurrent cancellation.
  if(signal.aborted&&!(failure instanceof ServiceError&&failure.code==='EVIDENCE_VALIDATION'))signal.throwIfAborted();
  if(failure instanceof MissingShardParticipant)
   throw new ServiceError('EXTRACTION_UNAVAILABLE','Parallel extraction did not complete all participant groups: '+failure.message);
  // Classify the first failure with the caller's signal: our sibling-cancel
  // signal is already aborted and would hide the original transport cause.
  if(!signal.aborted&&transientModelError(failure))
   throw new ServiceError('EXTRACTION_UNAVAILABLE','Parallel extraction could not reach the model provider');
  if(!signal.aborted&&failure instanceof SyntaxError)
   // Undecodable shard output is a model capability failure, not a semantic
   // verdict: the caller degrades to the deterministic offline plan with an
   // audit marker instead of terminal-failing the write. Continuation mode
   // never reaches this branch — its json() already rethrows a typed
   // EVIDENCE_VALIDATION rejection for the closed ledger to replay.
   throw new ServiceError('EXTRACTION_UNAVAILABLE','Parallel extraction could not decode model output');
  throw new ServiceError('EVIDENCE_VALIDATION','Parallel extraction did not complete all participant groups: '+(failure instanceof Error?failure.message:'unknown shard failure'));
 }
 signal.throwIfAborted();
 return {message_groups:results.flatMap(r=>r.status==='fulfilled'?r.value:[]).sort((a,b)=>a.message_index-b.message_index)};
}
