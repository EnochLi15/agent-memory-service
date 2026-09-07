import {continuationCall} from './write-continuation.js';
import {setTimeout as retryWait} from 'node:timers/promises';
import {modelRetryDelay,modelRateLimitDelay,classifyStreamError} from './model-retry.js';
import {sharedModelGate,ModelGate} from './model-gate.js';
import {sourceCoverageWork,SOURCE_COVERAGE_PROMPT} from './source-coverage.js';
// Adapted from mem0 TS llms/openai.ts and embeddings/ollama.ts at dae67f7.
// Changes: bounded cancellation, explicit model, no automatic downloads, true batch embed,
// strict vector validation, no tool calls or SDK retry hidden outside the request deadline.
import OpenAI from 'openai';
import { appendFileSync } from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type { Config } from './config.js';
import { ServiceError,hasRestoreWording } from './types.js';
import {modelFailure} from './model-failure.js';
import type {AddRequest,Extraction,Fact} from './types.js';
import {VERIFICATION_PROMPT,verificationInput,VerificationProtocolError} from './verification.js';
import {VerificationSession} from './verification-session.js';
import {COMPACT_VERIFICATION_PROMPT,COMPACT_VERIFICATION_PROTOCOL,COMPACT_VERIFICATION_RESPONSE_FORMAT,decodeCompactVerification} from './verification-compact.js';
import {SOURCE_ERASURE_RESPONSE_FORMAT,SOURCE_QUOTE_REPAIR_RESPONSE_FORMAT} from './source-erasure.js';
import {ERASURE_RESPONSE_FORMAT} from './erasure.js';
import {parseModelJson} from './model-json.js';
import {TRANSITION_RESPONSE_FORMAT} from './transitions.js';
function audit(record:Record<string,unknown>):void {
  if(process.env.MEMORY_MODEL_AUDIT)appendFileSync(process.env.MEMORY_MODEL_AUDIT,JSON.stringify({at:new Date().toISOString(),...record})+'\n');
}
type GenerationPurpose='extraction'|'verification'|'repair'|'rerank'|'erasure_binding'|'source_erasure'|'source_erasure_repair'|'state_transition'|'source_operation'|'source_operation_screen'|'source_operation_closure'|'source_operation_route';
type GenerationContext={source_erasure_batch?:import('./source-erasure-execution.js').SourceErasureBatchContext;extraction_shard?:{index:number;count:number;participants:number[]};purpose?:GenerationPurpose;verification_format?:string;verification_scope?:{facts:number;operations:number;replacements:number;messages:number;reused:number};trace?:{user_id:string;request_id:string}};

