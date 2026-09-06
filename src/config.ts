import { resolve } from 'node:path';
export interface Config {
  port: number; host: string; dataDir: string; mode: 'enhanced' | 'offline'; llmBase: string; llmKey: string; llmModel: string; llmReasoningEffort?:'low'|'medium'|'high';
  llmStageModels:Partial<Record<'extraction'|'verification'|'repair',string>>;
  maxRepairRounds:1|2;extractionWorkers:number;sourceErasureWorkers:number;
  extractionFormat:'flat'|'message_groups'|'source_refs';
  verificationFormat:'verbose'|'compact';
  verificationResponseFormat:'json_object'|'json_schema';
  erasureBinding:boolean;sourceErasure:boolean;semanticTransitions:boolean;sourceOperations:boolean;sourceOperationHistory:boolean;sourceOperationBatches:boolean;sourceOperationRouting:boolean;sourceFirst:boolean;
  embeddingBase: string; embeddingModel: string; embeddingDigest: string | null; embeddingDimensions: number; embeddingSpace: string;
  addTimeout: number; searchTimeout: number; maxEvidence: number; tokenBudget: number; retrieval: 'hybrid' | 'lexical' | 'mem0';
  rerank: boolean; rawFallback: boolean;incrementalVerification:boolean;
  relationMode:'off'|'cooccurrence'|'conditional';rerankPolicy:'always'|'selective';rerankFormat:'ids'|'indices';
  candidateLimit:number;rerankCandidates:number;coveragePacking:boolean;sourceIndex:boolean;eventView:boolean;
  experimental: {rawOnly:boolean;lifecycle:boolean;temporal:boolean;multiHop:boolean;reflection:boolean};
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (k: string, n: number): number => { const v = Number(env[k] ?? n); if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${k}`); return v; };
  const model = env.MEMORY_EMBEDDING_MODEL ?? 'nomic-embed-text:latest';
  const dimensions = num('MEMORY_EMBEDDING_DIMENSIONS', 768);
  const effort=env.MEMORY_LLM_REASONING_EFFORT;
  const relationMode=env.MEMORY_RELATION_MODE??'cooccurrence',rerankPolicy=env.MEMORY_RERANK_POLICY??'always';
  const rerankFormat=env.MEMORY_RERANK_FORMAT??'ids';
  if(!['ids','indices'].includes(rerankFormat))throw new Error('Invalid MEMORY_RERANK_FORMAT');
  if(!['off','cooccurrence','conditional'].includes(relationMode))throw new Error('Invalid MEMORY_RELATION_MODE');
  if(!['always','selective'].includes(rerankPolicy))throw new Error('Invalid MEMORY_RERANK_POLICY');
  if(effort!==undefined&&!['low','medium','high'].includes(effort))throw new Error('Invalid MEMORY_LLM_REASONING_EFFORT');
  if(env.MEMORY_SOURCE_ERASURE==='true'&&env.MEMORY_ERASURE_BINDING!=='true')throw new Error('Source erasure requires erasure binding');
  if(env.MEMORY_SEMANTIC_TRANSITIONS==='true'&&env.MEMORY_SOURCE_ERASURE!=='true')throw new Error('Semantic transitions require source erasure');
  if(env.MEMORY_SOURCE_OPERATIONS==='true'&&(env.MEMORY_SEMANTIC_TRANSITIONS!=='true'||env.MEMORY_MODE!=='enhanced'||env.MEMORY_EXPERIMENT_RAW_ONLY==='true'||env.MEMORY_EXPERIMENT_LIFECYCLE==='false'))throw new Error('Source operations require enhanced semantic transitions and structured extraction');
  if(env.MEMORY_SOURCE_OPERATION_HISTORY==='true'&&env.MEMORY_SOURCE_OPERATIONS!=='true')throw new Error('Historical source operations require source operations');
  if(env.MEMORY_SOURCE_OPERATION_BATCHES==='true'&&env.MEMORY_SOURCE_OPERATION_HISTORY!=='true')throw new Error('Batched source operations require source history');
  if(env.MEMORY_SOURCE_OPERATION_ROUTING==='true'&&env.MEMORY_SOURCE_OPERATION_BATCHES!=='true')throw new Error('Source routing requires batched source history');
  if(env.MEMORY_SOURCE_FIRST==='true'&&(env.MEMORY_SOURCE_OPERATION_ROUTING!=='true'||env.MEMORY_SOURCE_INDEX==='false'||env.MEMORY_RAW_FALLBACK==='false'||env.MEMORY_EXTRACTION_FORMAT!=='source_refs'||env.MEMORY_VERIFICATION_FORMAT!=='compact'||['lexical','mem0'].includes(env.MEMORY_RETRIEVAL??'')))throw new Error('Source-first requires v9 routing, source references, compact verification and hybrid raw retrieval');
  const stageModels:Config['llmStageModels']={};
  const sourceErasureWorkers=num('MEMORY_SOURCE_ERASURE_WORKERS',1);
  if(!Number.isInteger(sourceErasureWorkers)||sourceErasureWorkers<1||sourceErasureWorkers>3)throw new Error('Invalid MEMORY_SOURCE_ERASURE_WORKERS');
  if(sourceErasureWorkers>1&&(env.MEMORY_SOURCE_ERASURE!=='true'||env.MEMORY_MODE!=='enhanced'))throw new Error('Parallel source erasure requires enhanced source erasure');
  const extractionWorkers=num('MEMORY_EXTRACTION_WORKERS',1);
  if(!Number.isInteger(extractionWorkers)||extractionWorkers<1||extractionWorkers>3)throw new Error('Invalid MEMORY_EXTRACTION_WORKERS');
  if(extractionWorkers>1&&(env.MEMORY_MODE!=='enhanced'||!['message_groups','source_refs'].includes(env.MEMORY_EXTRACTION_FORMAT??'')))throw new Error('Parallel extraction requires enhanced grouped extraction');
  const maxRepairRounds=num('MEMORY_MAX_REPAIR_ROUNDS',1);
  if(maxRepairRounds!==1&&maxRepairRounds!==2)throw new Error('Invalid MEMORY_MAX_REPAIR_ROUNDS');
  const extractionFormat=env.MEMORY_EXTRACTION_FORMAT??'flat';
  if(!['flat','message_groups','source_refs'].includes(extractionFormat))throw new Error('Invalid MEMORY_EXTRACTION_FORMAT');
  const verificationFormat=env.MEMORY_VERIFICATION_FORMAT??'verbose';
  if(verificationFormat!=='verbose'&&verificationFormat!=='compact')throw new Error('Invalid MEMORY_VERIFICATION_FORMAT');
  const verificationResponseFormat=env.MEMORY_VERIFICATION_RESPONSE_FORMAT??'json_object';
  if(!['json_object','json_schema'].includes(verificationResponseFormat))throw new Error('Invalid MEMORY_VERIFICATION_RESPONSE_FORMAT');
  if(verificationResponseFormat==='json_schema'&&verificationFormat!=='compact')throw new Error('Strict verification schema requires compact format');
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
    relationMode:relationMode as Config['relationMode'],rerankPolicy:rerankPolicy as Config['rerankPolicy'],rerankFormat:rerankFormat as Config['rerankFormat'],
    maxRepairRounds,extractionWorkers,sourceErasureWorkers,
    extractionFormat:extractionFormat as Config['extractionFormat'],
    verificationFormat,
    verificationResponseFormat:verificationResponseFormat as Config['verificationResponseFormat'],
    sourceFirst:env.MEMORY_SOURCE_FIRST==='true',sourceOperationRouting:env.MEMORY_SOURCE_OPERATION_ROUTING==='true',sourceOperations:env.MEMORY_SOURCE_OPERATIONS==='true',sourceOperationHistory:env.MEMORY_SOURCE_OPERATION_HISTORY==='true',sourceOperationBatches:env.MEMORY_SOURCE_OPERATION_BATCHES==='true',
    erasureBinding:env.MEMORY_ERASURE_BINDING==='true',sourceErasure:env.MEMORY_SOURCE_ERASURE==='true',semanticTransitions:env.MEMORY_SEMANTIC_TRANSITIONS==='true',
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
