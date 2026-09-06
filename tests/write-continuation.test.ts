import {test} from 'node:test';import assert from 'node:assert/strict';
import OpenAI from 'openai';import Database from 'better-sqlite3';
import {ContinuationEntry,ContinuationAttempt,ContinuationCache,withContinuation,continuationCall} from '../dist/write-continuation.js';
import {PreparationLedger} from '../dist/preparation-ledger.js';
import {ServiceError} from '../dist/types.js';
const live=()=>new AbortController().signal;
const connection=()=>new OpenAI.APIConnectionError({message:'fixture connection'});
test('successful prefix including negative verifier decisions replays without semantic voting',async()=>{
 const e=new ContinuationEntry('u','identity');const a=new ContinuationAttempt(e,live());let calls=0;
 const invoke=(id:string,value:unknown)=>continuationCall({id},live(),async()=>{calls++;return value;});
 await withContinuation(a,async()=>{await invoke('extract',{facts:['wrong']});await invoke('verify',{supported:false});await assert.rejects(()=>continuationCall({id:'repair'},live(),async()=>{throw connection();}));});
 assert.equal(a.pending,true);assert.equal(calls,2);
 const b=new ContinuationAttempt(e,live());await withContinuation(b,async()=>{
  assert.deepEqual(await invoke('extract',{}),{facts:['wrong']});assert.deepEqual(await invoke('verify',{supported:true}),{supported:false});
  assert.deepEqual(await invoke('repair',{fixed:true}),{fixed:true});b.assertComplete();
 });assert.equal(calls,3);assert.equal(b.replayed,2);
});
test('skipping an earlier verdict cannot certify a successful continuation',async()=>{
 const e=new ContinuationEntry('u','i'),a=new ContinuationAttempt(e,live());await a.call({id:'rejection'},live(),async()=>({supported:false}));
 const b=new ContinuationAttempt(e,live());await b.call({id:'other'},live(),async()=>({supported:true}));assert.throws(()=>b.assertComplete(),/complete prior decisions/);
});
test('changed input is not a cache hit and cached objects cannot be mutated by consumers',async()=>{
 const e=new ContinuationEntry('u','i'),a=new ContinuationAttempt(e,live());const value:any=await a.call({input:'x'},live(),async()=>({nested:{value:1}}));value.nested.value=9;
 const b=new ContinuationAttempt(e,live());assert.deepEqual(await b.call({input:'x'},live(),async()=>{throw Error();}),{nested:{value:1}});
 assert.equal(await b.call({input:'y'},live(),async()=>2),2);b.assertComplete();
});
test('permanent errors and semantic failures do not gain transport continuation',async()=>{
 for(const error of [new SyntaxError('bad json'),new ServiceError('EVIDENCE_VALIDATION','rejected'),new OpenAI.APIError(400,{},'bad request',new Headers())]){
  const a=new ContinuationAttempt(new ContinuationEntry('u','i'),live());await assert.rejects(()=>a.call({},live(),async()=>{throw error;}));assert.equal(a.pending,false);assert.equal(a.terminalModelFailure,true);
 }
 const a=new ContinuationAttempt(new ContinuationEntry('u','i'),live()),signal=live();
 await assert.rejects(()=>a.call({},signal,async()=>{throw new OpenAI.APIError(503,{},'provider',new Headers({'x-should-retry':'false'}));}));assert.equal(a.pending,false);
});
test('inner model deadline can resume but caller cancellation cannot',async()=>{
 const caller=new AbortController(),inner=new AbortController(),a=new ContinuationAttempt(new ContinuationEntry('u','i'),caller.signal);
 await assert.rejects(()=>a.call({},inner.signal,async()=>{inner.abort(new DOMException('inner timeout','TimeoutError'));throw inner.signal.reason;}));assert.equal(a.pending,true);
 const b=new ContinuationAttempt(new ContinuationEntry('u','i'),caller.signal),signal=new AbortController();
 await assert.rejects(()=>b.call({},signal.signal,async()=>{caller.abort();signal.abort();throw connection();}));assert.equal(b.pending,false);
});
test('parallel calls are isolated by asynchronous attempt context',async()=>{
 const a=new ContinuationAttempt(new ContinuationEntry('a','i'),live()),b=new ContinuationAttempt(new ContinuationEntry('b','i'),live());
 await Promise.all([withContinuation(a,()=>continuationCall({},live(),async()=>({owner:'a'}))),withContinuation(b,()=>continuationCall({},live(),async()=>({owner:'b'})))]);
 assert.deepEqual(await new ContinuationAttempt(a.entry,live()).call({},live(),async()=>null),{owner:'a'});assert.deepEqual(await new ContinuationAttempt(b.entry,live()).call({},live(),async()=>null),{owner:'b'});
});
test('cache eviction, expiry and tenant mutation fail closed without retaining raw packets',async()=>{
 const cache=new ContinuationCache(),entry=cache.create('k','u','i'),a=new ContinuationAttempt(entry,live());await a.call({},live(),async()=>({secret:'fixture'}));assert.ok(cache.get('k','i'));assert.equal(cache.get('k','changed'),undefined);
 cache.invalidateTenant('u');assert.equal(entry.packets.size,0);assert.throws(()=>a.assertValid(),/no longer available/);
 const expired=new ContinuationEntry('u','i',Date.now()-300001);assert.throws(()=>new ContinuationAttempt(expired,live()).assertValid(),/no longer available/);
 cache.clear();
});
test('durable ledger refuses expired, lost, changed, terminal and excess continuation attempts',()=>{
 const db=new Database(':memory:'),ledger=new PreparationLedger(db),future=Date.now()+300000;
 try{
  assert.equal(ledger.begin('req','payload','identity','engine',false,future),1);
  assert.throws(()=>ledger.begin('req','payload','identity','engine',true,future),/cannot resume/);
  ledger.finish('req','engine',true);
  for(const args of [['req','other','identity','engine',true,future],['req','payload','changed','engine',true,future],['req','payload','identity','restart',true,future],['req','payload','identity','engine',false,future]] as const)assert.throws(()=>ledger.begin(...args));
  assert.equal(ledger.begin('req','payload','identity','engine',true,future),2);ledger.finish('req','engine',true);
  assert.equal(ledger.begin('req','payload','identity','engine',true,future),3);ledger.finish('req','engine',true);
  assert.throws(()=>ledger.begin('req','payload','identity','engine',true,future),/cannot resume/);
  assert.equal(ledger.begin('another','p','i','engine',false,future),1);ledger.committed('another');assert.throws(()=>ledger.begin('req','payload','identity','engine',true,future));
  const columns=db.prepare('PRAGMA table_info(preparation_attempts)').all().map((x:any)=>x.name);assert.deepEqual(columns,['id','payload','identity','owner','attempts','expires','state']);
  assert.ok(!(db.prepare('SELECT id FROM preparation_attempts').get() as any).id.includes('req'));
 }finally{db.close();}
});


test('a deadline that coincides with a permanent provider error cannot make it retryable',async()=>{
 const controller=new AbortController(),a=new ContinuationAttempt(new ContinuationEntry('u','i'),live());
 await assert.rejects(()=>a.call({},controller.signal,async()=>{controller.abort(new DOMException('deadline','TimeoutError'));throw new OpenAI.APIError(400,{},'bad request',new Headers());}));
 assert.equal(a.pending,false);assert.equal(a.terminalModelFailure,true);
});
test('complete late JSON is retained for replay without publishing after the inner deadline',async()=>{
 const controller=new AbortController(),entry=new ContinuationEntry('u','i'),a=new ContinuationAttempt(entry,live());
 await assert.rejects(()=>a.call({},controller.signal,async()=>{controller.abort(new DOMException('deadline','TimeoutError'));return {supported:false};}));assert.equal(a.pending,true);
 const b=new ContinuationAttempt(entry,live());assert.deepEqual(await b.call({},live(),async()=>({supported:true})),{supported:false});b.assertComplete();
});
