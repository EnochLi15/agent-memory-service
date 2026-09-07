import Fastify,{type FastifyRequest} from 'fastify';
import {createHash} from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdirSync,accessSync,constants } from 'node:fs';
import { z } from 'zod';
import { configFromEnv,type Config } from './config.js';
import { Engine } from './engine.js';
import { addSchema,searchSchema,ServiceError } from './types.js';

export async function buildServer(config:Config=configFromEnv()){
  mkdirSync(config.dataDir,{recursive:true});accessSync(config.dataDir,constants.W_OK);
  const engine=new Engine(config);await engine.ready;
  const app=Fastify({logger:false,exposeHeadRoutes:false,bodyLimit:8*1024*1024,requestTimeout:config.addTimeout+1000});
  const audit=new WeakMap<FastifyRequest,{request_id?:string;tenant?:string;error_code?:string}>();
  const identify=(request:FastifyRequest,body:{user_id:string;request_id?:string})=>audit.set(request,{request_id:body.request_id,tenant:createHash('sha256').update(body.user_id).digest('hex').slice(0,16)});
  app.addHook('onResponse',(request,reply,done)=>{
    const stage=request.routeOptions.url;
    if(stage==='/add'||stage==='/search'||stage==='/health'&&reply.statusCode>=400){
      // No messages, queries, provider errors, headers or credentials in normal logs.
      const row={event:'http_request',at:new Date().toISOString(),id:request.id,stage:stage.slice(1),mode:config.mode,status:reply.statusCode,elapsed_ms:Math.round(reply.elapsedTime),...audit.get(request)};
      process.stdout.write(JSON.stringify(row)+'\n');
    }
    done();
  });
  app.setErrorHandler((error,request,reply)=>{
    audit.set(request,{...audit.get(request),error_code:error instanceof z.ZodError?'INVALID_REQUEST':error instanceof ServiceError?error.code:'UNAVAILABLE'});
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'Request does not match the contract'}});
    if(error instanceof ServiceError)return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    const status=(error as {statusCode?:number}).statusCode;
    return reply.code(status===413?413:status===400?400:503).send({error:{code:'UNAVAILABLE',message:'Request could not be completed'}});
  });
  app.get('/health',async(request,reply)=>engine.isHealthy()?{status:'ok'}:reply.code(503).send({status:'unavailable'}));
  app.post('/add',async request=>{const body=addSchema.parse(request.body);identify(request,body);return engine.add(body,AbortSignal.timeout(config.addTimeout));});
  app.post('/search',async request=>{const body=searchSchema.parse(request.body);identify(request,body);return engine.search(body,AbortSignal.timeout(config.searchTimeout));});
  app.addHook('onClose',async()=>engine.close());
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=configFromEnv();const app=await buildServer(config);await app.listen({port:config.port,host:config.host});
  process.stdout.write(JSON.stringify({event:'ready',port:config.port,mode:config.mode})+'\n');
  for(const s of ['SIGINT','SIGTERM'] as const)process.once(s,()=>{void app.close();});
}
