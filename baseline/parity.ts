// Deterministic U0/U1 behavioral comparison through their real SQLite pipelines.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Memory as U0} from './upstream/src/oss/src/memory/index';
import {Memory as U1} from './.data/u1/src/oss/src/memory/index';
const root=mkdtempSync(join(tmpdir(),'memory-u1-parity-'));
const messages=[{role:'user',content:'I live in Oslo. My friend is Clara.'}];
const calls:string[][]=[];
async function exercise(Type:typeof U0,label:string){
 const dir=join(root,label);mkdirSync(dir);
 const memory:any=new Type({version:'v1.1',llm:{provider:'openai',config:{apiKey:'local',model:'fixture'}},embedder:{provider:'openai',config:{apiKey:'local',model:'fixture',embeddingDims:3}},vectorStore:{provider:'memory',config:{dimension:3,collectionName:'memory',dbPath:join(dir,'vectors.sqlite')}},historyStore:{provider:'sqlite',config:{historyDbPath:join(dir,'history.sqlite')}}});
 await memory._ensureInitialized();
 let texts=['The user lives in Oslo.','The user is friends with Clara.'];const prompts:string[]=[];
 memory.llm={generateResponse:async(m:any)=>{prompts.push(JSON.stringify(m));return JSON.stringify({memory:texts.map(text=>({text,attributed_to:'user',linked_memory_ids:[]}))});}};
 const embed=async(text:string)=>[1,text.includes('Oslo')?1:.1,text.includes('Clara')?1:.1];memory.embedder={embed,embedBatch:async(ts:string[])=>Promise.all(ts.map(embed))};
 const options={userId:'parity-user'};
 const first=await memory.add(messages,options);assert.equal(first.results.length,2);
 const duplicate=await memory.add(messages,options);assert.equal(duplicate.results.length,0);
 texts=['The user now lives in Bergen.'];await memory.add([{role:'user',content:'I now live in Bergen.'}],options);
 const results=[];
 for(const query of ['Where does the user live?','Who is Clara?','Oslo Bergen']){
  const r=await memory.search(query,{filters:{user_id:'parity-user'},topK:100});
  results.push(r.results.map((x:any)=>({memory:x.memory,score:x.score})).sort((a:any,b:any)=>a.memory.localeCompare(b.memory)));
 }
 assert.equal((await memory.search('Oslo',{filters:{user_id:'different-user'},topK:100})).results.length,0);
 await assert.rejects(()=>memory.search('Oslo',{filters:{user_id:'parity-user'},topK:-1}),/topK/);
 calls.push(prompts);return results;
}
async function main(){
 const a=await exercise(U0,'u0');const b=await exercise(U1 as typeof U0,'u1');assert.deepEqual(a,b);assert.deepEqual(calls[0],calls[1]);
 const result={status:'passed',checks:['exact extraction prompts','two extracted facts','hash deduplication','additive update behavior','three scored search queries','tenant filter','invalid top_k rejection'],model:'deterministic fixtures; no external LLM',results:a};
 mkdirSync('.data',{recursive:true});writeFileSync('.data/u1-parity.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
