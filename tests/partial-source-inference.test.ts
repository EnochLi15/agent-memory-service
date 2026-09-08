import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../src/extraction.js';
import {TenantStore} from '../src/storage.js';
import {configFromEnv} from '../src/config.js';
import type {Fact} from '../src/types.js';

const timestamp='2026-01-01T00:00:00Z';
const deleted='I saved the obsolete itinerary.';
const neighbor='Mina checks in more than I do.';
const other='I rarely start those conversations.';
const request=(id:string,content:string)=>({request_id:id,user_id:'fixture',session_id:'s',messages:[{role:'user',content,timestamp}]});
type Options={text?:string;quotes?:string[];spans?:boolean;legacy?:boolean;cutNeighbor?:boolean;depends?:boolean;mutate?:(f:Fact)=>void;extra?:string};
async function fixture(options:Options,fn:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'partial-source-inference-'));
 const store=new TenantStore(dir,'fixture');
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:options.legacy?'false':'true',MEMORY_SOURCE_ERASURE:options.legacy?'false':'true'});
 const text=options.text??`${deleted} ${neighbor} `;
 let proposal:any={facts:[{content:deleted,subject:'user',predicate:'itinerary',value:'obsolete itinerary',sources:[{index:0,quote:deleted}]},
  {content:'User initiates fewer friendly check-ins.',subject:'user',predicate:'support_pattern',value:'fewer check-ins',modality:'inferred',sources:(options.quotes??[neighbor]).map(quote=>({index:0,quote}))}],operations:[]};
 if(options.extra)proposal.facts[1].sources.push({index:1,quote:options.extra});
 const models={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_system:string,input:string,_signal:any,ctx:any)=>{
  const data=JSON.parse(input);
  if(ctx.purpose==='erasure_binding')return {decisions:data.CANDIDATES.map((c:any)=>({index:c.index,effect:'retain',quote:neighbor,reason:'Independent support pattern.',value_context:null}))};
  if(ctx.purpose==='source_erasure')return {decisions:data.CANDIDATES.map((c:any)=>{
   const source=data.SOURCES[c.source_slot];
   if(source.kind==='fact')return {index:c.index,effect:'retain',erase_quotes:[],reason:'independent_property'};
   if(source.text===text)return {index:c.index,effect:'mixed',erase_quotes:[deleted,...(options.cutNeighbor?[neighbor]:[])],reason:'mixed_source'};
   return {index:c.index,effect:'erase',erase_quotes:[],reason:'erased_record_echo'};
  })};
  return structuredClone(proposal);
 }} as any;
 const extractor=new Extractor(config,models),seed=request('seed',text);
 if(options.extra)seed.messages.push({role:'user',content:options.extra,timestamp});
 try{
  const seedPrepared=await extractor.prepare(seed,store.snapshot('s'),AbortSignal.timeout(3000));
  store.commit(seed,hash(JSON.stringify(seed)),seedPrepared,0);
  const target=store.facts().find(f=>f.predicate==='itinerary')!;
  const derived=store.facts().find(f=>f.predicate==='support_pattern')!;
  assert.ok(derived,'fixture must have an inferred fact');
  // Exercise source metadata variants against the public commit boundary.
  if(options.spans===false)delete derived.source_spans;
  if(options.depends)derived.depends_on=[target.id];
  options.mutate?.(derived);
  store.db.prepare('UPDATE facts SET body=? WHERE id=?').run(JSON.stringify(derived),derived.id);
  const del=request('delete','Forget my obsolete itinerary.');
  proposal={facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'itinerary',value:'obsolete itinerary',boundary:'value',source:{index:0,quote:del.messages[0]!.content}}]};
  const prepared=await extractor.prepare(del,store.snapshot('s'),AbortSignal.timeout(3000));
  const commit=()=>store.commit(del,hash(JSON.stringify(del)),prepared,store.revision());
  await fn({store,prepared,del,target,derived,commit,dir});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

