import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {sourceOperationWork,resolvedSourceInstructions} from '../dist/source-operations.js';
import {sourceRouteInput,decodeSourceRoute,ordinarySourceRoute,validateSourceRoutePlan} from '../dist/source-operation-routing.js';
import {sourceOperationNeedsBatches,prepareSourceBatches} from '../dist/source-operation-batches.js';
import {configFromEnv} from '../dist/config.js';import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';
const timestamp='2026-01-01T00:00:00Z',quote='Forget my old dentist appointment.';
const req={user_id:'u',request_id:'forget',session_id:'s',messages:[{role:'user',content:quote,timestamp}]};
const history=Array.from({length:100},(_,i)=>({id:'history-'+i,role:'assistant',session_id:'s',ordinal:i,content:'Unrelated astronomy. '.repeat(120),timestamp,searchable:true}));
const work=()=>sourceOperationWork(req,[],history);
const ordinary={rows:[{instruction:0,route:'ordinary',witness:{message:0,quote}}]};
const env={MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SEMANTIC_TRANSITIONS:'true',MEMORY_SOURCE_OPERATIONS:'true',MEMORY_SOURCE_OPERATION_HISTORY:'true',MEMORY_SOURCE_OPERATION_BATCHES:'true',MEMORY_SOURCE_OPERATION_ROUTING:'true'};
test('complete ordinary route bypasses large historical screening but resolves no forget obligation',()=>{
 const w=work(),r=decodeSourceRoute(ordinary,w),p=ordinarySourceRoute(w,r)!;assert.ok(sourceOperationNeedsBatches(w));assert.ok(JSON.stringify(sourceRouteInput(w)).length<1000);validateSourceRoutePlan(p,w);assert.deepEqual(resolvedSourceInstructions(p,req,[],history),[]);assert.equal(p.batch_review,undefined);
});
test('routing rejects incomplete, duplicate, invented, assistant and future witnesses',()=>{
 const w=work();for(const rows of [[],[...ordinary.rows,...ordinary.rows],[{...ordinary.rows[0],instruction:99}],[{...ordinary.rows[0],witness:null}],[{...ordinary.rows[0],witness:{message:0,quote:'invented'}}],[{instruction:0,route:'source_review',witness:{message:0,quote}}]])assert.throws(()=>decodeSourceRoute({rows},w));
 const altered=sourceOperationWork({...req,messages:[{role:'assistant',content:'My dentist appointment.',timestamp},...req.messages,{role:'user',content:'Later fact.',timestamp}]},[],history);
 for(const witness of [{message:0,quote:'My dentist appointment.'},{message:2,quote:'Later fact.'}])assert.throws(()=>decodeSourceRoute({rows:[{...ordinary.rows[0],witness}]},altered),/earlier current human/);
 const later=sourceOperationWork({...req,messages:[{...req.messages[0],content:quote+' A later fact.'}]},[],history);assert.equal(decodeSourceRoute({rows:[{...ordinary.rows[0],witness:{message:0,quote:quote+' A later fact.'}}]},later).rows[0].route,'ordinary');
});
test('request, facts and full history identity changes invalidate routing proof',()=>{
 const w=work(),p=ordinarySourceRoute(w,decodeSourceRoute(ordinary,w))!;
 for(const changed of [sourceOperationWork({...req,request_id:'different'},[],history),sourceOperationWork(req,[],history.map((m,i)=>i?m:{...m,content:'Changed history.'})),{...w,facts:[{id:'new'}],fingerprint:'facts changed'}])assert.throws(()=>validateSourceRoutePlan(p,changed as any),/identity/);
 const corrupt=structuredClone(p);corrupt.route_review!.rows=[];assert.throws(()=>validateSourceRoutePlan(corrupt,w),/Missing/);
 const cuts=structuredClone(p);cuts.decisions[0].cuts=[{message:0,quote}];assert.throws(()=>validateSourceRoutePlan(cuts,w),/unauthorized cuts/);
});
test('source review and mixed routing cannot bypass complete historical proof or promote ordinary to source cuts',async()=>{
 const mixed={...req,messages:[...req.messages,{role:'user',content:'Forget that earlier claim.',timestamp}]},w=sourceOperationWork(mixed,[],history);
 const review=decodeSourceRoute({rows:[ordinary.rows[0],{instruction:1,route:'source_review',witness:null}]},w);assert.equal(ordinarySourceRoute(w,review),undefined);
 const plan=await prepareSourceBatches(w,AbortSignal.timeout(3000),async(_p,input,_s,purpose)=>{const x=JSON.parse(input);if(purpose==='source_operation_screen')return {rows:x.UNITS.map((u:any)=>[u.unit,'irrelevant'])};assert.equal(purpose,'source_operation');return {decisions:w.instructions.map(i=>({instruction:i.slot,action:'ordinary',target_slots:[],cuts:[]}))};});
 const routed={...plan,route_review:review};validateSourceRoutePlan(routed,w);const incomplete=structuredClone(routed);delete incomplete.batch_review;assert.throws(()=>validateSourceRoutePlan(incomplete,w),/lacks complete/);
 const promoted=structuredClone(routed),slot=w.targets[0].slot;promoted.decisions[0]={instruction:0,action:'reject_source',target_slots:[slot],cuts:[{message:slot,quote:w.sources[slot].content},{message:0,quote}]};assert.throws(()=>validateSourceRoutePlan(promoted,w),/cannot authorize/);
});
test('v9 requires routing dependencies and fresh directory',()=>{assert.throws(()=>configFromEnv({MEMORY_SOURCE_OPERATION_ROUTING:'true'}),/requires batched/);assert.equal(configFromEnv({}).sourceOperationRouting,false);});
test('ordinary route cannot certify unknown forget as no-op even when extraction and semantic stubs omit it',async()=>{
 let routed=0,historyCalls=0;const config=configFromEnv(env),models={json:async(_p:string,_i:string,_s:AbortSignal,c:any)=>{if(c.purpose==='source_operation_route'){routed++;return ordinary;}if(c.purpose.startsWith('source_operation')){historyCalls++;throw Error('unexpected full review');}return {facts:[],operations:[]};},verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 await assert.rejects(()=>new Extractor(config,models as any).prepare(req,{revision:1,facts:[],tail:[],anchor:null,erasureSources:history,erasureBoundaries:[]},AbortSignal.timeout(3000)));assert.equal(routed,1);assert.equal(historyCalls,0);
});
test('v9 validates routing at atomic commit and refuses reuse of v8 storage',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-route-')),store=new TenantStore(dir,'u'),config=configFromEnv(env);
 const command="Please don't store that.",request={...req,messages:[{role:'assistant',content:'Your gym is Peak Gym.',timestamp},{role:'user',content:command,timestamp}]};
 const models={json:async(_p:string,i:string,_s:AbortSignal,c:any)=>{if(c.purpose==='source_operation_route')return {rows:[{instruction:0,route:'source_review',witness:null}]};if(c.purpose==='source_operation')return {decisions:[{instruction:0,action:'reject_source',target_slots:[0],cuts:[{message:0,quote:'Your gym is Peak Gym.'},{message:1,quote:command}]}]};if(c.purpose==='extraction')return {facts:[],operations:[]};throw Error(c.purpose);},verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 try{const x=new Extractor(config,models as any),before=store.snapshot('s'),p=await x.prepare(request,before,AbortSignal.timeout(3000));assert.equal(p.sourceFormat,'dual-source-v9');const corrupt=structuredClone(p);delete corrupt.sourceOperationPlan!.route_review;assert.throws(()=>store.commit(request,hash(JSON.stringify(request)),corrupt,0),/Missing source routing/);assert.deepEqual(store.snapshot('s'),before);assert.throws(()=>store.commit(request,hash(JSON.stringify(request)),p,0,'indexes'));assert.deepEqual(store.snapshot('s'),before);store.commit(request,hash(JSON.stringify(request)),p,0);assert.equal(store.meta('source_format'),'dual-source-v9');assert.doesNotMatch(JSON.stringify(store.snapshot('s').erasureSources),/Peak Gym/);
 const next={...req,request_id:'next',messages:[{role:'user',content:'Hello.',timestamp}]},old=await new Extractor({...config,sourceOperationRouting:false},models as any).prepare(next,store.snapshot('s'),AbortSignal.timeout(3000));assert.throws(()=>store.commit(next,hash(JSON.stringify(next)),old,1),/format|directory/i);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('atomic v9 commit rejects an all-ordinary proof with omitted operations before any mutation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-route-noop-')),store=new TenantStore(dir,'u');
 try{const request={...req,messages:[{role:'assistant',content:'Earlier context.',timestamp},...req.messages]},w=sourceOperationWork(request,[]),review=decodeSourceRoute({rows:[{instruction:0,route:'ordinary',witness:{message:1,quote}}]},w),before=store.snapshot('s');
 const prepared={sourceFormat:'dual-source-v9',sourceOperationPlan:ordinarySourceRoute(w,review),facts:[],operations:[],messages:[],anchor:null,degraded:[],embeddingSpace:'test'};
 assert.throws(()=>store.commit(request,hash(JSON.stringify(request)),prepared as any,0),/unexecuted forget/);assert.deepEqual(store.snapshot('s'),before);assert.equal(store.revision(),0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
