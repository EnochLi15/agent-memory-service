import {test} from 'node:test';import assert from 'node:assert/strict';
import {Extractor} from '../dist/extraction.js';import {configFromEnv} from '../dist/config.js';
import {decodeSourceReferences} from '../dist/source-references.js';import {decodeGroupedExtraction} from '../dist/extraction-groups.js';
const req={user_id:'u',request_id:'protocol',session_id:'s',messages:[{role:'user',content:'I plan to visit Paris.',timestamp:'2026-01-01T00:00:00Z'}]};
const fact={subject:'user',predicate:'travel_plan',value:'Paris',content:'I plan to visit Paris.',source_refs:[[0,0]]};
const raw=()=>({message_groups:[{message_index:0,facts:[{...fact}],operations:[]}]});
test('missing operations stay invalid but bounded repair receives the exact required field',async()=>{
 let calls=0,checks=0;
 const model={json:async(_s:string,input:string)=>{
  calls++;if(calls===1){const out:any=raw();delete out.message_groups[0].operations;return out;}
  const data=JSON.parse(input);assert.match(data.REPAIR_FEEDBACK,/message_groups\.0\.operations/);assert.match(data.REPAIR_FEEDBACK,/Required/);assert.match(data.REPAIR_FEEDBACK,/operations/);return raw();
 },verify:async()=>{checks++;return [];},embedBatch:async(xs:string[])=>xs.map(()=>[1,0])};
 const result=await new Extractor(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'source_refs',MEMORY_MAX_REPAIR_ROUNDS:'1'}),model as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(2000));
 assert.equal(result.facts.length,1);assert.equal(calls,2);assert.equal(checks,1);
});
test('grouped plan spelling uses the existing tentative-event normalization before strict parsing',()=>{
 const input:any=raw();input.message_groups[0].facts[0].kind='plan';input.message_groups[0].facts[0].modality='confirmed';
 for(const refs of [true,false]){
  const value=structuredClone(input);if(!refs){delete value.message_groups[0].facts[0].source_refs;value.message_groups[0].facts[0].sources=[{index:0,quote:req.messages[0].content}];}
  const out=(refs?decodeSourceReferences:decodeGroupedExtraction)(value,req);assert.equal(out.facts[0].kind,'event');assert.equal(out.facts[0].modality,'tentative');assert.equal(value.message_groups[0].facts[0].kind,'plan');
 }
 input.message_groups[0].facts[0].kind='invented';assert.throws(()=>decodeSourceReferences(input,req),/kind/);
});
test('exhausted grouped repair reports the actual schema failure and never invents empty operations',async()=>{
 const input:any=raw();delete input.message_groups[0].operations;
 await assert.rejects(new Extractor(configFromEnv({MEMORY_MODE:'enhanced',MEMORY_EXTRACTION_FORMAT:'source_refs',MEMORY_MAX_REPAIR_ROUNDS:'1'}),{json:async()=>input,verify:async()=>assert.fail('unvalidated proposal reached verifier')} as any).prepare(req,{revision:0,facts:[],tail:[],anchor:null},AbortSignal.timeout(1000)),/message_groups\.0\.operations/);
});
