import {createHash} from 'node:crypto';
import {preparePassages,sourceSpans,redactPassage} from './passages.js';
import {speakerPrefix,tokens} from './text.js';
import {ServiceError,type AddRequest,type Extraction,type Prepared,type StoredMessage,type Passage} from './types.js';
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export type SourceCoverageRow={index:number;disposition:string;fact_indices?:number[];operation_indices?:number[];raw_slots?:number[];reason?:string;quote?:string};
export type SourceCoveragePlan={fingerprint:string;rows:SourceCoverageRow[]};
export function sourceCoverageWork(req:AddRequest,proposal:Extraction){
 const messages:StoredMessage[]=req.messages.map((m,index)=>({...m,id:createHash('sha256').update(`${req.user_id}\0${req.request_id}\0${index}`).digest('hex'),session_id:req.session_id,ordinal:index,searchable:true}));
 const linked=proposal.facts.flatMap(f=>sourceSpans(f,messages));
 // Only independent, indexable human passages can carry unstructured coverage.
 // Commands and passages linked to proposed state facts remain on the ordinary
 // fact/operation path, including their eventual state visibility constraints.
 const candidates=preparePassages(messages,[],proposal.operations,0).flatMap(p=>p.fragments.filter(s=>tokens(s.text.replace(/\[(?:Session time|Source id):[^\]]*\]/g,'')).length>0&&!linked.some(f=>f.source_id===p.source_id&&f.start<s.end&&f.end>s.start)).map(s=>({message:messages.findIndex(m=>m.id===p.source_id),source_id:p.source_id,passage_id:p.id,start:s.start,end:s.end,quote:s.text}))).map((s,slot)=>({slot,...s}));
 return {fingerprint:digest({protocol:'source-coverage-v1',req,operations:proposal.operations,candidates}),candidates};
}
export type SourceCoverageWork=ReturnType<typeof sourceCoverageWork>;
export const SOURCE_FIRST_EXTRACTION_PROMPT=`
Source-first representation is enabled. Every permitted original human passage will be stored and indexed under the same lifecycle rules as facts. Still extract every necessary durable preference, current state, state change, time-qualified event, entity relationship and executable memory instruction. Keep each independently mutable property separate. Preserve names, numbers, time precision, uncertainty and meaningful qualifiers; do not infer a specific entity such as a medication name from an unspecified current statement. Existing facts are context, not new source evidence.
Incidental reactions, rhetorical setup, elaborations and contextual reasons that introduce no additional durable state, preference, event, relationship or instruction may be represented by their exact original passages instead of additional atomic facts. Do not turn each contextual phrase into a new property. A real future plan, personal event, specific preference or update is not incidental. All actual operations and transient targets still require structured representation. Source-only coverage is independently checked later; do not output coverage claims yourself or assume that an empty group passed. Keep the required participant groups, factual source encoding and operation protocol unchanged.`;
export const SOURCE_COVERAGE_PROMPT=`
Output protocol source-first-coverage-tuples-v1 extends the compact tuples only as specified here. Source-first coverage is enabled ONLY for SOURCE_COVERAGE_CANDIDATES supplied by the server. They are exact independent human passages scheduled for indexed storage, excluding instructions and proposed fact witnesses. Storage rechecks every accepted passage against independently validated lifecycle erasure before committing: authorized erased text must be absent, while every remaining part must survive and be indexed. A raw coverage verdict never authorizes erasure or excuses missing durable facts and operations.
Necessary durable preferences, current states/changes, time-qualified personal events, entity relationships and real memory instructions MUST remain in structured facts/operations. A new browser preference, child name, dosage state, future plan, relationship change or deletion cannot be represented solely by raw text. Do not excuse an omitted necessary fact because its original text exists. Only incidental reactions, rhetorical setup, elaborations or contextual reasons introducing no additional durable state/preference/event/relationship/instruction may rely on original passages. Judge meaning and every qualifier, not mere linkage. Generic claims still need no memory.
For a message containing only such incidental memorable context, use [message_index,"source_backed",[candidate_slots],"brief explanation why no additional structured item is required"]. For mixed structured and incidental content use [message_index,"represented",[fact_indices],[operation_indices],[candidate_slots]]. The supplied raw slots must cover ALL incidental content not already covered by referenced facts/operations. An empty slot list proves nothing. Never select another speaker/message, a command, or a candidate absent from the supplied catalog. Ordinary represented/not_memorable/missing rows retain their existing semantics. All necessary facts, operations and replacements still receive their normal independent checks. Missing core content remains missing even if safe raw candidates exist.`;
const participants=(req:AddRequest)=>req.messages.flatMap((m,index)=>m.role==='user'||speakerPrefix(m.content.replace(/\[(?:Session time|Source id):[^\]]*\]/g,'').trim())?[index]:[]);
function fail(message:string):never{throw new ServiceError('EVIDENCE_VALIDATION',message);}
function preparedProposal(prepared:Prepared):Extraction{
 return {facts:prepared.facts.map(f=>({...f,sources:(f.source_spans??[]).flatMap(s=>{const index=prepared.messages.findIndex(m=>m.id===s.source_id);return index<0?[]:[{index,quote:prepared.messages[index]!.content.slice(s.start,s.end),start:s.start}];})})),operations:prepared.operations};
}
function identity(req:AddRequest,prepared:Prepared,work:SourceCoverageWork,rows:SourceCoverageRow[]){
 return digest({protocol:'source-coverage-plan-v1',req,facts:prepared.facts.map(({vector,...f})=>f),operations:prepared.operations,messages:prepared.messages,work:work.fingerprint,rows});
}
export function makeSourceCoveragePlan(req:AddRequest,prepared:Prepared,rows:SourceCoverageRow[]):SourceCoveragePlan{
 const work=sourceCoverageWork(req,preparedProposal(prepared)),plan={fingerprint:identity(req,prepared,work,rows),rows:structuredClone(rows)};
 validateSourceCoveragePlan(plan,req,prepared);return plan;
}
export function validateSourceCoveragePlan(plan:SourceCoveragePlan|undefined,req:AddRequest,prepared:Prepared){
 const work=sourceCoverageWork(req,preparedProposal(prepared));
 if(!plan||plan.fingerprint!==identity(req,prepared,work,plan.rows))fail('Source coverage identity changed');
 const expected=participants(req),seen=new Set<number>();
 for(const row of plan.rows){
  if(!expected.includes(row.index)||seen.has(row.index)||!['represented','not_memorable'].includes(row.disposition))fail('Invalid source coverage message');seen.add(row.index);
  const fs=row.fact_indices??[],os=row.operation_indices??[],raw=row.raw_slots??[];
  if(![fs,os,raw].every(xs=>Array.isArray(xs)&&new Set(xs).size===xs.length&&xs.every(x=>Number.isInteger(x)&&x>=0)))fail('Invalid source coverage references');
  if(row.disposition==='not_memorable'){if(fs.length||os.length||raw.length)fail('Non-memorable coverage cannot carry references');continue;}
  if(!fs.length&&!os.length&&!raw.length)fail('Empty source coverage');
  if(fs.some(i=>!prepared.facts[i]?.source_ids.includes(prepared.messages[row.index]!.id))||os.some(i=>prepared.operations[i]?.source.index!==row.index)||raw.some(slot=>work.candidates[slot]?.message!==row.index))fail('Unlinked source coverage reference');
  if(raw.length&&!fs.length&&!os.length&&!row.reason?.trim())fail('Source-only coverage needs a semantic classification reason');
 }
 if(seen.size!==expected.length)fail('Incomplete source coverage');
 return work;
}
/** Called inside the transaction, after erasure and index writes. Only cuts
 * from already validated erasure plans can discharge an accepted raw witness;
 * all remaining text must still be independently stored and indexed. */
