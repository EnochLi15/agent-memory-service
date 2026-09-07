import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Models} from '../dist/models.js';
import {configFromEnv} from '../dist/config.js';

test('complete JSON with only trailing commas is parsed once without changing quoted punctuation or false checks',async()=>{
 let calls=0;const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'{"text":"literal ,] and ,} and \\\"quote\\\"","checks":[false,null,],}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const m=new Models(configFromEnv({MEMORY_LLM_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/v1`}));assert.deepEqual(await m.json('fixture','{}',AbortSignal.timeout(2000)),{text:'literal ,] and ,} and "quote"',checks:[false,null]});assert.equal(calls,1);}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('an unfinished SDK provider error frame retries the identical request and discards partial JSON',async()=>{
 const bodies:unknown[]=[];
 const server=createServer(async(req,res)=>{
  let input='';for await(const part of req)input+=part;bodies.push(JSON.parse(input));
  res.writeHead(200,{'content-type':'text/event-stream','retry-after-ms':'1'});
  if(bodies.length===1){
   res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"wrong":'},finish_reason:null}]})+'\n\n');
   res.end('data: '+JSON.stringify({error:{message:'Upstream request failed'}})+'\n\n');
  }else res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"facts":[]}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const m=new Models(configFromEnv({MEMORY_LLM_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/v1`}));
  assert.deepEqual(await m.json('fixture','same proposal',AbortSignal.timeout(3000)),{facts:[]});
  assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('explicit permanent stream errors, refusals and completed output are not sampled again',async()=>{
 for(const mode of ['authentication_error','invalid_request_error','insufficient_quota','unknown_error','refusal','completed','bad_json','no_retry']){
  let calls=0;
  const server=createServer(async(req,res)=>{
   for await(const _ of req){}calls++;
   res.writeHead(200,{'content-type':'text/event-stream',...(mode==='no_retry'?{'x-should-retry':'false'}:{})});
   const delta=mode==='refusal'?{refusal:'Cannot comply'}:{content:mode==='bad_json'?'invalid JSON':'{"facts":[]}'};
   res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:['completed','bad_json'].includes(mode)?'stop':null}]})+'\n\n');
   if(mode==='bad_json')res.end('data: [DONE]\n\n');
   else res.end('data: '+JSON.stringify({error:{message:'Upstream request failed',...(!['refusal','completed','no_retry'].includes(mode)?{type:mode}:{})}})+'\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const m=new Models(configFromEnv({MEMORY_LLM_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/v1`}));
   await assert.rejects(m.json('fixture','input',AbortSignal.timeout(3000)));assert.equal(calls,1,mode);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});
