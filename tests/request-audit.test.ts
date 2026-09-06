import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildServer} from '../dist/server.js';import {configFromEnv} from '../dist/config.js';

test('HTTP audit correlates outcomes without logging messages, query, tenant identity or credentials',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'http-audit-')),rows:any[]=[];const app=await buildServer({...configFromEnv({}),dataDir:dir,llmKey:'credential-not-for-logs'});
 const write=process.stdout.write.bind(process.stdout);
 process.stdout.write=((chunk:any,...args:any[])=>{if(typeof chunk==='string'&&chunk.startsWith('{"event":"http_request"')){rows.push(JSON.parse(chunk));return true;}return (write as any)(chunk,...args);}) as any;
 try{
  const body={request_id:'traceable-request',user_id:'private-tenant-identity',session_id:'s',messages:[{role:'user',content:'My access code is UNLOGGED-9182.',timestamp:'2026-01-01T00:00:00Z'}]};
  assert.equal((await app.inject({method:'POST',url:'/add',payload:body})).statusCode,200);
  await app.inject({method:'POST',url:'/search',payload:{user_id:body.user_id,query:'private-search-query',top_k:10}});
  assert.equal((await app.inject({method:'POST',url:'/add',payload:{...body,messages:[]}})).statusCode,409);
  await app.inject({method:'GET',url:'/health'});
  assert.equal(rows.length,3);assert.equal(rows[0].request_id,body.request_id);assert.equal(rows[0].tenant,rows[1].tenant);assert.equal(rows[1].stage,'search');assert.equal(rows[2].status,409);assert.ok(rows[2].error_code);assert.ok(rows.every(r=>r.elapsed_ms>=0&&r.id&&r.at));
  assert.doesNotMatch(JSON.stringify(rows),/UNLOGGED-9182|private-search-query|private-tenant-identity|credential-not-for-logs/);
 }finally{process.stdout.write=write;await app.close();rmSync(dir,{recursive:true,force:true});}
});
