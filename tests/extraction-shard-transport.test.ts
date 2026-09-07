import {test} from 'node:test';import assert from 'node:assert/strict';import OpenAI from 'openai';
import {prepareExtractionShards} from '../dist/extraction-shards.js';import {Extractor} from '../dist/extraction.js';import {configFromEnv} from '../dist/config.js';import {ServiceError,addSchema} from '../dist/types.js';
const req={user_id:'u',request_id:'transport',session_id:'s',messages:['I use Firefox.','My brother uses Brave.','My laptop is silver.','My tablet is blue.'].map(content=>({role:'user',content,timestamp:'2026-01-01T00:00:00Z'}))};
const input=JSON.stringify({PARTICIPANT_INDEX:[0,1,2,3],NEW_MESSAGES:req.messages});
const apiError=(status:number)=>OpenAI.APIError.generate(status,{message:'private-provider-detail'},undefined,new Headers());
test('typed connection, timeout, rate limit and server failures remain unavailable after shard cancellation',async()=>{
 for(const error of [new OpenAI.APIConnectionError({message:'private-provider-detail'}),new OpenAI.APIConnectionTimeoutError({message:'private-provider-detail'}),apiError(408),apiError(409),apiError(429),apiError(500),apiError(502),apiError(503),apiError(504)]){
  let started=0,cleaned=0,release!:()=>void;const barrier=new Promise<void>(r=>release=r);
  await assert.rejects(prepareExtractionShards(req,'prompt',input,3,AbortSignal.timeout(2000),async(_s,_u,signal,shard)=>{
   if(++started===3)release();await barrier;if(shard.index===0)throw error;
   await new Promise<void>(r=>signal.aborted?r():signal.addEventListener('abort',()=>r(),{once:true}));await new Promise(r=>setImmediate(r));cleaned++;throw Error('sibling cancelled');
  }),(e:any)=>e.code==='EXTRACTION_UNAVAILABLE'&&e.status===503&&!e.message.includes('private-provider-detail'));
  assert.equal(started,3);assert.equal(cleaned,2);
 }
});
test('schema, semantic and permanent provider failures cannot become retryable by their wording',async()=>{
 for(const error of [new Error('Connection error.'),new SyntaxError('Invalid JSON'),new ServiceError('EXTRACTION_SCHEMA','foreign group'),new ServiceError('EVIDENCE_VALIDATION','unsupported fact'),apiError(400),apiError(401),apiError(403),apiError(404)])await assert.rejects(prepareExtractionShards(req,'prompt',input,3,AbortSignal.timeout(2000),async()=>{throw error;}),{code:'EVIDENCE_VALIDATION'});
});
test('unavailable shard preparation cannot fall back to offline success or proceed to embedding',async()=>{
 let verified=0,embedded=0;
 const model={json:async()=>{throw new OpenAI.APIConnectionError({});},verify:async()=>{verified++;return [];},embedBatch:async()=>{embedded++;return [];}};
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'message_groups',MEMORY_EXTRACTION_WORKERS:'3'});
 await assert.rejects(new Extractor(config,model as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(2000)),{code:'EXTRACTION_UNAVAILABLE'});
 assert.equal(verified,0);assert.equal(embedded,0);
});

import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildServer} from '../dist/server.js';import {TenantStore} from '../dist/storage.js';import {hash} from '../dist/extraction.js';
test('HTTP connection failure has no receipt; retrying the same request commits exactly once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shard-http-retry-'));let broken=true,calls=0;
 const gateway=createServer(async(request,response)=>{
  let text='';for await(const chunk of request)text+=chunk;calls++;
  if(broken){request.socket.destroy();return;}
  const body=JSON.parse(text),data=JSON.parse(body.messages[1].content);
  const output=data.CHECK_SCOPE?{fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:data.CHECK_SCOPE.message_indices.map((index:number)=>({index,disposition:'not_memorable'}))}:{message_groups:data.PARTICIPANT_INDEX.map((message_index:number)=>({message_index,facts:[],operations:[]}))};
  response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(output)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));
 const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'message_groups',MEMORY_EXTRACTION_WORKERS:'3',MEMORY_VERIFICATION_FORMAT:'verbose',MEMORY_LLM_BASE_URL:`http://127.0.0.1:${(gateway.address() as any).port}/v1`,MEMORY_DATA_DIR:dir});
 const app=await buildServer(config),body={...req,messages:['What is gravity?','What is a rainbow?','What is photosynthesis?','What is geometry?'].map(content=>({...req.messages[0]!,content}))};
 const inspect=(expected:number,receipt:boolean)=>{const store=new TenantStore(dir,'u');try{assert.equal(store.revision(),expected);assert.equal(!!store.receipt(body.request_id,hash(JSON.stringify(addSchema.parse(body)))),receipt);}finally{store.close();}};
 try{
  const failed=await app.inject({method:'POST',url:'/add',payload:body});assert.equal(failed.statusCode,503);assert.equal(failed.json().error.code,'EXTRACTION_UNAVAILABLE');inspect(0,false);
  broken=false;const retried=await app.inject({method:'POST',url:'/add',payload:body});assert.equal(retried.statusCode,200,retried.body);inspect(1,true);
  const after=calls;assert.equal((await app.inject({method:'POST',url:'/add',payload:body})).statusCode,200);assert.equal(calls,after);inspect(1,true);
 }finally{await app.close();gateway.closeAllConnections();await new Promise<void>(r=>gateway.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