export function assertSourceCoverageStored(plan:SourceCoveragePlan,req:AddRequest,prepared:Prepared,passages:Passage[],indexed:Set<string>,verifiedCuts:ReadonlyMap<string,{start:number;end:number}[]>=new Map()){
 const work=validateSourceCoveragePlan(plan,req,prepared);
 for(const slot of plan.rows.flatMap(r=>r.raw_slots??[])){
  const c=work.candidates[slot]!,cuts=verifiedCuts.get(c.source_id)??[];
  const expected:Passage={id:c.passage_id,source_id:c.source_id,speaker:'',fragments:[{start:c.start,end:c.end,text:c.quote}],content:c.quote,fact_ids:[],vector:null,observed_at:'',time_basis:'source',revision:0,state:'active'};
  redactPassage(expected,cuts);
  const actual=passages.filter(p=>p.id===c.passage_id&&p.source_id===c.source_id);
  if(actual.some(p=>p.fragments.some(f=>cuts.some(cut=>cut.start<f.end&&cut.end>f.start))))fail('Accepted raw coverage retained an authorized erasure');
  if(!expected.fragments.length){
   if(actual.some(p=>p.state!=='erased'||p.content||indexed.has(p.id)))fail('Accepted raw coverage retained an authorized erasure');
   continue;
  }
  const p=actual.find(p=>p.state==='active'&&p.fact_ids.length===0&&indexed.has(p.id)&&p.content===p.fragments.map(f=>f.text).join(' […] ')&&expected.fragments.every(s=>p.fragments.some(f=>f.start<=s.start&&f.end>=s.end&&f.text.slice(s.start-f.start,s.end-f.start)===s.text)));
  if(!p)fail('Accepted raw coverage was erased, linked to state, or not indexed');
 }
}
