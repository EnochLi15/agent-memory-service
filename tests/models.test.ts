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
