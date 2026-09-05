import Fastify from 'fastify';
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
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'Request does not match the contract'}});
    if(error instanceof ServiceError)return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    const status=(error as {statusCode?:number}).statusCode;
    return reply.code(status===413?413:status===400?400:503).send({error:{code:'UNAVAILABLE',message:'Request could not be completed'}});
  });
  app.get('/health',async(request,reply)=>engine.isHealthy()?{status:'ok'}:reply.code(503).send({status:'unavailable'}));
  app.post('/add',async request=>{const body=addSchema.parse(request.body);return engine.add(body,AbortSignal.timeout(config.addTimeout));});
  app.post('/search',async request=>{const body=searchSchema.parse(request.body);return engine.search(body,AbortSignal.timeout(config.searchTimeout));});
  app.addHook('onClose',async()=>engine.close());
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=configFromEnv();const app=await buildServer(config);await app.listen({port:config.port,host:config.host});
  process.stdout.write(JSON.stringify({event:'ready',port:config.port,mode:config.mode})+'\n');
  for(const s of ['SIGINT','SIGTERM'] as const)process.once(s,()=>{void app.close();});
}
