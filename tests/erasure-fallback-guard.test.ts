import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {ServiceError} from '../dist/types.js';

const timestamp='2026-01-01T00:00:00Z';
const request=(id:string,content:string)=>({user_id:'fixture',session_id:'s',request_id:id,messages:[{role:'user',content,timestamp}]});
const fact=(content:string,predicate:string,value:string,index=0)=>({content,subject:'Rowan',predicate,value,sources:[{index,quote:content}]});
const residence='Rowan lived in Harbor City.',food='Rowan enjoys the food scene in Harbor City.';
const command='Forget that Rowan lived in Harbor City.';
const config=(sourceErasure=false)=>configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:String(sourceErasure)});
async function fixture(fn:any,options:{separate?:boolean;neighbor?:boolean;pronoun?:boolean;sourceErasure?:boolean}={}){
 const dir=mkdtempSync(join(tmpdir(),'erasure-fallback-guard-')),store=new TenantStore(dir,'fixture');
 const neighborText=options.pronoun?'Rowan enjoyed the food there.':food;
 const seed=request('seed',residence+(options.separate||options.neighbor===false?'':' '+neighborText));
 if(options.separate)seed.messages.push({role:'user',content:neighborText,timestamp});
 const seedProposal={facts:[fact(residence,'former_residence','Harbor City'),...(options.neighbor===false?[]:[{...fact(food,'food_preference','Harbor City food',options.separate?1:0),sources:[{index:options.separate?1:0,quote:neighborText}]}])],operations:[]};
 const cfg=config(options.sourceErasure);
 const seedModels={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async()=>structuredClone(seedProposal)};
 try{
  const seedPrepared=await new Extractor(cfg,seedModels as any).prepare(seed,store.snapshot('s'),AbortSignal.timeout(2000));
  store.commit(seed,hash(JSON.stringify(seed)),seedPrepared,0);
  const target=store.facts().find(f=>f.predicate==='former_residence')!,neighbor=store.facts().find(f=>f.predicate==='food_preference');
  const req=request('forget',command+' Keep every food preference.');
  const proposal={facts:[],operations:[{type:'forget',target_ids:[target.id],subject:target.subject,predicate:target.predicate,value:target.value,source:{index:0,quote:command}}]};
  const calls:string[]=[];
  const models=(erasure:any)=>({verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,input:string,_signal:any,context:any)=>{
   calls.push(context.purpose);if(context.purpose==='erasure_binding')return erasure(JSON.parse(input));return structuredClone(proposal);
  }});
  const prepare=(erasure:any,selectedConfig=cfg)=>new Extractor(selectedConfig,models(erasure) as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(2000));
  const commit=(p:any)=>store.commit(req,hash(JSON.stringify(req)),p,store.revision());
  const logical=()=>store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row:any)=>({name:row.name,rows:store.db.prepare('SELECT * FROM "'+row.name.replaceAll('"','""')+'"').all().map(x=>JSON.stringify(x)).sort()}));
  await fn({store,req,proposal,target,neighbor,calls,prepare,commit,models,logical});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
const unavailable=()=>{throw Error('Synthetic classifier unavailable');};
const requiredReview=(e:any)=>e.code==='EVIDENCE_VALIDATION'&&/Erasure scope semantic review required/.test(e.message);

test('unavailable erasure review cannot delete a same-source independent food fact despite explicit keep',()=>fixture(async(f:any)=>{
 const before=f.logical();
 await assert.rejects(async()=>f.commit(await f.prepare(unavailable)),requiredReview);
 assert.deepEqual(f.logical(),before);assert.equal(f.store.revision(),1);
 assert.equal(f.store.receipt(f.req.request_id,hash(JSON.stringify(f.req))),null);
 assert.ok(f.store.facts().every((x:any)=>x.state==='active'));
 assert.deepEqual(f.calls,['extraction','erasure_binding']);
}));

