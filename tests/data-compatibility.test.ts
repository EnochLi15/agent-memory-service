import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {buildServer} from '../dist/server.js';import {configFromEnv} from '../dist/config.js';import {TenantStore} from '../dist/storage.js';

test('a misspelled mode cannot silently select offline behavior',()=>{
 for(const mode of ['enhance','ENHANCED',''])assert.throws(()=>configFromEnv({MEMORY_MODE:mode}),/Invalid MEMORY_MODE/);
});

test('an incompatible deployment cannot search or replay receipts from another source format',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-format-')),config={...configFromEnv({}),dataDir:dir};let app=await buildServer(config);
 const request={request_id:'a',user_id:'u',session_id:'s',messages:[{role:'user',content:'I like painting.',timestamp:'2026-01-01T00:00:00Z'}]};
 try{
  assert.equal((await app.inject({method:'POST',url:'/add',payload:request})).statusCode,200);await app.close();
  app=await buildServer({...config,sourceIndex:false});
  for(const [url,payload] of [['/search',{user_id:'u',query:'painting',top_k:10}],['/add',request]] as const){
   const response=await app.inject({method:'POST',url,payload});assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'SOURCE_FORMAT');
  }
  await app.close();app=await buildServer(config);
  assert.equal((await app.inject({method:'POST',url:'/add',payload:request})).statusCode,200);
  assert.match((await app.inject({method:'POST',url:'/search',payload:{user_id:'u',query:'painting',top_k:10}})).body,/painting/);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('unknown future data format is refused even by a direct store reader',()=>{
 const dir=mkdtempSync(join(tmpdir(),'future-memory-format-'));const store=new TenantStore(dir,'u');
 store.setMeta('source_format','dual-source-v99');store.close();
 try{assert.throws(()=>new TenantStore(dir,'u'),{code:'SOURCE_FORMAT'});}finally{rmSync(dir,{recursive:true,force:true});}
});

test('populated unversioned data cannot be opened as a fresh store',()=>{
 const dir=mkdtempSync(join(tmpdir(),'unversioned-memory-'));const store=new TenantStore(dir,'u');
 store.db.prepare('INSERT INTO facts(id,body) VALUES (?,?)').run('legacy','{}');store.close();
 try{assert.throws(()=>new TenantStore(dir,'u'),{code:'SOURCE_FORMAT'});}finally{rmSync(dir,{recursive:true,force:true});}
});

test('legacy plaintext scope formats are refused without rewriting their database',()=>{
 for(const format of ['dual-source-v2','facts-only-v3','dual-source-v10']){
  const dir=mkdtempSync(join(tmpdir(),'legacy-scope-format-')),store=new TenantStore(dir,'u');
  store.setMeta('source_format',format);store.db.prepare('INSERT INTO facts VALUES (?,?)').run('old',JSON.stringify({scope:'private legacy context',state:'erased'}));store.close();
  const path=join(dir,createHash('sha256').update('u').digest('hex'),'memory.sqlite'),before=readFileSync(path);
  try{assert.throws(()=>new TenantStore(dir,'u'),{code:'SOURCE_FORMAT'});assert.deepEqual(readFileSync(path),before);}finally{rmSync(dir,{recursive:true,force:true});}
 }
});

test('legacy prepared writes cannot create a falsely compatible store',()=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-scope-write-')),store=new TenantStore(dir,'u');
 try{
  assert.throws(()=>store.commit({request_id:'a',user_id:'u',session_id:'s',messages:[]},'hash',{sourceFormat:'dual-source-v10'},0),{code:'SOURCE_FORMAT'});
  assert.equal(store.revision(),0);assert.equal(store.meta('source_format'),null);assert.equal(store.receipt('a','hash'),null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
