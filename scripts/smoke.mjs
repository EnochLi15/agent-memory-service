import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs, parseEnv} from 'node:util';

const {values} = parseArgs({options:{url:{type:'string'},self:{type:'boolean'},'dead-models':{type:'boolean'}}});
if (values.self && values.url || values['dead-models'] && !values.self) throw new Error('Use --self [--dead-models] or --url URL');
let app, directory, reopen, base = (values.url ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const user = 'delivery-smoke-' + randomUUID(), checks = [];
function pass(name) { checks.push(name); process.stdout.write(JSON.stringify({check:name,status:'passed'})+'\n'); }
async function request(path, body) {
  const start = performance.now();
  const response = await fetch(base + path, {method:body === undefined?'GET':'POST',
    headers:body === undefined?{}:{'Content-Type':'application/json'},
    ...(body === undefined?{}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(path==='/add'?120000:path==='/health'?10000:60000)});
  const json = await response.json();
  assert.ok(performance.now()-start < (path==='/add'?120000:path==='/health'?10000:60000),path+' deadline');
  return {status:response.status,json};
}
const payload = (id, content, session='session-1') => ({request_id:id,user_id:user,session_id:session,
  messages:[{role:'user',content,timestamp:id==='initial'?'2026-01-01T00:00:00Z':'2026-02-01T00:00:00Z'}]});
async function add(body) {
  const response = await request('/add',body);
  assert.equal(response.status,200,JSON.stringify(response.json));
  assert.deepEqual(response.json,{success:true,request_id:body.request_id,user_id:body.user_id,session_id:body.session_id});
}
async function search(query, extra={}) {
  const response = await request('/search',{query,user_id:user,top_k:100,...extra});
  assert.equal(response.status,200,JSON.stringify(response.json));
  assert.deepEqual(Object.keys(response.json),['data']);
  const rows=response.json.data;
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length<=Math.min(100,Math.floor(extra.top_k??100)));
  for(const row of rows){
    assert.deepEqual(Object.keys(row).sort(),['content','created_at','id','score']);
    assert.equal(typeof row.id,'string');assert.equal(typeof row.content,'string');
    assert.equal(typeof row.score,'number');assert.ok(Number.isFinite(row.score));
    assert.ok(Number.isFinite(Date.parse(row.created_at)));
  }
  return rows;
}
const contents=rows=>rows.map(row=>row.content).join('\n');
try {
  if(values.self){
    const [{buildServer},{configFromEnv}] = await Promise.all([import('../dist/server.js'),import('../dist/config.js')]);
    directory=await mkdtemp(join(tmpdir(),'agent-memory-smoke-'));
    const profile=values['dead-models']?'enhanced':'offline';
    const env=parseEnv(await readFile(new URL(`../configs/release-${profile}.env`,import.meta.url),'utf8'));
    const config=configFromEnv({...env,HOST:'127.0.0.1',PORT:'0',MEMORY_DATA_DIR:directory,
      MEMORY_LLM_BASE_URL:'http://127.0.0.1:1/v1',MEMORY_LLM_API_KEY:'',MEMORY_EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
    reopen=async()=>{app=await buildServer(config);base=await app.listen({host:'127.0.0.1',port:0});};
    await reopen();
  }
  const health=await request('/health');
  assert.equal(health.status,200);assert.equal(health.json.status,'ok');
  if(values['dead-models'])assert.equal(health.json.models,'degraded');
  pass('health without authentication');
  const initial=payload('initial','I live in Oslo. My manager is Alice. My access code is ZX-482.');
  await add(initial);
  assert.match(contents(await search('What is my current city?')),/Oslo/);
  pass('synchronous add receipt and immediate search');
  const before=await search('current city');await add(initial);assert.deepEqual(await search('current city'),before);
  pass('idempotent identical replay');
  const conflict=await request('/add',payload('initial','I live in Bergen.'));
  assert.equal(conflict.status,409);assert.deepEqual(await search('current city'),before);
  pass('conflicting request rejected without mutation');
  assert.deepEqual(await search('Oslo Alice ZX-482',{user_id:user+'-other'}),[]);
  pass('user isolation');
  assert.deepEqual(await search('city',{top_k:0}),[]);await search('city',{top_k:1});await search('city',{top_k:1000});
  pass('top_k zero, one and hard cap');
  assert.doesNotMatch(contents(await search('current city',{options:['Bergen','Invented-City-ZZ764']})),/Bergen|Invented-City-ZZ764/);
  pass('options cannot fabricate evidence');
  assert.equal((await request('/add',{})).status,400);
  assert.equal((await request('/search',{query:'city',user_id:user,top_k:-1})).status,400);
  pass('invalid request rejection');
  assert.equal((await request('/answer')).status,404);pass('no answer endpoint');
  await add(payload('update','I now live in Portland.','session-2'));
  const current=contents(await search('What is my current city?'));
  assert.match(current,/Portland/);assert.doesNotMatch(current,/Oslo/);
  pass('cross-session current state update');
  await add(payload('forget','Forget my access code.','session-2'));
  for(const query of ['access code ZX-482','previous access code','history of my code'])assert.doesNotMatch(contents(await search(query)),/ZX-482/);
  assert.match(contents(await search('my manager')),/Alice/);
  pass('targeted forgetting with neighbor preservation');
  await add(initial);assert.doesNotMatch(contents(await search('access code ZX-482')),/ZX-482/);
  pass('replayed receipt cannot restore forgotten value');
  if(reopen){
    await app.close();app=undefined;await reopen();
    assert.match(contents(await search('my manager')),/Alice/);
    assert.match(contents(await search('current city')),/Portland/);
    assert.doesNotMatch(contents(await search('access code ZX-482')),/ZX-482/);
    await add(initial);assert.doesNotMatch(contents(await search('access code ZX-482')),/ZX-482/);
    pass('durable state and receipts after engine restart');
  }
  process.stdout.write(JSON.stringify({status:'passed',checks:checks.length,mode:values.self?(values['dead-models']?'enhanced-degraded':'offline'):'external',user_id:user})+'\n');
} finally {
  if(app)await app.close();
  if(directory)await rm(directory,{recursive:true,force:true});
}
