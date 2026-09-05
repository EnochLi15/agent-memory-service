import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {TenantStore} from '../dist/storage.js';import {Extractor,hash} from '../dist/extraction.js';import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';
test('fault at each transactional boundary leaves no facts, source, index or receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-tx-'));const s=new TenantStore(dir,'u');const config=configFromEnv({});const extractor=new Extractor(config,new Models(config));
 const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:'I live in Seattle.',timestamp:'2026-01-01T00:00:00Z'}]};const prepared=await extractor.prepare(req,s.snapshot('s'),AbortSignal.timeout(1000));
 try{for(const boundary of ['operations','indexes']){assert.throws(()=>s.commit(req,hash(JSON.stringify(req)),prepared,0,boundary));assert.equal(s.revision(),0);assert.equal(s.facts().length,0);assert.equal(s.raw().length,0);assert.equal(s.lexical('Seattle',10).length,0);assert.equal(s.receipt('r',hash(JSON.stringify(req))),null);}s.commit(req,hash(JSON.stringify(req)),prepared,0);assert.equal(s.facts().length,1);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
