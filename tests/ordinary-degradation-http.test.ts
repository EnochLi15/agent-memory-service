import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildServer} from '../dist/server.js';
import {configFromEnv} from '../dist/config.js';

test('ordinary HTTP 400 degrades once, stays searchable and idempotent, and the next write resumes verified extraction',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ordinary-http-recovery-'));let extraction=0,verification=0;
 const audit=join(dir,'audit.jsonl'),previous=process.env.MEMORY_MODEL_AUDIT;
 const provider=createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('content-type','application/json');res.end('{}');return;}
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  if(req.url==='/api/embed'){res.setHeader('content-type','application/json');res.end(JSON.stringify({embeddings:body.input.map(()=>[1,0])}));return;}
  let value:unknown;
  if(body.messages[0].content.startsWith('Validate memory evidence')){
   verification++;value={fact_checks:[[0,true,true,0]],operation_checks:[],replacement_checks:[],message_checks:[[0,'represented',[0],[]]]};
  }else{
   extraction++;
   if(extraction===1){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'1301',message:'Fixture provider rejection'}}));return;}
   value={facts:[{subject:'user',predicate:'city',value:'Oslo',content:'I live in Oslo.',sources:[{index:0,quote:'I live in Oslo.'}]}],operations:[]};
  }
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(value)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const port=(provider.address() as any).port;
 process.env.MEMORY_MODEL_AUDIT=audit;
 const app=await buildServer(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_VERIFICATION_FORMAT:'compact',MEMORY_MODEL_TRANSPORT_ATTEMPTS:'3',MEMORY_DATA_DIR:dir,MEMORY_EMBEDDING_DIMENSIONS:'2',MEMORY_EMBEDDING_BASE_URL:`http://127.0.0.1:${port}`,MEMORY_LLM_BASE_URL:`http://127.0.0.1:${port}/v1`,MEMORY_LLM_API_KEY:'fixture'}));
 try{
  const base=await app.listen({host:'127.0.0.1',port:0});
  const post=async(path:string,payload:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return response.json() as Promise<any>;};
  const request=(request_id:string,content:string)=>({user_id:'u',request_id,session_id:request_id,messages:[{role:'user',content,timestamp:'2026-01-01T00:00:00Z'}]});
  const first=request('rejected','My browser is Firefox.');
  assert.equal((await post('/add',first)).success,true);assert.deepEqual([extraction,verification],[1,0],'400 must not be retried even with three transport attempts configured');
  assert.match(JSON.stringify(await post('/search',{user_id:'u',query:'What is my browser?',top_k:100})),/Firefox/);
  await post('/add',first);assert.deepEqual([extraction,verification],[1,0]);
  assert.equal((await post('/add',request('healthy','I live in Oslo.'))).success,true);
  assert.deepEqual([extraction,verification],[2,1],'A previous rejection must not disable extraction for later requests');
  assert.match(JSON.stringify(await post('/search',{user_id:'u',query:'Where do I live?',top_k:100})),/Oslo/);
  const rows=readFileSync(audit,'utf8').trim().split('\n').map(x=>JSON.parse(x)).filter(r=>r.kind==='generation');
  assert.equal(rows[0].provider_error_code,'1301');assert.equal(rows[0].stream_started,false);
  assert.deepEqual(rows.map(r=>r.outcome),['error','ok','ok']);
 }finally{
  await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));
  if(previous===undefined)delete process.env.MEMORY_MODEL_AUDIT;else process.env.MEMORY_MODEL_AUDIT=previous;
  rmSync(dir,{recursive:true,force:true});
 }
});
