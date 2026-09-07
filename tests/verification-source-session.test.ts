import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VerificationSession} from '../dist/verification-session.js';
import {sourceCoverageWork} from '../dist/source-coverage.js';
import {extractionSchema} from '../dist/types.js';

const req={request_id:'coverage-repair',user_id:'u',session_id:'s',messages:[
 {role:'user',content:'I keep a notebook for goals. It helps me stay organized.',timestamp:'2026-01-01T00:00:00Z'},
 {role:'user',content:'That sounds encouraging.',timestamp:'2026-01-01T00:00:01Z'},
 {role:'user',content:'My city is Portland.',timestamp:'2026-01-01T00:00:02Z'},
]};
const proposal=()=>extractionSchema.parse({facts:[{content:'My city is Portland.',subject:'user',predicate:'current_city',value:'Portland',sources:[{index:2,quote:'My city is Portland.'}]}],operations:[]});
const addNotebook=(p:any)=>p.facts.push(extractionSchema.parse({facts:[{content:'I keep a notebook for goals.',subject:'user',predicate:'organization_tool',value:'notebook',sources:[{index:0,quote:'I keep a notebook for goals.'}]}],operations:[]}).facts[0]);
const firstVerdict=(work:any,supported=true)=>({
 fact_checks:[{index:0,supported,modality_supported:true,source_index:2,quote:'My city is Portland.',reason:supported?'':'unsupported fixture claim'}],
 operation_checks:[],replacement_checks:[],message_checks:[
  {index:0,disposition:'missing',quote:'I keep a notebook for goals.',reason:'Notebook use needs a structured fact.'},
  {index:1,disposition:'represented',raw_slots:work.candidates.filter((c:any)=>c.message===1).map((c:any)=>c.slot),reason:'Incidental encouragement adds no durable personal state.'},
  {index:2,disposition:'represented',fact_indices:[0]},
 ],
});

test('source-first repair rechecks only changed evidence and remaps unchanged raw witnesses',()=>{
 const session=new VerificationSession(),p=proposal(),before=sourceCoverageWork(req,p);
 const first=session.plan(req,p,[],{model:'fixture'},before);
 assert.match(session.evaluate(first,firstVerdict(before))[0]!,/message 0:/);
 const oldSlot=before.candidates.find(c=>c.message===1)!.slot;
 addNotebook(p);
 const after=sourceCoverageWork(req,p),newSlot=after.candidates.find(c=>c.message===1)!.slot;
 assert.notEqual(before.fingerprint,after.fingerprint);
 assert.notEqual(oldSlot,newSlot,'The regression must actually renumber another message’s raw candidate');
 const next=session.plan(req,p,[],{model:'fixture'},after);
 assert.deepEqual(next.scope.fact_indices,[1]);
 assert.deepEqual(next.scope.message_indices,[0]);
 assert.deepEqual(next.cached.message_checks.find(c=>c.index===1)!.raw_slots,[newSlot]);
 assert.deepEqual(session.evaluate(next,{
  fact_checks:[{index:1,supported:true,modality_supported:true,source_index:0,quote:'I keep a notebook for goals.'}],
  operation_checks:[],replacement_checks:[],message_checks:[{index:0,disposition:'represented',fact_indices:[1],raw_slots:after.candidates.filter(c=>c.message===0).map(c=>c.slot)}],
 }),[]);
 const accepted=session.acceptedSourceCoverage(req,p);
 assert.deepEqual(accepted.find(c=>c.index===1)!.raw_slots,[newSlot]);
 assert.equal(after.candidates[newSlot]!.quote,before.candidates[oldSlot]!.quote);
});

test('an unrelated raw-catalog change cannot erase an unchanged semantic rejection',()=>{
 const session=new VerificationSession(),p=proposal(),before=sourceCoverageWork(req,p);
 const first=session.plan(req,p,[],{model:'fixture'},before);
 assert.equal(session.evaluate(first,firstVerdict(before,false)).length,2);
 addNotebook(p);
 const next=session.plan(req,p,[],{model:'fixture'},sourceCoverageWork(req,p));
 assert.equal(next.blockedFindings.length,1);
 assert.match(next.blockedFindings[0]!,/^fact 0:/);
});

test('changed local raw evidence invalidates that message certificate',()=>{
 const session=new VerificationSession(),p=proposal(),before=sourceCoverageWork(req,p);
 session.evaluate(session.plan(req,p,[],{model:'fixture'},before),firstVerdict(before));
 const changed=structuredClone(before);
 changed.candidates.find(c=>c.message===1)!.quote='Different evidence';
 changed.fingerprint='different-catalog';
 const next=session.plan(req,p,[],{model:'fixture'},changed);
 assert.ok(next.scope.message_indices.includes(1));
 assert.equal(next.cached.message_checks.some(c=>c.index===1),false);
});
