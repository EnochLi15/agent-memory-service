import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceErasureWork,sourceErasureInput,erasureAnchors,decodeSourceErasureResponse} from '../src/source-erasure.js';
import {groupSourceErasureWork,groupedSourceErasureInput,executeGroupedSourceErasure} from '../src/source-erasure-grouped.js';
import {valueDigest} from '../src/erasure.js';

function fixture(){
 const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:'A red notebook was mine. I now use blue.'}]};
 const card={id:'pattern-test',content:'[Aggregated pattern] user: experience — a red notebook, cooking soup (2 statements)',value:'a red notebook, cooking soup',subject:'user',predicate:'experience',scope:'',kind:'reflection',modality:'inferred',cardinality:'multiple',depends_on:['member-a','member-b'],supersedes:[],source_ids:['source'],source_quotes:[],source_spans:[],state:'active',vector:null,revision:2} as any;
 const boundary={subject:'user',predicate:'old_notebook',scope:'',boundary:'value',valueHash:valueDigest('red notebook'),tokenCount:2,allowedValueHashes:[],revision:1,anchorHashes:erasureAnchors({content:'red notebook',value:'red notebook'})} as any;
 const message={id:'source',content:req.messages[0]!.content,role:'user',session_id:'s',ordinal:0,timestamp:'2026-01-01'} as any;
 return {req,card,message,boundary,work:sourceErasureWork(req,[],[card],[],[boundary],[],[message])};
}

test('both wire formats expose per-kind effects and distinguish a derived reflection from a source',()=>{
 const {work,card}=fixture(),before=structuredClone(work);
 const flat=sourceErasureInput(work),grouped=groupedSourceErasureInput(groupSourceErasureWork(work).work);
 for(const rows of [flat.SOURCES,grouped.SOURCES]){
  const fact=rows.find(c=>c.kind==='fact')! as any,source=rows.find(c=>c.kind==='source')! as any;
  assert.deepEqual(fact.allowed_effects,['erase','retain','uncertain']);
  assert.deepEqual(source.allowed_effects,['erase','retain','mixed','uncertain']);
  assert.equal(fact.context.fact_kind,'reflection');assert.equal(fact.context.dependency_count,2);
  assert.deepEqual(fact.context.source_quotes,[],'derived text must not become a human witness');
  assert.equal(fact.context.depends_on,undefined,'do not add dangling member references');
  assert.equal(fact.text,card.content);assert.equal(source.context.fact_kind,undefined);
 }
 assert.deepEqual(work,before);assert.equal(work.candidates.length,2);
});

test('ordinary facts carry their actual kind and zero dependencies without inventing provenance',()=>{
 const {req,card,boundary}=fixture();const fact={...card,kind:'fact',modality:'confirmed',depends_on:[],source_quotes:['a red notebook']};
 const row=sourceErasureInput(sourceErasureWork(req,[],[fact],[],[boundary],[],[])).SOURCES[0] as any;
 assert.equal(row.context.fact_kind,'fact');assert.equal(row.context.dependency_count,0);assert.deepEqual(row.context.source_quotes,['a red notebook']);
});

test('mixed-on-fact and an empty mixed-source quote have separate precise refusal diagnostics',()=>{
 const {work}=fixture(),fact={fingerprint:'fact',candidates:work.candidates.filter(c=>c.kind==='fact')},source={fingerprint:'source',candidates:work.candidates.filter(c=>c.kind==='source')};
 assert.throws(()=>decodeSourceErasureResponse({decisions:[{index:0,effect:'mixed',reason:'mixed_source',erase_quotes:['a red notebook']}]},fact),/Mixed erasure is not allowed for fact candidates/);
 assert.throws(()=>decodeSourceErasureResponse({decisions:[{index:0,effect:'mixed',reason:'mixed_source',erase_quotes:[]}]},source),/Mixed source erasure requires explicit quotes/);
});

for(const effect of ['mixed','uncertain'])test(`a ${effect} fact verdict remains a refusal without a semantic repair or member deletion`,async()=>{
 const {work}=fixture();work.candidates=work.candidates.filter(c=>c.kind==='fact');const before=structuredClone(work);let calls=0;
 await assert.rejects(executeGroupedSourceErasure(work,1,AbortSignal.timeout(1000),async(_s,_i,_signal,purpose)=>{
  calls++;assert.equal(purpose,'source_erasure');return {decisions:[{index:0,effect,reason:effect==='mixed'?'mixed_source':'mixed_fact',erase_quotes:effect==='mixed'?['a red notebook']:[]}]};
 }));
 assert.equal(calls,1);assert.deepEqual(work,before);
});

test('source partition semantics remain exact and independent text remains retained',()=>{
 const {work}=fixture();work.candidates=work.candidates.filter(c=>c.kind==='source');
 const plan=decodeSourceErasureResponse({decisions:[{index:0,effect:'mixed',reason:'mixed_source',erase_quotes:['A red notebook was mine.']}]},work);
 assert.deepEqual(plan.decisions[0]!.parts,[{text:'A red notebook was mine.',effect:'erase'},{text:' I now use blue.',effect:'retain'}]);
});
