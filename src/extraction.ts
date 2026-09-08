import {indexedProposal} from './proposal-input.js';
import {prepareExtractionShards} from './extraction-shards.js';
import {SOURCE_FIRST_EXTRACTION_PROMPT,makeSourceCoveragePlan,type SourceCoverageRow} from './source-coverage.js';
import {SOURCE_ROUTE_PROMPT,sourceRouteInput,decodeSourceRoute,ordinarySourceRoute,validateSourceRoutePlan} from './source-operation-routing.js';
import {sourceOperationNeedsBatches,sourceOperationWholeInput,prepareSourceBatches,validateSourceBatchPlan} from './source-operation-batches.js';
import {sourceOperationWork,sourceOperationInput,sourceRejectionFindings,SOURCE_OPERATION_PROMPT,SOURCE_OPERATION_HISTORY_PROMPT,decodeSourceOperations,resolvedSourceInstructions,validateSourceOperations} from './source-operations.js';
import { createHash } from 'node:crypto';
import {sourceFormatFor,type Config} from './config.js';
import { Models } from './models.js';
import { EXTRACTION_PROMPT } from './prompts.js';
import { factId, addSchema, extractionSchema, canonical, slot, propertyFamily, replacementMatches, sameSlot, ServiceError, type AddRequest, type Extraction, type ExtractedFact, type Fact, type Snapshot, type Prepared, type Operation, type StoredMessage } from './types.js';
import {bindingCandidates,resolveOperationTargets} from './binding.js';
import { entities, overlap, tokens, speakerPrefix } from './text.js';
import {preparePassages,sourceSpans} from './passages.js';
import {messageAnchors,normalizeFactTime,normalizeMissingTimestamps} from './temporal.js';
import {forgetScopeContext,humanQuote,participantIndices} from './verification.js';
import {SOURCE_REFERENCE_PROTOCOL,SOURCE_REFERENCE_PROMPT,sourceReferenceMessages,decodeSourceReferences} from './source-references.js';
import {GROUPED_EXTRACTION_PROTOCOL,GROUPED_EXTRACTION_PROMPT,decodeGroupedExtraction} from './extraction-groups.js';
import {VerificationSession} from './verification-session.js';
import {PATCH_PROMPT,SEMANTIC_RETIREMENT_REPAIR_PROMPT,applyRepair,scopeForFindings,retirementInstructionsAtRisk,replacementTargetGroups,replacementBindingProblems,operationBindingProblems,RepairScopeError,type RepairScope} from './repair.js';
import {sourceErasureWork} from './source-erasure.js';
import {conservativeSourceErasureFallback} from './source-erasure-fallback.js';
import {executeSourceErasure} from './source-erasure-execution.js';
import {executeGroupedSourceErasure} from './source-erasure-grouped.js';
import {erasureWork,erasureInput,decodeErasure,ERASURE_PROMPT,containsValue,factContainsValue,valueWords,mentionsTokens} from './erasure.js';
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
        // Degraded ingest: an ambiguous offline restore skips the operation; the
        // raw message stays searchable instead of failing the whole write.
        if (keys.size !== 1) continue;
        const f = candidates[0]!;
        const value = quote.match(/(?:is|是)\s*([^.!。！]+?)(?:\s+again)?[.!。！]*$/i)?.[1]?.trim();
        if (!value) continue;
        result.operations.push({type:'restore',target_ids:[],subject:f.subject,predicate:f.predicate,scope:f.scope,value,boundary:'value',source:{index,quote},reason:'Explicit new authorization'});
        result.facts.push({content:`${subject}: ${quote}`,subject:f.subject,predicate:f.predicate,value,scope:f.scope,kind:'fact',modality:'confirmed',cardinality:f.cardinality,time_text:'',valid_from:null,valid_to:null,sources:[{index,quote}],supersedes:[],depends_on:[]});
        continue;
      }
      if (span.intent==='forget' && (message.role === 'user'||named)) {
        const mirror=anaphoricMirror(span,body,index,result.operations,snapshot.facts);
        if(mirror){
          // "Just remove all of that." restates the command the same message
          // already made; it cannot bind alone, so it mirrors that operation's
          // target and keeps its own obligation covered.
          result.operations.push({type:'forget',target_ids:[...mirror.target_ids],subject:mirror.subject,predicate:mirror.predicate,scope:mirror.scope,value:mirror.value,boundary:mirror.boundary,source:{index,quote},reason:mirror.reason});
          continue;
        }
        const coveredIds=new Set(result.operations.filter(o=>o.type==='forget').flatMap(o=>o.target_ids));
        const narrative=narrativeForget(quote,snapshot.facts,req,index,coveredIds);
        if(narrative){
          const first=narrative.targets[0]!;
          result.operations.push({type:'forget',target_ids:narrative.targets.map(f=>f.id).filter(Boolean),subject:first.subject,predicate:first.predicate,scope:first.scope,value:narrative.value,boundary:'value',source:{index,quote},reason:narrative.descriptor||first.predicate});
          // News told alongside the command ("his doctor switched him to a new
          // medication, so you can discard…") precedes the imperative and stays
          // memorable; only the command itself is consumed by the forget span.
          const at=quote.search(IMPERATIVE);
          if(at>0){
            const prefix=quote.slice(0,at).replace(/[\s,;:—–]+$/,'').trim();
            if(prefix.split(/\s+/).length>=4&&/\b(?:he|she|they|his|her|him|them)\b/iu.test(prefix)&&!/[?？]$/.test(prefix))
              result.facts.push({content:`${subject}: ${prefix}`,subject,predicate:'experience',value:prefix,scope:'',kind:'event',modality:'confirmed',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,sources:[{index,quote:prefix}],supersedes:[],depends_on:[]});
          }
          continue;
        }
        const available=[...snapshot.facts.filter(f=>f.predicate!=='memory_operation'),...result.facts.map((f,i)=>({...f,id:`new:${i}`,state:'active' as const}))];
        const relevant = available.filter(f => f.state !== 'erased' && overlap(quote, `${f.subject} ${f.predicate} ${f.value} ${f.content}`) > .12);
        let valueExact = relevant.filter(f => f.value && canonical(quote).includes(canonical(f.value)));
        // A same-literal collision across different properties must not all die
        // with one named property: when the instruction names a property ("my
        // manager"), a value match alone cannot pull an independent slot into
        // the deletion. Bare-entity deletions keep their whole-record scope.
        if(new Set(valueExact.map(f=>`${f.subject}|${f.predicate}`)).size>1){
          const valueTokens=new Set(valueExact.flatMap(f=>tokens(f.value??'')));
          const named=valueExact.filter(f=>tokens(quote).some(t=>t.length>=2&&!valueTokens.has(t)&&tokens(`${f.subject} ${f.predicate}`).includes(t)));
          if(named.length&&named.length<valueExact.length)valueExact=named;
        }
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
          // Degraded ingest: unbindable offline operations are skipped, never 5xx.
          // Before skipping, a definite noun-phrase unit may still name the
          // target the property paths could not type.
          const definite=theNounForget(quote,snapshot.facts);
          if(definite){
            const first=definite.targets[0]!;
            result.operations.push({type:'forget',target_ids:definite.targets.map(f=>f.id).filter(Boolean),subject:first.subject,predicate:first.predicate,scope:first.scope,value:definite.value,boundary:'value',source:{index,quote},reason:'Definite phrase binding'});
            continue;
          }
          continue;
        }
        if(new Set(typed.map(f=>`${f.subject}|${f.scope}`)).size>1 || (new Set(typed.map(f => `${f.subject}|${f.predicate}`)).size > 1 && !valueExact.length)){
          // The untyped mix may still share one definite phrase unit.
          const definite=theNounForget(quote,snapshot.facts);
          if(definite){
            const first=definite.targets[0]!;
            result.operations.push({type:'forget',target_ids:definite.targets.map(f=>f.id).filter(Boolean),subject:first.subject,predicate:first.predicate,scope:first.scope,value:definite.value,boundary:'value',source:{index,quote},reason:'Definite phrase binding'});
            continue;
          }
          continue;
        }
        // Generic experience is a catch-all bucket, not a user property. A
        // property-wide deletion marker would erase unrelated experiences, so a
        // degraded no-track instruction binds by distinctive content word
        // ("anything about the tablet") instead. Unbindable wording still skips.
        if(!valueExact.length&&typed.some(f=>f.predicate==='experience')){
          const distinctive=new Set(tokens(quote).filter(t=>t.length>=4&&!operationStop.has(t)&&!/^(?:anything|everything|something|about|track|need|forget|remove|delete|不要再?|不用|不要)$/.test(t)));
          const bound=typed.filter(f=>f.predicate!=='experience'||distinctive.size&&tokens(f.content).some(t=>distinctive.has(t)));
          if(!bound.length||bound.some(f=>f.predicate!=='experience')||new Set(bound.map(f=>`${f.subject}|${f.scope}`)).size!==1)continue;
          const b=bound[0]!;
          result.operations.push({type:'forget',target_ids:bound.map(f=>f.id).filter(Boolean),subject:b.subject,predicate:b.predicate,scope:b.scope,value:b.value,boundary:'value',source:{index,quote},reason:'Degraded content-word binding for an untyped experience'});
          continue;
        }
        const first = typed[0]!,currentRelation=currentRelationRemoval(span);
        result.operations.push({ type: currentRelation ? 'retract' : 'forget', target_ids: typed.map(f => f.id).filter(Boolean), subject: first.subject, predicate: first.predicate, scope: first.scope, value: valueExact[0]?.value ?? '', boundary: currentRelation ? 'current_relation' : valueExact.length ? 'value' : 'property', source: { index, quote }, reason: propertyWords });
        continue;
      }
      if (span.intent==='blocked') continue;
      if (message.role !== 'user' && !named) continue;
      if (/^(hi|hello|thanks|thank you|ok|okay|你好|谢谢)[.!。！\s]*$/i.test(quote)) continue;
      let predicate = 'experience', value = quote, cardinality: 'single'|'multiple' = 'multiple';
      const patterns: [RegExp,string][] = [
        [/(?:I (?:now |currently )?live in|I am living in|I moved to|I relocated to|My (?:current |new )?city is|I(?:'m| am) (?:currently )?based in|我(?:现在)?住在|我搬到了)\s*([^.!。！;；,]+)/iu,'current_city'],
        [/(?:My (?:current |new )?(?:job )?(?:title|position|role) is|My title (?:has )?changed to|I (?:now |currently )?work as|I was promoted to|I got promoted to|I switched (?:jobs|roles) (?:to|and became)|I(?:'m| am) now a)\s*([^.!。！;；,]+)/iu,'job_title'],
        [/(?:My (?:new )?(?:manager|supervisor|boss) is|I (?:now )?report to|我的(?:新)?经理是)\s*([^.!。！;；,]+)/iu,'manager'],
        [/(?:My (?:new |old )?(?:door |access |security )?(?:code|PIN) is|我的(?:旧)?(?:门禁码|密码)是)\s*([^.!。！;；,]+)/iu,'access_code'],
        [/(?:I (?:really )?(?:like|love|enjoy)|我喜欢|我爱好)\s*([^.!。！;；,]+)/iu,'hobby'],
        [/(?:My (?:new )?salary is|My (?:hourly )?(?:rate|pay) is|I (?:now )?(?:earn|make)|我的工资是)\s*([^.!。！;；,]+)/iu,'salary'],
        [/(?:I (?:now )?work (?:at|for)|My (?:new )?(?:company|employer) is|我(?:现在)?在?.{0,6}工作)\s*([^.!。！;；,]+)/iu,'employer'],
      ];
      for (const [regex, key] of patterns) {
        const m = quote.match(regex);
        if (m) {
          predicate = key; cardinality = key === 'hobby' ? 'multiple' : 'single';
          // Update phrasing keeps only the new value: "is now Portland, not
          // Seattle anymore" stores Portland, never the retired value.
          value = m[1]!.trim().replace(/,?\s*(?:not|no longer|instead of|而不是|不再是)\b[^.!。！;；]*$/iu,'').replace(/^(?:now|currently)\s+/i,'').replace(/\s*\b(?:anymore|these days)\b\s*$/i,'').trim();
          break;
        }
      }
      const tentative = /\b(plan|planning|might|maybe|possibly|tentative|considering|thinking (?:about|of)|next month|next quarter|not finalized|not yet official|applied for)\b|计划|可能|打算|考虑|未确定|没确定/.test(quote.toLowerCase());
      // Generic question/tutorial text is not evidence of a personal state.
      // Third-person statements about named participants still are: "He moved
      // to a firm in Vancouver" is an update the user just authorized.
      if (predicate === 'experience' && !/\b(I|my|we|our)\b|我|我们/iu.test(quote) && !/\b(?:he|she|they|his|her|him|them)\b/iu.test(quote) && !/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(quote)) continue;
      if (predicate === 'experience' && /^(?:Can |Could |How |What |Why |Please explain)|[?？]$/i.test(quote)) continue;
      result.facts.push({ content: `${subject}: ${quote}`, subject, predicate, value, scope: '', kind: predicate === 'experience' ? 'event' : predicate === 'hobby' ? 'preference' : 'fact', modality: tentative ? 'tentative' : 'confirmed', cardinality, depends_on: [], time_text: quote.match(/yesterday|last \w+|next \w+|昨天|下个月|去年/i)?.[0] ?? '', valid_from: null, valid_to: null, sources: [{ index, quote }], supersedes: [] });
    }
  }
  return result;
}

const operationStop=new Set('i my me we our you your user assistant the a an is are was were be been it that this those these to of for from with on in at and or but not no do does did have has had please remember forget delete remove store memory information fact previous current actual old new value need want told say said again really completely'.split(' '));
// ---------- Narrative forget binding ----------
// A deletion instruction usually names a semantic unit, not a stored
// sentence: "please forget the Tucson detail", "you can discard the
// cetirizine detail", "remove him from my work contacts". Binding by that
// unit lets every echo — the instruction message, an assistant confirmation,
// a differently-worded replay — be suppressed at token granularity, while a
// retention clause ("Everything else about Portland should stay") fences its
// tokens off the deletion.
const IMPERATIVE=/(?:^|[,;:—–]\s*|\b(?:so|well|actually|now)\s+,?\s*)(?:you\s+(?:can|could|should|may|might)\s+(?:go\s+ahead\s+and\s+|just\s+|simply\s+)?|please\s+|kindly\s+)?(?:forget|remove|delete|discard|erase)\b/iu;
// A numeric reference without a named property may restate a prior command.
// Explicit selectors ("forget my salary 240") always use normal binding.
const NUMERIC_RETIREMENT=/\bI (?:do not|don't) (?:need|want) (?:that|this|the)\s+[$€£]?\d[\d,.]*(?:\s+(?:figure|number|amount|quote))?\s+(?:stored|remembered|kept)(?:\s+(?:here|by you))?\s+anymore\b/iu;
function forgetPhrase(quote:string):string{
  const m=quote.match(/\b(?:forget|remove|delete|discard|erase)\s+(?:the\s+|any\s+|that\s+|those\s+)?(?:(?:detail|part|info(?:rmation)?|record|entry|mention|note|idea|timeline|quote|figure)s?\s+(?:about|of|on|regarding)\s+)?([\p{L}\p{N}][^,;.!?—–]{1,80})/iu);
  // Only a named-information shape ("the Tucson detail", "the detail about
  // how many…") binds by phrase. Plain property deletions ("remove my
  // access code", "forget my manager Iris") keep their existing paths.
  if(!m||!/\b(?:detail|part|info(?:rmation)?|record|entry|mention|note|idea|timeline|quote|figure)s?\b/iu.test(m[0]))return '';
  let core=m[1]!.trim();
  core=core.replace(/^(?:my|our|their|his|her|the)\s+/iu,'').trim();
  core=core.replace(/\s+(?:entirely|completely|anymore|now|instead|please)$/iu,'').trim();
  core=core.replace(/\s+(?:detail|part|info(?:rmation)?|record|entry|mention|note|idea|timeline|quote|figure)s?$/iu,'').trim();
  // "the cetirizine from your records" names the value before a trailing
  // prepositional tail; the unit itself ends at "from".
  core=core.split(/\s+from\s+/iu)[0]!.trim();
  core=core.replace(/^(?:how\s+many|how\s+much)\s+/iu,'').trim();
  return core;
}
function narrativeForget(quote:string,facts:Fact[],req:AddRequest,index:number,coveredIds:Set<string>):{targets:Fact[];value:string;descriptor:string}|null{
  const phrase=forgetPhrase(quote);
  const pronoun=quote.match(/\b(?:remove|delete|erase)\s+(him|her|them)\b/iu)?.[1];
  if(!phrase&&!pronoun){
    // A verb-less retirement sentence ("I don't need that $240 figure stored
    // anymore") names its target by number when no imperative carries it.
    // Facts an earlier command in the same message already bound stay out:
    // a second operation on them would carry a different deletion boundary.
    if(!NUMERIC_RETIREMENT.test(quote))return null;
    const numeral=valueWords(quote).find(t=>/^\d{2,}$/.test(t));
    if(!numeral)return null;
    const matched=facts.filter(f=>f.state!=='erased'&&!coveredIds.has(f.id)&&mentionsTokens(`${f.content} ${f.value}`,[numeral]));
    if(!matched.length)return null;
    const first=matched[0]!;
    const targets=matched.filter(f=>f.subject===first.subject&&f.scope===first.scope);
    return targets.length?{targets,value:numeral,descriptor:''}:null;
  }
  const descriptor=quote.match(/\b(?:my|our)\s+([\p{L}\p{N} ]{1,40}?)(?=\s+(?:is\s+|are\s+)?(?:not\s+)?(?:stored|remembered|kept|on\s+file)\b|\s+anymore\b)/iu)?.[1]?.trim()??'';
  if(pronoun){
    // The pronoun resolves to the nearest named person in the chunk. Only
    // records that already existed carry the stale relation; news told in
    // this same message ("He moved to a firm in Vancouver") is an update,
    // not the removed membership, so the boundary stays on the old record.
    const context=req.messages.slice(Math.max(0,index-3),index+1).map(m=>m.content).join(' ');
    const name=[...context.matchAll(/\b([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})+)\b/g)].map(m=>m[1]!).pop();
    if(!name)return null;
    const matched=facts.filter(f=>f.state!=='erased'&&mentionsTokens(`${f.content} ${f.value}`,valueWords(name)));
    if(!matched.length)return null;
    // One operation must carry one subject/scope coordinate set.
    const first=matched[0]!;
    const targets=matched.filter(f=>f.subject===first.subject&&f.scope===first.scope);
    return targets.length?{targets,value:'',descriptor:''}:null;
  }
  if(phrase.split(/\s+/).length>8)return null;
  const protect=new Set<string>();
  for(const m of quote.matchAll(/\b(?:everything|all)(?:\s+else)?\s+about\s+([\p{L}\p{N} ]{1,30}?)(?=\s+(?:should\s+)?(?:stay|remain|be\s+kept|be\s+intact))/giu))for(const t of valueWords(m[1]!))protect.add(t);
  const matched=facts.filter(f=>f.state!=='erased'&&mentionsTokens(`${f.content} ${f.value}`,valueWords(phrase))&&!(protect.size&&valueWords(f.value).length>0&&valueWords(f.value).every(w=>protect.has(w))));
  if(!matched.length)return null;
  // One operation must carry one subject/scope coordinate set.
  const first=matched[0]!;
  const targets=matched.filter(f=>f.subject===first.subject&&f.scope===first.scope);
  if(!targets.length)return null;
  const valueFree=descriptor&&!mentionsTokens(descriptor,valueWords(phrase));
  return {targets,value:phrase,descriptor:valueFree?descriptor:''};
}
// A command sentence is often followed by an emphatic restatement whose only
// object is anaphoric ("The $58,500 figure, just remove it entirely.",
// "Just remove all of that."). Such a tail cannot name its own target; when
// the same message already bound one, the tail restates that exact command.
const ANAPHORIC_TAIL=/^(?:[\p{L}\p{N}$,.'’%()\s-]{1,40}?[,，]\s*)?(?:just\s+|simply\s+|please\s+|kindly\s+|now\s+|go\s+ahead\s+and\s+)*(?:remove|delete|erase|discard|forget)\s+(?:it|that|those|them|all\s+of\s+(?:that|it)|everything)\b(?:\s+(?:entirely|completely|anymore|now|too|as\s+well))*(?:\s+from\s+[^.!?。！]{1,60})?[.!?。！]?$/iu;
function anaphoricMirror(span:{start:number;quote:string},body:string,index:number,ops:Operation[],facts:Fact[]):Operation|null{
  if(!ops.length)return null;
  const spanNumbers=[...new Set(span.quote.match(/\d{2,}/g)??[])];
  const pure=ANAPHORIC_TAIL.test(span.quote.replace(/\s+/g,' ').trim());
  if(!pure&&!NUMERIC_RETIREMENT.test(span.quote))return null;
  // A pure anaphoric tail restates the nearest earlier command; a numbered
  // sentence mirrors only an operation whose erased target or value echoes
  // that number, so a distinct named command never inherits a different
  // target.
  let best:Operation|null=null;let bestKey='';
  for(const o of ops){
    if(o.type!=='forget'||o.source.index!==index||!(o.value||o.boundary==='property'))continue;
    const pos=body.indexOf(o.source.quote);
    if(pos<0||pos+o.source.quote.length>span.start)continue;
    const targetText=o.target_ids.map(id=>facts.find(f=>f.id===id)).map(f=>f?`${f.content} ${f.value}`:'').join(' ');
    // Token-exact only: "240" must never echo a "1240" target — a substring
    // of one number is not the same number as the command named.
    const echoed=spanNumbers.some(n=>valueWords(`${o.value??''} ${o.source.quote} ${targetText}`).includes(n));
    if(!pure&&!echoed)continue;
    const key=`${echoed?1:0}${String(pos).padStart(6,'0')}`;
    if(key>bestKey){best=o;bestKey=key;}
  }
  return best;
}
// Last-chance binding for a definite noun-phrase unit the wrapper gate does
// not name ("forget the L6 comp band floor I mentioned"). It runs only after
// the ordinary property paths found nothing, so the alternative was a
// rejected write anyway; possessive property deletions never reach it.
function theNounForget(quote:string,facts:Fact[]):{targets:Fact[];value:string}|null{
  const m=quote.match(/\b(?:forget|remove|delete|discard|erase)\s+the\s+([\p{L}\p{N}][^,;.!?—–]{1,60})/iu);
  if(!m)return null;
  let core=m[1]!.trim();
  if(/\b(?:my|our|his|her|their|your)\b/iu.test(core))return null;
  core=core.replace(/\s+\bI\s+(?:mentioned|said|told you|shared|noted|added)\b.*$/iu,'').trim();
  core=core.split(/\s+(?:that|which)\s+(?:I|we|you)\b/iu)[0]!.trim();
  const words=core.split(/\s+/);
  if(words.length<2||words.length>8)return null;
  const matched=facts.filter(f=>f.state!=='erased'&&mentionsTokens(`${f.content} ${f.value}`,valueWords(core)));
  if(!matched.length)return null;
  const first=matched[0]!;
  const targets=matched.filter(f=>f.subject===first.subject&&f.scope===first.scope);
  return targets.length?{targets,value:core}:null;
}
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
  if(source.start!==undefined){
    if(sourceMatches(source,req))return;
    // Model-authored patches can miscount a numeric offset. Resolve only one
    // exact occurrence in the SAME message; no fuzzy quote or speaker change.
    const text=req.messages[source.index]?.content,start=text?.indexOf(source.quote)??-1;
    if(source.quote.length&&start>=0&&text!.indexOf(source.quote,start+1)<0)source.start=start;
    return;
  }
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
  // Capability failures (network, timeout, malformed output) degrade to
  // deterministic plans; a semantic refusal from a healthy model stays a
  // rejection — over-erasing after an explicit "uncertain" is its own hazard.
  private static semanticRefusal(error: unknown): boolean {
    return error instanceof ServiceError && error.code === 'EVIDENCE_VALIDATION';
  }

  async prepare(req: AddRequest, snapshot: Snapshot, signal: AbortSignal): Promise<Prepared> {
    addSchema.parse(req);
    // Official messages may omit every timestamp. Synthetic ordering stamps keep
    // lifecycle and ingestion working; flagged facts stay time_basis='ordering'.
    const sourceTimestamped=req.messages.map(m=>m.timestamp!==undefined);
    normalizeMissingTimestamps(req,snapshot);
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
    const chronology=messageAnchors(req,snapshot.anchor,sourceTimestamped);const anchor=chronology.last;
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
      const relevant=ordered.map((f,i)=>({id:`m${i}`,content:f.content,subject:f.subject,predicate:f.predicate,value:f.value,scope:f.scope,...(f.scopeHash?{scopeHash:f.scopeHash}:{}),state:f.state,modality:f.modality}));
      const visibleIds=new Set(ordered.map(f=>f.id));let extraCandidates=0;
      const expandTargets=(proposal:Extraction):void=>{
        // The checker can see a related historical record outside the initial
        // retrieval window. Give repair a usable alias for it under the same
        // existing 32-record expansion limit, before generic binding neighbors.
        const related=new Set(forgetScopeContext(proposal,snapshot.facts).flatMap(c=>c.facts.map(f=>f.id)));
        for(const f of [...snapshot.facts.filter(f=>related.has(f.id)),...proposal.operations.flatMap(o=>bindingCandidates(o,snapshot.facts))]){
          if(visibleIds.has(f.id)||extraCandidates>=32)continue;
          const id=`m${aliases.size}`;aliases.set(id,f.id);visibleIds.add(f.id);extraCandidates++;
          relevant.push({id,content:f.content,subject:f.subject,predicate:f.predicate,value:f.value,scope:f.scope,...(f.scopeHash?{scopeHash:f.scopeHash}:{}),state:f.state,modality:f.modality});
        }
      };
      const repairForgetContext=(proposal:Extraction)=>{
        const labels=new Map([...aliases].map(([label,id])=>[id,label]));
        proposal.facts.forEach((_,index)=>labels.set(factId(req,index),`new:${index}`));
        const resolved=structuredClone(proposal);
        for(const op of resolved.operations)op.target_ids=op.target_ids.map(id=>aliases.get(id)??(/^new:\d+$/.test(id)?factId(req,Number(id.slice(4))):id));
        return forgetScopeContext(resolved,[...snapshot.facts,...proposalFacts(proposal,req)]).map(c=>({...c,
          facts:c.facts.flatMap(f=>{const id=labels.get(f.id);return id?[{...f,id}]:[];})}));
      };
      const references=this.config.extractionFormat==='source_refs',grouped=this.config.extractionFormat!=='flat';
      const extractionPrompt=(references?SOURCE_REFERENCE_PROMPT:grouped?GROUPED_EXTRACTION_PROMPT:EXTRACTION_PROMPT)+(this.config.sourceFirst?SOURCE_FIRST_EXTRACTION_PROMPT:'')+(sourceActions.length?'\nRESOLVED_SOURCE_ACTIONS have a separate independently verified source removal plan that will commit atomically with your facts. Do not produce duplicate fact-ID operations for those exact instructions, and never bind them to unrelated existing facts. Preserve remaining corrected user facts and all other real instructions. Do not turn a rejected assistant value into a negative fact such as "user does not use REJECTED_VALUE"; that still stores the detail the user rejected. Generic rejection statements need no separate fact, while independent human preferences remain memorable. Do not cite any cut interval as a fact source; select the exact surviving user subclause if its whole sentence overlaps a cut.':'');
      const user=JSON.stringify({...(sourceActions.length?{RESOLVED_SOURCE_ACTIONS:sourceActions}:{}),...(grouped?{EXTRACTION_PROTOCOL:references?SOURCE_REFERENCE_PROTOCOL:GROUPED_EXTRACTION_PROTOCOL,PARTICIPANT_INDEX:participantIndices(req)}:{}),OBSERVATION_DATE:anchor,EXISTING_FACTS:relevant,CONTEXT_ONLY:snapshot.tail.map(m=>({role:m.role,content:m.content})),NEW_MESSAGES:references?sourceReferenceMessages(req):req.messages.map((m,index)=>({index,...m}))});
      // Reserve time for grounded fallback, local embedding and atomic commit.
      // This inner budget never extends the caller's absolute request deadline.
      let semanticallyRejected=false,unresolvedOperationIntent=false;const verificationSession=new VerificationSession(this.config.incrementalVerification);
      try {
        let issue='';let failedProposal:unknown;let repairScope:RepairScope|undefined;let semanticRepairFindings:string[]=[];let accepted:Extraction|undefined;
        for(let attempt=0;attempt<=this.config.maxRepairRounds;attempt++){
          const prior=extractionSchema.safeParse(failedProposal);
          const patchMode=!!issue&&prior.success;
          const scope=repairScope??{fact_indices:prior.success?prior.data.facts.map((_,i)=>i):[],operation_indices:prior.success?prior.data.operations.map((_,i)=>i):[],source_indices:req.messages.map((_,i)=>i)};
          const rejectedFindings=semanticRepairFindings;semanticRepairFindings=[];
          // A scope belongs to one rejected proposal. Consume it before the next
          // validation pass, whose indices may include newly appended facts.
          repairScope=undefined;
          const repairSystem=issue?(patchMode?PATCH_PROMPT:'\nRepair the malformed proposal; return the complete extraction schema.'):'';
          // Do not ask a scoped repair to append an operation from another
          // message. Remaining obligations are checked again after this patch.
          const missingInstructions=patchMode?pendingForget(prior.data!).filter(({index})=>scope.source_indices.includes(index)).map(({index,span})=>({index,start:span.start,end:span.end,quote:span.quote})):[];
          const atRiskInstructions=patchMode?retirementInstructionsAtRisk(req,prior.data!,rejectedFindings,scope,sourceActions):[];
          const repairInput=issue?JSON.stringify({...JSON.parse(user),...(grouped&&patchMode?{EXTRACTION_PROTOCOL:'flat-patch-v1',NEW_MESSAGES:req.messages.map((m,index)=>({index,...m}))}:{}),EXISTING_FACTS:relevant,REPAIR_FEEDBACK:issue,FAILED_PROPOSAL:patchMode?indexedProposal(prior.data!):failedProposal,...(missingInstructions.length?{MISSING_OPERATION_INSTRUCTIONS:missingInstructions}:{}),...(atRiskInstructions.length?{AT_RISK_OPERATION_INSTRUCTIONS:atRiskInstructions}:{}),...(patchMode?{REPAIR_SCOPE:scope,REPLACEMENT_TARGET_GROUPS:replacementTargetGroups(prior.data!,relevant),FORGET_SCOPE_CONTEXT:repairForgetContext(prior.data!),FACT_RULES:EXTRACTION_PROMPT}:{})}):user;
          const output=!issue&&grouped&&this.config.extractionWorkers>1&&participantIndices(req).length>=4
            ?await prepareExtractionShards(req,extractionPrompt,user,this.config.extractionWorkers,modelSignal,(prompt,input,s,extraction_shard)=>this.models.json(prompt,input,s,{purpose:'extraction',trace:traceIdentity,extraction_shard}))
            :await this.models.json(patchMode?PATCH_PROMPT+(atRiskInstructions.length?SEMANTIC_RETIREMENT_REPAIR_PROMPT:''):extractionPrompt+repairSystem,repairInput,modelSignal,{purpose:issue?'repair':'extraction',trace:traceIdentity});
          let raw:unknown=output;
          if(grouped&&!patchMode){
            try{raw=references?decodeSourceReferences(output,req):decodeGroupedExtraction(output,req);}
            catch(error){
              failedProposal=output;
              const detail=error instanceof Error?error.message:'Invalid grouped extraction';
              if(attempt===this.config.maxRepairRounds)throw new ServiceError('EVIDENCE_VALIDATION','Grouped extraction failed after bounded repair rounds: '+detail);
              issue=detail+'. Return the complete message_groups schema and preserve every participant index. Every group requires message_index, facts and operations, including explicit empty arrays; omit default-valued fact metadata only. Future plans use kind="event" and modality="tentative". Preserve all supported facts and actual operations.';continue;
            }
          }
          if(patchMode){
            try{raw=applyRepair(prior.data!,output,scope);}
            catch(error){
              if(issue.startsWith('Unknown target')||issue.startsWith('Operation target binding'))throw new ServiceError('OPERATION_TARGET','Invalid target/scope repair patch');
              if(error instanceof RepairScopeError&&attempt<this.config.maxRepairRounds){
                // Discard the invalid patch. Preserve the rejected proposal and
                // its exact scope, then spend only an already-allowed attempt.
                repairScope=scope;
                semanticRepairFindings=rejectedFindings;
                issue+=' Patch rejected: '+error.message+'. Retry within the unchanged REPAIR_SCOPE; do not add sources outside that scope or the edited fact\'s original sources.';
                continue;
              }
              throw error;
            }
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
            unresolvedOperationIntent=true;
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
          const badScopes=operationBindingProblems(valid.data,bindingPool,id=>id,id=>valid.data.facts.findIndex((_,i)=>factId(req,i)===id));
          // Resolve a copy to expose independent selector failures in the same
          // bounded patch as scope errors. Do not silently bind the failed proposal
          // or grant permission to edit valid sibling operations.
          const selectorIssues=bindOperationSelectors(structuredClone(valid.data),req,snapshot).filter(issue=>!badScopes.some(o=>o.operation===issue.operation));
          const badReplacements=valid.data.facts.flatMap((f,index)=>f.supersedes.some(id=>{const old=bindingPool.find(t=>t.id===id);return old&&!replacementMatches(f,old);})?[index]:[]);
          if(badScopes.length||badReplacements.length||selectorIssues.length){
            expandTargets(valid.data);
            const facts=new Set([...badReplacements,...invalid.map(f=>f.fact),...badScopes.flatMap(o=>o.selected_targets.map(f=>f.proposal_index).filter(i=>i>=0))]);
            const operations=new Set([...badScopes.map(o=>o.operation),...selectorIssues.map(o=>o.operation),...valid.data.operations.flatMap((o,index)=>badOps.includes(o)?[index]:[]),...unauthorized]);
            repairScope=scopeForFindings(valid.data,[...facts].map(i=>`fact ${i}: Invalid binding or source`).concat([...operations].map(i=>`operation ${i}: Invalid binding or source`)));
          }
          if(badScopes.length||badReplacements.length||selectorIssues.length){
            const labels=new Map([...aliases].map(([alias,id])=>[id,alias]));valid.data.facts.forEach((_,i)=>labels.set(factId(req,i),`new:${i}`));
            const operation_details=operationBindingProblems(valid.data,bindingPool,id=>labels.get(id)??id,id=>valid.data.facts.findIndex((_,i)=>factId(req,i)===id));
            const replacement_details=replacementBindingProblems(valid.data,bindingPool,id=>labels.get(id)??id);
            issue='Operation target binding: subject, property or scope does not match its selected targets. '+JSON.stringify({operations:operation_details,selector_issues:selectorIssues,replacement_facts:badReplacements,replacement_details})+sourceFeedback+'. Reuse matching existing fields only if that record is actually the requested target. For unresolved selectors, select actual targets from EXISTING_FACTS or earlier new:N facts; a missing target is not an executed operation. For same-chunk transient targets, proposal_index identifies the editable fact slot. If the user forgets multiple properties of one concrete entity, give those transient facts that same entity scope when their original statements support it; preserve unrelated devices. Alternatively split operations only when the source actually authorizes each distinct scope. Changing sources alone does not fix a scope mismatch. Never rename an existing or unrelated record to pass validation. If correcting an assistant claim that was never stored, keep the grounded USER facts but emit no operation or supersedes reference against an unrelated record. Cite the user correction itself, not the assistant restatement. Return the corrected object.';continue;}
          if(unauthorized.length){
            unresolvedOperationIntent=true;
            const findings=unauthorized.map(index=>`operation ${index}: The cited source is not an authorizing user deletion instruction.`);
            repairScope=scopeForFindings(valid.data,findings);
            issue=JSON.stringify(findings)+' Repair only these operations; preserve valid sibling operations and unrelated facts. If NEW_MESSAGES contains an actual deletion instruction for this same target, replace the source with its exact authorizing span and preserve the target fields. A reason for removal is not itself a command. If no actual instruction authorizes that target, remove only the unsupported operation. Do not borrow an unrelated command or combine targets with different properties/scopes. Source repair still requires independent target and semantic verification.';
            continue;
          }
          if(valid.data.operations.some(o=>!groundedOperation(o,req,[...snapshot.facts,...proposalFacts(valid.data,req)]))){issue='An operation targets a fact with no matching topic in the new user request or preceding context. Do not delete unrelated memories. If the user rejects a never-stored assistant claim, return no operation. Recheck targets and return full JSON.';continue;}
          if(pendingForget(valid.data).length){unresolvedOperationIntent=true;issue='Direct retirement instructions remain uncovered. MISSING_OPERATION_INSTRUCTIONS gives each exact original message index, span and quote. Bind those instructions to their actual tenant-local targets, preserving valid sibling operations and unrelated facts. A distinct listed instruction may independently repeat the same target; cite its own witness and keep its subject, property, value and boundary grounded. Do not invent deletion for nearby advice or merge separate instructions into one broad source quote.';continue;}
          unresolvedOperationIntent=false;
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
          if(findings.length){expandTargets(valid.data);semanticallyRejected=true;repairScope=scopeForFindings(valid.data,findings);semanticRepairFindings=findings;issue='Semantic verification rejected the proposal. Repair these specific failures while preserving supported unrelated facts. '+JSON.stringify(findings)+'. Return the complete corrected object.';continue;}
          accepted=valid.data;break;
        }
        if(!accepted&&issue.startsWith('Unknown target'))throw new ServiceError('OPERATION_TARGET','Unknown memory operation target after repair');
        if(!accepted&&issue.startsWith('Operation target binding'))throw new ServiceError('OPERATION_TARGET','Unresolved operation subject, property or scope after repair');
        if(!accepted&&issue.startsWith('Semantic verification'))throw new ServiceError('EVIDENCE_VALIDATION','Evidence still fails semantic verification after repair');
        if(!accepted&&issue.startsWith('Operation effect mismatch'))throw new ServiceError('OPERATION_INTENT','Retirement still has the wrong operation effect after repair');
        if(!accepted&&unresolvedOperationIntent)throw new ServiceError('OPERATION_INTENT','Unresolved retirement instruction or unauthorized operation after bounded repair');
        if(!accepted)throw new ServiceError('EXTRACTION_SCHEMA','Could not validate structured evidence and exact sources');
        parsed=accepted;
        if(this.config.sourceFirst)sourceCoverageRows=verificationSession.acceptedSourceCoverage(req,parsed);
      } catch (error) {
        if (signal.aborted) throw error;
        // Semantic refusals from a healthy model fail closed: binding failures
        // (retirement contracts) and evidence rejections must surface, never
        // silently degrade. Everything else here is a capability failure —
        // provider unreachable, protocol budget exhausted, malformed output —
        // and the evaluator does not replay failed adds, so ordinary mode
        // commits the deterministic offline plan with an auditable marker.
        if (error instanceof ServiceError && ['OPERATION_TARGET','OPERATION_SCOPE','OPERATION_INTENT','EVIDENCE_VALIDATION'].includes(error.code)) throw error;
        if(unresolvedOperationIntent)throw new ServiceError('OPERATION_INTENT','Unresolved retirement instruction or unauthorized operation could not be repaired');
        if(semanticallyRejected)throw new ServiceError('EVIDENCE_VALIDATION',modelSignal.aborted?'A rejected proposal could not be repaired before the request deadline':'A rejected proposal could not be repaired after a model or protocol failure');
        // Source-first (v10) commits additionally require independently verified
        // coverage that offline extraction cannot produce; that representation
        // keeps its strict contract (see the coverage assertion below). Release
        // configurations therefore stay on the degrade-covered v5 pipeline.
        if(this.config.sourceFirst){
          if(error instanceof ServiceError)throw error;
          throw new ServiceError('EXTRACTION_UNAVAILABLE','Source-first extraction did not complete within the model/protocol budget');
        }
        degraded.push('extraction_offline'); parsed = offlineExtract(req,snapshot);
      }
    }
    const validSource = (s:{index:number;quote:string;start?:number}): boolean => sourceMatches(s,req);
    if (parsed.operations.some(o => !validSource(o.source) || !humanOperation(o,req))) throw new ServiceError('OPERATION_SOURCE','Operation lacks valid user evidence');
    // Reject nonexistent operation targets; the model may only bind tenant-local evidence.
    const localIds=bindNewFactHandles(parsed,req);
    if(bindOperationSelectors(parsed,req,snapshot).length)throw new ServiceError('OPERATION_TARGET','Unresolved operation target before commit');
    // An unresolved retirement instruction fails closed: HTTP success must mean
    // the requested mutation took effect. Only capability failures (model
    // outage, malformed output) degrade to deterministic plans; a command that
    // cannot bind is a client-visible rejection, never a silent no-op.
    if(!this.config.experimental?.rawOnly&&pendingForget(parsed).length)throw new ServiceError('OPERATION_INTENT','Unresolved memory operation after bounded recovery');
    const known = new Set([...snapshot.facts.map(f=>f.id),...localIds]);
    if (parsed.operations.some(o=>o.target_ids.some(id=>!known.has(id)))) throw new ServiceError('OPERATION_TARGET','Unknown memory operation target');
    const messages = req.messages.map((m,i)=>({ ...m,id:hash(`${req.user_id}\0${req.request_id}\0${i}`),session_id:req.session_id,ordinal:i,external_id:m.content.match(/\[Source id: ([^\]]+)\]/)?.[1],searchable:true,partial:partialSources.has(i),time_basis:(chronology.anchors[i]?.includes('synthetic ordering')||!sourceTimestamped[i]?'ordering':'source') as 'ordering'|'source' }));
    const facts: Fact[] = [];
    for (const [i,f] of parsed.facts.entries()) {
      if (f.sources.some(s=>!validSource(s))) throw new ServiceError('FACT_SOURCE','Fact lacks verbatim source evidence');
      if ([...f.supersedes,...f.depends_on].some(id=>!known.has(id))) throw new ServiceError('FACT_TARGET','Unknown superseded fact');
      const src = f.sources.map(s=>messages[s.index]!);
      const eventTime=normalizeFactTime(f,req,chronology.anchors);
      const {sources:proposalSources,...attributes}=f;
      if(!this.config.experimental?.rawOnly&&src.every(m=>m.role!=='user'&&!speakerPrefix(m.content.replace(/\[Session time:[^\]]*\]/g,'').trim())))f.modality='quoted';
      facts.push({ ...attributes,event_time:eventTime,source_spans:sourceSpans(f,messages),modality:f.modality,time_basis:src[0]!.time_basis,id:factId(req,i),source_ids:[...new Set(src.map(m=>m.id))],source_quotes:proposalSources.map(s=>s.quote),created_at:src[0]!.timestamp!,observed_at:src[0]!.timestamp!,state:'active',vector:null,entities:entities(f.content),revision:snapshot.revision+1 });
    }
    // Pattern cards aggregate this add's facts with the tenant's prior facts
    // (S1 reflection layer / P2 list materialization). Plain content adds
    // only: operation adds must not rewrite cards, the source-operation
    // pipeline keeps its own bookkeeping, and the lifecycle experiment's
    // strip pass would break depends_on/supersedes card semantics.
    if(this.config.experimental?.aggregate&&!parsed.operations.length&&!sourceOperationPlan&&this.config.experimental?.lifecycle!==false)
      facts.push(...aggregatePatterns(req,snapshot,facts,messages));
    if(sourceOperationPlan&&this.config.sourceOperationRouting)validateSourceRoutePlan(sourceOperationPlan,sourceOperationWork(req,snapshot.facts,sourceHistory));
    else if(sourceOperationPlan&&this.config.sourceOperationBatches&&sourceOperationWork(req,snapshot.facts,sourceHistory).enabled)validateSourceBatchPlan(sourceOperationPlan,sourceOperationWork(req,snapshot.facts,sourceHistory));
    if(sourceOperationPlan)validateSourceOperations(sourceOperationPlan,req,snapshot.facts,facts,messages,sourceHistory);
    const useErasure=this.config.erasureBinding&&!this.config.experimental?.rawOnly;
    let erasurePlan:Prepared['erasurePlan'];
    if(useErasure){
      const work=erasureWork(req,snapshot.facts,facts,parsed.operations,snapshot.erasureBoundaries??[],this.config.sourceErasure?[...(snapshot.erasureSources??[]),...messages]:[]);
      if(work.candidates.length){
        // Write success over write perfection, but never a silent independent
        // deletion: without semantic binding only same-slot echoes and records
        // sharing the erased target's sources die with it. A cross-slot record
        // survives the outage as a retained (unverified) neighbor; the degraded
        // marker keeps that choice auditable instead of guessing independence.
        const deterministic=():Prepared['erasurePlan']=>({fingerprint:work.fingerprint,decisions:[...work.automatic,...work.candidates.map(c=>{
          const quote=c.fact.source_quotes.find(q=>q.trim());
          if(!quote)throw new ServiceError('EVIDENCE_VALIDATION','Degraded erasure candidate lacks a witness quote');
          const auth=c.authorization as {target?:{source_ids:string[]}}|null|undefined;
          const linked=sameSlot(c.fact,c.boundary)||(auth?.target?.source_ids.some(id=>c.fact.source_ids.includes(id))??false);
          if(linked)return {fact_id:c.fact_id,key:c.key,effect:'erase' as const,quote};
          // A retained neighbor must witness the colliding value itself; if no
          // quote can, the write stays committable by erasing conservatively.
          const witnessed=factContainsValue(c.fact,c.boundary)?c.fact.source_quotes.find(q=>containsValue(q,c.boundary))??null:null;
          if(!witnessed)return {fact_id:c.fact_id,key:c.key,effect:'erase' as const,quote};
          return {fact_id:c.fact_id,key:c.key,effect:'retain' as const,quote:witnessed};
        })]});
        let fallback=this.config.mode!=='enhanced'||degraded.includes('extraction_offline');
        if(!fallback){
          try{
            const raw=await this.models.json(ERASURE_PROMPT,JSON.stringify(erasureInput(req,snapshot.tail,work,this.config.sourceErasure)),modelSignal,{purpose:'erasure_binding',trace:traceIdentity});
            erasurePlan=decodeErasure(raw,work);
          }catch(error){if(signal.aborted||Extractor.semanticRefusal(error))throw error;fallback=true;}
        }
        if(fallback&&!erasurePlan){erasurePlan=deterministic();degraded.push('erasure_binding_deterministic');}
      }else erasurePlan={fingerprint:work.fingerprint,decisions:work.automatic};
    }
    let sourceErasurePlan:Prepared['sourceErasurePlan'];
    if(useErasure&&this.config.sourceErasure){
      const work=sourceErasureWork(req,snapshot.facts,facts,parsed.operations,snapshot.erasureBoundaries??[],snapshot.erasureSources??[],messages,erasurePlan?.decisions.filter(d=>d.effect==='erase').map(d=>d.fact_id)??[]);
      if(work.candidates.length){
        // Lexical nomination is not deletion authorization. Without independent
        // source review, neither an erase nor a retain partition is certified.
        let fallback=this.config.mode!=='enhanced'||degraded.includes('extraction_offline');
        if(!fallback){
          try{
            sourceErasurePlan=await (this.config.sourceErasureGrouped?executeGroupedSourceErasure:executeSourceErasure)(work,this.config.sourceErasureWorkers,modelSignal,(system,input,s,purpose,source_erasure_batch)=>this.models.json(system,input,s,{purpose,trace:traceIdentity,...(source_erasure_batch?{source_erasure_batch}:{})}));
          }catch(error){if(signal.aborted||Extractor.semanticRefusal(error))throw error;fallback=true;sourceErasurePlan=undefined;}
        }
        if(fallback&&!sourceErasurePlan)sourceErasurePlan=conservativeSourceErasureFallback(work);
      }else sourceErasurePlan={fingerprint:work.fingerprint,decisions:[]};
    }
    let transitionPlan:Prepared['transitionPlan'];
    if(useErasure&&this.config.semanticTransitions){
      const work=transitionWork(req,snapshot.facts,facts,parsed.operations);
      if(work.candidates.length){
        // Degraded deterministic transitions mark every pair uncertain: both
        // statements stay visible and conflicted instead of guessing a
        // replacement or losing the whole write.
        const deterministic=():Prepared['transitionPlan']=>({fingerprint:work.fingerprint,decisions:work.candidates.map((c,index)=>{
          if(!c.old.source_quotes[0]?.trim()||!c.incoming.source_quotes[0]?.trim())throw new ServiceError('EVIDENCE_VALIDATION','Degraded transition candidate lacks a witness quote');
          return {index,relation:'uncertain' as const,old_source_slot:0,new_source_slot:0,reason:'Degraded deterministic fallback: relation unresolved without semantic verification'};
        })});
        let fallback=this.config.mode!=='enhanced'||degraded.includes('extraction_offline');
        if(!fallback){
          try{
            const raw=await this.models.json(TRANSITION_PROMPT,JSON.stringify(transitionInput(req,work)),modelSignal,{purpose:'state_transition',trace:traceIdentity});
            transitionPlan=decodeTransitions(raw,work);
          }catch(error){if(signal.aborted||Extractor.semanticRefusal(error))throw error;fallback=true;}
        }
        if(fallback&&!transitionPlan){transitionPlan=deterministic();degraded.push('state_transition_deterministic');}
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
    const sourceFormat=sourceFormatFor(this.config);
    const prepared:Prepared={ ...(sourceOperationPlan?{sourceOperationPlan}:{}),facts,operations:parsed.operations,messages,passages,sourceFormat,...(erasurePlan?{erasurePlan}:{}),...(sourceErasurePlan?{sourceErasurePlan}:{}),...(transitionPlan?{transitionPlan}:{}),anchor,degraded,embeddingSpace:this.config.embeddingSpace };
    if(this.config.sourceFirst){if(!sourceCoverageRows)throw new ServiceError('EVIDENCE_VALIDATION','Source-first write lacks independent coverage');prepared.sourceCoveragePlan=makeSourceCoveragePlan(req,prepared,sourceCoverageRows);}
    return prepared;
  }
}

// Deterministic cross-session aggregation of multiple-cardinality facts into
// pattern cards (`kind:'reflection'`, `modality:'inferred'`): one mechanism
// serving the MemOps Reflect summaries and cat1 list completeness. The card
// embeds every distinct member value verbatim, so one evidence row answers
// "what have I shared about X" style queries; it retires on value-set change
// (supersedes), disappears with a forgotten member value (depends_on
// propagation, leak-marker replay guard and inferred-source redaction in the
// commit path), and is re-derived from surviving members by the next content
// add. No model is involved: the offline and enhanced forms produce it alike.
function aggregatePatterns(req:AddRequest,snapshot:Snapshot,currentFacts:Fact[],messages:StoredMessage[]):Fact[]{
  const pool=[...currentFacts,...snapshot.facts].filter(f=>f.cardinality==='multiple'&&f.state==='active'&&f.modality==='confirmed'&&(f.kind==='fact'||f.kind==='preference'));
  const currentIds=new Set(currentFacts.map(f=>f.id));
  const groups=new Map<string,Fact[]>();
  for(const f of pool){const key=slot(f);const list=groups.get(key)??[];list.push(f);groups.set(key,list);}
  const anchor=messages[messages.length-1]!;
  const cards:Fact[]=[];
  for(const [key,members] of groups){
    // Cards (and their reflection events) fire only when this add extended
    // the family; untouched families keep their existing card untouched.
    if(!members.some(f=>currentIds.has(f.id)))continue;
    const byValue=new Map<string,Fact[]>();
    for(const m of members){const v=canonical(m.value||m.content);const list=byValue.get(v)??[];list.push(m);byValue.set(v,list);}
    if(byValue.size<2)continue;
    const values=[...byValue.keys()].sort();
    const displays:string[]=[];const depends_on:string[]=[];
    for(const v of values){
      const carriers=byValue.get(v)!;
      // One representative per distinct value, preferring a snapshot carrier:
      // its id survives this request's duplicate merges, keeping depends_on
      // free of dead ids the retrieval prune would hide the card behind.
      const rep=carriers.find(f=>!currentIds.has(f.id))??carriers[0]!;
      const display=rep.value.trim()||rep.content;
      if(!displays.includes(display)){displays.push(display);depends_on.push(rep.id);}
    }
    const value=displays.join(', ');
    const oldCard=snapshot.facts.find(f=>f.kind==='reflection'&&f.state==='active'&&slot(f)===key);
    if(oldCard&&canonical(oldCard.value)===canonical(value))continue;
    const content=`[Aggregated pattern] ${members[0]!.subject}: ${propertyFamily(members[0]!.predicate)} — ${value} (${members.length} statements)`;
    // This add's sources first so the reflection event can bind a fresh
    // message even when prior sessions contributed many source ids.
    const sourceIds=[...new Set([...members.filter(m=>currentIds.has(m.id)).flatMap(m=>m.source_ids),...members.flatMap(m=>m.source_ids)])].slice(0,16);
    cards.push({content,subject:members[0]!.subject,predicate:propertyFamily(members[0]!.predicate),value,scope:members[0]!.scope,
      kind:'reflection',modality:'inferred',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,
      depends_on,supersedes:oldCard?[oldCard.id]:[],source_spans:[],time_basis:anchor.time_basis??'source',
      id:'pattern-'+hash(`${req.user_id}\0${key}\0${canonical(value)}`),source_ids:sourceIds,source_quotes:[],
      created_at:anchor.timestamp!,observed_at:anchor.timestamp!,state:'active',vector:null,entities:entities(content),revision:snapshot.revision+1});
  }
  return cards;
}
