// Adapted from mem0 TS llms/openai.ts and embeddings/ollama.ts at dae67f7.
// Changes: bounded cancellation, explicit model, no automatic downloads, true batch embed,
// strict vector validation, no tool calls or SDK retry hidden outside the request deadline.
import OpenAI from 'openai';
import { appendFileSync } from 'node:fs';
import type { Config } from './config.js';
import { ServiceError } from './types.js';
import type {AddRequest,Extraction,Fact} from './types.js';
import {VERIFICATION_PROMPT,verificationInput,VerificationProtocolError} from './verification.js';
import {VerificationSession} from './verification-session.js';
function audit(record:Record<string,unknown>):void {
  if(process.env.MEMORY_MODEL_AUDIT)appendFileSync(process.env.MEMORY_MODEL_AUDIT,JSON.stringify({at:new Date().toISOString(),...record})+'\n');
}
type GenerationPurpose='extraction'|'verification'|'repair'|'rerank';
type GenerationContext={purpose?:GenerationPurpose;verification_scope?:{facts:number;operations:number;replacements:number;messages:number;reused:number}};

export class Models {
  private client: OpenAI;
  constructor(private config: Config) {
    this.client = new OpenAI({ apiKey: config.llmKey || 'local', baseURL: config.llmBase, maxRetries: 0, timeout: config.addTimeout });
  }
  private stageModel(purpose:GenerationPurpose):string{return purpose==='rerank'?this.config.llmModel:this.config.llmStageModels[purpose]??this.config.llmModel;}
  async verify(proposal:Extraction,req:AddRequest,facts:Fact[],omitted:number[],signal:AbortSignal,session=new VerificationSession()):Promise<string[]>{
    const plan=session.plan(req,proposal,facts,{base:this.config.llmBase,model:this.stageModel('verification'),effort:this.config.llmReasoningEffort,prompt:VERIFICATION_PROMPT});
    if(plan.blockedFindings.length)return plan.blockedFindings;
    const scope=plan.scope;
    const counts={facts:scope.fact_indices.length,operations:scope.operation_indices.length,replacements:scope.replacements.length,messages:scope.message_indices.length,reused:plan.reused};
    if(!counts.facts&&!counts.operations&&!counts.replacements&&!counts.messages)return session.evaluate(plan,{fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[]});
    const input=JSON.stringify(verificationInput(req,proposal,facts,omitted,scope));let repair='';
    for(let attempt=0;attempt<2;attempt++){
      let raw:unknown;
      try{raw=await this.json(VERIFICATION_PROMPT,input+repair,signal,{purpose:'verification',verification_scope:counts});}
      catch{throw new ServiceError('VERIFICATION_UNAVAILABLE','Could not complete evidence verification within the request budget');}
      try{return session.evaluate(plan,raw);}
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
    // Streaming prevents idle gateway disconnects during long structured generations.
    // Nothing is published until the entire JSON object is validated and committed.
    const purpose=context?.purpose??(system.startsWith('Rank evidence')?'rerank':system.startsWith('Validate memory evidence')?'verification':system.includes('PATCH_SCHEMA')?'repair':'extraction');
    const model=this.stageModel(purpose);let last:unknown;
    for(let attempt=0;attempt<2;attempt++){
      const started=performance.now();let usage:unknown=null;
      try{
        const stream=await this.client.chat.completions.create({
          model,...(this.config.llmReasoningEffort?{reasoning_effort:this.config.llmReasoningEffort}:{}),messages:[{role:'system',content:system},{role:'user',content:user}],
          response_format:{type:'json_object'},max_completion_tokens:10000,stream:true,stream_options:{include_usage:true},
        },{signal});
        let content='',finish:string|null=null;
        for await(const chunk of stream){content+=chunk.choices[0]?.delta?.content??'';finish=chunk.choices[0]?.finish_reason??finish;usage=chunk.usage??usage;if(content.length>200000)throw new ServiceError('MODEL_OUTPUT','Model output too large');}
        if(!content||finish!=='stop')throw new ServiceError('MODEL_OUTPUT','Incomplete model output');
        const parsed=JSON.parse(content.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')) as unknown;
        audit({kind:'generation',...context,purpose,model,attempt,outcome:'ok',elapsed_ms:performance.now()-started,usage});return parsed;
      }catch(error){audit({kind:'generation',...context,purpose,model,attempt,outcome:'error',elapsed_ms:performance.now()-started,usage,error_type:error instanceof Error?error.name:'unknown'});last=error;if(signal.aborted||error instanceof ServiceError||error instanceof SyntaxError)throw error;if(attempt===1)throw error;}
    }
    throw last;
  }

  async embedBatch(texts: string[], action: 'add' | 'search', signal: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    const started=performance.now();
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
  }
}