export class Models {
  private client: OpenAI;
  private gate:ModelGate;
  constructor(private config: Config) {
    this.gate=sharedModelGate(config.llmBase,config.llmKey,config.modelMinIntervalMs);
    this.client = new OpenAI({ apiKey: config.llmKey || 'local', baseURL: config.llmBase, maxRetries: 0, timeout: config.addTimeout });
  }
  private stageModel(purpose:GenerationPurpose):string{return purpose==='rerank'?this.config.llmModel:this.config.llmStageModels[purpose==='erasure_binding'||purpose==='source_erasure'||purpose==='source_erasure_repair'||purpose==='state_transition'||purpose==='source_operation'||purpose==='source_operation_screen'||purpose==='source_operation_closure'||purpose==='source_operation_route'?'verification':purpose]??this.config.llmModel;}
  async verify(proposal:Extraction,req:AddRequest,facts:Fact[],omitted:number[],signal:AbortSignal,session=new VerificationSession(),resolvedSourceActions:unknown[]=[]):Promise<string[]>{
    const invalidRestores=proposal.operations.flatMap((o,index)=>o.type==='restore'&&!hasRestoreWording(o.source.quote)?[`operation ${index}: Restore needs an explicit instruction to remember again. Keeping an existing active fact unchanged is not restoration. Remove this unsupported operation; do not invent reauthorization or alter unrelated facts.`]:[]);
    if(invalidRestores.length)return invalidRestores;
    const currentSources=new Set(req.messages.map((_,index)=>createHash('sha256').update(`${req.user_id}\0${req.request_id}\0${index}`).digest('hex')));
    const changedTargets=new Set([...proposal.operations.flatMap(o=>o.target_ids),...proposal.facts.flatMap(f=>f.supersedes)]);
    const retentionContext=resolvedSourceActions.length?facts.filter(f=>f.state==='active'&&!changedTargets.has(f.id)&&!f.source_ids.some(id=>currentSources.has(id))).map(f=>({id:f.id,subject:f.subject,predicate:f.predicate,scope:f.scope,content:f.content,value:f.value,state:f.state,modality:f.modality})):[];
    const coverage=this.config.sourceFirst?sourceCoverageWork(req,proposal):undefined;
    const compact=this.config.verificationFormat==='compact',prompt=(compact?COMPACT_VERIFICATION_PROMPT:VERIFICATION_PROMPT)+(coverage?SOURCE_COVERAGE_PROMPT:'')+(resolvedSourceActions.length?'\nRESOLVED_SOURCE_ACTIONS were independently authorized against exact source targets before this proposal. They are pending atomic source removals, separate from fact operations. Do not demand duplicate fact-ID operations for these exact instructions. Still check every remaining personal assertion and instruction in those messages. A message with only resolved source instructions and no other memorable information may be not_memorable. Never use this context to authorize changing an unrelated fact. A proposed negative fact that restates a rejected assistant value still retains that detail: mark it unsupported. Removing rejected-claim summaries is not a coverage failure. Preserve independent user facts, including real preferences or routines. When a resolved source rejection is accompanied only by a request to KEEP specific already-active existing facts unchanged, those retention clauses require no additional fact or operation: use not_memorable if nothing else requires new storage or mutation. Check EXISTING_ACTIVE_FACTS for the exact owner/property/value and active state first; an absent record cannot use this exception. This exception does not cover a new personal assertion, a missing/erased record, a changed value, a future plan or another unresolved memory instruction. Do not demand restore for retaining an active record; restore needs explicit new authorization to remember again.':'');
    const plan=session.plan(req,proposal,facts,{base:this.config.llmBase,model:this.stageModel('verification'),effort:this.config.llmReasoningEffort,prompt,resolvedSourceActions,retentionContext,responseFormat:this.config.verificationResponseFormat,...(this.config.verificationResponseFormat==='json_schema'?{schema:COMPACT_VERIFICATION_RESPONSE_FORMAT.json_schema}:{})},coverage);
    if(plan.blockedFindings.length)return plan.blockedFindings;
    const scope=plan.scope;
    const counts={facts:scope.fact_indices.length,operations:scope.operation_indices.length,replacements:scope.replacements.length,messages:scope.message_indices.length,reused:plan.reused};
    if(!counts.facts&&!counts.operations&&!counts.replacements&&!counts.messages)return session.evaluate(plan,{fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[]});
    const data={...verificationInput(req,proposal,facts,omitted,scope),...(coverage?{SOURCE_COVERAGE_CANDIDATES:coverage.candidates.map(({slot,message,quote})=>({slot,message,quote}))}:{}),...(resolvedSourceActions.length?{RESOLVED_SOURCE_ACTIONS:resolvedSourceActions,EXISTING_ACTIVE_FACTS:retentionContext}:{})};
    const input=JSON.stringify(compact?{...data,VERIFICATION_PROTOCOL:coverage?'source-first-coverage-tuples-v1':COMPACT_VERIFICATION_PROTOCOL,PROPOSAL:{...data.PROPOSAL,facts:data.PROPOSAL.facts.map(f=>({...f,sources:f.sources.map((s,source_slot)=>({...s,source_slot}))}))},REPLACEMENT_TARGETS:scope.replacements.map((r,check_index)=>({...r,check_index}))}:data);let repair='';
    for(let attempt=0;attempt<2;attempt++){
      let raw:unknown;
      try{raw=await this.json(prompt,input+repair,signal,{purpose:'verification',verification_format:coverage?'source-first-coverage-tuples-v1':compact?COMPACT_VERIFICATION_PROTOCOL:'verbose',verification_scope:counts,trace:{user_id:req.user_id,request_id:req.request_id}});}
      catch(error){if(error instanceof ServiceError&&error.code==='EVIDENCE_VALIDATION')throw error;throw new ServiceError('VERIFICATION_UNAVAILABLE','Could not complete evidence verification within the request budget');}
      try{const decoded=compact?decodeCompactVerification(raw,proposal,scope,coverage):undefined;return session.evaluate(plan,decoded?.canonical??raw,decoded?.protocolErrors);}
      catch(error){
        // A malformed later check cannot erase an already validated rejection.
        // Repair that proposal; merged checks must still cover the full proposal.
        if(error instanceof VerificationProtocolError&&error.findings.length)return error.findings;
        // Retry protocol errors only. Semantic rejection returns findings directly
        // and cannot be discarded by sampling a second checker verdict.
        if(!(error instanceof VerificationProtocolError)||attempt===1||signal.aborted)throw error;
        repair='\nPROTOCOL_REPAIR: '+JSON.stringify({error:error.message,previous:raw})+'. Return exactly all checks requested by CHECK_SCOPE using the required dispositions and actual proposal/source references. Preserve semantic failures; do not change the proposal.';
      }
    }
    throw new ServiceError('EVIDENCE_VALIDATION','Incomplete evidence verification');
  }

