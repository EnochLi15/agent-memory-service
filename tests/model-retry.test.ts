import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';
async function fixture(handle:any,body:(m:Models)=>Promise<void>,env:NodeJS.ProcessEnv={}){
 const server=createServer(handle);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const model=new Models(configFromEnv({...env,MEMORY_LLM_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/v1`}));
 try{await body(model);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
function output(res:any){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"fact_edits":[]}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
const call=(m:Models,signal=AbortSignal.timeout(3000))=>m.json('PATCH_SCHEMA; preserve the rejected proposal','{"REPAIR_SCOPE":{"fact_indices":[2]}}',signal,{purpose:'repair'});
test('repair retries wait for a short provider hint and send exactly the same body',async()=>{
 const requests:any[]=[];let first=0;
 await fixture(async(req:any,res:any)=>{let text='';for await(const x of req)text+=x;requests.push(JSON.parse(text));
  if(requests.length===1){first=performance.now();res.writeHead(503,{'content-type':'application/json','retry-after-ms':'200'});res.end('{"error":{"message":"temporarily unavailable"}}');return;}
  if(performance.now()-first<150){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":{"message":"retry arrived too early"}}');return;}
  output(res);
 },async m=>assert.deepEqual(await call(m),{fact_edits:[]}));
 assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
});
test('permanent provider errors and excessive retry hints do not spend a second call',async()=>{
 for(const mode of ['permanent','long_hint','no_retry']){
  let calls=0;await fixture(async(req:any,res:any)=>{for await(const _ of req){}calls++;res.writeHead(mode==='permanent'?400:503,{'content-type':'application/json',...(mode==='long_hint'?{'retry-after':'60'}:{}),...(mode==='no_retry'?{'x-should-retry':'false'}:{})});res.end('{"error":{"message":"private provider detail"}}');},async m=>{await assert.rejects(call(m));});assert.equal(calls,1,mode);
 }
});
test('request cancellation interrupts backoff before a second model call',async()=>{
 let calls=0;const controller=new AbortController();
 await fixture(async(req:any,res:any)=>{for await(const _ of req){}calls++;if(calls===1){res.writeHead(503,{'content-type':'application/json','retry-after-ms':'1000'});res.end('{"error":{"message":"busy"}}');setTimeout(()=>controller.abort(),30);}else output(res);},async m=>{await assert.rejects(call(m,controller.signal));});assert.equal(calls,1);
});
test('transient provider failure still permits at most the original two attempts',async()=>{
 let calls=0;await fixture(async(req:any,res:any)=>{for await(const _ of req){}calls++;res.writeHead(503,{'content-type':'application/json','retry-after-ms':'1'});res.end('{"error":{"message":"busy"}}');},async m=>{await assert.rejects(call(m));});assert.equal(calls,2);
});

import OpenAI from 'openai';import {modelRetryDelay} from '../dist/model-retry.js';import {ServiceError} from '../dist/types.js';
test('retry hint parsing is bounded and never turns protocol or semantic failures into retries',()=>{
 const signal=new AbortController().signal,now=Date.parse('2026-09-06T00:00:00Z');
 const delay=(headers:Record<string,string>)=>modelRetryDelay(OpenAI.APIError.generate(503,{},undefined,new Headers(headers)),signal,now);
 assert.equal(delay({}),500);assert.equal(delay({'retry-after':'0.25'}),250);assert.equal(delay({'retry-after-ms':'0'}),0);
 assert.equal(delay({'retry-after-ms':'200','retry-after':'1'}),200);
 assert.equal(delay({'retry-after':'Sun, 06 Sep 2026 00:00:03 GMT'}),3000);assert.equal(delay({'retry-after':'Sun, 06 Sep 2026 00:01:00 GMT'}),null);
 assert.equal(delay({'retry-after':'-1'}),500);assert.equal(delay({'retry-after-ms':'100oops'}),500);assert.equal(delay({'retry-after-ms':'6000'}),null);
 for(const error of [new Error('Connection error.'),new SyntaxError('bad JSON'),new ServiceError('EVIDENCE_VALIDATION','unsupported fact'),new ServiceError('MODEL_OUTPUT','Incomplete model output')])assert.equal(modelRetryDelay(error,signal),null);
 assert.equal(modelRetryDelay(new OpenAI.APIConnectionError({}),AbortSignal.abort()),null);
});

test('three transport attempts require opt-in and still preserve the same rejected repair input',async()=>{
 assert.equal(configFromEnv({}).modelTransportAttempts,2);
 for(const n of ['0','4','1.5','NaN'])assert.throws(()=>configFromEnv({MEMORY_MODEL_TRANSPORT_ATTEMPTS:n}),/MEMORY_MODEL_TRANSPORT_ATTEMPTS/);
 for(const limit of [1,2,3]){
  const bodies:any[]=[];
  await fixture(async(req:any,res:any)=>{let text='';for await(const x of req)text+=x;bodies.push(JSON.parse(text));if(bodies.length<3){res.writeHead(503,{'content-type':'application/json','retry-after-ms':'1'});res.end('{"error":{"message":"busy"}}');}else output(res);},async m=>{if(limit===3)assert.deepEqual(await call(m),{fact_edits:[]});else await assert.rejects(call(m));},{MEMORY_MODEL_TRANSPORT_ATTEMPTS:String(limit)});
  assert.equal(bodies.length,limit);assert.ok(bodies.every(b=>JSON.stringify(b)===JSON.stringify(bodies[0])));
 }
 assert.equal(modelRetryDelay(new OpenAI.APIConnectionError({}),new AbortController().signal,Date.now(),1),1000);
});
