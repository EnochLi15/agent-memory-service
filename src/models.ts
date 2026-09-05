// Adapted from mem0 TS llms/openai.ts and embeddings/ollama.ts at dae67f7.
// Changes: bounded cancellation, explicit model, no automatic downloads, true batch embed,
// strict vector validation, no tool calls or SDK retry hidden outside the request deadline.
import OpenAI from 'openai';
import type { Config } from './config.js';
import { ServiceError } from './types.js';

export class Models {
  private client: OpenAI;
  constructor(private config: Config) {
    this.client = new OpenAI({ apiKey: config.llmKey || 'local', baseURL: config.llmBase, maxRetries: 0, timeout: config.addTimeout });
  }
  async json(system: string, user: string, signal: AbortSignal): Promise<unknown> {
    // Streaming prevents idle gateway disconnects during long structured generations.
    // Nothing is published until the entire JSON object is validated and committed.
    let last:unknown;
    for(let attempt=0;attempt<2;attempt++){
      try{
        const stream=await this.client.chat.completions.create({
          model:this.config.llmModel,messages:[{role:'system',content:system},{role:'user',content:user}],
          response_format:{type:'json_object'},max_completion_tokens:10000,stream:true,
        },{signal});
        let content='',finish:string|null=null;
        for await(const chunk of stream){content+=chunk.choices[0]?.delta?.content??'';finish=chunk.choices[0]?.finish_reason??finish;if(content.length>200000)throw new ServiceError('MODEL_OUTPUT','Model output too large');}
        if(!content||finish!=='stop')throw new ServiceError('MODEL_OUTPUT','Incomplete model output');
        return JSON.parse(content.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')) as unknown;
      }catch(error){last=error;if(signal.aborted||error instanceof ServiceError||error instanceof SyntaxError)throw error;if(attempt===1)throw error;}
    }
    throw last;
  }

  async embedBatch(texts: string[], action: 'add' | 'search', signal: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
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
    const data = await response.json() as { embeddings?: unknown };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new ServiceError('EMBEDDING_SHAPE', 'Invalid embedding batch');
    return data.embeddings.map((v: unknown) => {
      if (!Array.isArray(v) || v.length !== this.config.embeddingDimensions || !v.every(x => typeof x === 'number' && Number.isFinite(x))) throw new ServiceError('EMBEDDING_DIMENSION', 'Embedding dimension or values invalid');
      const vector = v as number[]; const norm = Math.hypot(...vector);
      if (!norm) throw new ServiceError('EMBEDDING_ZERO', 'Zero vector');
      return vector.map(x => x / norm);
    });
  }
}
