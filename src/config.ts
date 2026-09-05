import { resolve } from 'node:path';
export interface Config {
  port: number; host: string; dataDir: string; mode: 'enhanced' | 'offline'; llmBase: string; llmKey: string; llmModel: string;
  embeddingBase: string; embeddingModel: string; embeddingDigest: string | null; embeddingDimensions: number; embeddingSpace: string;
  addTimeout: number; searchTimeout: number; maxEvidence: number; tokenBudget: number; retrieval: 'hybrid' | 'lexical' | 'mem0';
  rerank: boolean; rawFallback: boolean;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (k: string, n: number): number => { const v = Number(env[k] ?? n); if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${k}`); return v; };
  const model = env.MEMORY_EMBEDDING_MODEL ?? 'nomic-embed-text:latest';
  const dimensions = num('MEMORY_EMBEDDING_DIMENSIONS', 768);
  return {
    port: num('PORT', 8088), host: env.HOST ?? '127.0.0.1', dataDir: resolve(env.MEMORY_DATA_DIR ?? '.data'),
    mode: env.MEMORY_MODE === 'enhanced' ? 'enhanced' : 'offline',
    llmBase: (env.MEMORY_LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, ''), llmKey: env.MEMORY_LLM_API_KEY ?? '', llmModel: env.MEMORY_LLM_MODEL ?? 'gpt-5.4-mini',
    embeddingBase: (env.MEMORY_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''), embeddingModel: model, embeddingDigest: env.MEMORY_EMBEDDING_DIGEST??null,
    embeddingDimensions: dimensions, embeddingSpace: `${model}:${env.MEMORY_EMBEDDING_DIGEST ?? 'configured'}:${dimensions}:${model.startsWith('nomic-embed-text')?'nomic-prefix-v1':'none'}`,
    addTimeout: num('MEMORY_ADD_TIMEOUT_MS', 115000), searchTimeout: num('MEMORY_SEARCH_TIMEOUT_MS', 55000),
    maxEvidence: num('MEMORY_MAX_EVIDENCE', 32), tokenBudget: num('MEMORY_TOKEN_BUDGET', 6000),
    retrieval: env.MEMORY_RETRIEVAL === 'lexical' ? 'lexical' : env.MEMORY_RETRIEVAL === 'mem0' ? 'mem0' : 'hybrid',
    rerank: env.MEMORY_RERANK === 'true', rawFallback: env.MEMORY_RAW_FALLBACK !== 'false',
  };
}
