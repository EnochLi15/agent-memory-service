import {test} from 'node:test';import assert from 'node:assert/strict';
import {IngestionGuard} from './ingestion-guard';
test('timed-out clients can retry one in-flight add without duplicate upstream work',async()=>{
 const g=new IngestionGuard();let count=0;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const first=g.run('u','r','body',async()=>{count++;await gate;});
 const retry=g.run('u','r','body',async()=>{count++;});await new Promise(r=>setImmediate(r));assert.equal(count,1);
 await assert.rejects(g.run('u','r','different',async()=>{}),e=>(e as any).statusCode===409);
 release();await Promise.all([first,retry]);await g.run('u','r','body',async()=>{count++;});assert.equal(count,1);
});
test('users progress independently, same-user chunks stay ordered, failures permit retry',async()=>{
 const g=new IngestionGuard();const events:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const first=g.run('a','1','x',async()=>{events.push('a1');await gate;});
 const second=g.run('a','2','x',async()=>{events.push('a2');});
 await g.run('b','1','x',async()=>{events.push('b1');});assert.deepEqual(events,['a1','b1']);release();await Promise.all([first,second]);assert.equal(events.at(-1),'a2');
 await assert.rejects(g.run('a','bad','x',async()=>{throw Error('transient');}),/transient/);let retried=false;await g.run('a','bad','x',async()=>{retried=true;});assert.ok(retried);
});
