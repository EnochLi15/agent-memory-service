import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Models} from '../dist/models.js';
import {configFromEnv} from '../dist/config.js';
import {extractionSchema} from '../dist/types.js';
import {VerificationSession} from '../dist/verification-session.js';

test('streamed key-quote recovery is audited and preserves a semantic rejection without resampling',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-key-recovery-')),audit=join(dir,'audit.jsonl'),trace=join(dir,'trace.jsonl');
 const previous={audit:process.env.MEMORY_MODEL_AUDIT,trace:process.env.MEMORY_MODEL_TRACE};let calls=0;
 const raw='{“fact_checks”:[[0,false,true,0,"Unsupported “manager”: assertion"]],"operation_checks":[],"replacement_checks":[],"message_checks":[[0,"represented",[0],[]]]}';
 const server=createServer(async(req,res)=>{
  for await(const _ of req){}calls++;
  res.writeHead(200,{'content-type':'text/event-stream'});
  // Split through the malformed key to exercise real streaming aggregation.
  for(const text of [raw.slice(0,8),raw.slice(8)])res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n');
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 process.env.MEMORY_MODEL_AUDIT=audit;process.env.MEMORY_MODEL_TRACE=trace;
 try{
  const config={...configFromEnv({MEMORY_VERIFICATION_FORMAT:'compact',MEMORY_LLM_API_KEY:'fixture-secret-never-log'}),llmBase:`http://127.0.0.1:${(server.address() as any).port}`};
  const req={user_id:'u',request_id:'r',session_id:'s',messages:[{role:'user',content:'My manager is Clara.',timestamp:'2026-01-01T00:00:00Z'}]};
  const proposal=extractionSchema.parse({facts:[{subject:'user',predicate:'manager',value:'Other',content:'My manager is Other.',sources:[{index:0,quote:req.messages[0]!.content}]}],operations:[]});
  const models=new Models(config),session=new VerificationSession();
  const findings=await models.verify(proposal,req,[],[],AbortSignal.timeout(2000),session);
  assert.ok(findings.some(f=>f.startsWith('fact 0:')&&f.includes('Unsupported “manager”: assertion')));
  assert.deepEqual(await models.verify(proposal,req,[],[],AbortSignal.timeout(2000),session),findings);
  assert.equal(calls,1,'A repaired JSON delimiter must not resample a negative semantic verdict');
  const rows=readFileSync(audit,'utf8').trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(rows.length,1);assert.equal(rows[0].outcome,'ok');assert.equal(rows[0].repaired_key_quotes,1);
  assert.equal(rows[0].syntax_normalization,'typographic_key_quotes_only');
  const saved=JSON.parse(readFileSync(trace,'utf8').trim());assert.equal(saved.output_text,raw);assert.equal(saved.output.fact_checks[0][1],false);
  assert.ok(!readFileSync(audit,'utf8').includes(config.llmKey));assert.ok(!readFileSync(trace,'utf8').includes(config.llmKey));
 }finally{
  for(const [key,value] of [['MEMORY_MODEL_AUDIT',previous.audit],['MEMORY_MODEL_TRACE',previous.trace]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
  await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
 }
});
