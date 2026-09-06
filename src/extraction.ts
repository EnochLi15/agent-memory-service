import {indexedProposal} from './proposal-input.js';
import {prepareExtractionShards} from './extraction-shards.js';
import {SOURCE_FIRST_EXTRACTION_PROMPT,makeSourceCoveragePlan,type SourceCoverageRow} from './source-coverage.js';
import {SOURCE_ROUTE_PROMPT,sourceRouteInput,decodeSourceRoute,ordinarySourceRoute,validateSourceRoutePlan} from './source-operation-routing.js';
import {sourceOperationNeedsBatches,sourceOperationWholeInput,prepareSourceBatches,validateSourceBatchPlan} from './source-operation-batches.js';
import {sourceOperationWork,sourceOperationInput,sourceRejectionFindings,SOURCE_OPERATION_PROMPT,SOURCE_OPERATION_HISTORY_PROMPT,decodeSourceOperations,resolvedSourceInstructions,validateSourceOperations} from './source-operations.js';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { Models } from './models.js';
import { EXTRACTION_PROMPT } from './prompts.js';
import { addSchema, extractionSchema, canonical, operationScopeProblem, replacementMatches, ServiceError, type AddRequest, type Extraction, type ExtractedFact, type Fact, type Snapshot, type Prepared, type Operation } from './types.js';
import {bindingCandidates,resolveOperationTargets} from './binding.js';
import { entities, overlap, tokens, speakerPrefix } from './text.js';
import {preparePassages,sourceSpans} from './passages.js';
import {messageAnchors,normalizeFactTime} from './temporal.js';
import {humanQuote,participantIndices} from './verification.js';
import {SOURCE_REFERENCE_PROTOCOL,SOURCE_REFERENCE_PROMPT,sourceReferenceMessages,decodeSourceReferences} from './source-references.js';
import {GROUPED_EXTRACTION_PROTOCOL,GROUPED_EXTRACTION_PROMPT,decodeGroupedExtraction} from './extraction-groups.js';
import {VerificationSession} from './verification-session.js';
import {PATCH_PROMPT,applyRepair,scopeForFindings,replacementTargetGroups,replacementBindingProblems,type RepairScope} from './repair.js';
import {sourceErasureWork} from './source-erasure.js';
import {executeSourceErasure} from './source-erasure-execution.js';
import {executeGroupedSourceErasure} from './source-erasure-grouped.js';
import {erasureWork,decodeErasure,ERASURE_PROMPT} from './erasure.js';
import {transitionWork,transitionInput,decodeTransitions,TRANSITION_PROMPT} from './transitions.js';

export function hash(s: string): string { return createHash('sha256').update(s).digest('hex'); }
import {retirementEffectMismatch,currentRelationRemoval,realControl,instructionSpans,authorizesForget,missingForgetObligations,missingPersonalSources} from './operation-intent.js';

