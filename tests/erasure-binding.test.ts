import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';import {TenantStore} from '../dist/storage.js';import {retrieve} from '../dist/retrieval.js';import {configFromEnv} from '../dist/config.js';
const config=configFromEnv({MEMORY_MODE:'enhanced',MEMORY_ERASURE_BINDING:'true'});
const req=(id:string,text:string)=>({request_id:id,user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-01-01T00:00:00Z'}]});
const fact=(content:string,predicate:string,value:string,scope='',subject='user')=>({content,predicate,value,scope,subject,sources:[{index:0,quote:content}]});
async function fixture(fn:any){
 const dir=mkdtempSync(join(tmpdir(),'erasure-binding-'));const store=new TenantStore(dir,'u');let calls=0;
 const prepare=async(r:any,proposal:any,decision?:any)=>new Extractor(config,{verify:async()=>[],embedBatch:async(xs:string[])=>xs.map(()=>[1,0]),json:async(_s:string,input:string,signal:AbortSignal,context:any)=>{
  if(context?.purpose!=='erasure_binding')return structuredClone(proposal);calls++;const d=JSON.parse(input);return decision?decision(d):{decisions:d.CANDIDATES.map((c:any,index:number)=>({index,effect:c.fact.predicate==='coworker_name'||c.fact.predicate==='project_code'?'retain':'erase',quote:c.fact.source_quotes[0],reason:c.fact.predicate==='project_code'?'A separate explicitly named project code.':c.fact.predicate==='coworker_name'?'A different real person in work context.':'The same backup name restated under another label.'}))};}
 } as any).prepare(r,store.snapshot('s'),AbortSignal.timeout(1000));
 const commit=(r:any,p:any)=>store.commit(r,hash(JSON.stringify(r)),p,store.revision());
 try{await fn({dir,store,prepare,commit,calls:()=>calls});}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('semantic erasure binds same-chunk restatements across scope labels while keeping an independently sourced same name',()=>fixture(async({store,prepare,commit,calls}:any)=>{
 const r=req('seed','Our backup name is Iris. My coworker is Iris.');commit(r,await prepare(r,{facts:[fact('Our backup name is Iris.','backup_name','Iris'),fact('My coworker is Iris.','coworker_name','Iris','office')],operations:[]}));
 const target=store.facts().find((f:any)=>f.predicate==='backup_name');
 const d=req('delete','Remove Iris from the list entirely. Keeping Iris on the list was hedging for no reason.');
 const p=await prepare(d,{facts:[fact('Remove Iris from the list entirely.','remove_name','Iris','baby name list'),fact('Keeping Iris on the list was hedging for no reason.','removal_reason','hedging','Iris')],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'backup_name',value:'Iris',boundary:'value',source:{index:0,quote:'Remove Iris from the list entirely.'}}]});
 assert.equal(calls(),1);commit(d,p);
 assert.ok(store.facts().filter((f:any)=>f.predicate!=='coworker_name').every((f:any)=>f.state==='erased'));
 assert.ok(store.facts().some((f:any)=>f.predicate==='coworker_name'&&f.state==='active'));
 const evidence=JSON.stringify(retrieve(store,{user_id:'u',query:'Iris backup name coworker hedging',top_k:100},null,config).data);
 assert.doesNotMatch(evidence,/hedging|Remove Iris|backup name is Iris/);assert.match(evidence,/coworker is Iris/);
 assert.ok(store.passages().every((p:any)=>p.state==='erased'||!p.content.includes('hedging')));
 // A fresh scope in a later request still goes through the stored boundary.
 const echo=req('echo','Keeping Iris as a backup had made us hesitate.');commit(echo,await prepare(echo,{facts:[fact(echo.messages[0].content,'choice_hesitation','hesitation','family preferences')],operations:[]}));
 assert.doesNotMatch(JSON.stringify(retrieve(store,{user_id:'u',query:'backup hesitate Iris',top_k:100},null,config).data),/hesitate|backup name is Iris/);
 const independent=req('independent','My project Blue access code is Iris.');commit(independent,await prepare(independent,{facts:[fact(independent.messages[0].content,'project_code','Iris','project Blue')],operations:[]}));
 assert.ok(store.facts().some((f:any)=>f.predicate==='project_code'&&f.state==='active'));
 assert.equal(calls(),3);
}));
test('missing, uncertain or unsupported independence decisions reject the whole prepare without fallback',()=>fixture(async({store,prepare,commit}:any)=>{
 const r=req('seed','Our backup name is Iris.');commit(r,await prepare(r,{facts:[fact(r.messages[0].content,'backup_name','Iris')],operations:[]}));const f=store.facts()[0];
 const d=req('delete','Remove Iris from the list entirely. Keeping Iris was hedging.');const proposal={facts:[fact('Keeping Iris was hedging.','removal_reason','hedging','Iris')],operations:[{type:'forget',target_ids:[f.id],subject:'user',predicate:'backup_name',value:'Iris',source:{index:0,quote:'Remove Iris from the list entirely.'}}]};
 for(const decision of [()=>({decisions:[]}),()=>({decisions:[{index:0,effect:'uncertain',quote:'Keeping Iris was hedging.',reason:'Ambiguous.'}]}),()=>({decisions:[{index:0,effect:'retain',quote:'Other unrelated evidence.',reason:'Different person.'}]})])await assert.rejects(()=>prepare(d,proposal,decision),(e:any)=>e.code==='EVIDENCE_VALIDATION');
 assert.equal(store.revision(),1);assert.equal(store.facts()[0].state,'active');
}));
test('a pronoun-only retention witness cannot keep a value borrowed from the erased neighboring claim',()=>fixture(async({store,prepare,commit}:any)=>{
 const text='Priya likes Volcano sauce, and I cannot imagine that. My usual order is mild curry.';
 const seed=req('seed-pronoun',text);
 const dependent={...fact('I cannot imagine liking Volcano sauce.','food_dislike','Volcano sauce'),sources:[{index:0,quote:'Priya likes Volcano sauce, and I cannot imagine that.'}]};
 commit(seed,await prepare(seed,{facts:[fact('Priya likes Volcano sauce','food_preference','Volcano sauce','','Priya'),dependent,fact('My usual order is mild curry.','usual_order','mild curry')],operations:[]}));
 const target=store.facts().find((f:any)=>f.subject==='Priya'),before=store.snapshot('s');
 const del=req('delete-pronoun',"Forget Priya's sauce preference.");
 const proposal={facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'Priya',predicate:'food_preference',value:'Volcano sauce',source:{index:0,quote:del.messages[0].content}}]};
 await assert.rejects(()=>prepare(del,proposal,(d:any)=>({decisions:d.CANDIDATES.map((c:any,index:number)=>({index,effect:'retain',quote:'I cannot imagine that',reason:'Claimed independent dislike.'}))})),/Independent-value witness/);
 assert.deepEqual(store.snapshot('s'),before);
 assert.equal(store.receipt(del.request_id,hash(JSON.stringify(del))),null);
 const prepared=await prepare(del,proposal,(d:any)=>({decisions:d.CANDIDATES.map((c:any,index:number)=>({index,effect:'erase',quote:c.fact.source_quotes[0],reason:'Only value witness depends on the erased claim.'}))}));
 commit(del,prepared);
 assert.ok(store.facts().filter((f:any)=>f.predicate!=='usual_order').every((f:any)=>f.state==='erased'));
 assert.ok(store.facts().some((f:any)=>f.predicate==='usual_order'&&f.state==='active'&&f.value==='mild curry'));
}));
test('v3 transaction checks request/record fingerprint and cannot omit an erasure plan',()=>fixture(async({store,prepare,commit}:any)=>{
 const r=req('seed','My hobby is hiking.');const p=await prepare(r,{facts:[fact(r.messages[0].content,'hobby','hiking')],operations:[]});
 assert.equal(p.sourceFormat,'dual-source-v3-s1');
 const missing=structuredClone(p);delete missing.erasurePlan;assert.throws(()=>commit(r,missing),(e:any)=>e.code==='EVIDENCE_VALIDATION');
 const changed=structuredClone(p);changed.facts[0].scope='changed';assert.throws(()=>commit(r,changed),(e:any)=>e.code==='EVIDENCE_VALIDATION');
 assert.throws(()=>commit({...r,request_id:'other'},p),(e:any)=>e.code==='EVIDENCE_VALIDATION');assert.equal(store.revision(),0);assert.equal(store.facts().length,0);commit(r,p);
}));
test('independent-name evidence cannot exempt an unlinked echo elsewhere in the same passage',()=>fixture(async({store,prepare,commit}:any)=>{
 const r=req('seed','Our backup name is Iris.');commit(r,await prepare(r,{facts:[fact(r.messages[0].content,'backup_name','Iris')],operations:[]}));const target=store.facts()[0];
 const d=req('delete','Remove Iris from the list entirely.');commit(d,await prepare(d,{facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'backup_name',value:'Iris',source:{index:0,quote:d.messages[0].content}}]}));
 const text='My coworker is Iris, my city is Oslo, I enjoy kayaking, and the old backup was Iris.';const echo=req('mixed',text);
 const p=await prepare(echo,{facts:[fact('My coworker is Iris','coworker_name','Iris','office'),fact('my city is Oslo','city','Oslo')],operations:[]});commit(echo,p);
 const passage=store.passages().find((p:any)=>p.content.includes('coworker'));
 assert.ok(passage);assert.match(passage.content,/My coworker is Iris/);assert.match(passage.content,/enjoy kayaking/);
 assert.doesNotMatch(passage.content,/old backup was Iris/);assert.equal((passage.content.match(/Iris/g)??[]).length,1);assert.equal(passage.vector,null);
}));
test('explicit restore preserves its authorized value and support while old unrelated erasures remain enforced',()=>fixture(async({store,prepare,commit}:any)=>{
 const seed=req('seed','Our backup name is Iris.');commit(seed,await prepare(seed,{facts:[fact(seed.messages[0].content,'backup_name','Iris')],operations:[]}));const target=store.facts()[0];
 const del=req('delete','Forget my backup name Iris.');commit(del,await prepare(del,{facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'backup_name',value:'Iris',source:{index:0,quote:del.messages[0].content}}]}));
 const restore=req('restore','Remember my backup name Iris again.');const p=await prepare(restore,{facts:[fact(restore.messages[0].content,'backup_name','Iris')],operations:[{type:'restore',target_ids:[target.id],subject:'user',predicate:'backup_name',value:'Iris',source:{index:0,quote:restore.messages[0].content}}]});commit(restore,p);
 const f=store.facts().find((f:any)=>f.state==='active'&&f.predicate==='backup_name');assert.ok(f);assert.ok(f.source_quotes.some((q:string)=>q.includes('Iris')));
}));
test('forget also scrubs older unlinked assistant echoes from searchable raw history',()=>fixture(async({store,prepare,commit}:any)=>{
 const seed=req('seed','Our backup name is Iris.');seed.messages.push({role:'assistant',content:'Your backup choice is Iris.',timestamp:'2026-01-01T00:00:01Z'});
 commit(seed,await prepare(seed,{facts:[fact(seed.messages[0].content,'backup_name','Iris')],operations:[]}));const target=store.facts()[0];assert.ok(store.raw().some((m:any)=>m.role==='assistant'&&m.content.includes('Iris')));
 const del=req('delete','Remove Iris from the list entirely.');commit(del,await prepare(del,{facts:[],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'backup_name',value:'Iris',source:{index:0,quote:del.messages[0].content}}]}));
 assert.doesNotMatch(JSON.stringify(store.raw()),/Iris/);assert.doesNotMatch(JSON.stringify(store.snapshot('s').tail),/Iris/);
}));
test('fault injection rolls back independent-retention certificates and forced erasures together',()=>fixture(async({store,prepare,commit}:any)=>{
 const seed=req('seed','Our backup name is Iris. My coworker is Iris.');commit(seed,await prepare(seed,{facts:[fact('Our backup name is Iris.','backup_name','Iris'),fact('My coworker is Iris.','coworker_name','Iris','office')],operations:[]}));const target=store.facts().find((f:any)=>f.predicate==='backup_name');const before=store.snapshot('s');
 const del=req('delete','Remove Iris from the list entirely. Keeping Iris was hedging.');const p=await prepare(del,{facts:[fact('Keeping Iris was hedging.','reason','hedging','Iris')],operations:[{type:'forget',target_ids:[target.id],subject:'user',predicate:'backup_name',value:'Iris',source:{index:0,quote:'Remove Iris from the list entirely.'}}]});
 assert.throws(()=>store.commit(del,hash(JSON.stringify(del)),p,store.revision(),'operations'),(e:any)=>e.code==='INJECTED_FAILURE');assert.deepEqual(store.snapshot('s'),before);assert.equal(store.receipt(del.request_id,hash(JSON.stringify(del))),null);commit(del,p);
}));
