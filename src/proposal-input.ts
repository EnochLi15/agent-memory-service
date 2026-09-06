import type {Extraction} from './types.js';

// Labels belong only to model input. Always derive them from the complete current
// proposal, even when CHECK_SCOPE requests a sparse subset of checks.
export function indexedProposal(proposal:Extraction){
 return {...proposal,
  facts:proposal.facts.map((fact,fact_index)=>({...fact,fact_index})),
  operations:proposal.operations.map((operation,operation_index)=>({...operation,operation_index})),
 };
}
