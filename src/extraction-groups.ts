import {z} from 'zod';
import {extractionSchema,ServiceError,type AddRequest,type Extraction} from './types.js';
import {participantIndices} from './verification.js';
import {EXTRACTION_PROMPT} from './prompts.js';

export const GROUPED_EXTRACTION_PROTOCOL='message-groups-v1';
export const GROUPED_EXTRACTION_PROMPT=EXTRACTION_PROMPT
 .replace('Output a JSON object with facts and operations arrays, and nothing else.','Output a JSON object with message_groups as specified below, and nothing else.')
 .replaceAll('new:N','new:<message_index>:<local_fact_index>')
 .replace('where N is its zero-based index in facts','where the first index is the original message index and the second is the zero-based local facts index in that message group')+`

Output protocol message-groups-v1: {message_groups:[{message_index:number,facts:[fact,...],operations:[operation,...]},...]}. Include exactly one group for EVERY index in PARTICIPANT_INDEX, in chronological order, even when facts and operations are both empty. Do not include unlabelled assistant groups. Process one whole participant message at a time: preserve its distinct personal setup, concrete plans, preferences, reasons and meaningful concerns before moving to the next. A question about the user's own app or child may contain personal context, but generic knowledge questions alone establish no durable trait. Do not invent a memory just to fill an empty group. Listing a group is not proof of semantic coverage: the independent checker still checks all meaningful content.
Each fact must cite its group's message at least once; additional earlier human sources can support the same fact. Each operation must cite its group's message. Reuse existing short memory IDs unchanged. For a fact from this same response, use new:<message_index>:<local_fact_index>, never a flat new:N counter. The server deterministically orders groups and resolves these references into its existing fact IDs. A same-chunk operation still needs earlier target evidence; group placement does not authorize deletion. No top-level facts/operations, summaries or coverage verdicts. The fact and operation field semantics above remain unchanged.`;
const groupSchema=z.object({message_index:z.number().int().nonnegative(),facts:extractionSchema.shape.facts,operations:extractionSchema.shape.operations.removeDefault()}).strict();
const groupedSchema=z.object({message_groups:z.array(groupSchema)}).strict();

/** Enforce traversal and provenance, not semantic completeness. Empty groups
 * still pass through the independent coverage verifier. Stable local handles
 * make chronological flattening independent of returned group order. */
export function decodeGroupedExtraction(raw:unknown,req:AddRequest):Extraction{
 const result=groupedSchema.safeParse(raw);
 if(!result.success)throw new ServiceError('EXTRACTION_SCHEMA','Invalid message-group extraction schema');
 const expected=participantIndices(req),groups=result.data.message_groups,byIndex=new Map(groups.map(g=>[g.message_index,g]));
 if(groups.length!==expected.length||byIndex.size!==groups.length||groups.some(g=>!expected.includes(g.message_index)))throw new ServiceError('EXTRACTION_SCHEMA','Grouped extraction must cover every participant exactly once');
 const facts:Extraction['facts']=[],operations:Extraction['operations']=[],handles=new Map<string,string>();
 for(const index of expected){
  const group=byIndex.get(index)!;
  for(const [local,f] of group.facts.entries()){
   if(!f.sources.some(s=>s.index===index)||f.sources.some(s=>s.index>index||!expected.includes(s.index)))throw new ServiceError('EXTRACTION_SCHEMA','Grouped fact must cite its participant message and only earlier human context');
   handles.set(`new:${index}:${local}`,`new:${facts.length}`);facts.push(f);
  }
  for(const o of group.operations){if(o.source.index!==index)throw new ServiceError('EXTRACTION_SCHEMA','Grouped operation must cite its participant message');operations.push(o);}
 }
 const ref=(id:string):string=>{
  if(!id.startsWith('new:'))return id;
  const mapped=handles.get(id);if(!mapped)throw new ServiceError('EXTRACTION_SCHEMA','Unknown or flat same-chunk handle in grouped extraction');return mapped;
 };
 return {facts:facts.map(f=>({...f,depends_on:f.depends_on.map(ref),supersedes:f.supersedes.map(ref)})),operations:operations.map(o=>({...o,target_ids:o.target_ids.map(ref)}))};
}
