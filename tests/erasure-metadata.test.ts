import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {TenantStore} from '../dist/storage.js';import {Extractor,hash} from '../dist/extraction.js';import {configFromEnv,sourceFormatFor} from '../dist/config.js';
import {verificationInput} from '../dist/verification.js';import {boundaryKey,protectBoundary,retainedAgainst} from '../dist/erasure.js';import {extractionSchema,scopeKey} from '../dist/types.js';
const scope='green curry at Thai-hot level';
const request=(id:string,texts:string[])=>({request_id:id,user_id:'u',session_id:'s',messages:texts.map(content=>({role:'user',content,timestamp:'2026-01-01T00:00:00Z'}))});
const fact=(quote:string,index:number,context:string)=>({content:quote,subject:'user',predicate:'meal_price',scope:context,value:'fifteen dollars',sources:[{index,quote}]});
test('erasure removes scope payloads atomically while restart, neighbors, replay and explicit restore keep their boundaries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'erasure-metadata-'));let store=new TenantStore(dir,'u');
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SOURCE_ERASURE_GROUPED:'true'});
 let proposal:any;
 const model={verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,input:string,_signal:any,ctx:any)=>{
  const d=JSON.parse(input);
  if(ctx.purpose==='erasure_binding')return {decisions:d.CANDIDATES.map((c:any,index:number)=>({index,effect:c.fact.scope==='mild soup'?'retain':'erase',quote:c.fact.source_quotes[0],reason:'The soup is a separately supported independent meal.'}))};
  if(ctx.purpose==='source_erasure')return {decisions:d.SOURCES.map((s:any)=>({index:s.index,effect:s.text.includes('mild soup')?'retain':'erase',erase_quotes:[],reason:s.text.includes('mild soup')?'independent_record':'same_erased_record'}))};
  return structuredClone(proposal);
 }} as any;
 const prepare=(r:any,p:any)=>{proposal=p;return new Extractor(config,model).prepare(r,store.snapshot('s'),AbortSignal.timeout(3000));};
 const commit=(r:any,p:any,fail?:string)=>store.commit(r,hash(JSON.stringify(r)),p,store.revision(),fail);
 try{
  const seed=request('seed',[`My ${scope} costs fifteen dollars.`,'My mild soup costs fifteen dollars.']);commit(seed,await prepare(seed,{facts:[fact(seed.messages[0].content,0,scope),fact(seed.messages[1].content,1,'mild soup')],operations:[]}));
  const target=store.facts().find(f=>f.scope===scope)!;
  const del=request('delete',[`Forget the price of my ${scope}.`]);const erased=await prepare(del,{facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'meal_price',scope,value:'fifteen dollars',boundary:'property',source:{index:0,quote:del.messages[0].content}}]});
  const before=store.snapshot('s');assert.throws(()=>commit(del,erased,'indexes'));assert.deepEqual(store.snapshot('s'),before);commit(del,erased);
  for(const table of ['facts','messages','passages','markers','operations','memory_events']){
   assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT body FROM '+table).all()),/Thai-hot/,'scope detail leaked through '+table);
  }
  const tombstone=store.facts().find(f=>f.id===target.id)!;assert.equal(tombstone.scope,'');assert.match((tombstone as any).scopeHash,/^[a-f0-9]{64}$/);
  assert.ok(store.facts().some(f=>f.scope==='mild soup'&&f.state==='active'));
  store.close();store=new TenantStore(dir,'u',sourceFormatFor(config));
  const wrong=request('wrong-restore',['Remember my mild soup price again.']);
  await assert.rejects(prepare(wrong,{facts:[],operations:[{type:'restore',target_ids:[target.id],subject:'user',predicate:'meal_price',scope:'mild soup',value:'fifteen dollars',source:{index:0,quote:wrong.messages[0].content}}]}),/target|scope/i);
  const echo=request('echo',[seed.messages[0].content]);commit(echo,await prepare(echo,{facts:[fact(echo.messages[0].content,0,scope)],operations:[]}));
  assert.ok(!store.facts().some(f=>f.state==='active'&&f.scope===scope));assert.ok(store.facts().some(f=>f.scope==='mild soup'&&f.state==='active'));
  const restore=request('restore',[`Remember the price of my ${scope} again: fifteen dollars.`]);
  commit(restore,await prepare(restore,{facts:[fact(restore.messages[0].content,0,scope)],operations:[{type:'restore',target_ids:[target.id],subject:'user',predicate:'meal_price',scope,value:'fifteen dollars',source:{index:0,quote:restore.messages[0].content}}]}));
  assert.ok(store.facts().some(f=>f.state==='active'&&f.scope===scope));assert.ok(store.facts().some(f=>f.scope==='mild soup'&&f.state==='active'));
  assert.doesNotMatch(store.db.prepare('SELECT body FROM messages WHERE id=?').get(before.erasureSources![0].id).body,/Thai-hot/);
  assert.ok(store.receipt(restore.request_id,hash(JSON.stringify(restore))));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('protected scope retains the certified boundary key and supplies exact operation coordinates without disclosing old scope',()=>{
 const marker={subject:'user',predicate:'meal_price',scope,boundary:'property',valueHash:'a'.repeat(64),tokenCount:2,revision:1};
 const protectedMarker=protectBoundary(marker);assert.equal(boundaryKey(protectedMarker),boundaryKey(marker));assert.deepEqual(protectBoundary(protectedMarker),protectedMarker);
 const erased:any={id:'old',subject:'user',predicate:'meal_price',scope:'',scopeHash:scopeKey(marker),content:'',value:'',state:'erased',modality:'confirmed',depends_on:[],supersedes:[]};
 assert.ok(retainedAgainst({...erased,erasure_exemptions:[{key:boundaryKey(marker),quote:'independent quote'}]},protectedMarker));
 const req=request('scope-check',['Remember my meal price again.']);
 const operations=[scope,'mild soup',''].map(context=>({type:'restore',target_ids:['old'],subject:'user',predicate:'meal_price',scope:context,value:'fifteen dollars',source:{index:0,quote:req.messages[0].content}}));
 const proposal=extractionSchema.parse({facts:[],operations});const row=verificationInput(req,proposal,[erased],[]).TARGET_FACTS[0]!;
 assert.equal(row.scope,'');assert.equal(row.scopeHash,scopeKey(marker));assert.deepEqual(row.matching_scope_operation_indices,[0]);assert.doesNotMatch(JSON.stringify(row),/Thai-hot/);
});
