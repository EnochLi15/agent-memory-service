import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { Models } from './models.js';
import { EXTRACTION_PROMPT } from './prompts.js';
import { addSchema, extractionSchema, canonical, ServiceError, type AddRequest, type Extraction, type ExtractedFact, type Fact, type Snapshot, type Prepared, type Operation } from './types.js';
import { entities, overlap, tokens } from './text.js';

export function hash(s: string): string { return createHash('sha256').update(s).digest('hex'); }
import {realControl,instructionSpans,authorizesForget,missingForgetObligations} from './operation-intent.js';

export function offlineExtract(req: AddRequest, snapshot: Snapshot): Extraction {
  const result: Extraction = { facts: [], operations: [] };
  for (const [index, message] of req.messages.entries()) {
    const clean = message.content.replace(/\[Session time:[^\]]*\]/g, '').trim();
    const named = /\b(?:said|says|quoted)\b/i.test(clean.split(':',1)[0]??'')?null:clean.match(/^([\p{L}][\p{L} .'-]{0,40}):\s*/u);
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
        const available=[...snapshot.facts,...result.facts.map((f,i)=>({...f,id:`new:${i}`,state:'active' as const}))];
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
        const first = typed[0]!;
        result.operations.push({ type: /current colleague|current contact|当前同事|当前联系人/i.test(quote) ? 'retract' : 'forget', target_ids: typed.map(f => f.id).filter(Boolean), subject: first.subject, predicate: first.predicate, scope: first.scope, value: valueExact[0]?.value ?? '', boundary: valueExact.length ? 'value' : 'property', source: { index, quote }, reason: propertyWords });
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
  const m=req.messages[o.source.index];if(!m)return false;if(m.role==='user')return true;
  const name=m.content.replace(/\[Session time:[^\]]*\]/g,'').trim().match(/^([\p{L}][\p{L} .'-]{0,40}):\s*/u)?.[1];
  return !!name && (canonical(o.subject)===canonical(name)||canonical(o.subject).startsWith(canonical(name)+"'s "));
}
function resolveSource(source:{index:number;quote:string},req:AddRequest):void {
  // Correct unambiguous index/copying mistakes without accepting paraphrased evidence.
  if(req.messages[source.index]?.content.includes(source.quote))return;
  const escaped=source.quote.trim().split(/\s+/).map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+');
  if(!escaped)return;
  const matches=req.messages.flatMap((m,index)=>{const match=m.content.match(new RegExp(escaped,'u'));return match?[{index,quote:match[0]}]:[];});
  if(matches.length===1){source.index=matches[0]!.index;source.quote=matches[0]!.quote;}
}
const factId=(req:AddRequest,index:number):string=>hash(`${req.user_id}\0${req.request_id}\0fact\0${index}`);
function before(a:{index:number;quote:string},b:{index:number;quote:string},req:AddRequest):boolean{
  if(a.index!==b.index)return a.index<b.index;
  const text=req.messages[a.index]?.content??'';
  const start=text.indexOf(a.quote),end=text.indexOf(b.quote);
  return start>=0&&end>=0&&start+a.quote.length<=end;
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
export class Extractor {
  constructor(private config: Config, private models: Models) {}
  async prepare(req: AddRequest, snapshot: Snapshot, signal: AbortSignal): Promise<Prepared> {
    addSchema.parse(req);
    const degraded: string[] = [];const partialSources=new Set<number>();
    const anchor = req.messages.map(m => m.content.match(/\[Session time:\s*([^\]]+)\]/i)?.[1]).find(Boolean) ?? snapshot.anchor ?? req.messages[0]?.timestamp ?? null;
    let parsed: Extraction;
    if(this.config.experimental?.rawOnly){
      parsed={operations:[],facts:req.messages.flatMap((m,index)=>m.content.match(/[\s\S]{1,2000}/g)?.map(quote=>({content:`${m.role}: ${quote}`,subject:m.role,predicate:'raw_evidence',value:quote,scope:'',kind:'event' as const,modality:'confirmed' as const,cardinality:'multiple' as const,time_text:'',valid_from:null,valid_to:null,sources:[{index,quote}],supersedes:[],depends_on:[]}))??[])};
    }
    else if (this.config.mode === 'offline') parsed = offlineExtract(req, snapshot);
    else {
      const chunkText = req.messages.map(m => m.content).join('\n');
      const ordered=snapshot.facts.map(f=>({f,score:overlap(chunkText,`${f.subject} ${f.predicate} ${f.value} ${f.content}`)+(f.state==='active'&&f.cardinality==='single'?.08:0)})).sort((a,b)=>b.score-a.score).slice(0,120).map(x=>x.f);
      const aliases=new Map(ordered.map((f,i)=>[`m${i}`,f.id]));
      const knownIds=new Set(snapshot.facts.map(f=>f.id));
      const relevant=ordered.map((f,i)=>({id:`m${i}`,content:f.content,subject:f.subject,predicate:f.predicate,value:f.value,scope:f.scope,state:f.state,modality:f.modality}));
      const user=JSON.stringify({OBSERVATION_DATE:anchor,EXISTING_FACTS:relevant,CONTEXT_ONLY:snapshot.tail.map(m=>({role:m.role,content:m.content})),NEW_MESSAGES:req.messages.map((m,index)=>({index,...m}))});
      // Reserve time for grounded fallback, local embedding and atomic commit.
      // This inner budget never extends the caller's absolute request deadline.
      const modelSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.min(80000,Math.max(500,this.config.addTimeout-25000)))]);
      try {
        let issue='';let accepted:Extraction|undefined;
        for(let attempt=0;attempt<2;attempt++){
          const raw=await this.models.json(EXTRACTION_PROMPT,user+(issue?'\nREPAIR: '+issue:''),modelSignal);
          // Normalize an unambiguous model spelling without weakening the runtime
          // schema: a plan is a tentative event, never confirmed current state.
          if(raw&&typeof raw==='object'&&Array.isArray((raw as {facts?:unknown}).facts)){
            for(const f of (raw as {facts:unknown[]}).facts)if(f&&typeof f==='object'&&(f as {kind?:unknown}).kind==='plan')Object.assign(f,{kind:'event',modality:'tentative'});
          }
          const valid=extractionSchema.safeParse(raw);
          if(!valid.success){issue='Return the complete schema. '+valid.error.issues.slice(0,4).map(x=>x.path.join('.')+': '+x.message).join('; ');continue;}
          for(const f of valid.data.facts)for(const source of f.sources)resolveSource(source,req);
          for(const o of valid.data.operations){resolveSource(o.source,req);const statement=req.messages[o.source.index]?.content??'';if(o.type==='retract'&&realControl(statement)&&/\b(?:forget|erase|delete)\b|remove .{0,100} entirely|彻底删除|完全移除/i.test(o.source.quote)&&!/current (?:colleague|contact)|当前同事|当前联系人/i.test(statement))o.type='forget';}
          for(const f of valid.data.facts){f.supersedes=f.supersedes.map(id=>aliases.get(id)??id);f.depends_on=f.depends_on.map(id=>aliases.get(id)??id);}
          for(const o of valid.data.operations)o.target_ids=o.target_ids.map(id=>aliases.get(id)??id);
          let localIds:Set<string>;
          try{localIds=bindNewFactHandles(valid.data,req);}catch{issue='Unknown target chronology. new:N may only reference an earlier sourced fact in this chunk. Repair the invalid references.';continue;}
          const unknown=[...valid.data.facts.flatMap(f=>[...f.supersedes,...f.depends_on]),...valid.data.operations.flatMap(o=>o.target_ids)].filter(id=>!knownIds.has(id)&&!localIds.has(id));
          if(unknown.length){issue='Unknown target IDs. Use ONLY short IDs from EXISTING_FACTS, never invent IDs. If a rejected assistant claim was not in existing memories, emit no delete/correct operation for it. Return the whole corrected object. Unknown IDs: '+JSON.stringify(unknown.slice(0,8));continue;}
          if(valid.data.operations.some(o=>o.type==='forget'&&!authorizesForget(o,req))){issue='The proposed forget is quoted, hypothetical, negated, or lacks an actual user deletion instruction. Remove that operation; preserve existing facts. Return the whole object.';continue;}
          if(valid.data.operations.some(o=>!groundedOperation(o,req,[...snapshot.facts,...proposalFacts(valid.data,req)]))){issue='An operation targets a fact with no matching topic in the new user request or preceding context. Do not delete unrelated memories. If the user rejects a never-stored assistant claim, return no operation. Recheck targets and return full JSON.';continue;}
          if(missingForgetObligations(req,valid.data).length){issue='A direct retirement instruction has no operation. Bind each instruction to tenant-local evidence; do not silently omit it. Return the full object.';continue;}
          const invalid=valid.data.facts.flatMap((f,i)=>f.sources.filter(s=>!req.messages[s.index]?.content.includes(s.quote)).map(s=>({fact:i,index:s.index,quote:s.quote})));
          const badOps=valid.data.operations.filter(o=>!req.messages[o.source.index]?.content.includes(o.source.quote)||!humanOperation(o,req));
          if(attempt===1&&invalid.length&&!badOps.length){
            // Preserve valid operations and facts; an unsupported paraphrased quote must
            // not invalidate an entire chronological sample. Recover only what rules can
            // ground, and retain the remaining original text under lifecycle visibility.
            const badIndexes=new Set(invalid.map(x=>x.index).filter(i=>!!req.messages[i]));
            const good=valid.data.facts.filter(f=>f.sources.every(s=>req.messages[s.index]?.content.includes(s.quote)));
            for(const index of badIndexes){
              partialSources.add(index);
              try{const recovered=offlineExtract({...req,messages:[req.messages[index]!]},snapshot);if(!recovered.operations.length)for(const f of recovered.facts){f.sources=f.sources.map(s=>({...s,index}));good.push(f);}}catch{ /* original evidence remains available */ }
            }
            valid.data.facts=good;accepted=valid.data;degraded.push('source_span_partial');break;
          }
          if(invalid.length||badOps.length){issue='Every source quote must be an exact substring of the indicated NEW_MESSAGES content. Operations must cite a USER message, or a named real participant changing their own facts. An unlabelled assistant reply never authorizes changes. Never copy CONTEXT_ONLY as a new source. Fix all facts/operations and return the full object. Invalid fact spans: '+JSON.stringify(invalid.slice(0,8));continue;}
          accepted=valid.data;break;
        }
        if(!accepted&&issue.startsWith('Unknown target'))throw new ServiceError('OPERATION_TARGET','Unknown memory operation target after repair');
        if(!accepted)throw new ServiceError('EXTRACTION_SCHEMA','Could not validate structured evidence and exact sources');
        parsed=accepted;
      } catch (error) {
        if (signal.aborted || (error instanceof ServiceError && error.code==='OPERATION_TARGET')) throw error;
        degraded.push('extraction_offline'); parsed = offlineExtract(req,snapshot);
      }
    }
    const validSource = (s:{index:number;quote:string}): boolean => !!req.messages[s.index]?.content.includes(s.quote);
    if (parsed.operations.some(o => !validSource(o.source) || !humanOperation(o,req))) throw new ServiceError('OPERATION_SOURCE','Operation lacks valid user evidence');
    // Reject nonexistent operation targets; the model may only bind tenant-local evidence.
    const localIds=bindNewFactHandles(parsed,req);
    if(!this.config.experimental?.rawOnly&&missingForgetObligations(req,parsed).length)throw new ServiceError('OPERATION_INTENT','Unresolved memory operation after bounded recovery');
    const known = new Set([...snapshot.facts.map(f=>f.id),...localIds]);
    if (parsed.operations.some(o=>o.target_ids.some(id=>!known.has(id)))) throw new ServiceError('OPERATION_TARGET','Unknown memory operation target');
    const messages = req.messages.map((m,i)=>({ ...m,id:hash(`${req.user_id}\0${req.request_id}\0${i}`),session_id:req.session_id,ordinal:i,searchable:true,partial:partialSources.has(i),time_basis:(anchor?.includes('synthetic ordering')?'ordering':'source') as 'ordering'|'source' }));
    const facts: Fact[] = [];
    for (const [i,f] of parsed.facts.entries()) {
      if (f.sources.some(s=>!validSource(s))) throw new ServiceError('FACT_SOURCE','Fact lacks verbatim source evidence');
      if ([...f.supersedes,...f.depends_on].some(id=>!known.has(id))) throw new ServiceError('FACT_TARGET','Unknown superseded fact');
      const src = f.sources.map(s=>messages[s.index]!);
      const {sources:proposalSources,...attributes}=f;
      if(!this.config.experimental?.rawOnly&&src.every(m=>m.role!=='user'&&!/^([\p{L}][\p{L} .'-]{0,40}):\s*/u.test(m.content.replace(/\[Session time:[^\]]*\]/g,'').trim())))f.modality='quoted';
      facts.push({ ...attributes,modality:f.modality,time_basis:anchor?.includes('synthetic ordering')?'ordering':'source',id:factId(req,i),source_ids:[...new Set(src.map(m=>m.id))],source_quotes:proposalSources.map(s=>s.quote),created_at:src[0]!.timestamp,observed_at:src[0]!.timestamp,state:'active',vector:null,entities:entities(f.content),revision:snapshot.revision+1 });
    }
    if (this.config.mode !== 'offline' && facts.length) {
      try {
        const eligible = facts.filter(f=>f.content.length<3500);
        const vectors = await this.models.embedBatch(eligible.map(f=>f.content),'add',signal);
        eligible.forEach((f,i)=>{f.vector=vectors[i]!;});
        if (eligible.length !== facts.length) degraded.push('long_evidence_lexical');
      } catch(error) { if (signal.aborted) throw error; degraded.push('embedding_lexical'); }
    }
    return { facts,operations:parsed.operations,messages,anchor,degraded,embeddingSpace:this.config.embeddingSpace };
  }
}
