import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';
import {retrieve} from '../dist/retrieval.js';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'review-round2-'));const store=new TenantStore(dir,'u');
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let index=0;const config=configFromEnv({MEMORY_MODE:'offline'});const offline=new Extractor(config,{});
 const put=async(content,extractor=offline)=>{
  const req={request_id:'r'+(++index),user_id:'u',session_id:'s',messages:[{role:'user',content,timestamp:'2026-01-01T00:00:00Z'}]};
  const prepared=await extractor.prepare(req,store.snapshot('s'),AbortSignal.timeout(2000));
  store.commit(req,hash(JSON.stringify(req)),prepared,store.revision());
  return prepared;
 };
 return {store,put,config};
}
test('two explicit property commands sharing the same full number are not one command',async t=>{
 const {store,put}=await fixture(t);
 await put('My access code is 240.');await put('My salary is 240.');
 const prepared=await put('Forget my access code. Forget my salary 240.');
 assert.equal(store.facts().find(f=>f.predicate==='salary').state,'erased',JSON.stringify(prepared.operations));
});
test('a new person remains independent when their name shares two bigrams',async t=>{
 const {store,put}=await fixture(t);
 await put('My manager is Alice Van Der Smith.');await put('Forget my manager Alice Van Der Smith.');
 await put('My manager is Alice Van Der Jones.');
 assert.ok(store.facts().some(f=>f.state==='active'&&f.value==='Alice Van Der Jones'),JSON.stringify(store.snapshot('s').tail));
});
test('an independent person sharing a retired titled persons surname survives',async t=>{
 const {store,put}=await fixture(t);
 await put('My former advisor is Professor Anil Mehta.');
 await put('Please forget the information about Professor Anil Mehta.');
 await put('My manager is Anita Mehta.');
 assert.ok(store.facts().some(f=>f.state==='active'&&f.value==='Anita Mehta'),JSON.stringify(store.snapshot('s').tail));
});
test('a same-request fact followed by property erasure cannot leak through the event reason',async t=>{
 const {store,put}=await fixture(t);
 const config=configFromEnv({MEMORY_MODE:'enhanced'});
 const seed='My access code is 593842.',command='Forget my access code.';
 const models={verify:async()=>[],embedBatch:async xs=>xs.map(()=>[1,0]),json:async()=>({
  facts:[{content:seed,subject:'user',predicate:'access_code',value:'593842',scope:'',sources:[{index:0,quote:seed}]}],
  operations:[{type:'forget',target_ids:['new:0'],subject:'user',predicate:'access_code',scope:'',value:'',boundary:'property',source:{index:0,quote:command},reason:'Remove code 593842'}]
 })};
 await put(seed+' '+command,new Extractor(config,models));
 assert.equal(store.facts().find(f=>f.predicate==='access_code')?.state,'erased','fact is erased successfully before retrieval');
 const result=retrieve(store,{user_id:'u',query:'What did I ask you to forget?',top_k:10},null,config);
 assert.equal(JSON.stringify(result).includes('593842'),false,JSON.stringify(result));
});

test('one numeric property deletion retains another property with the same number',async t=>{
 const {store,put}=await fixture(t);
 await put('My access code is 240.');await put('My salary is 240.');
 await put('Forget my access code 240.');
 assert.equal(store.facts().find(f=>f.predicate==='access_code').state,'erased');
 assert.equal(store.facts().find(f=>f.predicate==='salary').state,'active');
});

test('a replay preface does not make a different full person name an erased echo',async t=>{
 const {store,put}=await fixture(t);
 await put('My manager is Alice Van Der Smith.');await put('Forget my manager Alice Van Der Smith.');
 await put('As I mentioned, my manager is Alice Van Der Jones.');
 assert.ok(store.facts().some(f=>f.state==='active'&&f.value==='Alice Van Der Jones'));
 assert.ok(!store.snapshot('s').tail.at(-1).redacted);
});

test('explicit different identity survives replay wording regardless of capitalization',async t=>{
 const {store,put}=await fixture(t);
 await put('My manager is Alice Van Der Smith.');await put('Forget my manager Alice Van Der Smith.');
 await put('As I mentioned, my manager is alice van der jones.');
 assert.ok(store.facts().some(f=>f.state==='active'&&f.value==='alice van der jones'));
});

test('ordinary new statements may reuse words in a retired non-person phrase',async t=>{
 const {store,put}=await fixture(t);
 await put('I keep a sourdough bread starter on my kitchen counter.');
 await put('Please forget the sourdough bread starter detail.');
 await put('I enjoy sourdough bread with soup.');
 assert.ok(store.facts().some(f=>f.state==='active'&&f.value==='sourdough bread with soup'));
});

test('narrative binding preserves the complete named person instead of a shared prefix',async t=>{
 const {store,put}=await fixture(t);
 await put('My former advisor is Professor Anil Mehta.');
 await put('My current advisor is Professor Anil Sharma.');
 await put('Please forget the information about Professor Anil Mehta.');
 assert.ok(store.facts().some(f=>f.state==='active'&&f.content.includes('Professor Anil Sharma')));
 assert.ok(!store.facts().some(f=>f.state==='active'&&f.content.includes('Professor Anil Mehta')));
});

test('a named band floor binds its stated lower bound without deleting personal salary',async t=>{
 const {store,put}=await fixture(t);
 await put('The L6 comp band at our company starts at $185,000 base.');
 await put('My salary is $191,500.');
 assert.ok(store.facts().some(f=>f.content.includes('185,000')));
 await put('Please forget the L6 comp band floor I mentioned. Just remove it entirely.');
 assert.equal(store.facts().find(f=>f.predicate==='salary')?.state,'active');
 assert.ok(!store.facts().some(f=>f.state==='active'&&f.content.includes('185,000')));
});

test('hashed markers suppress shortened explicit removal echoes',async t=>{
 const {store,put}=await fixture(t);
 await put('My former advisor is Professor Anil Mehta.');
 await put('Please forget the information about Professor Anil Mehta.');
 const rows=store.db.prepare('SELECT body FROM markers').all();
 assert.ok(rows.length>0);assert.ok(!JSON.stringify(rows).includes('Mehta'));
 await put('I just wanted to clear out the Mehta stuff specifically.');
 assert.ok(store.snapshot('s').tail.at(-1).redacted);
});
