import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../dist/server.js';
import { configFromEnv } from '../dist/config.js';

async function fixture(fn:(app:Awaited<ReturnType<typeof buildServer>>,dir:string)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'memory-test-'));const app=await buildServer({...configFromEnv({}),dataDir:dir,mode:'offline',maxEvidence:100});
  try{await fn(app,dir);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
}
const msg=(content:string,t='2026-01-01T00:00:00Z',role='user')=>({role,content,timestamp:t});
async function add(app:any,id:string,messages:any[],user='u',session='s'){
  const r=await app.inject({method:'POST',url:'/add',payload:{request_id:id,user_id:user,session_id:session,messages}});assert.equal(r.statusCode,200,r.body);return r.json();
}
async function search(app:any,query:string,user='u',top_k=100){const r=await app.inject({method:'POST',url:'/search',payload:{query,user_id:user,top_k}});assert.equal(r.statusCode,200,r.body);return r.json().data as {id:string;content:string;score:number}[];}

test('only prescribed routes, exact receipt, validation and top_k boundary',async()=>fixture(async app=>{
  assert.equal((await app.inject('/health')).statusCode,200);
  for(const path of ['/openapi.json','/docs','/metrics','/reset'])assert.equal((await app.inject(path)).statusCode,404);
  assert.equal((await app.inject({method:'HEAD',url:'/health'})).statusCode,404);
  const receipt=await add(app,'a',[msg('I live in Seattle.')]);assert.deepEqual(receipt,{success:true,request_id:'a',user_id:'u',session_id:'s'});
  assert.match((await search(app,'Where do I live?'))[0]!.content,/Seattle/);
  assert.deepEqual(await search(app,'city','unknown'),[]);assert.deepEqual(await search(app,'city','u',0),[]);
  for(const k of [1,2.5,100,101]){const data=await search(app,'city','u',k);assert.ok(data.length<=Math.min(Math.floor(k),100));assert.ok(data.every((x,i)=>Number.isFinite(x.score)&&(i===0||data[i-1]!.score>=x.score)));}
  assert.equal((await app.inject({method:'POST',url:'/add',payload:{}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/add',payload:{request_id:'x',user_id:'u',session_id:'s',messages:[msg('x','yesterday')]}})).statusCode,400);
}));
test('strict tenant separation including names and path-like identities',async()=>fixture(async app=>{
  await add(app,'same',[msg('I live in Seattle.')],'../u');await add(app,'same',[msg('I live in Portland.')],'u');
  assert.ok((await search(app,'city','../u')).every(x=>!x.content.includes('Portland')));
  assert.ok((await search(app,'city','u')).every(x=>!x.content.includes('Seattle')));
}));
test('idempotency and payload conflict',async()=>fixture(async app=>{
  const messages=[msg('I live in Seattle.')];await add(app,'a',messages);const before=await search(app,'city');await add(app,'a',messages);assert.deepEqual(await search(app,'city'),before);
  const r=await app.inject({method:'POST',url:'/add',payload:{request_id:'a',user_id:'u',session_id:'s',messages:[msg('I live in Boston.')]}});assert.equal(r.statusCode,409);assert.deepEqual(await search(app,'city'),before);
}));
test('current state excludes old value, explicit history preserves it',async()=>fixture(async app=>{
  await add(app,'a',[msg('I live in Seattle.')]);await add(app,'b',[msg('I now live in Portland.','2026-02-01T00:00:00Z')],'u','s2');
  const current=await search(app,'What is my current city?');assert.match(current.map(x=>x.content).join('\n'),/Portland/);assert.ok(current.every(x=>!x.content.includes('Seattle')));
  const history=await search(app,'What was my previous city?');assert.match(history.map(x=>x.content).join('\n'),/Seattle/);
}));
test('late historical state cannot replace newer state',async()=>fixture(async app=>{
  await add(app,'a',[msg('I live in Portland.','2026-03-01T00:00:00Z')]);await add(app,'b',[msg('I live in Seattle.','2026-01-01T00:00:00Z')]);
  assert.ok((await search(app,'current city')).every(x=>!x.content.includes('Seattle')));
}));
test('tentative plan and multiple hobbies do not overwrite confirmed facts',async()=>fixture(async app=>{
  await add(app,'a',[msg('My title is Data Analyst. I like painting. I like hiking.')]);
  await add(app,'b',[msg('My title is Lead Analyst next quarter, but it is not finalized.','2026-02-01T00:00:00Z')]);
  const jobs=await search(app,'job title');assert.match(jobs.map(x=>x.content).join('\n'),/Data Analyst/);assert.ok(jobs.filter(x=>x.content.includes('Lead Analyst')).every(x=>x.content.includes('tentative')));
  const hobbies=await search(app,'hobbies painting hiking');assert.match(hobbies.map(x=>x.content).join('\n'),/painting/);assert.match(hobbies.map(x=>x.content).join('\n'),/hiking/);
}));
test('forget suppresses all retrieval paths, retains neighbor and resists replay',async()=>fixture(async app=>{
  const initial=[msg('My access code is ZX-482. My manager is Alice.')];await add(app,'a',initial);
  await add(app,'b',[msg('Forget my access code.','2026-02-01T00:00:00Z')]);
  for(const q of ['access code ZX-482','previous access code','history of my code','Alice access code'])assert.ok((await search(app,q)).every(x=>!x.content.includes('ZX-482')),q);
  assert.match((await search(app,'manager')).map(x=>x.content).join('\n'),/Alice/);
  await add(app,'a',initial);assert.ok((await search(app,'code')).every(x=>!x.content.includes('ZX-482')));
  await add(app,'c',[msg('My access code is ZX-482.','2026-03-01T00:00:00Z')]);assert.ok((await search(app,'ZX-482 code')).every(x=>!x.content.includes('ZX-482')));
}));
test('forget it and do not forget are not destructive',async()=>fixture(async app=>{
  await add(app,'a',[msg('My access code is ZX-482.')]);await add(app,'b',[msg('Forget it. Do not forget my access code.')]);
  assert.match((await search(app,'access code')).map(x=>x.content).join('\n'),/ZX-482/);
}));
test('descriptions of human forgetfulness are evidence, not memory deletion commands',async()=>fixture(async app=>{
  await add(app,'a',[msg('My access code is ZX-482. My manager is Alice.')]);
  await add(app,'b',[msg("I'm on sertraline 50mg daily. I sometimes forget a dose but most days I remember. Just want that on record."),msg('I forget my access code sometimes.'),msg('我有时忘记吃药。请记住这个情况。')]);
  assert.match((await search(app,'access code')).map(x=>x.content).join('\n'),/ZX-482/);
  assert.match((await search(app,'sertraline dose')).map(x=>x.content).join('\n'),/50mg/);
  await add(app,'c',[msg('Please forget my access code.')]);
  assert.ok((await search(app,'access code ZX-482')).every(x=>!x.content.includes('ZX-482')));
  assert.match((await search(app,'manager')).map(x=>x.content).join('\n'),/Alice/);
}));
test('named assistant participant and Chinese evidence stay distinct',async()=>fixture(async app=>{
  await add(app,'a',[msg('Alice: I like painting.'),msg('Beth: I like hiking.','2026-01-01T00:00:01Z','assistant'),msg('我喜欢喝茶。我喜欢画画。')]);
  assert.match((await search(app,'Beth hiking')).map(x=>x.content).join('\n'),/Beth/);
  const cn=(await search(app,'喜欢')).map(x=>x.content).join('\n');assert.match(cn,/喝茶/);assert.match(cn,/画画/);
}));
test('concurrent user writes are serialized and remain searchable',async()=>fixture(async app=>{
  await Promise.all(Array.from({length:8},(_,i)=>add(app,`r${i}`,[msg(`I like hobby${i}.`)])));
  assert.equal((await search(app,'hobby')).length,8);
}));
test('committed state survives restart including forgotten content',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'memory-restart-'));const config={...configFromEnv({}),dataDir:dir};
  let app=await buildServer(config);
  try{await add(app,'a',[msg('My access code is X123. My manager is Alice.')]);await add(app,'b',[msg('Forget my access code.')]);await app.close();app=await buildServer(config);assert.ok((await search(app,'old access code')).every(x=>!x.content.includes('X123')));assert.match((await search(app,'manager')).map(x=>x.content).join('\n'),/Alice/);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('quoted and hypothetical forgetting never mutates real memory',async()=>fixture(async app=>{
 await add(app,'a',[msg('My access code is ZX-482.')]);
 await add(app,'b',[msg('Alice said "forget my access code" as an example.'),msg('What if I ask you to forget my access code?')]);
 assert.match((await search(app,'access code')).map(x=>x.content).join('\n'),/ZX-482/);
}));
