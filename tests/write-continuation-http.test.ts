import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildServer} from '../dist/server.js';import {configFromEnv} from '../dist/config.js';

test('HTTP retries resume after actual SDK connection failures without regenerating the rejected prefix',async()=>{
 let extraction=0,verification=0,repair=0;const dir=mkdtempSync(join(tmpdir(),'http-continuation-'));
 const provider=createServer(async(request,response)=>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(request.url==='/api/embed'){response.setHeader('content-type','application/json');response.end(JSON.stringify({embeddings:body.input.map(()=>[1,0])}));return;}
  const system=body.messages[0].content,input=JSON.parse(body.messages[1].content);let value:unknown;
  if(system.includes('PATCH_SCHEMA')){repair++;if(repair<=3){request.socket.destroy();return;}value={fact_edits:[{index:0,changes:{value:'Firefox',content:'My browser is Firefox.'}}]};}
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