for(const spans of [true,false])test(`reviewed partial deletion preserves an independent inferred witness, spans=${spans}`,()=>fixture({spans,mutate:f=>{
 if(spans&&f.source_spans?.[0])f.source_spans[0].end++; // Stored offsets may include source whitespace.
}},async({store,target,derived,commit}:any)=>{
 const before=store.snapshot('s');
 commit();
 assert.equal(store.revision(),2);
 assert.equal(store.facts().find((f:Fact)=>f.id===target.id).state,'erased');
 const retained=store.facts().find((f:Fact)=>f.id===derived.id);
 assert.equal(retained.state,'active');
 assert.deepEqual(retained.source_quotes,[neighbor]);
 assert.doesNotMatch(JSON.stringify(store.snapshot('s').erasureSources),/obsolete itinerary/);
 assert.match(JSON.stringify(store.snapshot('s').erasureSources),/Mina checks in/);
 assert.notDeepEqual(store.snapshot('s'),before);
}));

test('all distinct witnesses across multiple sources must survive',()=>fixture({extra:other},async({store,derived,commit}:any)=>{
 commit();
 const retained=store.facts().find((f:Fact)=>f.id===derived.id);
 assert.equal(retained.state,'active');
 assert.deepEqual(new Set(retained.source_quotes),new Set([neighbor,other]));
}));

test('an explicit dependency is still erased when its authorized source witness is cut',()=>fixture({depends:true,cutNeighbor:true},async({store,derived,commit}:any)=>{
 commit();
 assert.equal(store.facts().find((f:Fact)=>f.id===derived.id).state,'erased');
}));

test('explicit dependency with intact witnesses still trips the existing cross-plan guard',()=>fixture({depends:true},async({store,commit}:any)=>{
 const before=store.snapshot('s');
 assert.throws(commit,/every original witness intact/);
 assert.deepEqual(store.snapshot('s'),before);
 assert.equal(store.revision(),1);
}));

test('loss of part of any witness still invalidates inferred support',()=>fixture({quotes:[`${deleted} ${neighbor}`]},async({store,derived,commit}:any)=>{
 commit();
 assert.equal(store.facts().find((f:Fact)=>f.id===derived.id).state,'erased');
}));

for(const [name,options] of [
 ['missing source',{mutate:(f:Fact)=>f.source_ids.push('missing-source')}],
 ['missing quote',{mutate:(f:Fact)=>f.source_quotes.push('A witness that was never in the source.')}],
 ['incomplete recorded spans',{text:`${deleted} ${neighbor} ${other}`,quotes:[neighbor,other],mutate:(f:Fact)=>f.source_spans!.pop()}],
 ['repeated quote in one source',{text:`${deleted} ${neighbor} ${neighbor}`}],
 ['same quote in multiple declared sources',{extra:neighbor}],
 ['span outside the source',{mutate:(f:Fact)=>{f.source_spans![0]!.end=999999;}}],
] as [string,Options][])test(`uncertain support stays conservative: ${name}`,()=>fixture(options,async({store,commit}:any)=>{
 const before=store.snapshot('s');
 try{commit();assert.equal(store.facts().find((f:Fact)=>f.predicate==='support_pattern').state,'erased');}
 catch(error){assert.match(String(error),/every original witness intact/);assert.deepEqual(store.snapshot('s'),before);}
}));

test('missing source plan cannot make same-source retention bypass validation',()=>fixture({},async({store,prepared,commit}:any)=>{
 const before=store.snapshot('s');
 prepared.sourceErasurePlan=undefined;
 assert.throws(commit,/source erasure plan/);
 assert.deepEqual(store.snapshot('s'),before);
}));

test('legacy whole-source erasure keeps its previous inferred-fact invalidation',()=>fixture({legacy:true},async({store,derived,commit}:any)=>{
 commit();
 assert.equal(store.facts().find((f:Fact)=>f.id===derived.id).state,'erased');
}));
