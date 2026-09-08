import {createHash} from 'node:crypto';
import {z} from 'zod';
import {factSchema,ServiceError,type AddRequest,type Extraction} from './types.js';
import {decodeGroupedExtraction,GROUPED_EXTRACTION_PROMPT,normalizeGroupedPlans,groupedSchemaDetails} from './extraction-groups.js';
import {participantIndices} from './verification.js';

export const SOURCE_REFERENCE_PROTOCOL='message-groups-source-refs-v1';
export const SOURCE_REFERENCE_PROMPT=GROUPED_EXTRACTION_PROMPT+`
Source encoding override for message-groups-source-refs-v1: NEW_MESSAGES contains spans:[{slot,text}] instead of content; joining spans in order yields the exact original message. FACTS use source_refs:[[message_index,span_slot],...] INSTEAD OF sources. Select every full sentence/span needed to support ALL parts of the fact, including owner, qualifiers, uncertainty and negation. Do not copy span text, offsets or hashes into the output. The server resolves references to exact text and positions before independent verification. A selected span is evidence, not proof of your interpretation. Prefer concise content/value; omit default-valued metadata as instructed above.
OPERATIONS still use source:{index,quote}, copying the exact authorizing subclause from a span; do not use source_refs for operations. If a fact is created and targeted by an operation in the SAME message, and a whole span would cross the operation's source position, that target fact may instead use the original sources:[{index,quote}] with a unique exact earlier subclause. Only such same-message operation targets may use this escape; all ordinary facts must use source_refs. Never supply both source_refs and sources. Group indexes and new:<message_index>:<local_fact_index> handles retain their existing meaning. Generic assistant messages remain context only, not human fact sources.`;

export function sourceReferenceWork(req:AddRequest){
 const segmenter=new Intl.Segmenter('en',{granularity:'sentence'});
 const messages=req.messages.map((m,index)=>{
  const spans:{slot:number;start:number;end:number;text:string}[]=[];
  for(const sentence of segmenter.segment(m.content))for(let start=sentence.index;start<sentence.index+sentence.segment.length;){
   const bound=sentence.index+sentence.segment.length;let end=Math.min(bound,start+900);
   if(end<bound){const space=m.content.lastIndexOf(' ',end);if(space>start+450)end=space;}
   if(end<bound&&/[\uD800-\uDBFF]/.test(m.content[end-1]!)&&/[\uDC00-\uDFFF]/.test(m.content[end]!))end--;
   spans.push({slot:spans.length,start,end,text:m.content.slice(start,end)});start=end;
  }
  return {index,role:m.role,timestamp:m.timestamp,spans};
 });
 return {fingerprint:createHash('sha256').update(JSON.stringify({protocol:SOURCE_REFERENCE_PROTOCOL,req,messages})).digest('hex'),messages};
}
export function sourceReferenceMessages(req:AddRequest){return sourceReferenceWork(req).messages.map(m=>({...m,spans:m.spans.map(({slot,text})=>({slot,text}))}));}
const tuple=z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative()]);
const referencedFact=factSchema.omit({sources:true}).extend({source_refs:z.array(tuple).min(1).optional(),sources:factSchema.shape.sources.optional()}).strict();
const envelope=z.object({message_groups:z.array(z.object({message_index:z.number().int().nonnegative(),facts:z.array(referencedFact),operations:z.array(z.unknown())}).strict())}).strict();

/** Tables are reconstructed from the current request, never accepted from the
 * model. The existing grouped decoder then checks speaker/group provenance and
 * stable handles; the ordinary verifier still judges every expanded claim. */
export function decodeSourceReferences(raw:unknown,req:AddRequest):Extraction{
 const checked=envelope.safeParse(normalizeGroupedPlans(raw));if(!checked.success)throw new ServiceError('EXTRACTION_SCHEMA','Invalid referenced extraction schema: '+groupedSchemaDetails(checked.error));
 const work=sourceReferenceWork(req),participants=new Set(participantIndices(req));
 // Report all malformed coordinates together so a bounded repair can address
 // them without guessing which fact failed. These are available coordinates,
 // never a replacement reference or a verdict that its text supports a claim.
 const evidence=(text:string)=>!!text.replace(/\[(?:Session time|Source id):[^\]]*\]/g,'').trim();
 const problems:{group_message_index:number;fact_index:number;reference:number[];reason:string;available_span_slots:number[];available_span_count:number}[]=[];
 let total=0;
 for(const group of checked.data.message_groups)for(const [local,f] of group.facts.entries()){
  if(!f.source_refs||f.sources)continue;
  const seen=new Set<string>();
  for(const [index,slot] of f.source_refs){
   const message=work.messages[index],span=message?.spans[slot],key=`${index}:${slot}`;
   const reason=!message?'unknown_message':!participants.has(index)?'non_human_message':!span?'unknown_span':seen.has(key)?'duplicate_reference':!evidence(span.text)?'non_evidence_span':null;
   seen.add(key);if(!reason)continue;total++;
   if(problems.length<32){
    const available=participants.has(index)?message?.spans.filter(s=>evidence(s.text)).map(s=>s.slot)??[]:[];
    problems.push({group_message_index:group.message_index,fact_index:local,reference:[index,slot],reason,available_span_slots:available.slice(0,64),available_span_count:available.length});
   }
  }
 }
 if(total)throw new ServiceError('EXTRACTION_SCHEMA','Unknown, duplicate or non-human source reference. SOURCE_REFERENCE_PROBLEMS: '+JSON.stringify({total,problems,truncated:total>problems.length}));
 const groups=checked.data.message_groups.map(group=>({...group,facts:group.facts.map((f,local)=>{
  if(!!f.source_refs===!!f.sources)throw new ServiceError('EXTRACTION_SCHEMA','Choose exactly one source encoding per referenced fact');
  const {source_refs,sources,...attributes}=f;
  if(sources){
   const handle=`new:${group.message_index}:${local}`;
   const targeted=group.operations.some((o:any)=>o?.source?.index===group.message_index&&Array.isArray(o.target_ids)&&o.target_ids.includes(handle));
   if(!targeted||sources.some(s=>s.index!==group.message_index||s.start!==undefined||(req.messages[s.index]?.content.indexOf(s.quote)??-1)<0||req.messages[s.index]?.content.indexOf(s.quote)!==req.messages[s.index]?.content.lastIndexOf(s.quote)))throw new ServiceError('EXTRACTION_SCHEMA','Explicit sources are only for unique same-message operation target subclauses');
   return {...attributes,sources};
  }
  const resolved=source_refs!.map(([index,slot])=>{
   const span=work.messages[index]!.spans[slot]!;
   return {index,quote:span.text,start:span.start};
  });
  return {...attributes,sources:resolved};
 })}));
 return decodeGroupedExtraction({message_groups:groups},req);
}
