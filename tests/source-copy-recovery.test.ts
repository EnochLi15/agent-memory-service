import {test} from 'node:test';import assert from 'node:assert/strict';
import {Extractor} from '../dist/extraction.js';import {configFromEnv} from '../dist/config.js';
const config=configFromEnv({MEMORY_MODE:'enhanced'}),snapshot={facts:[],tail:[],anchor:null,revision:0};

test('a unique capitalization copying error uses the declared human span before semantic verification',async()=>{
 const text="Dana says he doesn't even notice.",req={request_id:'case-copy',user_id:'u',session_id:'s',messages:[{role:'user',content:text,timestamp:'2026-01-01T00:00:00Z'}]};let calls=0,checks=0;
 const x=new Extractor(config,{json:async()=>{calls++;return calls===1?{facts:[{content:"Dana says he doesn't even notice.",subject:'Dana',predicate:'reported_reaction',value:"he doesn't even notice",sources:[{index:0,quote:"He doesn't even notice"}]}]}:{fact_edits:[{index:0,changes:{sources:[{index:0,quote:"he doesn't even notice"}]}}]};},verify:async(p:any)=>{checks++;assert.equal(p.facts[0].sources[0].quote,"he doesn't even notice");return [];}} as any);
 const result=await x.prepare(req,snapshot,AbortSignal.timeout(1000));
 assert.equal(calls,1,'Case-only copying must not spend a model repair round');assert.equal(checks,1);assert.equal(result.facts[0]!.source_quotes[0],"he doesn't even notice");
});

test('case-insensitive recovery cannot choose among repeated spans or change the declared speaker',async()=>{
 for(const messages of [
  [{role:'user',content:'Dana says he does not notice. Craig says he does not notice.'}],
  [{role:'user',content:'Dana asked how Craig reacted.'},{role:'assistant',content:'he does not notice.'}],
 ]){
  const req={request_id:'ambiguous',user_id:'u',session_id:'s',messages:messages.map(m=>({...m,timestamp:'2026-01-01T00:00:00Z'}))};let calls=0,checks=0,feedback='';
  const x=new Extractor(config,{json:async(_s:string,input:string)=>{calls++;if(calls===1)return {facts:[{content:'Reported reaction',subject:'Dana',predicate:'reaction',value:'does not notice',sources:[{index:0,quote:'He does not notice'}]}]};feedback=JSON.parse(input).REPAIR_FEEDBACK;throw new Error('Probe ends at required model repair');},verify:async()=>{checks++;throw new Error('Invalid source must not reach semantic verification');}} as any);
  // Offline fallback may reject or return independent grounded facts. Neither
  // outcome can pretend that the ambiguous model quote passed verification.
  try{await x.prepare(req,snapshot,AbortSignal.timeout(1000));}catch{}
  assert.equal(calls,2);assert.equal(checks,0);assert.match(feedback,/exact substring/);
 }
});
