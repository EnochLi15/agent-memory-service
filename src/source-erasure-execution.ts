import {sourceErasureBatches,sourceErasureInput,sourceReasonProblems,applySourceReasonRepairs,SOURCE_REASON_REPAIR_INSTRUCTION,sourceQuoteProblems,applySourceQuoteRepairs,decodeSourceErasureResponse,decodeSourceErasure,SOURCE_ERASURE_PROMPT,SOURCE_QUOTE_REPAIR_PROMPT,type sourceErasureWork} from './source-erasure.js';
import {ServiceError,type SourceErasurePlan} from './types.js';
type Work=ReturnType<typeof sourceErasureWork>;
export type SourceErasureBatchContext={index:number;count:number;offset:number;candidates:number};
export type SourceErasureCall=(system:string,input:string,signal:AbortSignal,purpose:'source_erasure'|'source_erasure_repair',batch?:SourceErasureBatchContext)=>Promise<unknown>;
/** Complete semantic classifications precede the one global literal-quote repair.
 * A worker failure cancels and drains siblings before any plan can be returned. */
export async function executeSourceErasure(work:Work,workers:number,signal:AbortSignal,call:SourceErasureCall,protocol:{prompt:string;input:(work:Pick<Work,'candidates'>)=>unknown}={prompt:SOURCE_ERASURE_PROMPT,input:sourceErasureInput}):Promise<SourceErasurePlan>{
 if(!Number.isInteger(workers)||workers<1||workers>3)throw new ServiceError('EVIDENCE_VALIDATION','Invalid source erasure concurrency');
 signal.throwIfAborted();const batches=sourceErasureBatches(work,protocol.input),raws:unknown[]=new Array(batches.length),problems:ReturnType<typeof sourceQuoteProblems>[]=[],reasonProblems:ReturnType<typeof sourceReasonProblems>[]=[];
 const controller=new AbortController(),shared=AbortSignal.any([signal,controller.signal]);let next=0,failed=false,failure:unknown;
 const run=async()=>{try{while(next<batches.length){shared.throwIfAborted();const index=next++,batch=batches[index]!;
  const raw=await call(protocol.prompt,JSON.stringify(protocol.input(batch)),shared,'source_erasure',{index,count:batches.length,offset:batch.offset,candidates:batch.candidates.length});shared.throwIfAborted();
  const reasons=sourceReasonProblems(raw,batch),defects=reasons.length?[]:sourceQuoteProblems(raw,batch);if(!defects.length&&!reasons.length)decodeSourceErasureResponse(raw,batch);raws[index]=raw;problems[index]=defects;reasonProblems[index]=reasons;
 }}catch(error){if(!failed){failed=true;failure=error;}controller.abort();throw error;}};
 await Promise.allSettled(Array.from({length:Math.min(workers,batches.length)},run));
 if(failed){if(failure instanceof ServiceError)throw failure;throw new ServiceError('VERIFICATION_UNAVAILABLE','Source erasure batch unavailable within shared budget');}signal.throwIfAborted();
 const offsets:number[]=[];let count=0;for(const [index,defects] of problems.entries()){offsets.push(count);count+=defects.length+reasonProblems[index]!.length;}
 if(count>8)throw new ServiceError('EVIDENCE_VALIDATION','Too many source quote defects for one global repair');
 if(count){
  const PROBLEMS=problems.flatMap((defects,batch)=>[...defects,...reasonProblems[batch]!].map((p,local)=>({index:offsets[batch]!+local,...p})));let raw:unknown;
  try{raw=await call(SOURCE_QUOTE_REPAIR_PROMPT+(reasonProblems.some(p=>p.length)?SOURCE_REASON_REPAIR_INSTRUCTION:''),JSON.stringify({PROBLEMS}),shared,'source_erasure_repair');}
  catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError('VERIFICATION_UNAVAILABLE','Global source quote repair unavailable within shared budget');}signal.throwIfAborted();
  const patch=raw as any;if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>k!=='repairs')||!Array.isArray(patch.repairs)||patch.repairs.length!==count)throw new ServiceError('EVIDENCE_VALIDATION','Incomplete global source quote repair');
  const byIndex=new Map<number,any>();for(const r of patch.repairs){
   if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['index','status',('kind' in (PROBLEMS[r.index]??{}))?'reason':'quote'].includes(k))||!Number.isInteger(r.index)||r.index<0||r.index>=count||byIndex.has(r.index)||r.status!=='resolved'||(('kind' in (PROBLEMS[r.index]??{}))?r.reason!=='mixed_source':typeof r.quote!=='string'||!r.quote))throw new ServiceError('EVIDENCE_VALIDATION','Invalid global source quote repair');byIndex.set(r.index,r);
  }
  for(const [index,batch] of batches.entries()){
   const reasons=reasonProblems[index]!;
   if(reasons.length)raws[index]=applySourceReasonRepairs(raws[index],batch,{repairs:reasons.map((_,local)=>({...byIndex.get(offsets[index]!+local),index:local}))});
   else if(problems[index]!.length)raws[index]=applySourceQuoteRepairs(raws[index],batch,{repairs:problems[index]!.map((_,local)=>({...byIndex.get(offsets[index]!+local),index:local}))});
  }
 }
 signal.throwIfAborted();const decisions=batches.flatMap((batch,index)=>decodeSourceErasureResponse(raws[index],batch).decisions.map(d=>({...d,index:d.index+batch.offset})));
 return decodeSourceErasure({decisions},work);
}
