import {factId,type AddRequest,type Extraction} from './types.js';

// Labels belong only to model input. Always derive them from the complete current
// proposal, even when CHECK_SCOPE requests a sparse subset of checks.
export function indexedProposal(proposal:Extraction,req?:AddRequest){
 return {...proposal,
  facts:proposal.facts.map((fact,fact_index)=>({...fact,fact_index,...(req?{fact_id:factId(req,fact_index),forget_operation_indices:proposal.operations.flatMap((o,i)=>o.type==='forget'&&o.target_ids.includes(factId(req,fact_index))?[i]:[])}:{})})),
  operations:proposal.operations.map((operation,operation_index)=>({...operation,operation_index})),
 };
}
