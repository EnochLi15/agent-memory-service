import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildServer} from '../dist/server.js';import {configFromEnv} from '../dist/config.js';

test('extraction invalid JSON is terminal on the first HTTP response and never retried through a closed ledger',async()=>{
 let calls=0;const dir=mkdtempSync(join(tmpdir(),'http-invalid-json-'));
 const provider=createServer(async(req,res)=>{for await(const _ of req){}if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'{"message_groups":[}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
 const app=await buildServer(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_WRITE_CONTINUATION:'true',MEMORY_MODEL_TRANSPORT_ATTEMPTS:'3',MEMORY_DATA_DIR:dir,MEMORY_LLM_BASE_URL:`http://127.0.0.1:${(provider.address() as any).port}/v1`,MEMORY_LLM_API_KEY:'fixture'}));
 const payload={user_id:'u',request_id:'invalid-json',session_id:'s',messages:[{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'}]};
 try{
  const response=await app.inject({method:'POST',url:'/add',payload});assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'EVIDENCE_VALIDATION');assert.match(response.json().error.message,/invalid JSON/);
  const retry=await app.inject({method:'POST',url:'/add',payload});assert.equal(retry.json().error.code,'EVIDENCE_VALIDATION');assert.equal(calls,1);
  const search=await app.inject({method:'POST',url:'/search',payload:{user_id:'u',query:'browser',top_k:10}});assert.deepEqual(search.json().data,[]);
 }finally{await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

for(const mode of ['recover','exhaust','transport_resume'])test(`verification JSON repair ${mode} preserves atomic HTTP writes and bounded continuation`,async()=>{
 let extraction=0,verification=0;const dir=mkdtempSync(join(tmpdir(),'http-verification-json-'));
 const provider=createServer(async(request,response)=>{
  // The readiness probe warms GET /models at startup (metadata only); it must
  // not reach the body parser as an empty POST.
  if(request.method==='GET'){response.writeHead(200,{'content-type':'application/json'});response.end('{}');return;}
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(request.url==='/api/embed'){response.setHeader('content-type','application/json');response.end(JSON.stringify({embeddings:body.input.map(()=>[1,0])}));return;}
  const system=body.messages[0].content;let text:string;
  if(system.startsWith('Validate memory evidence')){
   verification++;
   if(mode==='transport_resume'&&verification>=2&&verification<=4){request.socket.destroy();return;}
   if(verification===1||mode==='exhaust')text='{"fact_checks":[}';
   else{
    assert.match(body.messages[1].content,/PROTOCOL_REPAIR/);
    text=JSON.stringify({fact_checks:[[0,true,true,0]],operation_checks:[],replacement_checks:[],message_checks:[[0,'represented',[0],[]]]});
   }
  }else{
   extraction++;text=JSON.stringify({facts:[{subject:'user',predicate:'browser',value:'Firefox',content:'My browser is Firefox.',sources:[{index:0,quote:'My browser is Firefox.'}]}],operations:[]});
  }
  response.setHeader('content-type','text/event-stream');response.end('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const port=(provider.address() as any).port;
 const app=await buildServer(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_VERIFICATION_FORMAT:'compact',MEMORY_WRITE_CONTINUATION:'true',MEMORY_MODEL_TRANSPORT_ATTEMPTS:'3',MEMORY_SOURCE_INDEX:'false',MEMORY_DATA_DIR:dir,MEMORY_EMBEDDING_DIMENSIONS:'2',MEMORY_EMBEDDING_BASE_URL:`http://127.0.0.1:${port}`,MEMORY_LLM_BASE_URL:`http://127.0.0.1:${port}/v1`,MEMORY_LLM_API_KEY:'fixture'}));
 const payload={user_id:'u',request_id:mode,session_id:'s',messages:[{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'}]};
 const send=()=>app.inject({method:'POST',url:'/add',payload});
 try{
  let response=await send();
  if(mode==='transport_resume'){
   assert.equal(response.json().error.code,'WRITE_CONTINUATION_PENDING');assert.deepEqual([extraction,verification],[1,4]);
   assert.deepEqual((await app.inject({method:'POST',url:'/search',payload:{user_id:'u',query:'browser',top_k:10}})).json().data,[]);
   response=await send();assert.deepEqual([extraction,verification],[1,5],'The original invalid JSON is replayed, not generated again');
  }
  if(mode==='exhaust'){
   assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'EVIDENCE_VALIDATION');assert.equal(verification,2);
   assert.deepEqual((await app.inject({method:'POST',url:'/search',payload:{user_id:'u',query:'browser',top_k:10}})).json().data,[]);
   assert.equal((await send()).json().error.code,'EVIDENCE_VALIDATION');assert.equal(verification,2);
  }else{
   assert.equal(response.statusCode,200);assert.equal(response.json().success,true);const before=verification;
   assert.equal((await send()).statusCode,200);assert.equal(verification,before);assert.equal(extraction,1);
   const found=await app.inject({method:'POST',url:'/search',payload:{user_id:'u',query:'browser Firefox',top_k:10}});assert.ok(JSON.stringify(found.json().data).includes('Firefox'));
  }
 }finally{await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

for(const failure of ['connection','provider_stream'])test(`HTTP retries resume after actual SDK ${failure} failures without regenerating the rejected prefix`,async()=>{
 let extraction=0,verification=0,repair=0;const dir=mkdtempSync(join(tmpdir(),'http-continuation-'));
 const provider=createServer(async(request,response)=>{
  if(request.method==='GET'){response.setHeader('content-type','application/json');response.end('{}');return;}
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(request.url==='/api/embed'){response.setHeader('content-type','application/json');response.end(JSON.stringify({embeddings:body.input.map(()=>[1,0])}));return;}
  const system=body.messages[0].content,input=JSON.parse(body.messages[1].content);let value:unknown;
  if(system.includes('PATCH_SCHEMA')){repair++;if(repair<=3){if(failure==='connection')request.socket.destroy();else{response.writeHead(200,{'content-type':'text/event-stream','retry-after-ms':'1'});response.end('data: '+JSON.stringify({error:{message:'Upstream request failed',type:'server_error'}})+'\n\n');}return;}value={fact_edits:[{index:0,changes:{value:'Firefox',content:'My browser is Firefox.'}}]};if(failure==='provider_stream')value={answer:value};}
  else if(system.startsWith('Validate memory evidence')){verification++;const supported=input.PROPOSAL.facts[0].value==='Firefox';value={fact_checks:[{index:0,supported,modality_supported:true,source_index:0,quote:'My browser is Firefox.',...(!supported?{reason:'Source says Firefox, not Safari.'}:{})}],operation_checks:[],replacement_checks:[],message_checks:[{index:0,disposition:'represented',fact_indices:[0]}]};}
  else{extraction++;value={facts:[{subject:'user',predicate:'default_browser',value:'Safari',content:'My browser is Safari.',sources:[{index:0,quote:'My browser is Firefox.'}]}],operations:[]};}
  response.setHeader('content-type','text/event-stream');response.write('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(value)},finish_reason:null}]})+'\n\n');response.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const port=(provider.address() as any).port;
 const app=await buildServer(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_WRITE_CONTINUATION:'true',MEMORY_MODEL_TRANSPORT_ATTEMPTS:'3',MEMORY_DATA_DIR:dir,MEMORY_SOURCE_INDEX:'false',MEMORY_EMBEDDING_DIMENSIONS:'2',MEMORY_EMBEDDING_BASE_URL:`http://127.0.0.1:${port}`,MEMORY_LLM_BASE_URL:`http://127.0.0.1:${port}/v1`,MEMORY_LLM_API_KEY:'fixture'}));
 try{
  const address=await app.listen({host:'127.0.0.1',port:0});const body=JSON.stringify({user_id:'u',request_id:'r',session_id:'s',messages:[{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'}]});
  const send=()=>fetch(address+'/add',{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(10000)});
  const first=await send();assert.equal(first.status,503);assert.equal((await first.json() as any).error.code,'WRITE_CONTINUATION_PENDING');assert.deepEqual([extraction,verification,repair],[1,1,3]);
  const second=await send();assert.equal(second.status,200);assert.equal((await second.json() as any).success,true);assert.deepEqual([extraction,verification,repair],[1,2,4]);
  const duplicate=await send();assert.equal(duplicate.status,200);assert.deepEqual([extraction,verification,repair],[1,2,4]);
 }finally{await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
