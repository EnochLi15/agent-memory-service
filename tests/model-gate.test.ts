import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import OpenAI from 'openai';
import {Models} from '../dist/models.js';
import {configFromEnv} from '../dist/config.js';
import {ModelGate,sharedModelGate} from '../dist/model-gate.js';
import {modelRateLimitDelay} from '../dist/model-retry.js';

async function fixture(handle:any,body:(a:Models,b:Models)=>Promise<void>,env:NodeJS.ProcessEnv={}){
 const server=createServer(handle);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const config=configFromEnv({...env,MEMORY_LLM_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/v1`,MEMORY_LLM_API_KEY:'test-only'});
 try{await body(new Models(config),new Models(config));}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
function output(res:any){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"ok":true}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
const call=(m:Models,signal=AbortSignal.timeout(5000))=>m.json('Return JSON','{}',signal);

test('15 simultaneous calls across model instances produce only one active HTTP stream',async()=>{
 let active=0,peak=0,count=0;
 await fixture(async(req:any,res:any)=>{for await(const _ of req){}count++;active++;peak=Math.max(peak,active);await sleep(5);active--;output(res);},async(a,b)=>{
  const values=await Promise.all(Array.from({length:15},(_,i)=>call(i%2?a:b)));
  assert.ok(values.every(v=>JSON.stringify(v)==='{"ok":true}'));
 });
 assert.equal(count,15);assert.equal(peak,1);
});

test('cancelling a queued call rejects promptly without letting the next caller overtake',async()=>{
 const gate=new ModelGate(),signal=new AbortController().signal,queued=new AbortController();
 let release!:()=>void,started!:()=>void;const began=new Promise<void>(r=>{started=r;});
 const first=gate.run(signal,async()=>{started();await new Promise<void>(r=>{release=r;});});await began;
 const second=gate.run(queued.signal,async()=>assert.fail('cancelled work executed'));
 const rejected=assert.rejects(second,/cancelled/);queued.abort(new Error('cancelled'));await rejected;
 let thirdStarted=false;const third=gate.run(signal,async()=>{thirdStarted=true;});
 await sleep(10);assert.equal(thirdStarted,false);release();await Promise.all([first,third]);assert.equal(thirdStarted,true);
});

test('terminal 429 still delays another model instance using the same credential',async()=>{
 const starts:number[]=[];
 await fixture(async(req:any,res:any)=>{for await(const _ of req){}starts.push(Date.now());if(starts.length===1){res.writeHead(429,{'content-type':'application/json','retry-after-ms':'120'});res.end('{"error":{"message":"busy"}}');}else output(res);},async(a,b)=>{
  const first=assert.rejects(call(a));const second=call(b);await first;assert.deepEqual(await second,{ok:true});
 },{MEMORY_MODEL_TRANSPORT_ATTEMPTS:'1'});
 assert.equal(starts.length,2);assert.ok(starts[1]-starts[0]>=110);
});

test('long provider cooldown does not extend the next request deadline or send an extra HTTP call',async()=>{
 let count=0;
 await fixture(async(req:any,res:any)=>{for await(const _ of req){}count++;res.writeHead(429,{'content-type':'application/json','retry-after':'60'});res.end('{"error":{"message":"busy"}}');},async(a,b)=>{
  await assert.rejects(call(a));const start=Date.now();await assert.rejects(call(b,AbortSignal.timeout(30)));assert.ok(Date.now()-start<1000);
 });assert.equal(count,1);
});

test('spacing applies to separate instances and identical transport retry bodies',async()=>{
 const starts:number[]=[],bodies:string[]=[];
 await fixture(async(req:any,res:any)=>{let body='';for await(const x of req)body+=x;bodies.push(body);starts.push(Date.now());if(starts.length===1){res.writeHead(503,{'content-type':'application/json','retry-after-ms':'0'});res.end('{"error":{"message":"busy"}}');}else output(res);},async(a,b)=>{await Promise.all([call(a),call(b)]);},{MEMORY_MODEL_MIN_INTERVAL_MS:'70'});
 assert.equal(starts.length,3);assert.equal(bodies[0],bodies[1]);for(let i=1;i<3;i++)assert.ok(starts[i]-starts[i-1]>=60);
});

test('credential lanes are shared only for the same normalized endpoint and key',()=>{
 assert.equal(sharedModelGate('https://test.invalid/v1/','fake-a'),sharedModelGate('https://test.invalid/v1','fake-a'));
 assert.notEqual(sharedModelGate('https://test.invalid/v1','fake-a'),sharedModelGate('https://test.invalid/v1','fake-b'));
 assert.notEqual(sharedModelGate('https://test.invalid/v1','fake-a'),sharedModelGate('https://other.invalid/v1','fake-a'));
});

test('429 cooldown preserves long provider hints and uses bounded exponential fallback',()=>{
 const now=Date.parse('2026-09-07T00:00:00Z');
 const delay=(headers:Record<string,string>,attempt=0)=>modelRateLimitDelay(OpenAI.APIError.generate(429,{},undefined,new Headers(headers)),now,attempt);
 assert.equal(delay({'retry-after':'60'}),60000);assert.equal(delay({'retry-after-ms':'12000'}),12000);
 assert.equal(delay({'retry-after':'Mon, 07 Sep 2026 00:01:00 GMT'}),60000);
 assert.equal(delay({}),2000);assert.equal(delay({},1),4000);assert.equal(delay({},2),5000);
 assert.equal(modelRateLimitDelay(OpenAI.APIError.generate(503,{},undefined,new Headers())),null);
 for(const value of ['-1','1.5','60001','NaN'])assert.throws(()=>configFromEnv({MEMORY_MODEL_MIN_INTERVAL_MS:value}),/MEMORY_MODEL_MIN_INTERVAL_MS/);
});
