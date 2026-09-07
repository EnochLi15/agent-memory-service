import type {Candidate,Fact,QueryIntent,SearchRequest,SearchResponse} from './types.js';
import type {Config} from './config.js';
import {tokens,estimateTokens} from './text.js';

const stop=new Set('s a an the what which who where when how is are was were do does did my me i our your you of to for in on at and or about tell please have has had can would should be it its that this all'.split(' '));
const normalize=(s:string)=>s.toLowerCase().replace(/[_-]/g,' ').replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim();
const terms=(s:string)=>new Set(tokens(s).filter(t=>!stop.has(t)));
const text=(f:Fact)=>`${f.subject} ${f.predicate} ${f.scope} ${f.content}`;
function coverage(query:string,candidates:Candidate[]):number{
 const wanted=terms(query);if(!wanted.size)return 0;
 return Math.max(0,...candidates.slice(0,6).map(c=>{const found=terms(text(c.fact));return [...wanted].filter(t=>found.has(t)).length/wanted.size;}));
}
export type RelationDecision={enabled:boolean;reason:'disabled'|'legacy'|'multiple_entities'|'relationship_query'|'weak_initial_evidence'|'direct_evidence';initial_coverage:number};
export function relationDecision(query:string,qi:QueryIntent,candidates:Candidate[],config:Config):RelationDecision{
 const initial_coverage=coverage(query,candidates);
 if(config.retrieval!=='hybrid'||config.experimental?.multiHop===false||config.relationMode==='off')return {enabled:false,reason:'disabled',initial_coverage};
 if(config.relationMode==='cooccurrence')return {enabled:true,reason:'legacy',initial_coverage};
 if(qi.entities.length>=2)return {enabled:true,reason:'multiple_entities',initial_coverage};
 if(initial_coverage<1&&/\b(?:friend|manager|boss|supervisor|colleague|coworker|brother|sister|spouse|partner|parent|employer|relationship|related|connected)\b|关系|关联|朋友|同事|经理|兄弟|姐妹|雇主/i.test(query))return {enabled:true,reason:'relationship_query',initial_coverage};
 if(initial_coverage<.7)return {enabled:true,reason:'weak_initial_evidence',initial_coverage};
 return {enabled:false,reason:'direct_evidence',initial_coverage};
}
const relationFamilies=[['manager','boss','supervisor'],['friend'],['colleague','coworker','co worker'],['brother','sister','sibling'],['parent','mother','father'],['partner','spouse','wife','husband'],['employer','company','organization','works for','works at','workplace'],['residence','city','lives in','location','based in']];
function family(predicate:string):string[]|undefined{const p=normalize(predicate).replace(/^(?:current|primary) /,'');return relationFamilies.find(xs=>xs.includes(p));}
function owner(s:string):string{return /^(?:i|me|my|user|myself)$/.test(normalize(s))?'user':normalize(s);}
type Window=[number,number];
function window(f:Fact):Window|null{const start=f.valid_from?Date.parse(f.valid_from):-Infinity,end=f.valid_to?Date.parse(f.valid_to):Infinity;return Number.isNaN(start)||Number.isNaN(end)||start>=end?null:[start,end];}
function intersect(a:Window,b:Window|null):Window|null{if(!b)return null;const w:Window=[Math.max(a[0],b[0]),Math.min(a[1],b[1])];return w[0]<w[1]?w:null;}
function grounded(f:Fact):boolean{return f.modality==='confirmed'&&['active','superseded'].includes(f.state)&&f.source_ids.length>0&&(f.source_quotes.length>0||!!f.source_spans?.length);}
export type RelationExpansion={hits:{id:string;depth:number;direction:'outgoing'|'incoming'|'property'}[];roots:number;visited:number;limit_reached:boolean};
/** Traverses declared subject/relation/value edges, never arbitrary entity co-occurrence.
 * Caller supplies only lifecycle-visible facts. The output is evidence, not a new conclusion. */
