import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';

test('failure audit distinguishes HTTP rejection, truncated output and filtered completion without echoing credentials',async()=>{
 const key='fixture-sensitive-value-never-log',dir=mkdtempSync(join(tmpdir(),'memory-failure-audit-')),trace=join(dir,'trace.jsonl'),audit=join(dir,'audit.jsonl');
 const previous={trace:process.env.MEMORY_MODEL_TRACE,audit:process.env.MEMORY_MODEL_AUDIT};let mode='http';
 const server=createServer(async(req,res)=>{
  for await(const _ of req){}
  if(mode==='http'){res.writeHead(429,{'content-type':'application/json','x-request-id':key});res.end(JSON.stringify({error:{message:key,type:'rate_limit_error',code:'rate_limit_exceeded'}}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const finish=mode==='filtered'?'content_filter':mode==='length'?'length':null;
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"facts":'},finish_reason:finish}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.MEMORY_MODEL_TRACE=trace;process.env.MEMORY_MODEL_AUDIT=audit;
 try{
  const config=configFromEnv({MEMORY_LLM_API_KEY:key});config.llmBase=`http://127.0.0.1:${(server.address() as any).port}`;const m=new Models(config);
  for(mode of ['http','filtered','length','truncated'])await assert.rejects(m.json('fixture','input',AbortSignal.timeout(1000),{purpose:'repair'}));
  const rows=readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r=>r.error_category),['provider_http','provider_http','provider_filtered','output_limit','incomplete_output']);
  assert.ok(rows.slice(0,2).every(r=>r.http_status===429&&r.stream_started===false));assert.ok(rows.slice(2).every(r=>r.http_status===null&&r.stream_started===true));
  assert.deepEqual(rows.slice(2).map(r=>r.finish_reason),['content_filter','length',null]);
  assert.ok(!readFileSync(trace,'utf8').includes(key));assert.ok(!readFileSync(audit,'utf8').includes(key));
 }finally{
  if(previous.trace===undefined)delete process.env.MEMORY_MODEL_TRACE;else process.env.MEMORY_MODEL_TRACE=previous.trace;
  if(previous.audit===undefined)delete process.env.MEMORY_MODEL_AUDIT;else process.env.MEMORY_MODEL_AUDIT=previous.audit;
  await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
 }
});

import OpenAI from 'openai';import {modelFailure} from '../dist/model-failure.js';
test('deadline, caller cancellation and connection errors have distinct bounded metadata',()=>{
 const timeout=AbortSignal.abort(new DOMException('private timeout detail','TimeoutError')),cancelled=AbortSignal.abort();
 assert.equal(modelFailure(new Error('private detail'),timeout,false,null).error_category,'deadline');
 assert.equal(modelFailure(new Error('private detail'),cancelled,false,null).error_category,'cancelled');
 const cause=Object.assign(new Error('private connection endpoint'),{code:'ECONNRESET'}),connection=new OpenAI.APIConnectionError({cause});
 const failure=modelFailure(connection,new AbortController().signal,true,null);assert.equal(failure.error_category,'connection');assert.equal(failure.transport_code,'ECONNRESET');assert.equal(failure.stream_started,true);assert.ok(!JSON.stringify(failure).includes('private'));
 const unknown=Object.assign(new Error('private detail'),{code:'private-unlisted-code'});assert.equal(modelFailure(unknown,new AbortController().signal,false,null).transport_code,null);
});