test('unresolved fact scope stops before downstream source review when source erasure is enabled',()=>fixture(async(f:any)=>{
 const before=f.logical();
 await assert.rejects(()=>f.prepare(unavailable),requiredReview);
 assert.deepEqual(f.calls,['extraction','erasure_binding']);
 assert.deepEqual(f.logical(),before);
},{sourceErasure:true}));

test('a value-free quote is not authority to erase a separate-source neighbor on outage',()=>fixture(async(f:any)=>{
 const before=f.logical();
 await assert.rejects(()=>f.prepare(unavailable),requiredReview);
 assert.deepEqual(f.calls,['extraction','erasure_binding']);
 assert.deepEqual(f.logical(),before);assert.equal(f.store.revision(),1);
},{separate:true,pronoun:true}));

test('a same-literal witness is not authority to certify independent retention on outage',()=>fixture(async(f:any)=>{
 await assert.rejects(()=>f.prepare(unavailable),requiredReview);
 assert.ok(f.store.facts().every((x:any)=>x.state==='active'));
},{separate:true}));

test('skipping semantic erasure in offline mode cannot classify ambiguous neighbors',()=>fixture(async(f:any)=>{
 const before=f.logical();
 const cfg={...config(),mode:'offline' as const};
 await assert.rejects(()=>f.prepare(unavailable,cfg),requiredReview);
 assert.deepEqual(f.logical(),before);assert.ok(!f.calls.includes('erasure_binding'));
}));

for(const error of [new SyntaxError('invalid JSON'),new ServiceError('VERIFICATION_UNAVAILABLE','shared budget unavailable')])test('unresolved erasure stays fail-closed after '+error.name+': '+error.message,()=>fixture(async(f:any)=>{
 await assert.rejects(()=>f.prepare(()=>{throw error;}),requiredReview);
 assert.equal(f.store.revision(),1);
}));

test('semantic uncertain remains its original terminal refusal',()=>fixture(async(f:any)=>{
 await assert.rejects(()=>f.prepare((x:any)=>({decisions:x.CANDIDATES.map((c:any)=>({index:c.index,effect:'uncertain',quote:x.FACTS[c.fact_slot].fact.source_quotes[0],reason:'Uncertain scope.',value_context:null}))})),/Erasure scope remains uncertain/);
 assert.equal(f.store.revision(),1);
}));

test('reviewed independent retention still commits the direct deletion and preserves the food neighbor',()=>fixture(async(f:any)=>{
 const p=await f.prepare((x:any)=>({decisions:x.CANDIDATES.map((c:any)=>({index:c.index,effect:'retain',quote:x.FACTS[c.fact_slot].fact.source_quotes[0],reason:'Independent food preference with its own complete witness.',value_context:null}))}));
 assert.deepEqual(p.operations[0].target_ids,[f.target.id]);assert.deepEqual(p.degraded,[]);f.commit(p);
 assert.equal(f.store.facts().find((x:any)=>x.id===f.target.id).state,'erased');
 assert.equal(f.store.facts().find((x:any)=>x.id===f.neighbor.id).state,'active');
 assert.equal(f.store.revision(),2);
},{separate:true}));

test('direct deletion without ambiguous candidates still commits without an erasure classifier call',()=>fixture(async(f:any)=>{
 const p=await f.prepare(unavailable);assert.ok(!f.calls.includes('erasure_binding'));f.commit(p);
 assert.equal(f.store.facts().find((x:any)=>x.id===f.target.id).state,'erased');assert.equal(f.store.revision(),2);
},{neighbor:false}));

test('ordinary writes without ambiguous erasure work keep capability fallback',async()=>{
 const req=request('ordinary','I enjoy cycling.');
 const p=await new Extractor(config(),{json:async()=>{throw Error('Synthetic extraction unavailable');}} as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(2000));
 assert.ok(p.degraded.includes('extraction_offline'));assert.equal(p.messages[0]!.content,req.messages[0].content);
 assert.equal(p.erasurePlan!.decisions.length,0);
});
