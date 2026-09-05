import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {buildServer} from '../dist/server.js';import {configFromEnv} from '../dist/config.js';
test('raw-only experiment preserves source roles and old statements without claiming lifecycle',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'raw-ablation-'));const c=configFromEnv({MEMORY_DATA_DIR:dir,MEMORY_EXPERIMENT_RAW_ONLY:'true',MEMORY_EXPERIMENT_LIFECYCLE:'false',MEMORY_RETRIEVAL:'lexical',MEMORY_EXPERIMENT_MULTI_HOP:'false'});const app=await buildServer(c);
 try{
  for(const [i,content] of ['I live in Oslo.','I now live in Bergen.','Forget Oslo.'].entries()){
   const r=await app.inject({method:'POST',url:'/add',payload:{request_id:String(i),user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp:'2026-01-01T00:00:00Z'},{role:'assistant',content:'You mentioned a city.',timestamp:'2026-01-01T00:00:00Z'}]}});assert.equal(r.statusCode,200,r.body);
  }
  const r=await app.inject({method:'POST',url:'/search',payload:{query:'city Oslo Bergen',user_id:'u',top_k:100}});const text=r.json().data.map((x:any)=>x.content).join('\n');assert.match(text,/Oslo/);assert.match(text,/Bergen/);assert.match(text,/assistant: You mentioned/);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