export function expandTypedRelations(query:string,qi:QueryIntent,facts:Fact[],initial:Candidate[]):RelationExpansion{
 const eligible=facts.filter(grounded),nodes=new Set(eligible.flatMap(f=>[owner(f.subject),family(f.predicate)?owner(f.value):'']).filter(Boolean));
 const roots=new Set(qi.entities.map(owner).filter(n=>nodes.has(n)));
 if(/\b(?:my|me|I|our)\b|我(?:的|们)/i.test(query)&&nodes.has('user'))roots.add('user');
 if(!roots.size)for(const c of initial.slice(0,3)){const n=owner(c.fact.subject);if(nodes.has(n)&&terms(query).size&&coverage(query,[c])>=.5)roots.add(n);}
 const reverse=/\b(?:who|whose|which (?:person|people|colleague))\b|relationship between|关系|谁|哪些人/i.test(query);
 const requested=relationFamilies.filter(xs=>xs.some(x=>new RegExp(`\\b${x}\\b`,'i').test(query)));
 const wanted=terms(query);for(const root of roots)for(const term of terms(root))wanted.delete(term);
 const propertyMatch=(f:Fact)=>[...terms(`${f.predicate} ${f.content}`)].some(t=>wanted.has(t));
 const hits:RelationExpansion['hits']=[],seenFacts=new Set<string>(),seenNodes=new Set<string>();
 const queue=[...roots].slice(0,8).map(node=>({node,depth:0,time:[-Infinity,Infinity] as Window}));
 let limited=roots.size>8;
 while(queue.length){const item=queue.shift()!,key=`${item.node}|${item.time[0]}|${item.time[1]}`;if(seenNodes.has(key))continue;seenNodes.add(key);if(seenNodes.size>24){limited=true;break;}
  const linked=eligible.filter(f=>owner(f.subject)===item.node||reverse&&!!family(f.predicate)&&owner(f.value)===item.node).sort((a,b)=>Number(propertyMatch(b))-Number(propertyMatch(a))||a.id.localeCompare(b.id));
  let perNode=0;
  for(const f of linked){const time=intersect(item.time,window(f));if(!time)continue;
   const edge=family(f.predicate),outgoing=owner(f.subject)===item.node;
   // At the root, an explicit relation word selects the corresponding relation.
   // Subsequent nodes may supply the requested terminal property or another edge.
   if(item.depth===0&&requested.length&&edge&&!requested.some(xs=>xs===edge))continue;
   if(!edge&&!propertyMatch(f))continue;
   if(!seenFacts.has(f.id)){if(hits.length>=40||perNode>=8){limited=true;break;}seenFacts.add(f.id);hits.push({id:f.id,depth:item.depth,direction:edge?(outgoing?'outgoing':'incoming'):'property'});perNode++;}
   if(edge&&item.depth<2){const node=outgoing?owner(f.value):owner(f.subject);if(node&&nodes.has(node)&&node!==item.node)queue.push({node,depth:item.depth+1,time});}
  }
 }
 return {hits,roots:roots.size,visited:Math.min(seenNodes.size,24),limit_reached:limited};
}
export type RerankDecision={enabled:boolean;reason:'disabled'|'too_few_candidates'|'always'|'complex_query'|'fits_budget'|'clear_direct_match'|'ambiguous_candidates';candidate_count:number;initial_coverage:number};
export function rerankDecision(req:SearchRequest,qi:QueryIntent,ranked:Candidate[],compact:SearchResponse,config:Config):RerankDecision{
 const base={candidate_count:compact.data.length,initial_coverage:coverage(req.query,ranked)},result=(enabled:boolean,reason:RerankDecision['reason'])=>({...base,enabled,reason});
 if(!config.rerank||config.mode!=='enhanced')return result(false,'disabled');
 if(compact.data.length<2)return result(false,'too_few_candidates');
 if(config.rerankPolicy==='always')return result(true,'always');
 if(qi.operation||qi.trajectory||qi.historical||qi.temporal||qi.list||qi.entities.length>=2)return result(true,'complex_query');
 if(compact.data.length===ranked.length&&ranked.length<=Math.min(req.top_k,config.maxEvidence)&&compact.data.reduce((n,x)=>n+estimateTokens(x.content),0)<=config.tokenBudget&&base.initial_coverage>=.7)return result(false,'fits_budget');
 const first=ranked[0],second=ranked[1];
 const actorMatches=first&&(/\b(?:my|me|I|our)\b|我(?:的|们)/i.test(req.query)?owner(first.fact.subject)==='user':qi.entities.length?qi.entities.map(owner).includes(owner(first.fact.subject)):true);
 if(first&&second&&actorMatches&&coverage(req.query,[first])===1&&first.score>=second.score*1.5&&first.fact.state==='active'&&first.fact.modality==='confirmed')return result(false,'clear_direct_match');
 return result(true,'ambiguous_candidates');
}
