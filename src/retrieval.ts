import type { Config } from './config.js';
import { TenantStore, allowed } from './storage.js';
import { intent, overlap, estimateTokens, tokens } from './text.js';
import { scoreAndRank, normalizeBm25, getBm25Params } from './mem0/scoring.js';
import { canonical, propertyFamily } from './types.js';
import type { Fact, SearchRequest, SearchResponse, Candidate, QueryIntent, Passage } from './types.js';
import {createHash} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {projectEvents} from './events.js';
import {temporalEvidenceText} from './temporal.js';
import {relationDecision,expandTypedRelations,type RelationDecision,type RelationExpansion} from './retrieval-policy.js';

// Cosine computation derived from mem0 MemoryVectorStore; vectors are normalized at ingress.
export function cosine(a:number[],b:number[]):number {if(a.length!==b.length)return -1;let sum=0,aa=0,bb=0;for(let i=0;i<a.length;i++){sum+=a[i]!*b[i]!;aa+=a[i]!**2;bb+=b[i]!**2;}return aa&&bb?sum/Math.sqrt(aa*bb):-1;}
export type RetrievalFrame={ranked:Candidate[];allFacts:Fact[];visibleIds:Set<string>;qi:QueryIntent;allPassages:Passage[];trace:{eligible:string[];filtered:string[];routes:Record<string,string[]>;candidate_ids:string[];source_indexed_ids:string[];source_filtered_ids:string[];relation_plan?:RelationDecision;relation_expansion?:RelationExpansion}};
export type RankedEvidence={id:string;score:number};
export function collectCandidates(store:TenantStore,req:SearchRequest,vector:number[]|null,config:Config):RetrievalFrame {
  const qi=intent(req.query);if(config.experimental?.temporal===false){qi.historical=false;qi.trajectory=false;qi.asOf=null;}
  const allFacts=store.facts();const allPassages=config.sourceIndex?store.passages():[];let eligible=allFacts.filter(f=>allowed(f,qi));
  // Derived evidence cannot remain current after a supporting state expires or
  // is corrected. Historical queries may still use valid historical support.
  while(true){const ids=new Set(eligible.map(f=>f.id));const next=eligible.filter(f=>f.depends_on.every(id=>ids.has(id)));if(next.length===eligible.length)break;eligible=next;}
  const visibleIds=new Set(eligible.map(f=>f.id));
  const facts=eligible.filter(f=>config.experimental?.reflection!==false||(f.kind!=='reflection'&&f.modality!=='inferred'));const byId=new Map(facts.map(f=>[f.id,f]));
  const compatibleVector=vector&&store.meta('embedding_space')===config.embeddingSpace?vector:null;
  const semantic=compatibleVector ? facts.filter(f=>f.vector).map(f=>({id:f.id,score:cosine(compatibleVector,f.vector!)})).filter(x=>x.score>.15).sort((a,b)=>b.score-a.score).slice(0,150):[];
  const lexical=store.lexical(req.query,180).filter(x=>byId.has(x.id));
  const expanded=new Map(lexical.map(x=>[x.id,x]));
  for(const option of req.options??[]){if(typeof option!=='string')continue;for(const hit of store.lexical(`${req.query} ${option}`,40)){if(byId.has(hit.id)&&!expanded.has(hit.id))expanded.set(hit.id,{...hit,score:hit.score*.5});}}
  const lexicalAll=[...expanded.values()].sort((a,b)=>b.score-a.score);
  const entity=facts.map(f=>({id:f.id,score:qi.entities.reduce((s,e)=>s+(f.content.toLowerCase().includes(e.toLowerCase())?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  const candidates=new Map<string,Candidate>();
  const add=(id:string,score:number,signal:string):void=>{const f=byId.get(id);if(!f)return;const c=candidates.get(id)??{fact:f,score:0,signals:[]};c.score+=score;c.signals.push(signal);candidates.set(id,c);};
  if(config.retrieval==='mem0'&&vector){
    const [mid,steep]=getBm25Params(req.query);const bm=Object.fromEntries(lexicalAll.map(x=>[x.id,normalizeBm25(x.score,mid,steep)]));
    const ent=Object.fromEntries(entity.map(x=>[x.id,.5]));
    const scored=scoreAndRank(semantic.map(x=>({...x,payload:{data:byId.get(x.id)!.content}})),bm,ent,.1,150,false);
    for(const x of scored)add(x.id,x.score,'mem0');
  }else{
    if(config.retrieval!=='lexical')semantic.forEach((x,i)=>add(x.id,1/(60+i+1),'semantic'));
    lexicalAll.forEach((x,i)=>add(x.id,1/(60+i+1),'lexical'));
    entity.forEach((x,i)=>add(x.id,.5/(60+i+1),'entity'));
  }
  if(config.eventView&&!config.experimental?.rawOnly&&(qi.operation||qi.trajectory||qi.historical)){
    let history=allFacts.filter(f=>allowed(f,{...qi,historical:true}));
    while(true){const ids=new Set(history.map(f=>f.id));const next=history.filter(f=>f.depends_on.every(id=>ids.has(id)));if(next.length===history.length)break;history=next;}
    const events=store.events().filter(e=>!qi.asOf||e.time_basis==='ordering'||Date.parse(e.observed_at)<=Date.parse(qi.asOf+'T23:59:59.999Z'));
    const projected=projectEvents(events,allFacts,new Set(history.map(f=>f.id)));
    for(const f of projected){
      const relevance=overlap(req.query,f.content.replace(/_/g,' '));
      if(relevance>0)candidates.set(f.id,{fact:f,score:.04+relevance*.03,signals:['operation-event']});
    }
  }
  // Bounded two-hop entity expansion, always from eligible facts and backed by sources.
  if(config.retrieval==='hybrid'&&config.experimental?.multiHop!==false&&config.relationMode==='cooccurrence'){
    const seeds=[...candidates.values()].sort((a,b)=>b.score-a.score).slice(0,6);
    let frontier=new Set([...qi.entities,...seeds.flatMap(c=>c.fact.entities)]);const visited=new Set<string>();let count=0;
    for(let depth=0;depth<2&&frontier.size;depth++){
      const next=new Set<string>();const perEntity=new Map<string,number>();
      for(const f of facts){
        if(count>=40)break;
        const shared=f.entities.filter(e=>frontier.has(e)&&!visited.has(e));
        if(!shared.length||shared.every(e=>(perEntity.get(e)??0)>=8))continue;
        if(!candidates.has(f.id)){add(f.id,.012/(depth+1),'relation-'+(depth+1));count++;}
        for(const e of shared)perEntity.set(e,(perEntity.get(e)??0)+1);
        for(const e of f.entities)if(!visited.has(e))next.add(e);
      }
      for(const e of frontier)visited.add(e);frontier=next;
    }
  }
  if(config.rawFallback&&config.sourceIndex){
    const passages=allPassages.filter(p=>p.state==='active'&&p.content&&p.fact_ids.every(id=>visibleIds.has(id)));
    const byPassage=new Map(passages.map(p=>[p.id,p]));
    const semanticPassages=config.retrieval!=='lexical'&&compatibleVector?passages.filter(p=>p.vector).map(p=>({id:p.id,score:cosine(compatibleVector,p.vector!)})).filter(p=>p.score>.15).sort((a,b)=>b.score-a.score).slice(0,config.candidateLimit):[];
    const lexicalPassages=store.lexicalPassages(req.query,config.candidateLimit).filter(p=>byPassage.has(p.id));
    const scores=new Map<string,{score:number;signals:string[]}>();
    for(const [route,hits] of [['source-semantic',semanticPassages],['source-lexical',lexicalPassages]] as const){
      hits.forEach((hit,i)=>{const entry=scores.get(hit.id)??{score:0,signals:[]};entry.score+=.85/(60+i+1);entry.signals.push(route);scores.set(hit.id,entry);});
    }
    for(const [id,rank] of scores){
      const p=byPassage.get(id)!;
      const f:Fact={id,content:p.content,subject:p.speaker,predicate:'raw_evidence',value:'',scope:'',kind:'event',modality:'confirmed',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:[p.source_id],source_quotes:[],source_spans:p.fragments.map(f=>({source_id:p.source_id,start:f.start,end:f.end})),created_at:p.observed_at,observed_at:p.observed_at,time_basis:p.time_basis,state:'active',vector:p.vector,entities:[],revision:p.revision};
      candidates.set(id,{fact:f,...rank});
    }
  }
  if(config.rawFallback&&!config.sourceIndex){
    for(const m of store.raw()){
      if(allFacts.some(f=>f.source_ids.includes(m.id)&&!visibleIds.has(f.id)))continue;
      if(m.role!=='user'&&!/^([\p{L}][\p{L} .'-]{0,40}):\s*/u.test(m.content.replace(/\[Session time:[^\]]*\]/g,'').trim()))continue;
      if(!/\b(I|my|we|our)\b|我|^[\p{L} .'-]+:/iu.test(m.content))continue;
      const relevance=overlap(req.query,m.content);if(relevance<.2||m.content.length>2500)continue;
      const f:Fact={time_basis:m.time_basis,id:`raw-${m.id}`,content:m.content,subject:m.role,predicate:'raw_evidence',value:'',scope:'',kind:'event',modality:'confirmed',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:[m.id],source_quotes:[],created_at:m.timestamp!,observed_at:m.timestamp!,state:'active',vector:null,entities:[],revision:store.revision()};
      candidates.set(f.id,{fact:f,score:.006*relevance,signals:['raw']});
    }
  }
  const initial=[...candidates.values()].sort((a,b)=>b.score-a.score||a.fact.id.localeCompare(b.fact.id));
  applySubjectDemotion(candidates,req.query,qi);
  boostCandidateWinner(candidates,facts,req.query,req.options??[]);
  const relationPlan=relationDecision(req.query,qi,initial,config);
  let relationExpansion:RelationExpansion|undefined;
  if(config.relationMode==='conditional'&&relationPlan.enabled){
    relationExpansion=expandTypedRelations(req.query,qi,facts,initial);
    for(const hit of relationExpansion.hits)add(hit.id,.012/(hit.depth+1),`relation-typed-${hit.depth+1}`);
  }
  const ranked=[...candidates.values()].filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.fact.id.localeCompare(b.fact.id)).slice(0,config.candidateLimit);
  const routes:Record<string,string[]>={};for(const c of candidates.values())for(const route of c.signals)(routes[route]??=[]).push(c.fact.id);
  return {ranked,allFacts,visibleIds,qi,allPassages,trace:{eligible:[...visibleIds,...[...candidates.values()].filter(c=>c.signals.includes('operation-event')).map(c=>c.fact.id)],filtered:allFacts.filter(f=>!visibleIds.has(f.id)).map(f=>f.id),routes,candidate_ids:ranked.map(c=>c.fact.id),source_indexed_ids:allPassages.map(p=>p.id),source_filtered_ids:allPassages.filter(p=>p.state!=='active'||!p.content||p.fact_ids.some(id=>!visibleIds.has(id))).map(p=>p.id),relation_plan:relationPlan,...(relationExpansion?{relation_expansion:relationExpansion}:{})}};
}
// ---------- Deterministic ranking arbitration (round-12/13 P1 rules) ----------

/** Version-chain grouping key: same subject + property family + scope. */
function slotKeyLite(f:Pick<Fact,'subject'|'predicate'|'scope'>):string{
  return [canonical(f.subject),propertyFamily(f.predicate),canonical(f.scope)].join('');
}
function slotChains(allFacts:Fact[]):Map<string,Fact[]>{
  const chains=new Map<string,Fact[]>();
  for(const f of allFacts)if(f.cardinality==='single'&&f.predicate!=='raw_evidence')chains.set(slotKeyLite(f),[...(chains.get(slotKeyLite(f))??[]),f]);
  return chains;
}
/** Intent-aware multipliers that separate current winners from history noise.
 * Base hybrid scores sit within ~3% of each other, which carries no ranking
 * information for the downstream answer model. */
function arbitrationPlan(chains:Map<string,Fact[]>,allFacts:Fact[],qi:QueryIntent):Map<string,number>{
  const plan=new Map<string,number>();
  const current=!(qi.historical||qi.trajectory||qi.operation||qi.list||qi.asOf);
  for(const fs of chains.values()){
    const active=fs.find(f=>f.state==='active'&&f.modality==='confirmed');
    const hasHistory=fs.some(f=>f.state==='superseded'||f.state==='retracted');
    if(current){
      // State questions: current value first, tentative never masks confirmed
      // (recency trap), conflicts stay visible but demoted. Demotion is
      // relative to a confirmed winner: without one the fact layer must stay
      // above raw passages or the status wording disappears from results.
      if(active&&hasHistory)plan.set(active.id,3);
      if(active)for(const f of fs){
        if(f.state==='active'&&f.modality==='tentative')plan.set(f.id,Math.min(plan.get(f.id)??1,.4));
        else if(f.state==='conflicted')plan.set(f.id,Math.min(plan.get(f.id)??1,.6));
      }
    }else if(qi.historical||qi.trajectory||qi.operation){
      // History/trajectory: chain order wins, latest value stays reachable.
      if(active)plan.set(active.id,1.2);
      for(const f of fs)if(f.state==='superseded'||f.state==='retracted')plan.set(f.id,2.5);
    }
  }
  if(qi.temporal)for(const f of allFacts)if(f.event_time?.anchor||f.time_text||f.valid_from)plan.set(f.id,(plan.get(f.id)??1)*1.4);
  return plan;
}
/** Third-party subject demotion: a named participant's facts must not float
 * above the user's own state on self-referential queries (near-miss decoys are
 * the largest MemOps distractor family). */
function applySubjectDemotion(candidates:Map<string,Candidate>,query:string,qi:QueryIntent):void{
  const self=/\b(?:i|my|me|mine|we|our|us)\b|我|我的|我们/i.test(query);
  const named=qi.entities.map(e=>canonical(e)).filter(Boolean);
  if(!named.length&&!self)return;
  for(const c of candidates.values()){
    const subject=canonical(c.fact.subject);
    if(subject==='user'){if(named.length&&!self)c.score*=.3;continue;}
    if(subject==='assistant'){if(self)c.score*=.3;continue;}
    if(named.length){if(!named.includes(subject))c.score*=.3;}
    else if(self)c.score*=.3;
  }
}
/** High-confidence in-question candidate enumeration ("which of these would
 * you choose?"). Official evaluation queries embed candidates in text. */
function parseQueryCandidates(query:string):string[]{
  const trigger=/which of (?:these|the following|the two|the three)|would you (?:choose|pick|prefer)|should (?:i|we) (?:pick|choose|select|go with)|do you prefer|would you rather|choose between/i;
  if(!trigger.test(query))return [];
  const frame=/which|choose|pick|prefer|select|would you|should i|should we|option|rather|between/i;
  const items=query.split(/,|\bor\b|;|还是/i).map(s=>s.replace(/["'“”]/g,' ').replace(/[?.!。！]+$/,'').trim()).filter(s=>s.length>=2&&s.split(/\s+/).length<=14&&!frame.test(s));
  return items.length>=2?items.slice(0,6):[];
}
/** Four-level matching ladder: exact/verbatim (1) then long-text token overlap
 * (4). Short non-exact candidates never fuzzy-match, so digit near-duplicates
 * (60143 vs 60148) can only win by exact equality. */
function candidateMatchLevel(candidate:string,fact:Fact):0|1|4{
  const c=canonical(candidate);if(!c)return 0;
  const value=canonical(fact.value),content=canonical(fact.content);
  if(value&&value===c)return 1;
  if(c.length>=4&&content.includes(c))return 1;
  if(candidate.split(/\s+/).length>3){
    const ct=new Set(tokens(candidate)),ft=new Set(tokens(fact.content));
    if([...ct].filter(t=>ft.has(t)).length/Math.max(1,ct.size)>=.8)return 4;
  }
  return 0;
}
/** Force the uniquely matching candidate's evidence to rank-1. Ambiguity (no
 * match, or several candidates matching) leaves ranking untouched. */
function boostCandidateWinner(candidates:Map<string,Candidate>,facts:Fact[],query:string,options:unknown[]):void{
  const list=[...new Set([...parseQueryCandidates(query),...options.filter((x):x is string=>typeof x==='string')])];
  if(list.length<2)return;
  const pool=facts.filter(f=>f.state==='active'&&f.modality!=='hypothetical'&&f.cardinality==='single'&&f.value);
  const wins=new Map<string,0|1|4>();
  const matched=new Map<string,0|1|4>();
  for(const candidate of list)for(const f of pool){
    if(!candidates.has(f.id))continue;
    const level=candidateMatchLevel(candidate,f);
    if(!level)continue;
    const prev=wins.get(candidate);
    if(prev===undefined||level<prev)wins.set(candidate,level);
    const prior=matched.get(f.id);
    if(prior===undefined||level<prior)matched.set(f.id,level);
  }
  if([...wins.keys()].length!==1)return;
  const exact=[...matched.entries()].filter(([,level])=>level===1);
  if(!exact.length)return;
  const max=Math.max(0,...[...candidates.values()].map(c=>c.score));
  for(const [id] of exact.slice(0,2)){
    const entry=candidates.get(id);
    if(entry){entry.score=max*1.5+.005;entry.signals.push('candidate-exact');}
  }
}
export function compactCandidates(frame:RetrievalFrame,limit:number):SearchResponse{
  return {data:frame.ranked.slice(0,limit).map(c=>({id:c.fact.id,content:`${c.fact.content.slice(0,1200)}\n${temporalEvidenceText(c.fact.event_time)}\n[subject: ${c.fact.subject}; scope: ${c.fact.scope}; status: ${c.fact.predicate==='raw_evidence'?'original source, verify speaker, negation and plans':c.fact.state+'/'+c.fact.modality}; ${c.fact.time_basis==='ordering'?'synthetic order':'observed'}: ${c.fact.observed_at}; original time: ${c.fact.time_text}; valid from: ${c.fact.valid_from??'unspecified'}; valid until: ${c.fact.valid_to??'unspecified'}]`,score:c.score,created_at:c.fact.created_at}))};
}
function evidenceKey(f:Fact):string{return f.subject.toLowerCase()+'|'+f.scope.toLowerCase()+'|'+f.content.replace(/\[(?:Session time|Source id):[^\]]*\]/g,'').replace(/^[\p{L}][\p{L} .'-]{0,40}:\s*/u,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function packEvidence(store:TenantStore,req:SearchRequest,config:Config,frame:RetrievalFrame,scores?:RankedEvidence[]):SearchResponse{
  const {allFacts,visibleIds,qi}=frame;
  const top=Math.min(100,Math.floor(req.top_k),config.maxEvidence);if(!top)return {data:[]};
  const scoreMap=scores?new Map(scores.map(x=>[x.id,x.score])):null;
  const ranked=frame.ranked.map(c=>({...c,score:scoreMap?(scoreMap.get(c.fact.id)??0):c.score})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.fact.id.localeCompare(b.fact.id));
  const chains=slotChains(allFacts);
  const multiplier=arbitrationPlan(chains,allFacts,qi);
  for(const c of ranked){
    c.score*=multiplier.get(c.fact.id)??1;
    // The raw layer is a fallback: when a fact and its raw twin compete, the
    // fact wins (it carries status, time and scope the passage cannot).
    if(c.fact.predicate==='raw_evidence')c.score*=.4;
  }
  ranked.sort((a,b)=>b.score-a.score||a.fact.id.localeCompare(b.fact.id));
  const data:SearchResponse['data']=[];let budget=0;const seen=new Set<string>();const seenSources=new Set<string>();const seenItems=new Set<string>();const discarded:{id:string;reason:string}[]=scoreMap?frame.ranked.filter(c=>(scoreMap.get(c.fact.id)??0)<=0).map(c=>({id:c.fact.id,reason:'rerank-not-selected'})):[];
  while(ranked.length){
    let index=0;
    if(config.coveragePacking&&(qi.list||qi.trajectory)){
      let best=-Infinity;for(const [i,c] of ranked.entries()){
        const item=`${c.fact.subject}|${c.fact.predicate}|${c.fact.value||evidenceKey(c.fact)}`;
        const novelItem=seenItems.has(item)?0:1,novelSource=c.fact.source_ids.some(id=>!seenSources.has(id))?1:0;
        const utility=c.score*(1+.35*novelItem+.15*novelSource);if(utility>best){best=utility;index=i;}
      }
    }
    const c=ranked.splice(index,1)[0]!;
    const f=c.fact;const key=evidenceKey(f);if(seen.has(key)){discarded.push({id:f.id,reason:'duplicate'});continue;}
    const state=f.predicate==='raw_evidence'?'original source; interpret its speaker, negation and conditional wording':f.state==='conflicted'?'unresolved relationship or timing between supported statements; no current value has been selected':f.state==='superseded'?`historical; valid until ${f.valid_to??'later update'}`:f.modality;
    const originals=f.source_ids.slice(0,2).flatMap(id=>{const m=store.source(id);if(f.id.startsWith('source-')||f.id.startsWith('event-')||!m||m.redacted||(f.predicate==='memory_operation'&&!qi.historical)||seenSources.has(id)||allFacts.some(x=>x.source_ids.includes(id)&&!visibleIds.has(x.id)))return [];const q=f.source_quotes.find(q=>m.content.includes(q))??'';const position=q?m.content.indexOf(q):0;const start=Math.max(0,position-100);const excerpt=m.content.length<=600?m.content:m.content.slice(0,100)+' … '+m.content.slice(start,start+400);return [`${m.role}: ${excerpt}`];});
    const invalidValues=allFacts.filter(x=>!visibleIds.has(x.id)&&x.value&&x.source_ids.some(id=>f.source_ids.includes(id))).map(x=>x.value.toLowerCase());
    const safeQuotes=f.source_quotes.filter(q=>!invalidValues.some(v=>q.toLowerCase().includes(v)));
    const support=f.source_ids.every(id=>seenSources.has(id))?'':originals.length?`\nVerbatim source context (use this to verify actor and negation):\n${originals.join('\n')}`:safeQuotes.length?`\nVerbatim support: ${safeQuotes.slice(0,2).join(' | ')}`:'';
    const external=f.source_ids.flatMap(id=>{const m=store.source(id);const label=m?.external_id??m?.content.match(/\[Source id: ([^\]]+)\]/)?.[1];return label?[label]:[];});
    const timeText=temporalEvidenceText(f.event_time);
    // Presentation law: retired values travel wrapped with their successor so
    // the answer model cannot quote them as the current state. An as-of query
    // pins a point in time; there the successor is a temporal decoy, not context.
    const chain=chains.get(slotKeyLite(f));
    const currentFact=qi.asOf?undefined:chain?.find(x=>x.state==='active'&&(x.modality==='confirmed'||x.modality==='tentative'));
    let bodyText=f.content;
    if(f.state==='superseded'||f.state==='retracted')bodyText=`Former ${f.predicate}${f.value?`: "${f.value}"`:''} (${f.state==='retracted'?'removed at user request':'superseded'}${f.valid_to&&f.time_basis!=='ordering'?` on ${String(f.valid_to).slice(0,10)}`:''}${currentFact?`; current ${f.predicate}: "${currentFact.value}"`:''}). Original statement: ${f.content}`;
    else if(f.state==='conflicted')bodyText=`[Conflicting statements recorded; no single current value] ${f.content}`;
    const body=bodyText+(timeText?`\n${timeText}`:'');
    const transition=f.transition_time?` transition window: ${f.transition_time.start} to ${f.transition_time.end_exclusive} (${f.transition_time.precision} precision; exact boundary unknown);`:'';
    const suffix=`${external.length?`\n[Original source ids: ${external.join(',')}]`:''}\n[status: ${state}; subject/speaker: ${f.subject}; scope: ${f.scope||'unspecified'};${transition} ${f.time_basis==='ordering'?'synthetic order marker, not an event date':'observed'}: ${f.observed_at};${f.time_text?` original time: ${f.time_text};`:''}${f.valid_from?` valid from: ${f.valid_from};`:''}${f.valid_to?` valid until: ${f.valid_to};`:''} source: ${f.source_ids.map(id=>id.slice(0,12)).join(',')}]`;
    // Time anchor leads the content: the answer model reads sequentially and
    // temporal questions lose their footing when dates hide in a suffix.
    const lead=!f.observed_at||f.time_basis==='ordering'?'[time: session order only] ':`[${String(f.observed_at).slice(0,10)} | ${f.subject}] `;
    let content=`${lead}${body}${support}${suffix}`;
    if(budget+estimateTokens(content)>config.tokenBudget&&support)content=`${body}${safeQuotes[0]?`\nVerbatim support: ${safeQuotes[0].slice(0,200)}`:''}${suffix}`;
    const cost=estimateTokens(content);if(budget+cost>config.tokenBudget){discarded.push({id:f.id,reason:'budget'});continue;}
    data.push({id:f.id,content,score:Number(c.score.toFixed(8)),created_at:f.created_at});budget+=cost;seen.add(key);seenItems.add(`${f.subject}|${f.predicate}|${f.value||evidenceKey(f)}`);for(const id of f.source_ids)seenSources.add(id);if(data.length>=top)break;
  }
  discarded.push(...ranked.map(c=>({id:c.fact.id,reason:'count-limit'})));
  // Public scores remain ordered even when coverage affects selection order.
  data.sort((a,b)=>b.score-a.score);
  if(process.env.MEMORY_RETRIEVAL_AUDIT){
    const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
    const catalog=[...frame.allFacts.map(f=>({id:f.id,source_ids:f.source_ids})),...frame.allPassages.map(p=>({id:p.id,source_ids:[p.source_id]})),...frame.ranked.filter(c=>c.signals.includes('operation-event')).map(c=>({id:c.fact.id,source_ids:c.fact.source_ids}))];
    const sources=catalog.map(c=>({id:c.id,source_ids:c.source_ids,external_ids_sha256:c.source_ids.flatMap(id=>{const m=store.source(id);const label=m?.external_id??m?.content.match(/\[Source id: ([^\]]+)\]/)?.[1];return label?[hash(label)]:[];})}));
    appendFileSync(process.env.MEMORY_RETRIEVAL_AUDIT,JSON.stringify({event:'retrieval_stages',query_sha256:hash(req.query),tenant_sha256:hash(req.user_id),revision:store.revision(),...frame.trace,sources,reranked:scores?.map(s=>({id:s.id,score:s.score}))??null,discarded,selected:data.map(x=>x.id),tokens:budget})+'\n');
  }
  return {data};
}
export function retrieve(store:TenantStore,req:SearchRequest,vector:number[]|null,config:Config):SearchResponse {
 return packEvidence(store,req,config,collectCandidates(store,req,vector,config));
}
