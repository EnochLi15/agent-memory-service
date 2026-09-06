import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';
test('streaming extraction aggregates chunks and rejects premature EOF',async()=>{let complete=true;const server=createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const body=JSON.parse(raw);assert.equal(body.stream,true);res.writeHead(200,{'Content-Type':'text/event-stream'});for(const text of ['{"facts":','[],"operations":[]}'])res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n');if(complete)res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');res.end();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{const m=new Models({...configFromEnv({}),llmBase:`http://127.0.0.1:${(server.address() as any).port}`});assert.deepEqual(await m.json('s','u',AbortSignal.timeout(1000)),{facts:[],operations:[]});complete=false;await assert.rejects(()=>m.json('s','u',AbortSignal.timeout(1000)),/Incomplete/);}finally{await new Promise<void>(r=>server.close(()=>r()));}});

test('explicit reasoning effort is sent without changing the provider-default request',async()=>{
 const bodies:any[]=[];const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;bodies.push(JSON.parse(raw));res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  for(const env of [{},{MEMORY_LLM_REASONING_EFFORT:'low'}])await new Models({...configFromEnv(env),llmBase:base}).json('fixture','{}',AbortSignal.timeout(1000));
  assert.equal('reasoning_effort'in bodies[0],false);assert.equal(bodies[1].reasoning_effort,'low');assert.throws(()=>configFromEnv({MEMORY_LLM_REASONING_EFFORT:'invalid'}),/REASONING_EFFORT/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('stage routing uses explicit caller purpose and records the actual model without changing budgets',async()=>{
 const bodies:any[]=[];const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;bodies.push(JSON.parse(raw));res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const c=configFromEnv({MEMORY_LLM_MODEL:'base',MEMORY_EXTRACTION_MODEL:'fast',MEMORY_VERIFICATION_MODEL:'critic',MEMORY_REPAIR_MODEL:'repair',MEMORY_LLM_REASONING_EFFORT:'low'});c.llmBase=`http://127.0.0.1:${(server.address() as any).port}`;const m=new Models(c);
  await m.json('ordinary extraction','u',AbortSignal.timeout(1000));
  await m.json('Validate memory evidence','u',AbortSignal.timeout(1000));
  await m.json('PATCH_SCHEMA','u',AbortSignal.timeout(1000));
  await (m.json as any)('ordinary extraction with malformed proposal repair','u',AbortSignal.timeout(1000),{purpose:'repair'});
  await m.json('Rank evidence','u',AbortSignal.timeout(1000));
  assert.deepEqual(bodies.map(b=>b.model),['fast','critic','repair','repair','base']);
  assert.ok(bodies.every(b=>b.reasoning_effort==='low'&&b.max_completion_tokens===10000&&b.stream===true));assert.equal(c.addTimeout,115000);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('unsupported stage model errors retain the actual route in audit and never switch models',async()=>{
 const bodies:any[]=[],dir=mkdtempSync(join(tmpdir(),'memory-stage-audit-')),path=join(dir,'audit.jsonl'),previous=process.env.MEMORY_MODEL_AUDIT;
 const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;bodies.push(JSON.parse(raw));res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Unsupported fixture model',type:'invalid_request_error'}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.MEMORY_MODEL_AUDIT=path;
 try{
  const config=configFromEnv({MEMORY_LLM_MODEL:'base',MEMORY_REPAIR_MODEL:'unsupported-repair'});config.llmBase=`http://127.0.0.1:${(server.address() as any).port}`;
  await assert.rejects(new Models(config).json('complete-schema repair','u',AbortSignal.timeout(1000),{purpose:'repair'}),/Unsupported fixture/);
  assert.deepEqual(bodies.map(b=>b.model),['unsupported-repair','unsupported-repair']);
  const audit=readFileSync(path,'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.equal(audit.length,2);assert.ok(audit.every(x=>x.purpose==='repair'&&x.model==='unsupported-repair'&&x.outcome==='error'));
 }finally{if(previous===undefined)delete process.env.MEMORY_MODEL_AUDIT;else process.env.MEMORY_MODEL_AUDIT=previous;await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true});}
});
