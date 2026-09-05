import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildServer} from '../dist/server.js';import {configFromEnv} from '../dist/config.js';
test('lost HTTP response after commit remains idempotent across a service restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-lost-reply-'));const config={...configFromEnv({}),dataDir:dir};let app=await buildServer(config);let base=await app.listen({host:'127.0.0.1',port:0});let committed=false;
 const proxy=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=String(chunk);const upstream=await fetch(base+'/add',{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(upstream.status,200);await upstream.json();committed=true;res.destroy();});await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const request={request_id:'lost-reply',user_id:'u',session_id:'s',messages:[{role:'user',content:'I like painting.',timestamp:'2026-01-01T00:00:00Z'}]};
 try{
  await assert.rejects(fetch(`http://127.0.0.1:${(proxy.address() as any).port}/add`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}));assert.ok(committed);
  await app.close();app=await buildServer(config);base=await app.listen({host:'127.0.0.1',port:0});
  const retry=await fetch(base+'/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});assert.equal(retry.status,200);assert.deepEqual(await retry.json(),{success:true,request_id:'lost-reply',user_id:'u',session_id:'s'});
  const changed=await app.inject({method:'POST',url:'/add',payload:{...request,messages:[{...request.messages[0],content:'I like hiking.'}]}});assert.equal(changed.statusCode,409);
  const search=await app.inject({method:'POST',url:'/search',payload:{user_id:'u',query:'painting',top_k:100}});assert.equal(search.json().data.length,1);assert.match(search.body,/painting/);assert.doesNotMatch(search.body,/hiking/);
 }finally{proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await app.close();rmSync(dir,{recursive:true,force:true});}
});