  async json(system: string, user: string, signal: AbortSignal,context?:GenerationContext): Promise<unknown> {
    try{return await continuationCall({system,user,context,base:this.config.llmBase,models:this.config.llmStageModels,model:this.config.llmModel,effort:this.config.llmReasoningEffort,responseFormat:this.config.verificationResponseFormat},signal,()=>this.gate.run(signal,()=>this.generateJson(system,user,signal,context)));}
    catch(error){
      // Syntax failure is a terminal protocol result, not a provider outage.
      // Keep the private audit's invalid_json classification and never expose
      // raw output or invite an HTTP retry against an already closed ledger.
      if(error instanceof SyntaxError)throw new ServiceError('EVIDENCE_VALIDATION','Model returned invalid JSON; this preparation cannot be resumed');
      throw error;
    }
  }
  private async generateJson(system:string,user:string,signal:AbortSignal,context?:GenerationContext):Promise<unknown>{
    // Streaming prevents idle gateway disconnects during long structured generations.
    // Nothing is published until the entire JSON object is validated and committed.
    const purpose=context?.purpose??(system.startsWith('Rank evidence')?'rerank':system.startsWith('Validate memory evidence')?'verification':system.includes('PATCH_SCHEMA')?'repair':'extraction');
    const {trace:identity,...auditContext}=context??{};
    const traceFile=process.env.MEMORY_MODEL_TRACE,traceId=traceFile?randomUUID():undefined;
    const saveTrace=(record:Record<string,unknown>):void=>{
      if(!traceFile)return;
      try{appendFileSync(traceFile,JSON.stringify({protocol:'private-model-trace-v1',at:new Date().toISOString(),trace_id:traceId,identity,purpose,model:this.stageModel(purpose),system,input:user,input_sha256:createHash('sha256').update(user).digest('hex'),...record})+'\n',{mode:0o600});}
      catch{throw new ServiceError('EVIDENCE_VALIDATION','Requested private model trace could not be written');}
    };
    const model=this.stageModel(purpose),structured=['verification','erasure_binding','source_erasure','source_erasure_repair','state_transition'].includes(purpose)&&this.config.verificationResponseFormat==='json_schema';
    const formatAudit=['verification','erasure_binding','source_erasure','source_erasure_repair','state_transition'].includes(purpose)?{verification_response_format:structured?'json_schema':'json_object'}:{};let last:unknown;
    for(let attempt=0;attempt<this.config.modelTransportAttempts;attempt++){
      await this.gate.startAttempt(signal);
      const started=performance.now();let usage:unknown=null,content='',finish:string|null=null,streamStarted=false,refusalDetected=false;
      try{
        const stream=await this.client.chat.completions.create({
          model,...(this.config.llmReasoningEffort?{reasoning_effort:this.config.llmReasoningEffort}:{}),messages:[{role:'system',content:system},{role:'user',content:user}],
          response_format:structured?(purpose==='source_erasure_repair'?SOURCE_QUOTE_REPAIR_RESPONSE_FORMAT:purpose==='state_transition'?TRANSITION_RESPONSE_FORMAT:purpose==='source_erasure'?SOURCE_ERASURE_RESPONSE_FORMAT:purpose==='erasure_binding'?ERASURE_RESPONSE_FORMAT:COMPACT_VERIFICATION_RESPONSE_FORMAT):{type:'json_object'},max_completion_tokens:10000,stream:true,stream_options:{include_usage:true},
        },{signal});
        streamStarted=true;
        for await(const chunk of stream){refusalDetected ||= !!chunk.choices[0]?.delta?.refusal;content+=chunk.choices[0]?.delta?.content??'';finish=chunk.choices[0]?.finish_reason??finish;usage=chunk.usage??usage;if(content.length>200000)throw new ServiceError('MODEL_OUTPUT','Model output too large');}
        if(!content||finish!=='stop'){signal.throwIfAborted();throw new ServiceError('MODEL_OUTPUT','Incomplete model output');}
        const {value:parsed,trailingCommas}=parseModelJson(content.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
        const syntax=trailingCommas?{syntax_normalization:'trailing_commas_only',removed_commas:trailingCommas}:{};
        saveTrace({attempt,outcome:'ok',output:parsed,...syntax,...(trailingCommas?{output_text:content}:{})});
        audit({kind:'generation',...auditContext,...formatAudit,...syntax,...(traceId?{trace_id:traceId}:{}),purpose,model,attempt,outcome:'ok',elapsed_ms:performance.now()-started,usage,output_chars:content.length});return parsed;
      }catch(caught){const error=classifyStreamError(caught,streamStarted,finish,refusalDetected);const failure=modelFailure(error,signal,streamStarted,finish,refusalDetected);const cooldown=modelRateLimitDelay(error,Date.now(),attempt);if(cooldown!==null){this.gate.defer(cooldown);audit({kind:"generation_cooldown",purpose,model,delay_ms:cooldown,scope:"provider_credential_process",reason:"http_429"});}saveTrace({attempt,outcome:'error',output_text:content,...failure});audit({kind:'generation',...auditContext,...formatAudit,...(traceId?{trace_id:traceId}:{}),purpose,model,attempt,outcome:'error',elapsed_ms:performance.now()-started,usage,...failure});last=error;if(attempt+1===this.config.modelTransportAttempts)throw error;const delay=modelRetryDelay(error,signal,Date.now(),attempt);if(delay===null)throw error;audit({kind:'generation_retry',purpose,model,after_attempt:attempt,delay_ms:delay,reason:failure.error_category});await retryWait(delay,undefined,{signal});}
    }
    throw last;
  }

  async embedBatch(texts: string[], action: 'add' | 'search', signal: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    const started=performance.now();
    try{
    if(this.config.embeddingDigest){
      const tags=await fetch(`${this.config.embeddingBase}/api/tags`,{signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
      if(!tags.ok)throw new ServiceError('EMBEDDING_IDENTITY','Could not verify local model digest');
      const body=await tags.json() as {models?:{name:string;model:string;digest:string}[]};
      const model=body.models?.find(m=>m.name===this.config.embeddingModel||m.model===this.config.embeddingModel);
      if(model?.digest!==this.config.embeddingDigest)throw new ServiceError('EMBEDDING_IDENTITY','Configured embedding digest differs from loaded model');
    }
    const prefix = this.config.embeddingModel.startsWith('nomic-embed-text') ? (action === 'search' ? 'search_query: ' : 'search_document: ') : '';
    // Evidence units are bounded during preparation. Do not silently truncate at the model.
    const response = await fetch(`${this.config.embeddingBase}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.embeddingModel, input: texts.map(t => prefix + t), truncate: false, keep_alive: '30m' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new ServiceError('EMBEDDING_HTTP', `Embedding HTTP ${response.status}`);
    const data = await response.json() as { embeddings?: unknown; prompt_eval_count?:number };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new ServiceError('EMBEDDING_SHAPE', 'Invalid embedding batch');
    const vectors=data.embeddings.map((v: unknown) => {
      if (!Array.isArray(v) || v.length !== this.config.embeddingDimensions || !v.every(x => typeof x === 'number' && Number.isFinite(x))) throw new ServiceError('EMBEDDING_DIMENSION', 'Embedding dimension or values invalid');
      const vector = v as number[]; const norm = Math.hypot(...vector);
      if (!norm) throw new ServiceError('EMBEDDING_ZERO', 'Zero vector');
      return vector.map(x => x / norm);
    });
    audit({kind:'embedding',action,model:this.config.embeddingModel,count:texts.length,elapsed_ms:performance.now()-started,prompt_eval_count:data.prompt_eval_count??null,outcome:'ok'});return vectors;
    }catch(error){
      audit({kind:'embedding',action,model:this.config.embeddingModel,count:texts.length,elapsed_ms:performance.now()-started,outcome:'error',...modelFailure(error,signal,false,null),...(error instanceof ServiceError?{error_code:error.code}:{})});
      throw error;
    }
  }
}
