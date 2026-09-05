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
    const completion = await this.client.chat.completions.create({
      model: this.config.llmModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, max_completion_tokens: 6500,
    }, { signal });
    const content = completion.choices[0]?.message.content;
    if (!content || completion.choices[0]?.finish_reason === 'length') throw new ServiceError('MODEL_OUTPUT', 'Incomplete model output');
    return JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as unknown;
  }
  async embedBatch(texts: string[], action: 'add' | 'search', signal: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
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
