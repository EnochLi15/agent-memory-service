import type { Config } from './config.js';
import { TenantStore, allowed } from './storage.js';
import { intent, overlap, estimateTokens } from './text.js';
import { scoreAndRank, normalizeBm25, getBm25Params } from './mem0/scoring.js';
import type { Fact, SearchRequest, SearchResponse, Candidate } from './types.js';

// Cosine computation derived from mem0 MemoryVectorStore; vectors are normalized at ingress.
export function cosine(a:number[],b:number[]):number {if(a.length!==b.length)return -1;let sum=0,aa=0,bb=0;for(let i=0;i<a.length;i++){sum+=a[i]!*b[i]!;aa+=a[i]!**2;bb+=b[i]!**2;}return aa&&bb?sum/Math.sqrt(aa*bb):-1;}
export function retrieve(store:TenantStore,req:SearchRequest,vector:number[]|null,config:Config):SearchResponse {
  const top=Math.min(100,Math.floor(req.top_k),config.maxEvidence);if(!top)return {data:[]};
  const qi=intent(req.query);const facts=store.facts().filter(f=>allowed(f,qi));const byId=new Map(facts.map(f=>[f.id,f]));
  const semantic=vector ? facts.filter(f=>f.vector).map(f=>({id:f.id,score:cosine(vector,f.vector!)})).filter(x=>x.score>.15).sort((a,b)=>b.score-a.score).slice(0,150):[];
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
  // Bounded two-hop entity expansion, always from eligible facts and backed by sources.
  if(config.retrieval==='hybrid'){
    const seeds=[...candidates.values()].sort((a,b)=>b.score-a.score).slice(0,6);
    const names=new Set(seeds.flatMap(c=>c.fact.entities).filter(n=>n.length>3));
    let count=0;for(const f of facts){if(count>=40)break;if(!candidates.has(f.id)&&f.entities.some(e=>names.has(e))&&overlap(req.query,f.content)>.08){add(f.id,.007,'relation');count++;}}
  }
  if(config.rawFallback){
    for(const m of store.raw()){
      if(!/\b(I|my|we|our)\b|我|^[\p{L} .'-]+:/iu.test(m.content))continue;
      const relevance=overlap(req.query,m.content);if(relevance<.2||m.content.length>2500)continue;
      const f:Fact={id:`raw-${m.id}`,content:m.content,subject:m.role,predicate:'raw_evidence',value:'',scope:'',kind:'event',modality:'confirmed',cardinality:'multiple',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:[m.id],source_quotes:[],created_at:m.timestamp,observed_at:m.timestamp,state:'active',vector:null,entities:[],revision:store.revision()};
      candidates.set(f.id,{fact:f,score:.006*relevance,signals:['raw']});
    }
  }
  const ranked=[...candidates.values()].filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.fact.id.localeCompare(b.fact.id));
  const data:SearchResponse['data']=[];let budget=0;const seen=new Set<string>();
  for(const c of ranked){
    const f=c.fact;const key=f.content.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');if(seen.has(key))continue;
    const state=f.state==='conflicted'?'conflicting confirmed claims; do not choose without clarification':f.state==='superseded'?`historical; valid until ${f.valid_to??'later update'}`:f.modality;
    const content=`${f.content}\n[status: ${state}; observed: ${f.observed_at};${f.time_text?` original time: ${f.time_text};`:''} source: ${f.source_ids.join(',')}]`;
    const cost=estimateTokens(content);if(budget+cost>config.tokenBudget)continue;
    data.push({id:f.id,content,score:Number(c.score.toFixed(8)),created_at:f.created_at});budget+=cost;seen.add(key);if(data.length>=top)break;
  }
  return {data};
}
