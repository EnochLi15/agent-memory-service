import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {Models} from '../dist/models.js';import {configFromEnv} from '../dist/config.js';import {extractionSchema} from '../dist/types.js';import {VerificationSession} from '../dist/verification-session.js';
const req={request_id:'schema',user_id:'u',session_id:'s',messages:[{role:'user',content:'My browser is Firefox.',timestamp:'2026-01-01T00:00:00Z'}]};
const proposal=extractionSchema.parse({facts:[{content:'My browser is Firefox.',subject:'user',predicate:'browser',value:'Firefox',sources:[{index:0,quote:req.messages[0]!.content}]}]});
const full=()=>({fact_checks:[[0,true,true,0]],operation_checks:[],replacement_checks:[],message_checks:[[0,'represented',[0],[]]]});
const config=()=>configFromEnv({MEMORY_VERIFICATION_FORMAT:'compact',MEMORY_VERIFICATION_RESPONSE_FORMAT:'json_schema'});
const verify=(m:Models,state=new VerificationSession())=>m.verify(proposal,req,[],[],AbortSignal.timeout(1000),state);
async function endpoint(reply:(body:any)=>{status?:number;output:unknown}){
 const bodies:any[]=[];const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);bodies.push(body);const result=reply(body);
  if(result.status){res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.output));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(result.output)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 return {bodies,base:`http://127.0.0.1:${(server.address() as any).port}`,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}

test('strict verification requests require all four arrays without changing extraction format',async()=>{
 const http=await endpoint(body=>({output:body.response_format.type==='json_schema'?full():{fact_checks:full().fact_checks}}));
 try{
  const c=config();c.llmBase=http.base;const m=new Models(c);assert.deepEqual(await verify(m),[]);
  assert.equal(http.bodies.length,1);const format=http.bodies[0].response_format;assert.equal(format.type,'json_schema');assert.equal(format.json_schema.strict,true);
  assert.deepEqual(format.json_schema.schema.required,['fact_checks','operation_checks','replacement_checks','message_checks']);assert.equal(format.json_schema.schema.additionalProperties,false);
  await m.json('extract evidence','{}',AbortSignal.timeout(1000),{purpose:'extraction'});assert.deepEqual(http.bodies[1].response_format,{type:'json_object'});
  assert.throws(()=>configFromEnv({MEMORY_VERIFICATION_RESPONSE_FORMAT:'invalid'}),/RESPONSE_FORMAT/);
  assert.throws(()=>configFromEnv({MEMORY_VERIFICATION_RESPONSE_FORMAT:'json_schema'}),/compact/);
 }finally{await http.close();}
});

test('schema-conforming semantic rejection is never resampled and transport mode changes invalidate passes',async()=>{
 let reject=true;const http=await endpoint(()=>({output:reject?{...full(),fact_checks:[[0,false,true,0,'Wrong claim despite valid structure']]}:full()}));
 try{
  const c=config();c.llmBase=http.base;const m=new Models(c),state=new VerificationSession();assert.match((await verify(m,state))[0]!,/Wrong claim/);assert.equal(http.bodies.length,1);
  reject=false;assert.match((await verify(m,state))[0]!,/Wrong claim/);assert.equal(http.bodies.length,1);
  const passes=new VerificationSession();assert.deepEqual(await verify(m,passes),[]);(c as any).verificationResponseFormat='json_object';assert.deepEqual(await verify(m,passes),[]);assert.equal(http.bodies.length,3);
  assert.deepEqual(http.bodies[2].response_format,{type:'json_object'});assert.deepEqual(JSON.parse(http.bodies[2].messages[1].content).CHECK_SCOPE.fact_indices,[0]);
 }finally{await http.close();}
});

test('unsupported strict schema is reported without silently downgrading the request',async()=>{
 const http=await endpoint(()=>({status:400,output:{error:{message:'Schema unsupported',type:'invalid_request_error'}}}));
 try{
  const c=config();c.llmBase=http.base;await assert.rejects(verify(new Models(c)),/complete evidence verification/);assert.equal(http.bodies.length,2);assert.ok(http.bodies.every(b=>b.response_format.type==='json_schema'));
 }finally{await http.close();}
});
