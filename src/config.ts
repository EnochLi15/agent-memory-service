import { resolve } from 'node:path';
export interface Config {
  port: number; host: string; dataDir: string; mode: 'enhanced' | 'offline'; llmBase: string; llmKey: string; llmModel: string; llmReasoningEffort?:'low'|'medium'|'high';
  llmStageModels:Partial<Record<'extraction'|'verification'|'repair',string>>;
  embeddingBase: string; embeddingModel: string; embeddingDigest: string | null; embeddingDimensions: number; embeddingSpace: string;
  addTimeout: number; searchTimeout: number; maxEvidence: number; tokenBudget: number; retrieval: 'hybrid' | 'lexical' | 'mem0';
  rerank: boolean; rawFallback: boolean;incrementalVerification:boolean;
  candidateLimit:number;rerankCandidates:number;coveragePacking:boolean;sourceIndex:boolean;eventView:boolean;
  experimental: {rawOnly:boolean;lifecycle:boolean;temporal:boolean;multiHop:boolean;reflection:boolean};
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (k: string, n: number): number => { const v = Number(env[k] ?? n); if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${k}`); return v; };
  const model = env.MEMORY_EMBEDDING_MODEL ?? 'nomic-embed-text:latest';
  const dimensions = num('MEMORY_EMBEDDING_DIMENSIONS', 768);
  const effort=env.MEMORY_LLM_REASONING_EFFORT;
  if(effort!==undefined&&!['low','medium','high'].includes(effort))throw new Error('Invalid MEMORY_LLM_REASONING_EFFORT');
  const stageModels:Config['llmStageModels']={};
  for(const stage of ['extraction','verification','repair'] as const){
    const key=`MEMORY_${stage.toUpperCase()}_MODEL`,value=env[key];
    if(value!==undefined){if(!value.trim())throw new Error(`Invalid ${key}`);stageModels[stage]=value.trim();}
  }
  return {
    port: num('PORT', 8088), host: env.HOST ?? '127.0.0.1', dataDir: resolve(env.MEMORY_DATA_DIR ?? '.data'),
    mode: env.MEMORY_MODE === 'enhanced' ? 'enhanced' : 'offline',
    llmBase: (env.MEMORY_LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, ''), llmKey: env.MEMORY_LLM_API_KEY ?? '', llmModel: env.MEMORY_LLM_MODEL ?? 'gpt-5.4-mini',
    ...(effort?{llmReasoningEffort:effort as 'low'|'medium'|'high'}:{}),
    llmStageModels:stageModels,
    embeddingBase: (env.MEMORY_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''), embeddingModel: model, embeddingDigest: env.MEMORY_EMBEDDING_DIGEST??null,
    embeddingDimensions: dimensions, embeddingSpace: `${model}:${env.MEMORY_EMBEDDING_DIGEST ?? 'configured'}:${dimensions}:${model.startsWith('nomic-embed-text')?'nomic-prefix-v1':'none'}`,
    addTimeout: num('MEMORY_ADD_TIMEOUT_MS', 115000), searchTimeout: num('MEMORY_SEARCH_TIMEOUT_MS', 55000),
    maxEvidence: num('MEMORY_MAX_EVIDENCE', 32), tokenBudget: num('MEMORY_TOKEN_BUDGET', 6000),
    retrieval: env.MEMORY_RETRIEVAL === 'lexical' ? 'lexical' : env.MEMORY_RETRIEVAL === 'mem0' ? 'mem0' : 'hybrid',
    rerank: env.MEMORY_RERANK === 'true', rawFallback: env.MEMORY_RAW_FALLBACK !== 'false',incrementalVerification:env.MEMORY_INCREMENTAL_VERIFICATION!=='false',
    candidateLimit:Math.min(500,Math.max(1,Math.floor(num('MEMORY_CANDIDATE_LIMIT',200)))),
    rerankCandidates:Math.min(200,Math.max(1,Math.floor(num('MEMORY_RERANK_CANDIDATES',80)))),
    coveragePacking:env.MEMORY_COVERAGE_PACKING!=='false',sourceIndex:env.MEMORY_SOURCE_INDEX!=='false',
    eventView:env.MEMORY_EVENT_VIEW!=='false',
    experimental:{rawOnly:env.MEMORY_EXPERIMENT_RAW_ONLY==='true',lifecycle:env.MEMORY_EXPERIMENT_LIFECYCLE!=='false',temporal:env.MEMORY_EXPERIMENT_TEMPORAL!=='false',multiHop:env.MEMORY_EXPERIMENT_MULTI_HOP!=='false',reflection:env.MEMORY_EXPERIMENT_REFLECTION!=='false'},
  };
}
