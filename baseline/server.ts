// Test-only adapter around the unmodified upstream implementation.
import Fastify from 'fastify';
import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {IngestionGuard} from './ingestion-guard';
import {Memory as UpstreamMemory} from './upstream/src/oss/src/memory/index';
const variant=process.env.BASELINE_VARIANT??'U0';
const Memory:typeof UpstreamMemory=variant==='U1'?require('./.data/u1/src/oss/src/memory/index').Memory:UpstreamMemory;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const root=resolve(process.env.BASELINE_DATA_DIR??'.data/u0');mkdirSync(root,{recursive:true});
const instances=new Map<string,UpstreamMemory>();const ingestion=new IngestionGuard();
function memory(user:string){
 let m=instances.get(user);if(m)return m;
 const folder=join(root,hash(user));mkdirSync(folder,{recursive:true});
 m=new Memory({version:'v1.1',llm:{provider:'openai',config:{model:process.env.MEMORY_LLM_MODEL,baseURL:process.env.MEMORY_LLM_BASE_URL,apiKey:process.env.MEMORY_LLM_API_KEY,timeout:100000}},embedder:{provider:'openai',config:{model:'nomic-embed-text:latest',baseURL:'http://127.0.0.1:11434/v1',apiKey:'local',embeddingDims:768}},vectorStore:{provider:'memory',config:{dimension:768,collectionName:'memory',dbPath:join(folder,'vectors.sqlite')}},historyStore:{provider:'sqlite',config:{historyDbPath:join(folder,'history.sqlite')}}});instances.set(user,m);return m;
}
async function main(){
 const app=Fastify({exposeHeadRoutes:false,bodyLimit:8*1024*1024});
 app.get('/health',async()=>({status:'ok',baseline:variant}));
 app.post('/add',async(req,reply)=>{
  const r=req.body as any;const signature=hash(JSON.stringify(r));
  await ingestion.run(r.user_id,r.request_id,signature,async()=>{if(r.messages.length)await memory(r.user_id).add(r.messages.map((m:any)=>({role:m.role,content:m.content})),{userId:r.user_id,metadata:{session_id:r.session_id}});});
  return {success:true,request_id:r.request_id,user_id:r.user_id,session_id:r.session_id};
 });
 app.post('/search',async req=>{
  const r=req.body as any;const top=Math.min(100,Math.floor(r.top_k));if(!top)return {data:[]};
  const results=await memory(r.user_id).search(r.query,{filters:{user_id:r.user_id},topK:top});let budget=0;
  const data=results.results.map((m:any)=>({id:m.id,content:m.memory??m.content??'',score:m.score??0,created_at:m.createdAt??m.created_at??'1970-01-01T00:00:00Z'})).sort((a:any,b:any)=>b.score-a.score).filter((m:any)=>{budget+=Math.ceil(m.content.length/3);return budget<=6000;}).slice(0,32);
  return {data};
 });
 await app.listen({host:'127.0.0.1',port:Number(process.env.PORT??8091)});console.log(variant+' baseline ready');
}
void main();