export function offlineExtract(req: AddRequest, snapshot: Snapshot): Extraction {
  const result: Extraction = { facts: [], operations: [] };
  for (const [index, message] of req.messages.entries()) {
    const clean = message.content.replace(/\[Session time:[^\]]*\]/g, '').trim();
    const named = speakerPrefix(clean);
    const subject = named?.[1]?.trim() ?? (message.role === 'user' ? 'user' : message.role);
    const body = named ? clean.slice(named[0].length) : clean;
    for (const span of instructionSpans(body)) {
      const quote=span.quote;
      if (message.role === 'user' && /remember.*again|store.*again|重新.*记|再次.*记/i.test(quote)) {
        const candidates = snapshot.facts.filter(f => f.state === 'erased' && overlap(quote, f.predicate) > 0);
        const keys = new Set(candidates.map(f => `${f.subject}|${f.predicate}|${f.scope}`));
        if (keys.size !== 1) throw new ServiceError('RESTORE', 'Offline restore needs an unambiguous property and a new value');
        const f = candidates[0]!;
        const value = quote.match(/(?:is|是)\s*([^.!。！]+?)(?:\s+again)?[.!。！]*$/i)?.[1]?.trim();
        if (!value) throw new ServiceError('RESTORE', 'Explicit value required');
        result.operations.push({type:'restore',target_ids:[],subject:f.subject,predicate:f.predicate,scope:f.scope,value,boundary:'value',source:{index,quote},reason:'Explicit new authorization'});
        result.facts.push({content:`${subject}: ${quote}`,subject:f.subject,predicate:f.predicate,value,scope:f.scope,kind:'fact',modality:'confirmed',cardinality:f.cardinality,time_text:'',valid_from:null,valid_to:null,sources:[{index,quote}],supersedes:[],depends_on:[]});
        continue;
      }
      if (span.intent==='forget' && (message.role === 'user'||named)) {
        const available=[...snapshot.facts.filter(f=>f.predicate!=='memory_operation'),...result.facts.map((f,i)=>({...f,id:`new:${i}`,state:'active' as const}))];
        const relevant = available.filter(f => f.state !== 'erased' && overlap(quote, `${f.subject} ${f.predicate} ${f.value} ${f.content}`) > .12);
        const valueExact = relevant.filter(f => f.value && canonical(quote).includes(canonical(f.value)));
        const target = valueExact.length ? valueExact : relevant;
        const propertyWords = quote.match(/(?:my|我的)\s*([\p{L}\s]{1,35})/u)?.[1] ?? '';
        const propertyMatches=target.filter(f=>/code|pin|密码|编号/i.test(quote)?/code|pin|密码|编号/i.test(f.predicate):false);
        const typed=propertyMatches.length?propertyMatches:target.filter(f=>f.modality!=='inferred');
        if (!typed.length){
          const erased=snapshot.facts.filter(f=>f.state==='erased'&&overlap(quote,`${f.subject} ${f.predicate} ${f.scope}`)>.12);
          // A repeated property deletion is a proven no-op only for one known slot.
          if(erased.length&&new Set(erased.map(f=>`${f.subject}|${f.predicate}|${f.scope}`)).size===1){
            const f=erased[0]!;
            const knownWords=new Set(tokens(`${f.subject} ${f.predicate} ${f.scope}`));
            if(tokens(quote).every(t=>operationStop.has(t)||knownWords.has(t)||t==='entirely')){
              result.operations.push({type:'forget',target_ids:erased.map(f=>f.id),subject:f.subject,predicate:f.predicate,scope:f.scope,value:'',boundary:'property',source:{index,quote},reason:'Already erased property'});continue;
            }
          }
          throw new ServiceError('AMBIGUOUS_OPERATION','Offline mode cannot safely bind this memory operation');
        }
        if(new Set(typed.map(f=>`${f.subject}|${f.scope}`)).size>1 || (new Set(typed.map(f => `${f.subject}|${f.predicate}`)).size > 1 && !valueExact.length)) throw new ServiceError('AMBIGUOUS_OPERATION', 'Offline mode cannot safely bind this memory operation');
        // Generic experience is a catch-all bucket, not a user property. Its
        // deletion marker would affect unrelated experiences and raw evidence.
        if(!valueExact.length&&typed.some(f=>f.predicate==='experience'))throw new ServiceError('AMBIGUOUS_OPERATION','Offline mode cannot bind an untyped experience property');
        const first = typed[0]!,currentRelation=currentRelationRemoval(span);
        result.operations.push({ type: currentRelation ? 'retract' : 'forget', target_ids: typed.map(f => f.id).filter(Boolean), subject: first.subject, predicate: first.predicate, scope: first.scope, value: valueExact[0]?.value ?? '', boundary: currentRelation ? 'current_relation' : valueExact.length ? 'value' : 'property', source: { index, quote }, reason: propertyWords });
        continue;
      }
      if (span.intent==='blocked') continue;
      if (message.role !== 'user' && !named) continue;
      if (/^(hi|hello|thanks|thank you|ok|okay|你好|谢谢)[.!。！\s]*$/i.test(quote)) continue;
      let predicate = 'experience', value = quote, cardinality: 'single'|'multiple' = 'multiple';
      const patterns: [RegExp,string][] = [
        [/(?:I (?:now )?live in|I moved to|My (?:current )?city is|我(?:现在)?住在|我搬到了)\s*([^.!。！;；]+)/iu,'current_city'],
        [/(?:My (?:current )?(?:job )?title is|我的职位是|我现在的职位是)\s*([^.!。！;；]+)/iu,'job_title'],
        [/(?:My manager is|我的经理是)\s*([^.!。！;；]+)/iu,'manager'],
        [/(?:My (?:old )?(?:door |access |security )?(?:code|PIN) is|我的(?:旧)?(?:门禁码|密码)是)\s*([^.!。！;；]+)/iu,'access_code'],
        [/(?:I (?:really )?(?:like|love|enjoy)|我喜欢|我爱好)\s*([^.!。！;；]+)/iu,'hobby'],
        [/(?:My salary is|我的工资是)\s*([^.!。！;；]+)/iu,'salary'],
      ];
      for (const [regex, key] of patterns) { const m = quote.match(regex); if (m) { predicate = key; value = m[1]!.trim(); cardinality = key === 'hobby' ? 'multiple' : 'single'; break; } }
      const tentative = /\b(plan|might|maybe|possibly|tentative|next month|next quarter|not finalized)\b|计划|可能|打算|未确定|没确定/.test(quote.toLowerCase());
      // Generic question/tutorial text is not evidence of a personal state.
      if (predicate === 'experience' && !/\b(I|my|we|our)\b|我|我们/iu.test(quote)) continue;
      if (predicate === 'experience' && /^(?:Can |Could |How |What |Why |Please explain)|[?？]$/i.test(quote)) continue;
      result.facts.push({ content: `${subject}: ${quote}`, subject, predicate, value, scope: '', kind: predicate === 'experience' ? 'event' : predicate === 'hobby' ? 'preference' : 'fact', modality: tentative ? 'tentative' : 'confirmed', cardinality, depends_on: [], time_text: quote.match(/yesterday|last \w+|next \w+|昨天|下个月|去年/i)?.[0] ?? '', valid_from: null, valid_to: null, sources: [{ index, quote }], supersedes: [] });
    }
  }
  return result;
}

