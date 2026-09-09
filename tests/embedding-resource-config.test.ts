import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {configFromEnv} from '../src/config.js';
import {Models} from '../src/models.js';

for(const authenticated of [false,true])test(`embedding resource uses configured endpoint, model and ${authenticated?'Bearer authentication':'no authentication'}`,async()=>{
  const calls:{path:string;authorization:string|undefined;body:any}[]=[];
  const key=authenticated?'embedding-fixture-token':'';
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    calls.push({path:req.url!,authorization:req.headers.authorization,body:body?JSON.parse(body):null});
    if(authenticated&&req.headers.authorization!==`Bearer ${key}`){res.writeHead(401);res.end();return;}
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/tags')res.end(JSON.stringify({models:[{name:'nomic-embed-text:fixture',digest:'fixture-digest'}]}));
    else if(req.url==='/api/embed')res.end(JSON.stringify({embeddings:[[3,4]]}));
    else{res.writeHead(404);res.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const config=configFromEnv({MEMORY_EMBEDDING_BASE_URL:`http://127.0.0.1:${address.port}`,
      MEMORY_EMBEDDING_API_KEY:key,MEMORY_EMBEDDING_MODEL:'nomic-embed-text:fixture',
      MEMORY_EMBEDDING_DIGEST:'fixture-digest',MEMORY_EMBEDDING_DIMENSIONS:'2'});
    const models=new Models(config);
    assert.deepEqual(await models.embedBatch(['Oslo'],'add',AbortSignal.timeout(2000)),[[.6,.8]]);
    assert.deepEqual(await models.embedBatch(['city'],'search',AbortSignal.timeout(2000)),[[.6,.8]]);
    assert.deepEqual(calls.map(c=>c.path),['/api/tags','/api/embed','/api/tags','/api/embed']);
    assert.ok(calls.every(c=>c.authorization===(authenticated?`Bearer ${key}`:undefined)));
    assert.equal(calls[1]!.body.model,'nomic-embed-text:fixture');
    assert.deepEqual(calls[1]!.body.input,['search_document: Oslo']);
    assert.deepEqual(calls[3]!.body.input,['search_query: city']);
    assert.equal(calls[1]!.body.truncate,false);
    const invalid=new Models({...config,embeddingDimensions:3});
    await assert.rejects(invalid.embedBatch(['city'],'search',AbortSignal.timeout(2000)),/dimension/i);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
