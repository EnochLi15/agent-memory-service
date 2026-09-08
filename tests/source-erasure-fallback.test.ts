import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conservativeSourceErasureFallback} from '../src/source-erasure-fallback.js';
import {sourceErasureWork} from '../src/source-erasure.js';
import {containsValue, valueDigest} from '../src/erasure.js';
import {ServiceError, type AddRequest, type Fact, type Operation, type StoredMessage} from '../src/types.js';

const timestamp='2026-01-01T00:00:00Z';
const request:AddRequest={request_id:'forget',user_id:'fixture',session_id:'current',messages:[{role:'user',content:'Forget my former treatment.',timestamp}]};
const message=(id:string,content:string):StoredMessage=>({id,session_id:'prior',ordinal:0,role:'user',content,timestamp,searchable:true});
const target=(content='I used the old treatment for a time.',value='old treatment')=>({id:'target',content,value,subject:'user',predicate:'treatment',scope:'former treatment',state:'active',source_ids:['target-source'],source_quotes:[content],vector:null,depends_on:[],supersedes:[]} as unknown as Fact);
const forget=(fact:Fact)=>({type:'forget',target_ids:[fact.id],subject:fact.subject,predicate:fact.predicate,scope:fact.scope,value:fact.value,boundary:'value',source:{index:0,quote:request.messages[0]!.content}} as Operation);
const requiresReview=(error:unknown)=>error instanceof ServiceError&&error.code==='EVIDENCE_VALIDATION'&&/semantic review required/i.test(error.message);

test('empty source-erasure work has a complete empty fallback without changing its fingerprint',()=>{
 const work=sourceErasureWork(request,[],[],[],[],[],[]);
 const result=conservativeSourceErasureFallback(work);
 assert.deepEqual(result,{fingerprint:work.fingerprint,decisions:[]});
 assert.notEqual(result.decisions,work.candidates);
});

test('weak-anchor nomination cannot erase or certify an independent source during capability failure',()=>{
 const fact=target(),independent=message('independent-remedy','I used a separate remedy last time, and it helped.');
 const work=sourceErasureWork(request,[fact],[],[forget(fact)],[],[independent],[]);
 assert.equal(work.candidates.length,1);
 const candidate=work.candidates[0]!;
 assert.equal(candidate.id,independent.id);
 assert.deepEqual([...candidate.matching_words].sort(),['time','used']);
 assert.equal(containsValue(candidate.text,candidate.boundary),false);
 const before=structuredClone(work);
 assert.throws(()=>conservativeSourceErasureFallback(work),requiresReview);
 assert.deepEqual(work,before);
});

test('even a target-linked source and exact literal do not authorize erasing its independent neighbor',()=>{
 const fact=target(),source=message('target-source',fact.content+' I now prefer independent email reminders.');
 const neighbor={...fact,id:'neighbor',content:'I now prefer independent email reminders.',value:'email reminders',predicate:'contact_preference',source_quotes:['I now prefer independent email reminders.']} as Fact;
 const work=sourceErasureWork(request,[fact,neighbor],[],[forget(fact)],[],[source],[]);
 const candidate=work.candidates.find(c=>c.kind==='source')!;
 assert.ok(candidate);
 assert.equal(containsValue(candidate.text,candidate.boundary),true);
 assert.ok((candidate.context as {linked_facts:{id:string}[]}).linked_facts.some(f=>f.id==='neighbor'));
 assert.ok((candidate.authorization as {target:Fact}).target.source_ids.includes(source.id));
 assert.throws(()=>conservativeSourceErasureFallback(work),requiresReview);
});

test('literal collisions under a historical boundary still require owner and scope review',()=>{
 const boundary={subject:'user',predicate:'appointment',scope:'',boundary:'value' as const,valueHash:valueDigest('Pham'),tokenCount:1,revision:1};
 const independent=message('different-owner','My colleague Kevin sees Pham; that is his appointment, not mine.');
 const work=sourceErasureWork(request,[],[],[],[boundary],[],[independent]);
 assert.equal(work.candidates.length,1);
 assert.equal(work.candidates[0]!.authorization,null);
 assert.throws(()=>conservativeSourceErasureFallback(work),requiresReview);
});

test('paraphrase candidates cannot be implicitly retained merely because the erased literal is absent',()=>{
 const fact=target(),echo=message('assistant-echo','The one you used at that time was the former course.');
 echo.role='assistant';
 const work=sourceErasureWork(request,[fact],[],[forget(fact)],[],[echo],[]);
 assert.equal(work.candidates.length,1);
 assert.equal(containsValue(work.candidates[0]!.text,work.candidates[0]!.boundary),false);
 assert.throws(()=>conservativeSourceErasureFallback(work),requiresReview);
});

test('explicit authorized restoration is handled by source work before the empty fallback',()=>{
 const fact=target(),restoration={type:'restore',target_ids:[fact.id],subject:fact.subject,predicate:fact.predicate,scope:fact.scope,value:fact.value,source:{index:0,quote:'Remember my old treatment again.'}} as Operation;
 const boundary={subject:fact.subject,predicate:fact.predicate,scope:fact.scope,boundary:'value' as const,valueHash:valueDigest(fact.value),tokenCount:2,revision:1};
 const restored=message('restored',fact.content);
 const work=sourceErasureWork(request,[],[],[restoration],[boundary],[],[restored]);
 assert.equal(work.candidates.length,0);
 assert.deepEqual(conservativeSourceErasureFallback(work),{fingerprint:work.fingerprint,decisions:[]});
});
