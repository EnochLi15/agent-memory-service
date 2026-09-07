import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {retrieve} from '../dist/retrieval.js';

test('correction duplicate expansion follows selected old values, never its replacement value',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'correction-expansion-')),store=new TenantStore(dir,'u');
 const config=configFromEnv({MEMORY_MODE:'enhanced'});
 const req={request_id:'correction',user_id:'u',session_id:'s',messages:[
  {role:'user',content:'My investment amount is $200 every two weeks.',timestamp:'2026-01-01T00:00:00Z'},
  {role:'user',content:'Actually the amount is $250 every two weeks, not $200. Please update that to $250.',timestamp:'2026-01-02T00:00:00Z'},
 ]};
 const fact=(value:string,index:number,quote:string)=>({content:`My investment amount is ${value}.`,subject:'user',predicate:'investment_amount',scope:'index fund',value,cardinality:'single',sources:[{index,quote}]});
 const old=fact('$200 every two weeks',0,'$200 every two weeks');
 const x=new Extractor(config,{json:async()=>({facts:[old,{...old,content:'The recorded investment amount was $200 every two weeks.'},{...fact('$250 every two weeks',1,'$250 every two weeks, not $200'),supersedes:['new:0']}],operations:[{type:'correct',target_ids:['new:0'],subject:'user',predicate:'investment_amount',scope:'index fund',value:'$250 every two weeks',source:{index:1,quote:'Please update that to $250.'}}]}),verify:async()=>[],embedBatch:async()=>{throw Error('fixture lexical');}} as any);
 try{
  const prepared=await x.prepare(req,store.snapshot('s'),AbortSignal.timeout(1000));
  store.commit(req,hash(JSON.stringify(req)),prepared,0);
  const current=store.facts().filter(f=>f.state==='active');
  assert.equal(current.filter(f=>f.value==='$250 every two weeks').length,1);
  assert.equal(store.facts().filter(f=>f.value==='$200 every two weeks'&&f.state==='retracted').length,2);
  const event=store.events().find(e=>e.type==='correct')!;
  assert.equal(event.before_ids.length,2);assert.equal(event.after_ids.length,1);
  assert.ok(event.before_ids.every(id=>!event.after_ids.includes(id)));
  assert.match(retrieve(store,{user_id:'u',query:'current investment amount',top_k:100},null,config).data.map(m=>m.content).join('\n'),/\$250/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
