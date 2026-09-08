import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TenantStore} from '../dist/storage.js';
import {retrieve} from '../dist/retrieval.js';
import {configFromEnv} from '../dist/config.js';
import {normalizeTime,temporalEvidenceText} from '../dist/temporal.js';
import {parseModelJson} from '../dist/model-json.js';
import {modelFailure} from '../dist/model-failure.js';
import OpenAI from 'openai';

function fixture(work:(store:TenantStore,config:any,base:any)=>void){
 const dir=mkdtempSync(join(tmpdir(),'priority-quality-')),store=new TenantStore(dir,'u');
 const config={...configFromEnv({}),rawFallback:false,sourceIndex:false,eventView:true,maxEvidence:32,tokenBudget:6000};
 const base={subject:'Alex',predicate:'salary',scope:'',kind:'fact',modality:'confirmed',cardinality:'single',time_text:'',valid_from:null,valid_to:null,supersedes:[],depends_on:[],source_ids:[],source_quotes:[],created_at:'2025-01-01T00:00:00Z',observed_at:'2025-01-01T00:00:00Z',time_basis:'source',state:'active',vector:null,entities:['Alex'],revision:1};
 try{work(store,config,base);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test('historical operation evidence retains a corrected statement without making it a current fact or reviving erased values',()=>fixture((store,config,base)=>{
 // The recorded failure was a user's report of another person's offer: quoted
 // modality must remain available as a corrected statement in a message trace.
 const old={...base,id:'old',content:'Alex salary was reported as $90K.',value:'$90K',state:'retracted',modality:'quoted'};
 const current={...base,id:'new',content:'Alex corrected the salary to $95K.',value:'$95K'};
 for(const f of [old,current])store.db.prepare('INSERT INTO facts VALUES (?,?)').run(f.id,JSON.stringify(f));
 const event={id:'event-correction',type:'correct',actor:'user',category:'salary',slot_hash:'salary',source_ids:[],before_ids:['old'],after_ids:['new'],ordinal:2,observed_at:base.observed_at,time_basis:'source',revision:1};
 store.db.prepare('INSERT INTO memory_events VALUES (?,?)').run(event.id,JSON.stringify(event));
 const search=(query:string)=>retrieve(store,{user_id:'u',query,top_k:100},null,config).data.map(r=>r.content).join('\n');
 const question='Over the course of our conversations about Alex salary, which messages established and corrected the figure?';
 const history=search(question);
 assert.match(history,/\$90K/);assert.match(history,/\$95K/);assert.match(history,/later corrected|withdrawn statement/i);
 assert.doesNotMatch(search('What is Alex current salary?'),/\$90K/);
 store.db.prepare('UPDATE facts SET body=? WHERE id=?').run(JSON.stringify({...old,state:'erased',content:'',value:''}),'old');
 assert.doesNotMatch(search(question),/\$90K/);
 // A retained derived statement whose support has been erased is not history evidence.
 store.db.prepare('UPDATE facts SET body=? WHERE id=?').run(JSON.stringify({...old,depends_on:['erased-support']}),'old');
 store.db.prepare('INSERT INTO facts VALUES (?,?)').run('erased-support',JSON.stringify({...base,id:'erased-support',state:'erased',content:'',value:''}));
 assert.doesNotMatch(search(question),/\$90K/);
}));

test('relative week evidence preserves the anchor without asserting calendar-boundary days',()=>fixture((store,config,base)=>{
 const time=normalizeTime('last week','2023-07-09');
 const text=temporalEvidenceText(time);assert.match(text,/week before 2023-07-09/);assert.doesNotMatch(text,/2023-06-26|2023-07-03/);
 const f={...base,id:'week',content:'Alex was noticed by editors last week.',predicate:'recognition',value:'noticed by editors',time_text:'last week',event_time:time,valid_from:time.start,observed_at:'2023-07-09T00:00:00Z'};
 store.db.prepare('INSERT INTO facts VALUES (?,?)').run(f.id,JSON.stringify(f));
 const result=retrieve(store,{user_id:'u',query:'When was Alex noticed by editors?',top_k:100},null,config).data.map(r=>r.content).join('\n');
 assert.match(result,/week before 2023-07-09/);assert.doesNotMatch(result,/2023-06-26|scope: unspecified/);
 assert.match(temporalEvidenceText(normalizeTime('yesterday','2023-07-09')),/Event date: 2023-07-08/);
}));

test('typographic JSON key delimiters are repaired without editing string values or rejection verdicts',()=>{
 const result=parseModelJson('{“message_groups”:[{“message_index”:0,"facts":[],"operations":[]}],"note":"keep “message_index”: verbatim","accepted":false}');
 assert.deepEqual(result.value,{message_groups:[{message_index:0,facts:[],operations:[]}],note:'keep “message_index”: verbatim',accepted:false});
 assert.equal((result as any).keyQuotes,2);
 for(const raw of ['{“key”:“value”}','{“key”:','{“key” 1}','{“key”:1, “broken:2}'])assert.throws(()=>parseModelJson(raw),SyntaxError);
});

test('known provider rejection codes are auditable while free text and unknown codes remain private',()=>{
 const failure=(code:string)=>modelFailure(new OpenAI.APIError(400,{error:{code,message:'never expose request content'}},'private message',new Headers()),new AbortController().signal,false,null) as any;
 assert.equal(failure('context_length_exceeded').provider_error_code,'context_length_exceeded');
 assert.equal(failure('1301').provider_error_code,'1301');
 const privateCode='private-user-or-credential-value';const output=failure(privateCode);
 assert.equal(output.provider_error_code,null);assert.ok(!JSON.stringify(output).includes(privateCode));assert.ok(!JSON.stringify(output).includes('private message'));
});
