import {test} from 'node:test';import assert from 'node:assert/strict';
import {executeSourceErasure} from '../dist/source-erasure-execution.js';import {configFromEnv} from '../dist/config.js';import {decodeSourceErasure} from '../dist/source-erasure.js';
const work=(n:number)=>({fingerprint:'f',candidates:Array.from({length:n},(_,i)=>({kind:'source',id:String(i),start:0,text:`Remove code ${i}. Keep my browser.`,key:'b',boundary:{subject:'user'},authorization:null,matching_words:[],context:{}}))}) as any;
const rows=(input:string,defects:number[]=[])=>{const x=JSON.parse(input);return {decisions:x.CANDIDATES.map((c:any)=>{const source=x.SOURCES[c.source_slot];return {index:c.index,effect:defects.includes(Number(source.id))?'mixed':'erase',erase_quotes:defects.includes(Number(source.id))?[`Remove code${source.id}.`]:[],reason:defects.includes(Number(source.id))?'mixed_source':'same_erased_record'};})};};
test('source batches run at bounded concurrency and merge original indices despite reversed completion',async()=>{
 let active=0,max=0,count=0,release!:()=>void;const ready=new Promise<void>(r=>release=r),completions:number[]=[];
 const result=await executeSourceErasure(work(130),3,AbortSignal.timeout(3000),async(_s,input,_signal,purpose,batch)=>{
  assert.equal(purpose,'source_erasure');active++;max=Math.max(max,active);count++;if(count===3)release();await ready;
  await new Promise(r=>setTimeout(r,(2-batch!.index)*5));completions.push(batch!.index);active--;return rows(input);
 });assert.equal(max,3);assert.deepEqual(completions,[2,1,0]);assert.deepEqual(result.decisions.map(r=>r.index),Array.from({length:130},(_,i)=>i));assert.equal(result.decisions[64].parts[0].text,'Remove code 64. Keep my browser.');assert.throws(()=>decodeSourceErasure({...result,decisions:result.decisions.slice(1)},work(130)),/Incomplete/);
});
test('a failed classification cancels and drains running siblings without starting remaining batches',async()=>{
 let count=0,cleaned=0,release!:()=>void;const ready=new Promise<void>(r=>release=r);
 await assert.rejects(()=>executeSourceErasure(work(256),3,AbortSignal.timeout(3000),async(_s,input,signal,_purpose,batch)=>{
  count++;if(count===3)release();await ready;if(batch!.index===0)return {decisions:[]};
  await new Promise<void>(resolve=>signal.aborted?resolve():signal.addEventListener('abort',()=>resolve(),{once:true}));await new Promise(r=>setImmediate(r));cleaned++;return rows(input);
 }),/Incomplete/);assert.equal(count,3);assert.equal(cleaned,2);
});
test('one global quotation repair covers defects in separate batches and preserves semantic classifications',async()=>{
 let classified=0,repairs=0;const originals:any[]=[];
 const result=await executeSourceErasure(work(65),3,AbortSignal.timeout(3000),async(_s,input,_signal,purpose)=>{
  if(purpose==='source_erasure'){classified++;const raw=rows(input,[0,64]);originals.push(structuredClone(raw));return raw;}
  repairs++;assert.equal(classified,2);const x=JSON.parse(input);assert.equal(x.PROBLEMS.length,2);return {repairs:x.PROBLEMS.map((p:any)=>({index:p.index,status:'resolved',quote:`Remove code ${p.candidate.id}.`})).reverse()};
 });assert.equal(repairs,1);for(const i of [0,64])assert.deepEqual(result.decisions[i].parts,[{text:`Remove code ${i}.`,effect:'erase'},{text:' Keep my browser.',effect:'retain'}]);assert.equal(originals[0].decisions[0].erase_quotes[0],'Remove code0.');
});
test('later semantic uncertainty prevents any quotation repair even with a completed earlier defective batch',async()=>{
 let repairs=0;
 await assert.rejects(()=>executeSourceErasure(work(65),1,AbortSignal.timeout(3000),async(_s,input,_signal,purpose,batch)=>{
  if(purpose==='source_erasure_repair'){repairs++;throw Error('Must not repair');}const raw=rows(input,[0]);if(batch!.index===1)raw.decisions[0]={index:0,effect:'uncertain',erase_quotes:[],reason:'uncertain_owner'};return raw;
 }),/Uncertain/);assert.equal(repairs,0);
});
test('global repair is bounded to eight defects and rejects missing, duplicate, foreign or uncertain patches',async()=>{
 let repairs=0;await assert.rejects(()=>executeSourceErasure(work(65),3,AbortSignal.timeout(3000),async(_s,input,_signal,purpose)=>{if(purpose==='source_erasure_repair')repairs++;return rows(input,[0,1,2,3,4,5,6,7,64]);}),/global repair/);assert.equal(repairs,0);
 for(const mode of ['missing','duplicate','foreign','uncertain','extra'])await assert.rejects(()=>executeSourceErasure(work(65),3,AbortSignal.timeout(3000),async(_s,input,_signal,purpose)=>{
  if(purpose==='source_erasure')return rows(input,[0,64]);const patch:any={repairs:[{index:0,status:'resolved',quote:'Remove code 0.'},{index:1,status:'resolved',quote:'Remove code 64.'}]};
  if(mode==='missing')patch.repairs.pop();if(mode==='duplicate')patch.repairs[1].index=0;if(mode==='foreign')patch.repairs[1].index=2;if(mode==='uncertain')patch.repairs[1].status='uncertain';if(mode==='extra')patch.score=true;return patch;
 }),/global source quote repair/);
});
test('external cancellation, empty work and invalid configuration do not publish partial plans',async()=>{
 let calls=0;assert.deepEqual(await executeSourceErasure(work(0),3,AbortSignal.timeout(3000),async()=>{calls++;return {};}),{fingerprint:'f',decisions:[]});assert.equal(calls,0);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>executeSourceErasure(work(65),3,controller.signal,async()=>{calls++;return {};}));assert.equal(calls,0);
 assert.equal(configFromEnv({}).sourceErasureWorkers,1);const env={MEMORY_MODE:'enhanced',MEMORY_SOURCE_ERASURE:'true',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE_WORKERS:'3'};assert.equal(configFromEnv(env).sourceErasureWorkers,3);
 for(const n of ['0','4','1.5'])assert.throws(()=>configFromEnv({...env,MEMORY_SOURCE_ERASURE_WORKERS:n}));assert.throws(()=>configFromEnv({MEMORY_SOURCE_ERASURE_WORKERS:'3'}),/requires/);
});
test('deadline cancellation during classification or global repair rejects late model successes',async()=>{
 let completed=0;const deadline=AbortSignal.timeout(10);
 await assert.rejects(()=>executeSourceErasure(work(130),3,deadline,async(_s,input)=>{await new Promise(r=>setTimeout(r,25));completed++;return rows(input);}),/shared budget/);assert.equal(completed,3);assert.ok(deadline.aborted);
 const controller=new AbortController();let repairs=0;
 await assert.rejects(()=>executeSourceErasure(work(65),3,controller.signal,async(_s,input,_signal,purpose)=>{if(purpose==='source_erasure')return rows(input,[0,64]);repairs++;controller.abort();const x=JSON.parse(input);return {repairs:x.PROBLEMS.map((p:any)=>({index:p.index,status:'resolved',quote:`Remove code ${p.candidate.id}.`}))};}));assert.equal(repairs,1);
});