const operationStop=new Set('i my me we our you your user assistant the a an is are was were be been it that this those these to of for from with on in at and or but not no do does did have has had please remember forget delete remove store memory information fact previous current actual old new value need want told say said again really completely'.split(' '));
function groundedOperation(o:Operation,req:AddRequest,facts:Fact[]):boolean {
  if(!o.target_ids.length)return true;
  const context=req.messages.slice(Math.max(0,o.source.index-3),o.source.index+1).map(m=>m.content).join(' ');
  const source=new Set(tokens(context).filter(t=>t.length>2&&!operationStop.has(t)));
  return o.target_ids.every(id=>{const f=facts.find(x=>x.id===id);if(!f)return false;const target=tokens(`${f.subject} ${f.predicate} ${f.value} ${f.content}`).filter(t=>t.length>2&&!operationStop.has(t));return target.some(t=>source.has(t));});
}
function humanOperation(o:Operation,req:AddRequest):boolean {
  const m=req.messages[o.source.index];if(!m||!humanQuote(req,o.source.index,o.source.quote))return false;if(m.role==='user')return true;
  const name=speakerPrefix(m.content.replace(/\[Session time:[^\]]*\]/g,'').trim())?.[1];
  return !!name && (canonical(o.subject)===canonical(name)||canonical(o.subject).startsWith(canonical(name)+"'s "));
}
function sourceMatches(source:{index:number;quote:string;start?:number},req:AddRequest):boolean{const text=req.messages[source.index]?.content;return !!text&&(source.start===undefined?text.includes(source.quote):text.slice(source.start,source.start+source.quote.length)===source.quote);}
function resolveSource(source:{index:number;quote:string;start?:number},req:AddRequest):void {
  if(source.start!==undefined)return;
  // Correct unambiguous index/copying mistakes without accepting paraphrased evidence.
  if(req.messages[source.index]?.content.includes(source.quote))return;
  const escaped=source.quote.trim().split(/\s+/).map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+');
  if(!escaped)return;
  const matches=req.messages.flatMap((m,index)=>[...m.content.matchAll(new RegExp(escaped,'gu'))].map(match=>({index,quote:match[0]})));
  if(matches.length===1){source.index=matches[0]!.index;source.quote=matches[0]!.quote;return;}
  // A case-only copying error can recover an exact span, but cannot select a
  // different speaker or one of several occurrences. Claim/modality support
  // still goes through independent verification against the recovered text.
  if(matches.length)return;
  const declared=req.messages[source.index];if(!declared)return;
  const local=[...declared.content.matchAll(new RegExp(escaped,'giu'))];
  if(local.length===1)source.quote=local[0]![0];
}
const factId=(req:AddRequest,index:number):string=>hash(`${req.user_id}\0${req.request_id}\0fact\0${index}`);
function before(a:{index:number;quote:string;start?:number},b:{index:number;quote:string;start?:number},req:AddRequest):boolean{
  if(!sourceMatches(a,req)||!sourceMatches(b,req))return false;
  if(a.index!==b.index)return a.index<b.index;
  const text=req.messages[a.index]?.content??'';
  const start=a.start??text.indexOf(a.quote),end=b.start??text.indexOf(b.quote);
  return start>=0&&end>=0&&(a.start!==undefined||start===text.lastIndexOf(a.quote))&&(b.start!==undefined||end===text.lastIndexOf(b.quote))&&start+a.quote.length<=end;
}
function bindNewFactHandles(parsed:Extraction,req:AddRequest):Set<string>{
  const ids=new Map(parsed.facts.map((_,i)=>[factId(req,i),i]));
  const resolve=(id:string,sources:{index:number;quote:string}[],owner?:number):string=>{
    const match=id.match(/^new:(\d+)$/);
    const index=match?Number(match[1]):ids.get(id);
    if(index===undefined)return id;
    const f=parsed.facts[index];
    if(!f||index===owner||(owner!==undefined&&index>=owner)||!f.sources.every(a=>sources.every(b=>before(a,b,req))))
      throw new ServiceError('OPERATION_TARGET','Invalid same-chunk target chronology');
    return factId(req,index);
  };
  for(const [i,f] of parsed.facts.entries()){
    f.depends_on=f.depends_on.map(id=>resolve(id,f.sources,i));f.supersedes=f.supersedes.map(id=>resolve(id,f.sources,i));
  }
  for(const o of parsed.operations)o.target_ids=o.target_ids.map(id=>resolve(id,[o.source]));
  return new Set(ids.keys());
}
function proposalFacts(parsed:Extraction,req:AddRequest):Fact[]{
  return parsed.facts.map((f,i)=>({...f,id:factId(req,i),source_ids:[],source_quotes:f.sources.map(s=>s.quote),created_at:'',observed_at:'',state:'active',vector:null,entities:[],revision:0}));
}
function bindOperationSelectors(parsed:Extraction,req:AddRequest,snapshot:Snapshot):{operation:number;code:string;reason:string}[]{
 const proposed=proposalFacts(parsed,req),issues:{operation:number;code:string;reason:string}[]=[];
 for(const [index,operation] of parsed.operations.entries()){
  const pending=proposed.filter((_,i)=>parsed.facts[i]!.sources.every(source=>before(source,operation.source,req)));
  const allowEmpty=operation.type==='restore'||operation.type==='update'&&parsed.facts.some(f=>replacementMatches(f,operation)&&f.sources.some(s=>s.index===operation.source.index));
  const binding=resolveOperationTargets(operation,[...snapshot.facts,...pending],allowEmpty);
  if(binding.status==='resolved')operation.target_ids=binding.target_ids;
  else issues.push({operation:index,code:binding.code,reason:binding.reason});
 }
 return issues;
}
export class Extractor {
  constructor(private config: Config, private models: Models) {}
  async prepare(req: AddRequest, snapshot: Snapshot, signal: AbortSignal): Promise<Prepared> {
    addSchema.parse(req);
    const traceIdentity={user_id:req.user_id,request_id:req.request_id};
    if(this.config.sourceErasure&&!this.config.experimental?.rawOnly&&snapshot.revision>0&&!snapshot.erasureSources)throw new ServiceError('SOURCE_FORMAT','Source erasure requires a fresh v4 directory');
    const degraded: string[] = [];const partialSources=new Set<number>();
    const modelSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.min(95000,Math.max(500,this.config.addTimeout-25000)))]);
    const sourceHistory=this.config.sourceOperationHistory?(snapshot.erasureSources??[]):[];
    let sourceOperationPlan:Prepared['sourceOperationPlan'];
    if(this.config.sourceOperations){
      const work=sourceOperationWork(req,snapshot.facts,sourceHistory);
      let routeReview;
      if(work.enabled&&this.config.sourceOperationRouting){
        let raw:unknown;
        try{raw=await this.models.json(SOURCE_ROUTE_PROMPT,JSON.stringify(sourceRouteInput(work)),modelSignal,{purpose:'source_operation_route',trace:traceIdentity});}
        catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError('VERIFICATION_UNAVAILABLE','Source routing unavailable within shared budget');}
        routeReview=decodeSourceRoute(raw,work);sourceOperationPlan=ordinarySourceRoute(work,routeReview);
      }
      if(sourceOperationPlan){/* Ordinary routing leaves all fact operations pending. */}
      else if(work.enabled&&this.config.sourceOperationBatches&&sourceOperationNeedsBatches(work)){
        sourceOperationPlan=await prepareSourceBatches(work,modelSignal,(prompt,input,s,purpose)=>this.models.json(prompt,input,s,{purpose,trace:traceIdentity}));
      }else if(work.enabled){
        let raw:unknown;
        try{raw=await this.models.json(this.config.sourceOperationHistory?SOURCE_OPERATION_HISTORY_PROMPT:SOURCE_OPERATION_PROMPT,JSON.stringify(this.config.sourceOperationBatches?sourceOperationWholeInput(work):sourceOperationInput(work)),modelSignal,{purpose:'source_operation',trace:traceIdentity});}
        catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError('VERIFICATION_UNAVAILABLE','Source operation review unavailable within shared budget');}
        sourceOperationPlan=decodeSourceOperations(raw,work);
      }else sourceOperationPlan={fingerprint:work.fingerprint,decisions:work.instructions.map(i=>({instruction:i.slot,action:'ordinary',target_slots:[],cuts:[]}))};
      if(routeReview)sourceOperationPlan={...sourceOperationPlan!,route_review:routeReview};
      if(this.config.sourceOperationRouting)validateSourceRoutePlan(sourceOperationPlan!,work);
    }
    const sourceActions=sourceOperationPlan?resolvedSourceInstructions(sourceOperationPlan,req,snapshot.facts,sourceHistory):[];
    const pendingForget=(proposal:Extraction)=>missingForgetObligations(req,proposal).filter(o=>!sourceActions.some(a=>a.message===o.index&&a.start===o.span.start&&a.end===o.span.end));
    const chronology=messageAnchors(req,snapshot.anchor);const anchor=chronology.last;
    let parsed: Extraction;let sourceCoverageRows:SourceCoverageRow[]|undefined;
    if(this.config.experimental?.rawOnly){
      parsed={operations:[],facts:req.messages.flatMap((m,index)=>m.content.match(/[\s\S]{1,2000}/g)?.map(quote=>({content:`${m.role}: ${quote}`,subject:m.role,predicate:'raw_evidence',value:quote,scope:'',kind:'event' as const,modality:'confirmed' as const,cardinality:'multiple' as const,time_text:'',valid_from:null,valid_to:null,sources:[{index,quote}],supersedes:[],depends_on:[]}))??[])};
    }
    else if (this.config.mode === 'offline') parsed = offlineExtract(req, snapshot);
    else {
      const chunkText = req.messages.map(m => m.content).join('\n');
      const ordered=snapshot.facts.filter(f=>f.predicate!=='memory_operation').map(f=>({f,score:overlap(chunkText,`${f.subject} ${f.predicate} ${f.value} ${f.content}`)+(f.state==='active'&&f.cardinality==='single'?.08:0)})).sort((a,b)=>b.score-a.score).slice(0,120).map(x=>x.f);
      const aliases=new Map(ordered.map((f,i)=>[`m${i}`,f.id]));
      const knownIds=new Set(snapshot.facts.map(f=>f.id));
      const relevant=ordered.map((f,i)=>({id:`m${i}`,content:f.content,subject:f.subject,predicate:f.predicate,value:f.value,scope:f.scope,state:f.state,modality:f.modality}));
      const visibleIds=new Set(ordered.map(f=>f.id));let extraCandidates=0;
      const expandTargets=(proposal:Extraction):void=>{
        for(const operation of proposal.operations)for(const f of bindingCandidates(operation,snapshot.facts)){
          if(visibleIds.has(f.id)||extraCandidates>=32)continue;
          const id=`m${aliases.size}`;aliases.set(id,f.id);visibleIds.add(f.id);extraCandidates++;
          relevant.push({id,content:f.content,subject:f.subject,predicate:f.predicate,value:f.value,scope:f.scope,state:f.state,modality:f.modality});
        }
      };
      const references=this.config.extractionFormat==='source_refs',grouped=this.config.extractionFormat!=='flat';
      const extractionPrompt=(references?SOURCE_REFERENCE_PROMPT:grouped?GROUPED_EXTRACTION_PROMPT:EXTRACTION_PROMPT)+(this.config.sourceFirst?SOURCE_FIRST_EXTRACTION_PROMPT:'')+(sourceActions.length?'\nRESOLVED_SOURCE_ACTIONS have a separate independently verified source removal plan that will commit atomically with your facts. Do not produce duplicate fact-ID operations for those exact instructions, and never bind them to unrelated existing facts. Preserve remaining corrected user facts and all other real instructions. Do not turn a rejected assistant value into a negative fact such as "user does not use REJECTED_VALUE"; that still stores the detail the user rejected. Generic rejection statements need no separate fact, while independent human preferences remain memorable. Do not cite any cut interval as a fact source; select the exact surviving user subclause if its whole sentence overlaps a cut.':'');
      const user=JSON.stringify({...(sourceActions.length?{RESOLVED_SOURCE_ACTIONS:sourceActions}:{}),...(grouped?{EXTRACTION_PROTOCOL:references?SOURCE_REFERENCE_PROTOCOL:GROUPED_EXTRACTION_PROTOCOL,PARTICIPANT_INDEX:participantIndices(req)}:{}),OBSERVATION_DATE:anchor,EXISTING_FACTS:relevant,CONTEXT_ONLY:snapshot.tail.map(m=>({role:m.role,content:m.content})),NEW_MESSAGES:references?sourceReferenceMessages(req):req.messages.map((m,index)=>({index,...m}))});
      // Reserve time for grounded fallback, local embedding and atomic commit.
      // This inner budget never extends the caller's absolute request deadline.
      let semanticallyRejected=false;const verificationSession=new VerificationSession(this.config.incrementalVerification);
      try {
        let issue='';let failedProposal:unknown;let repairScope:RepairScope|undefined;let accepted:Extraction|undefined;
        for(let attempt=0;attempt<=this.config.maxRepairRounds;attempt++){
          const prior=extractionSchema.safeParse(failedProposal);
          const patchMode=!!issue&&prior.success;
          const scope=repairScope??{fact_indices:prior.success?prior.data.facts.map((_,i)=>i):[],operation_indices:prior.success?prior.data.operations.map((_,i)=>i):[],source_indices:req.messages.map((_,i)=>i)};
          // A scope belongs to one rejected proposal. Consume it before the next
          // validation pass, whose indices may include newly appended facts.
          repairScope=undefined;
          const repairSystem=issue?(patchMode?PATCH_PROMPT:'\nRepair the malformed proposal; return the complete extraction schema.'):'';
          const repairInput=issue?JSON.stringify({...JSON.parse(user),...(grouped&&patchMode?{EXTRACTION_PROTOCOL:'flat-patch-v1',NEW_MESSAGES:req.messages.map((m,index)=>({index,...m}))}:{}),EXISTING_FACTS:relevant,REPAIR_FEEDBACK:issue,FAILED_PROPOSAL:patchMode?indexedProposal(prior.data!):failedProposal,...(patchMode?{REPAIR_SCOPE:scope,REPLACEMENT_TARGET_GROUPS:replacementTargetGroups(prior.data!,relevant),FACT_RULES:EXTRACTION_PROMPT}:{})}):user;
          const output=!issue&&grouped&&this.config.extractionWorkers>1&&participantIndices(req).length>=4
            ?await prepareExtractionShards(req,extractionPrompt,user,this.config.extractionWorkers,modelSignal,(prompt,input,s,extraction_shard)=>this.models.json(prompt,input,s,{purpose:'extraction',trace:traceIdentity,extraction_shard}))
            :await this.models.json(patchMode?PATCH_PROMPT:extractionPrompt+repairSystem,repairInput,modelSignal,{purpose:issue?'repair':'extraction',trace:traceIdentity});
          let raw:unknown=output;
          if(grouped&&!patchMode){
            try{raw=references?decodeSourceReferences(output,req):decodeGroupedExtraction(output,req);}
            catch(error){
              failedProposal=output;
              if(attempt===this.config.maxRepairRounds)throw new ServiceError('EVIDENCE_VALIDATION','Grouped extraction could not cover every participant within bounded repair rounds');
              issue=(error instanceof Error?error.message:'Invalid grouped extraction')+'. Return the complete message_groups schema and preserve every participant index.';continue;
            }
          }
          if(patchMode){
            try{raw=applyRepair(prior.data!,output,scope);}
            catch(error){if(issue.startsWith('Unknown target')||issue.startsWith('Operation target binding'))throw new ServiceError('OPERATION_TARGET','Invalid target/scope repair patch');throw error;}
          }
          failedProposal=structuredClone(raw);
          // Normalize an unambiguous model spelling without weakening the runtime
          // schema: a plan is a tentative event, never confirmed current state.
          if(raw&&typeof raw==='object'&&Array.isArray((raw as {facts?:unknown}).facts)){
            for(const f of (raw as {facts:unknown[]}).facts)if(f&&typeof f==='object'&&(f as {kind?:unknown}).kind==='plan')Object.assign(f,{kind:'event',modality:'tentative'});
          }
          const valid=extractionSchema.safeParse(raw);
          if(!valid.success){issue='Return the complete schema. '+valid.error.issues.slice(0,4).map(x=>x.path.join('.')+': '+x.message).join('; ');continue;}
          for(const f of valid.data.facts)for(const source of f.sources)resolveSource(source,req);
          for(const o of valid.data.operations){resolveSource(o.source,req);const statement=req.messages[o.source.index]?.content??'';if(o.type==='retract'&&realControl(statement)&&/\b(?:forget|erase|delete)\b|remove .{0,100} entirely|彻底删除|完全移除/i.test(o.source.quote)&&!/current (?:colleague|contact)|当前同事|当前联系人/i.test(statement))o.type='forget';}
          failedProposal=structuredClone(valid.data);
          if(valid.data.operations.some(o=>retirementEffectMismatch(o,req))){
            issue='Operation effect mismatch: a request to stop retaining information requires forget, not retract. Bind ALL affected properties within the requested entity boundary, including same-chunk transient facts, so their sources are erased. A status-only retraction cannot satisfy an erasure request. Preserve unrelated entities and facts. Only explicit removal from a current relationship list permits retract with current_relation.';
            continue;
          }
          for(const f of valid.data.facts){f.supersedes=f.supersedes.map(id=>aliases.get(id)??id);f.depends_on=f.depends_on.map(id=>aliases.get(id)??id);}
          for(const o of valid.data.operations)o.target_ids=o.target_ids.map(id=>aliases.get(id)??id);
          let localIds:Set<string>;
          try{localIds=bindNewFactHandles(valid.data,req);}catch{issue='Unknown target chronology. new:N may only reference an earlier sourced fact in this chunk. Repair the invalid references.';continue;}
          const unknown=[...valid.data.facts.flatMap(f=>[...f.supersedes,...f.depends_on]),...valid.data.operations.flatMap(o=>o.target_ids)].filter(id=>!knownIds.has(id)&&!localIds.has(id));
          if(unknown.length){expandTargets(valid.data);issue='Unknown target IDs. Use ONLY short IDs from EXISTING_FACTS, never invent IDs. This list now includes bounded operation-specific candidates. Candidate similarity is not authorization; bind only actual targets supported by the user statement. If a rejected assistant claim was not in existing memories, emit no delete/correct operation for it. Unknown IDs: '+JSON.stringify(unknown.slice(0,8));continue;}
          const bindingPool=[...snapshot.facts,...proposalFacts(valid.data,req)];
          const invalid=valid.data.facts.flatMap((f,i)=>f.sources.filter(s=>!sourceMatches(s,req)).map(s=>({fact:i,index:s.index,quote:s.quote,start:s.start})));
          const unauthorized=valid.data.operations.flatMap((o,index)=>o.type==='forget'&&!authorizesForget(o,req)?[index]:[]);
          const badOps=valid.data.operations.filter(o=>!req.messages[o.source.index]?.content.includes(o.source.quote)||!humanOperation(o,req));
          const sourceFeedback=invalid.length||badOps.length||unauthorized.length?' SOURCE_ERRORS: '+JSON.stringify({facts:invalid,operations:badOps,authorization_errors:unauthorized.map(operation=>({operation,source:valid.data.operations[operation]!.source,reason:'Cited span does not authorize deletion of this target.'}))})+'. Also repair these exact human source spans in this same patch; copy from NEW_MESSAGES without paraphrasing. For authorization errors cite an actual deletion instruction for the same target, not a reason for removal; remove only that unsupported operation if no such instruction exists. Preserve valid sibling operations.':'';
          const badScopes=valid.data.operations.flatMap((o,index)=>{
            const code=operationScopeProblem(o,bindingPool.filter(f=>o.target_ids.includes(f.id)));
            return code?[{operation:index,code,requested:{subject:o.subject,predicate:o.predicate,scope:o.scope},selected_targets:bindingPool.filter(f=>o.target_ids.includes(f.id)).map(f=>({id:f.id,proposal_index:valid.data.facts.findIndex((_,i)=>factId(req,i)===f.id),subject:f.subject,predicate:f.predicate,scope:f.scope,content:f.content}))}]:[];
          });
          const badReplacements=valid.data.facts.flatMap((f,index)=>f.supersedes.some(id=>{const old=bindingPool.find(t=>t.id===id);return old&&!replacementMatches(f,old);})?[index]:[]);
          if(badScopes.length||badReplacements.length){
            expandTargets(valid.data);
            const facts=new Set([...badReplacements,...invalid.map(f=>f.fact),...badScopes.flatMap(o=>o.selected_targets.map(f=>f.proposal_index).filter(i=>i>=0))]);
            const operations=new Set([...badScopes.map(o=>o.operation),...valid.data.operations.flatMap((o,index)=>badOps.includes(o)?[index]:[]),...unauthorized]);
            repairScope=scopeForFindings(valid.data,[...facts].map(i=>`fact ${i}: Invalid binding or source`).concat([...operations].map(i=>`operation ${i}: Invalid binding or source`)));
          }
          if(badScopes.length||badReplacements.length){
            const labels=new Map([...aliases].map(([alias,id])=>[id,alias]));valid.data.facts.forEach((_,i)=>labels.set(factId(req,i),`new:${i}`));
            const replacement_details=replacementBindingProblems(valid.data,bindingPool,id=>labels.get(id)??id);
            issue='Operation target binding: subject, property or scope does not match its selected targets. '+JSON.stringify({operations:badScopes,replacement_facts:badReplacements,replacement_details})+sourceFeedback+'. Reuse matching existing fields only if that record is actually the requested target. For same-chunk transient targets, proposal_index identifies the editable fact slot. If the user forgets multiple properties of one concrete entity, give those transient facts that same entity scope when their original statements support it; preserve unrelated devices. Alternatively split operations only when the source actually authorizes each distinct scope. Changing sources alone does not fix a scope mismatch. Never rename an existing or unrelated record to pass validation. If correcting an assistant claim that was never stored, keep the grounded USER facts but emit no operation or supersedes reference against an unrelated record. Cite the user correction itself, not the assistant restatement. Return the corrected object.';continue;}
          if(unauthorized.length){
            const findings=unauthorized.map(index=>`operation ${index}: The cited source is not an authorizing user deletion instruction.`);
            repairScope=scopeForFindings(valid.data,findings);
            issue=JSON.stringify(findings)+' Repair only these operations; preserve valid sibling operations and unrelated facts. If NEW_MESSAGES contains an actual deletion instruction for this same target, replace the source with its exact authorizing span and preserve the target fields. A reason for removal is not itself a command. If no actual instruction authorizes that target, remove only the unsupported operation. Do not borrow an unrelated command or combine targets with different properties/scopes. Source repair still requires independent target and semantic verification.';
            continue;
          }
          if(valid.data.operations.some(o=>!groundedOperation(o,req,[...snapshot.facts,...proposalFacts(valid.data,req)]))){issue='An operation targets a fact with no matching topic in the new user request or preceding context. Do not delete unrelated memories. If the user rejects a never-stored assistant claim, return no operation. Recheck targets and return full JSON.';continue;}
          if(pendingForget(valid.data).length){issue='A direct retirement instruction has no operation. Bind each instruction to tenant-local evidence; do not silently omit it. Return the full object.';continue;}
          const bindingIssues=bindOperationSelectors(valid.data,req,snapshot);
          if(bindingIssues.length){expandTargets(valid.data);issue='Operation target binding: '+JSON.stringify(bindingIssues)+'. Select the actual targets from EXISTING_FACTS or earlier new:N facts; do not treat a missing target as an executed operation.';continue;}
          if(attempt===this.config.maxRepairRounds&&invalid.length&&!badOps.length){
            // Preserve valid operations and facts; an unsupported paraphrased quote must
            // not invalidate an entire chronological sample. Recover only what rules can
            // ground, and retain the remaining original text under lifecycle visibility.
            const badIndexes=new Set(invalid.map(x=>x.index).filter(i=>!!req.messages[i]));
            const recoveredFacts:Extraction['facts']=[];
            for(const index of badIndexes){
              partialSources.add(index);
              try{const recovered=offlineExtract({...req,messages:[req.messages[index]!]},snapshot);if(!recovered.operations.length)for(const f of recovered.facts){f.sources=f.sources.map(s=>({...s,index}));recoveredFacts.push(f);}}catch{ /* original evidence remains available */ }
            }
            // Reuse the same stable-slot mapping as model patches; removing an
            // invalid source must never redirect an existing new:N reference.
            const previous=extractionSchema.parse(failedProposal);
            const invalidFactIndices=[...new Set(invalid.map(x=>x.fact))];
            valid.data=applyRepair(previous,{fact_edits:invalidFactIndices.map(index=>({index,remove:true})),append_facts:recoveredFacts},{fact_indices:invalidFactIndices,operation_indices:[],source_indices:[...badIndexes]});
            for(const f of valid.data.facts){f.supersedes=f.supersedes.map(id=>aliases.get(id)??id);f.depends_on=f.depends_on.map(id=>aliases.get(id)??id);}
            for(const o of valid.data.operations)o.target_ids=o.target_ids.map(id=>aliases.get(id)??id);
            bindNewFactHandles(valid.data,req);degraded.push('source_span_partial');
            if(bindOperationSelectors(valid.data,req,snapshot).length)throw new ServiceError('OPERATION_TARGET','Partial recovery left unresolved target bindings');
            const findings=await this.models.verify(valid.data,req,[...snapshot.facts,...proposalFacts(valid.data,req)],missingPersonalSources(req,valid.data),modelSignal,verificationSession,sourceActions);
            if(findings.length)throw new ServiceError('EVIDENCE_VALIDATION','Partial recovery failed semantic verification');
            accepted=valid.data;break;
          }
          if(invalid.length||badOps.length){issue='Every source quote must be an exact substring of the indicated NEW_MESSAGES content. Operations must cite a USER message, or a named real participant changing their own facts. An unlabelled assistant reply never authorizes changes. Never copy CONTEXT_ONLY as a new source. Fix all facts/operations and return the full object. Invalid fact spans: '+JSON.stringify(invalid.slice(0,8));continue;}
          const rejectionFindings=sourceRejectionFindings(sourceOperationPlan,req,valid.data.facts,sourceHistory);
          const findings=rejectionFindings.length?rejectionFindings:await this.models.verify(valid.data,req,bindingPool,missingPersonalSources(req,valid.data),modelSignal,verificationSession,sourceActions);
          if(findings.length){semanticallyRejected=true;repairScope=scopeForFindings(valid.data,findings);issue='Semantic verification rejected the proposal. Repair these specific failures while preserving supported unrelated facts. '+JSON.stringify(findings)+'. Return the complete corrected object.';continue;}
          accepted=valid.data;break;
        }
        if(!accepted&&issue.startsWith('Unknown target'))throw new ServiceError('OPERATION_TARGET','Unknown memory operation target after repair');
        if(!accepted&&issue.startsWith('Operation target binding'))throw new ServiceError('OPERATION_TARGET','Unresolved operation subject, property or scope after repair');
        if(!accepted&&issue.startsWith('Semantic verification'))throw new ServiceError('EVIDENCE_VALIDATION','Evidence still fails semantic verification after repair');
        if(!accepted&&issue.startsWith('Operation effect mismatch'))throw new ServiceError('OPERATION_INTENT','Retirement still has the wrong operation effect after repair');
        if(!accepted)throw new ServiceError('EXTRACTION_SCHEMA','Could not validate structured evidence and exact sources');
        parsed=accepted;
        if(this.config.sourceFirst)sourceCoverageRows=verificationSession.acceptedSourceCoverage(req,parsed);
      } catch (error) {
        if (signal.aborted || (error instanceof ServiceError && ['OPERATION_TARGET','OPERATION_SCOPE','OPERATION_INTENT','EVIDENCE_VALIDATION','VERIFICATION_UNAVAILABLE'].includes(error.code))) throw error;
        if(semanticallyRejected)throw new ServiceError('EVIDENCE_VALIDATION',modelSignal.aborted?'A rejected proposal could not be repaired before the request deadline':'A rejected proposal could not be repaired after a model or protocol failure');
        degraded.push('extraction_offline'); parsed = offlineExtract(req,snapshot);
      }
    }
    const validSource = (s:{index:number;quote:string;start?:number}): boolean => sourceMatches(s,req);
    if (parsed.operations.some(o => !validSource(o.source) || !humanOperation(o,req))) throw new ServiceError('OPERATION_SOURCE','Operation lacks valid user evidence');
    // Reject nonexistent operation targets; the model may only bind tenant-local evidence.
    const localIds=bindNewFactHandles(parsed,req);
    if(bindOperationSelectors(parsed,req,snapshot).length)throw new ServiceError('OPERATION_TARGET','Unresolved operation target before commit');
    if(!this.config.experimental?.rawOnly&&pendingForget(parsed).length)throw new ServiceError('OPERATION_INTENT','Unresolved memory operation after bounded recovery');
    const known = new Set([...snapshot.facts.map(f=>f.id),...localIds]);
    if (parsed.operations.some(o=>o.target_ids.some(id=>!known.has(id)))) throw new ServiceError('OPERATION_TARGET','Unknown memory operation target');
    const messages = req.messages.map((m,i)=>({ ...m,id:hash(`${req.user_id}\0${req.request_id}\0${i}`),session_id:req.session_id,ordinal:i,external_id:m.content.match(/\[Source id: ([^\]]+)\]/)?.[1],searchable:true,partial:partialSources.has(i),time_basis:(chronology.anchors[i]?.includes('synthetic ordering')?'ordering':'source') as 'ordering'|'source' }));
    const facts: Fact[] = [];
    for (const [i,f] of parsed.facts.entries()) {
      if (f.sources.some(s=>!validSource(s))) throw new ServiceError('FACT_SOURCE','Fact lacks verbatim source evidence');
      if ([...f.supersedes,...f.depends_on].some(id=>!known.has(id))) throw new ServiceError('FACT_TARGET','Unknown superseded fact');
      const src = f.sources.map(s=>messages[s.index]!);
      const eventTime=normalizeFactTime(f,req,chronology.anchors);
      const {sources:proposalSources,...attributes}=f;
      if(!this.config.experimental?.rawOnly&&src.every(m=>m.role!=='user'&&!speakerPrefix(m.content.replace(/\[Session time:[^\]]*\]/g,'').trim())))f.modality='quoted';
      facts.push({ ...attributes,event_time:eventTime,source_spans:sourceSpans(f,messages),modality:f.modality,time_basis:src[0]!.time_basis,id:factId(req,i),source_ids:[...new Set(src.map(m=>m.id))],source_quotes:proposalSources.map(s=>s.quote),created_at:src[0]!.timestamp,observed_at:src[0]!.timestamp,state:'active',vector:null,entities:entities(f.content),revision:snapshot.revision+1 });
    }
    if(sourceOperationPlan&&this.config.sourceOperationRouting)validateSourceRoutePlan(sourceOperationPlan,sourceOperationWork(req,snapshot.facts,sourceHistory));
    else if(sourceOperationPlan&&this.config.sourceOperationBatches&&sourceOperationWork(req,snapshot.facts,sourceHistory).enabled)validateSourceBatchPlan(sourceOperationPlan,sourceOperationWork(req,snapshot.facts,sourceHistory));
    if(sourceOperationPlan)validateSourceOperations(sourceOperationPlan,req,snapshot.facts,facts,messages,sourceHistory);
    const useErasure=this.config.erasureBinding&&!this.config.experimental?.rawOnly;
    let erasurePlan:Prepared['erasurePlan'];
    if(useErasure){
      const work=erasureWork(req,snapshot.facts,facts,parsed.operations,snapshot.erasureBoundaries??[]);
      if(work.candidates.length){
        if(this.config.mode!=='enhanced'||degraded.includes('extraction_offline'))throw new ServiceError('EVIDENCE_VALIDATION','Erasure scope requires semantic binding; offline recovery cannot certify independence');
        let raw:unknown;
        try{raw=await this.models.json(ERASURE_PROMPT,JSON.stringify({NEW_MESSAGES:req.messages,CONTEXT_ONLY:snapshot.tail,CANDIDATES:work.candidates.map((c,index)=>({index,...c}))}),modelSignal,{purpose:'erasure_binding',trace:traceIdentity});}
        catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError('VERIFICATION_UNAVAILABLE','Could not bind erasure scope within the shared model budget');}
        erasurePlan=decodeErasure(raw,work);
      }else erasurePlan={fingerprint:work.fingerprint,decisions:work.automatic};
    }
    let sourceErasurePlan:Prepared['sourceErasurePlan'];
    if(useErasure&&this.config.sourceErasure){
      const work=sourceErasureWork(req,snapshot.facts,facts,parsed.operations,snapshot.erasureBoundaries??[],snapshot.erasureSources??[],messages,erasurePlan?.decisions.filter(d=>d.effect==='erase').map(d=>d.fact_id)??[]);
      if(work.candidates.length){
        if(this.config.mode!=='enhanced'||degraded.includes('extraction_offline'))throw new ServiceError('EVIDENCE_VALIDATION','Source erasure requires semantic verification');
        sourceErasurePlan=await (this.config.sourceErasureGrouped?executeGroupedSourceErasure:executeSourceErasure)(work,this.config.sourceErasureWorkers,modelSignal,(system,input,s,purpose,source_erasure_batch)=>this.models.json(system,input,s,{purpose,trace:traceIdentity,...(source_erasure_batch?{source_erasure_batch}:{})}));
      }else sourceErasurePlan={fingerprint:work.fingerprint,decisions:[]};
    }
    let transitionPlan:Prepared['transitionPlan'];
    if(useErasure&&this.config.semanticTransitions){
      const work=transitionWork(req,snapshot.facts,facts,parsed.operations);
      if(work.candidates.length){
        if(this.config.mode!=='enhanced'||degraded.includes('extraction_offline'))throw new ServiceError('EVIDENCE_VALIDATION','Implicit transitions require semantic verification');
        let raw:unknown;try{raw=await this.models.json(TRANSITION_PROMPT,JSON.stringify(transitionInput(req,work)),modelSignal,{purpose:'state_transition',trace:traceIdentity});}
        catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError('VERIFICATION_UNAVAILABLE','Implicit transition verification unavailable within shared model budget');}
        transitionPlan=decodeTransitions(raw,work);
      }else transitionPlan={fingerprint:work.fingerprint,decisions:[]};
    }
    const passages=this.config.sourceIndex&&!this.config.experimental?.rawOnly?preparePassages(messages,facts,parsed.operations,snapshot.revision+1):[];
    if (this.config.mode !== 'offline' && (facts.length||passages.length)) {
      try {
        const eligible = [...facts.filter(f=>f.content.length<3500),...passages];
        const vectors = await this.models.embedBatch(eligible.map(f=>f.content),'add',signal);
        eligible.forEach((f,i)=>{f.vector=vectors[i]!;});
        if (facts.some(f=>f.content.length>=3500)) degraded.push('long_evidence_lexical');
      } catch(error) { if (signal.aborted) throw error; degraded.push('embedding_lexical'); }
    }
    const sourceFormat=`${this.config.sourceIndex&&!this.config.experimental?.rawOnly?'dual-source':'facts-only'}-v${useErasure?(this.config.sourceFirst?10:this.config.sourceOperationRouting?9:this.config.sourceOperationBatches?8:this.config.sourceOperationHistory?7:this.config.sourceOperations?6:this.config.semanticTransitions?5:this.config.sourceErasure?4:3):2}` as Prepared['sourceFormat'];
    const prepared:Prepared={ ...(sourceOperationPlan?{sourceOperationPlan}:{}),facts,operations:parsed.operations,messages,passages,sourceFormat,...(erasurePlan?{erasurePlan}:{}),...(sourceErasurePlan?{sourceErasurePlan}:{}),...(transitionPlan?{transitionPlan}:{}),anchor,degraded,embeddingSpace:this.config.embeddingSpace };
    if(this.config.sourceFirst){if(!sourceCoverageRows)throw new ServiceError('EVIDENCE_VALIDATION','Source-first write lacks independent coverage');prepared.sourceCoveragePlan=makeSourceCoveragePlan(req,prepared,sourceCoverageRows);}
    return prepared;
  }
}
