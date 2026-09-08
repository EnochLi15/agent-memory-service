import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configFromEnv} from '../dist/config.js';
import {Engine} from '../dist/engine.js';
import {Models} from '../dist/models.js';
import {QueryFocusClassifier} from '../dist/query-focus.js';
import {TenantStore} from '../dist/storage.js';
import {Extractor,hash} from '../dist/extraction.js';
import {retrieve} from '../dist/retrieval.js';

function output(res:any,value:unknown){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
async function provider(fn:(req:any,res:any,body:any)=>void,run:(config:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'focus-provider-'));
 const server=createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;fn(req,res,text?JSON.parse(text):{});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{await run({...configFromEnv({MEMORY_MODE:'enhanced',MEMORY_QUERY_FOCUS:'true'}),dataDir:dir,llmBase:base+'/v1',embeddingBase:base,embeddingDimensions:2,queryFocusTimeout:500});}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
}
async function seed(config:any,query:string){
 const store=new TenantStore(config.dataDir,'u');
 try{
  for(const [i,content] of ['My favorite hobby is hiking.','Mara: My favorite hobby is chess.','Noel: My favorite hobby is pottery.'].entries()){
   const req={request_id:`seed${i}`,user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp:'2026-01-01T00:00:00Z'}]};
   const p=await new Extractor({...config,mode:'offline'},{} as any).prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));store.commit(req,hash(JSON.stringify(req)),p,store.revision());
  }
  const req={user_id:'u',query,top_k:32};return {baseline:retrieve(store,req,null,{...config,queryFocus:false}),expanded:retrieve(store,req,null,config,'other_people')};
 }finally{store.close();}
}

test('Engine starts query focus and embedding concurrently and caches only the query decision',async()=>{
 const query='What hobbies did I tell you about for my friends?';let embeds=0,focus=0;let release:any;let body:any;
 await provider((req,res,input)=>{
  if(req.url==='/api/embed'){embeds++;if(embeds===1)release=()=>{release=undefined;res.setHeader('content-type','application/json');res.end(JSON.stringify({embeddings:[[1,0]]}));};else {res.setHeader('content-type','application/json');res.end(JSON.stringify({embeddings:[[1,0]]}));}if(focus)release?.();}
  else{focus++;body=input;output(res,{focus:'other_people',evidence:[{quote:'hobbies did I tell you about for my friends'}]});release?.();}
 },async config=>{
  const expected=await seed(config,query);assert.notDeepEqual(expected.expanded,expected.baseline);
  const engine=new Engine(config);
  try{
   assert.deepEqual(await engine.search({query,user_id:'u',top_k:32},AbortSignal.timeout(1500)),expected.expanded);
   assert.deepEqual(await engine.search({query,user_id:'u',top_k:32},AbortSignal.timeout(1500)),expected.expanded);
   assert.equal(focus,1);assert.equal(embeds,2);assert.deepEqual(JSON.parse(body.messages[1].content),{query});assert.equal(body.max_completion_tokens,512);assert.deepEqual(body.response_format,{type:'json_object'});
  }finally{await engine.close();}
 });
});

test('real Models query_focus has one transport attempt and audited output limits',async()=>{
 for(const failure of ['503','oversized','invalid_json']){
  let calls=0;
  await provider((_req,res,body)=>{
   calls++;assert.equal(body.max_completion_tokens,512);
   if(failure==='503'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture unavailable'}}));}
   else output(res,failure==='oversized'?' '.repeat(4097)+'{}':'{"focus":');
  },async config=>{
   const audit=join(config.dataDir,'audit.jsonl'),old=process.env.MEMORY_MODEL_AUDIT;process.env.MEMORY_MODEL_AUDIT=audit;
   try{
    const classifier=new QueryFocusClassifier({...config,modelTransportAttempts:3},new Models({...config,modelTransportAttempts:3}));
    const result=await classifier.classify('the plans of my colleagues',AbortSignal.timeout(1500));
    assert.equal(result.focus,'unknown');assert.equal(result.outcome,'fallback');assert.equal(calls,1);
    const rows=readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse),generation=rows.filter(x=>x.kind==='generation');
    assert.equal(generation.length,1);assert.equal(generation[0].purpose,'query_focus');assert.equal(generation[0].transport_attempt_limit,1);assert.equal(generation[0].max_completion_tokens,512);assert.equal(generation[0].output_char_limit,4096);assert.equal(rows.some(x=>x.kind==='generation_retry'),false);
   }finally{if(old===undefined)delete process.env.MEMORY_MODEL_AUDIT;else process.env.MEMORY_MODEL_AUDIT=old;}
  });
 }
});

test('real provider deadline aborts the request and unknown preserves Engine baseline',async()=>{
 const query='my favorite hobby';let pending:any,focus=0;
 await provider((req,res)=>{
  if(req.url==='/api/embed'){res.setHeader('content-type','application/json');res.end(JSON.stringify({embeddings:[[1,0]]}));}
  else{focus++;pending=res;}
 },async config=>{
  config.queryFocusTimeout=100;const expected=await seed(config,query);const engine=new Engine(config);
  try{
   const start=performance.now();assert.deepEqual(await engine.search({query,user_id:'u',top_k:32},AbortSignal.timeout(1500)),expected.baseline);assert.ok(performance.now()-start<1000);assert.equal(focus,1);
   await new Promise(r=>setTimeout(r,30));assert.equal(pending.destroyed,true);
  }finally{await engine.close();}
 });
});

test('Engine invalid and unknown focus preserve nonempty baseline; parent abort never becomes successful Search',async()=>{
 const query='my favorite hobby';let mode='unknown';
 await provider((req,res)=>{
  if(req.url==='/api/embed'){res.setHeader('content-type','application/json');res.end(JSON.stringify({embeddings:[[1,0]]}));}
  else if(mode==='unknown')output(res,{focus:'unknown',evidence:[]});
  else if(mode==='invalid')output(res,{focus:'other_people',evidence:[{quote:'not present'}]});
 },async config=>{
  const expected=await seed(config,query);
  for(const current of ['unknown','invalid','abort']){
   mode=current;const engine=new Engine(config);
   try{
    if(current==='abort'){const controller=new AbortController();const search=engine.search({query,user_id:'u',top_k:32},controller.signal);setTimeout(()=>controller.abort(),20);await assert.rejects(()=>search);}
    else assert.deepEqual(await engine.search({query,user_id:'u',top_k:32},AbortSignal.timeout(1500)),expected.baseline);
   }finally{await engine.close();}
  }
 });
});
