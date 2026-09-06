import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';
import {sourceOperationWork,sourceOperationInput,decodeSourceOperations,validateSourceOperations} from '../dist/source-operations.js';
const timestamp='2026-01-01T00:00:00Z',m=(role:string,content:string)=>({role,content,timestamp});
const request=(request_id:string,messages:any[],session_id='s')=>({request_id,user_id:'u',session_id,messages});
const a=request('a',[m('user','I swim at Harbor Pool.'),m('assistant','Your gym is Peak Gym. Water is available.')]);
const b=request('b',[m('user','What did you say?'),m('assistant','You attend Peak Gym. Bring water.')],'other-session');
const c=request('c',[m('user',"Your earlier gym claim is wrong. Please don't store that. I use Firefox.")]);
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true',MEMORY_SOURCE_ERASURE:'true',MEMORY_SEMANTIC_TRANSITIONS:'true',MEMORY_SOURCE_OPERATIONS:'true',MEMORY_SOURCE_OPERATION_HISTORY:'true'});
const decision=()=>({decisions:[{instruction:0,action:'reject_source',target_slots:[2],cuts:[{message:2,quote:'Your gym is Peak Gym.'},{message:4,quote:'You attend Peak Gym.'},{message:0,quote:"Please don't store that."}]}]});
const f=(text:string,predicate:string,value:string)=>({content:text,subject:'user',predicate,value,sources:[{index:0,quote:text}]});
const models={json:async(_s:string,input:string,_signal:AbortSignal,ctx:any)=>{const d=JSON.parse(input);
 if(ctx.purpose==='source_operation'){assert.equal(d.SOURCES.length,5);assert.equal(d.SOURCES[2].origin,'stored');assert.equal(d.SOURCES[4].session_id,'other-session');return decision();}
 if(ctx.purpose==='extraction'){const text=d.NEW_MESSAGES[0].content;return {facts:text.includes('Harbor Pool')?[f('I swim at Harbor Pool.','exercise','swim at Harbor Pool')]:text.includes('Firefox')?[f('I use Firefox.','browser','Firefox')]:[],operations:[]};}
 throw Error('Unexpected stage '+ctx.purpose);
},verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};

test('historical catalog is complete and deterministic, including non-searchable sources across sessions',()=>{
 const history=[...a.messages.map((x,i)=>({...x,id:'a'+i,session_id:'s',ordinal:i,searchable:i===0})),...b.messages.map((x,i)=>({...x,id:'b'+i,session_id:'other-session',ordinal:i+2,searchable:true}))];
 const work=sourceOperationWork(c,[],history),reordered=sourceOperationWork(c,[],[...history].reverse());assert.equal(work.fingerprint,reordered.fingerprint);assert.deepEqual(work.sources,reordered.sources);assert.ok(work.enabled);assert.equal(sourceOperationInput(work).SOURCES?.length,5);assert.equal(work.sources[2].id,'a1');assert.equal(work.sources[4].id,'b1');
 assert.equal(decodeSourceOperations(decision(),work).decisions[0].target_slots[0],2);
 assert.throws(()=>sourceOperationWork(c,[],[...history,history[0]]),/Duplicate/);
 const stale=decodeSourceOperations(decision(),work);assert.throws(()=>validateSourceOperations(stale,c,[],[],[],history.slice(1)),/identity changed/);
 assert.throws(()=>sourceOperationInput(sourceOperationWork(c,[],[{...history[0],content:'x'.repeat(180001)}])),/bounded/);
});

test('historical source cuts are revalidated for fact overlaps and cannot target a future current assistant',()=>{
 const history=[...a.messages.map((x,i)=>({...x,id:'a'+i,session_id:'s',ordinal:i,searchable:true})),...b.messages.map((x,i)=>({...x,id:'b'+i,session_id:'other-session',ordinal:i+2,searchable:true}))];
 const old=[{id:'linked',content:'Peak Gym',value:'Peak Gym',subject:'user',predicate:'gym',scope:'',time_text:'',state:'active',source_ids:['a1'],source_spans:[{source_id:'a1',start:0,end:21}]}] as any;
 const plan=decodeSourceOperations(decision(),sourceOperationWork(c,old,history)),current=c.messages.map((x,i)=>({...x,id:hash(`${c.user_id}\0${c.request_id}\0${i}`),session_id:'s',ordinal:i,searchable:true}));
 assert.throws(()=>validateSourceOperations(plan,c,old,[],current,history),/fact witness/);
 const partial=[{...old[0],source_spans:[{source_id:'another-source',start:0,end:5}]}];const partialPlan=decodeSourceOperations(decision(),sourceOperationWork(c,partial,history));assert.throws(()=>validateSourceOperations(partialPlan,c,partial,[],current,history),/fact witness/);
 const future=request('future',[m('user',"Please don't store that."),m('assistant','Your gym is Peak Gym.')]);
 assert.throws(()=>decodeSourceOperations({decisions:[{instruction:0,action:'reject_source',target_slots:[1],cuts:[{message:0,quote:"Please don't store that."},{message:1,quote:'Your gym is Peak Gym.'}]}]},sourceOperationWork(future,[],history)),/precede/);
});

test('v7 erases historical assertions and cross-session echoes atomically while preserving true records and neighbors',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'history-source-'));let store=new TenantStore(dir,'u');const x=new Extractor(config,models as any);
 try{
  for(const req of [a,b]){const revision=store.revision(),p=await x.prepare(req,store.snapshot(req.session_id),AbortSignal.timeout(2000));store.commit(req,hash(JSON.stringify(req)),p,revision);}
  assert.equal(store.meta('source_format'),'dual-source-v7');
  const sourceId=hash(['u','a','1'].join('\0')),row=store.db.prepare('SELECT body FROM messages WHERE id=?').get(sourceId) as any;
  const hidden=JSON.parse(row.body);hidden.searchable=false;store.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(hidden),sourceId);
  const before=store.snapshot('s'),prepared=await x.prepare(c,before,AbortSignal.timeout(2000));
  assert.throws(()=>store.commit(c,hash(JSON.stringify(c)),prepared,2,'indexes'));assert.deepEqual(store.snapshot('s'),before);
  const receipt=store.commit(c,hash(JSON.stringify(c)),prepared,2);assert.deepEqual(store.commit(c,hash(JSON.stringify(c)),prepared,2),receipt);assert.equal(store.revision(),3);
  store.close();store=new TenantStore(dir,'u');const all=store.db.prepare('SELECT body FROM messages').all();assert.doesNotMatch(JSON.stringify(all),/Peak Gym/);assert.match(JSON.stringify(all),/Water is available|Bring water/);assert.doesNotMatch(JSON.stringify(store.snapshot('other-session').tail),/Peak Gym/);
  assert.ok(store.facts().some(f=>f.value==='swim at Harbor Pool'&&f.state==='active'));assert.ok(store.facts().some(f=>f.value==='Firefox'&&f.state==='active'));assert.equal(store.events().filter(e=>e.type==='forget').length,1);
  const operations=store.db.prepare('SELECT body FROM operations').all() as any[];assert.ok(operations.some(r=>JSON.parse(r.body).target_ids.includes(sourceId)));
  const other=new TenantStore(dir,'another-user');try{assert.equal(other.snapshot('s').erasureSources,undefined);assert.equal(other.raw().length,0);}finally{other.close();}

 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
