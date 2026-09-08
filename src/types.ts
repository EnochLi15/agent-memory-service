import { z } from 'zod';
import {createHash} from 'node:crypto';

// Official evaluation messages carry no per-message timestamp: order comes from
// session sequence and [Session time: ...] anchors. Ingestion fills missing
// stamps with deterministic synthetic ordering markers (see temporal.ts), and
// such messages stay flagged time_basis='ordering' instead of claiming a date.
export const messageSchema = z.object({ role: z.string(), content: z.string(), timestamp: z.string().datetime({ offset: true }).optional() });
export const addSchema = z.object({ request_id: z.string(), user_id: z.string(), session_id: z.string(), messages: z.array(messageSchema) });
export const searchSchema = z.object({ query: z.string(), user_id: z.string(), top_k: z.number().finite().nonnegative(), options: z.array(z.unknown()).optional() });
export type Message = z.infer<typeof messageSchema>;
export type AddRequest = z.infer<typeof addSchema>;
/** Shared identity for preparation, reference binding and model-input links. */
export const factId=(req:AddRequest,index:number):string=>createHash('sha256').update(`${req.user_id}\0${req.request_id}\0fact\0${index}`).digest('hex');
export type SearchRequest = z.infer<typeof searchSchema>;
export type Receipt = { success: true; request_id: string; user_id: string; session_id: string };
export type SearchResponse = { data: { id: string; content: string; score: number; created_at: string }[] };

const sourceSchema = z.object({ index: z.number().int().nonnegative(), quote: z.string().min(1) });
export const factSchema = z.object({
  content: z.string().min(1), subject: z.string().min(1), predicate: z.string().min(1), value: z.string(), scope: z.string().default(''),
  kind: z.enum(['fact', 'event', 'preference', 'reflection']).default('fact'),
  modality: z.enum(['confirmed', 'tentative', 'hypothetical', 'quoted', 'inferred']).default('confirmed'),
  cardinality: z.enum(['single', 'multiple']).default('multiple'),
  time_text: z.string().default(''), valid_from: z.string().nullable().default(null), valid_to: z.string().nullable().default(null),
  depends_on: z.array(z.string()).default([]), sources: z.array(sourceSchema.extend({start:z.number().int().nonnegative().optional()})).min(1), supersedes: z.array(z.string()).default([]),
});
export const operationSchema = z.object({
  type: z.enum(['update', 'correct', 'retract', 'forget', 'restore']),
  target_ids: z.array(z.string()).default([]), subject: z.string(), predicate: z.string(), scope: z.string().default(''),
  value: z.string().default(''), boundary: z.enum(['value', 'property', 'current_relation']).default('value'),
  source: sourceSchema, reason: z.string().default(''),
});
export const extractionSchema = z.object({ facts: z.array(factSchema), operations: z.array(operationSchema).default([]) });
export type ExtractedFact = z.infer<typeof factSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export type TemporalEvidence={expression:string;anchor:string|null;start:string|null;end_exclusive:string|null;precision:'day'|'month'|'year'|'week'|'unknown';resolution:'resolved'|'unresolved'|'ordering';reason?:string};
export type MemoryEvent={id:string;type:'remember'|'update'|'correct'|'retract'|'forget'|'restore'|'reflection';category:string;slot_hash:string;source_ids:string[];before_ids:string[];after_ids:string[];ordinal:number;observed_at:string;time_basis:'source'|'ordering';revision:number;actor?:'user'|'participant'|'observation';descriptor?:string};
export type Fact = Omit<ExtractedFact, 'sources'> & {
  scopeHash?:string;
  erasure_exemptions?: {key:string;quote:string}[];
  event_time?:TemporalEvidence;
  transition_time?:Pick<TemporalEvidence,'start'|'end_exclusive'|'precision'>;
  source_spans?: {source_id:string;start:number;end:number}[];
  time_basis?: 'source' | 'ordering'; id: string; source_ids: string[]; source_quotes: string[]; created_at: string; observed_at: string;
  state: 'active' | 'conflicted' | 'superseded' | 'retracted' | 'erased'; vector: number[] | null; entities: string[]; revision: number;
};
export type StoredMessage = Message & { id: string; session_id: string; ordinal: number; searchable: boolean; partial?: boolean; time_basis?: 'source' | 'ordering'; redacted?: boolean; external_id?:string };
export type Passage = {id:string;source_id:string;speaker:string;external_id?:string;fragments:{start:number;end:number;text:string}[];fact_ids:string[];content:string;vector:number[]|null;observed_at:string;time_basis:'source'|'ordering';revision:number;state:'active'|'erased'};
/** Hashed echo index for a retired phrase: per-token digests, adjacent-pair
 * digests, title flags and token lengths. Marker rows never persist the
 * plaintext value; matching hashes candidate tokens and pairs instead. */
export type PhraseEchoIndex={t:string[];p:string[];titles:boolean[];lengths:number[]};
export type ErasureBoundary={scopeHash?:string;keyHash?:string;subject:string;predicate:string;scope:string;boundary:string;valueHash:string;tokenCount?:number;anchorHashes?:string[];allowedValueHashes?:string[];revision:number;phraseEcho?:PhraseEchoIndex};
export type ErasurePlan={fingerprint:string;decisions:{fact_id:string;key:string;effect:'erase'|'retain';quote:string;value_context?:{source_id:string;quote:string;start:number;claim_start:number}}[]};
export type SourceErasurePlan={fingerprint:string;decisions:{index:number;parts:{text:string;effect:'erase'|'retain'}[];reason:string}[]};
export type TransitionPlan={fingerprint:string;decisions:{index:number;relation:'compatible'|'exclusive'|'uncertain';old_source_slot:number;new_source_slot:number;reason:string}[]};
export type Snapshot = { revision: number; facts: Fact[]; tail: StoredMessage[]; anchor: string | null; erasureBoundaries?:ErasureBoundary[];erasureSources?:StoredMessage[] };
export type Prepared = { sourceCoveragePlan?:import('./source-coverage.js').SourceCoveragePlan; sourceOperationPlan?:import('./source-operation-routing.js').RoutedPlan; facts: Fact[]; operations: Operation[]; messages: StoredMessage[]; passages?:Passage[]; sourceFormat?:'dual-source-v2-s1'|'facts-only-v2-s1'|'dual-source-v3-s1'|'facts-only-v3-s1'|'dual-source-v4-s1'|'facts-only-v4-s1'|'dual-source-v5-s1'|'facts-only-v5-s1'|'dual-source-v6-s1'|'facts-only-v6-s1'|'dual-source-v7-s1'|'facts-only-v7-s1'|'dual-source-v8-s1'|'facts-only-v8-s1'|'dual-source-v9-s1'|'facts-only-v9-s1'|'dual-source-v10-s1'; erasurePlan?:ErasurePlan;sourceErasurePlan?:SourceErasurePlan;transitionPlan?:TransitionPlan; anchor: string | null; degraded: string[]; embeddingSpace: string };
export type Candidate = { fact: Fact; score: number; signals: string[] };
export type QueryIntent = { historical: boolean; trajectory: boolean; list: boolean; asOf: string | null; entities: string[]; operation?:boolean; mode?:'current'|'historical'|'list'|'operation'|'trajectory'; temporal?:boolean };

export class ServiceError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}
export function canonical(s: string): string { return s.normalize('NFKC').toLowerCase().trim().replace(/[\s_\-]+/g, ' '); }
export function propertyFamily(predicate:string,content=''):string {
  const p=canonical(predicate);
  if(/^(?:current )?(?:home |residence )?city$|^city of residence$/.test(p))return 'current city';
  if(/^(?:current )?(?:job )?(?:title|position|role)$/.test(p))return 'job title';
  if(/^(?:current )?(?:manager|supervisor|boss)$/.test(p))return 'manager';
  if(/^(?:backup|alternate|secondary)(?: first| baby)? name$/.test(p))return 'backup name';
  if(/^(?:selected|primary|first choice|top)(?: first| baby)? name(?: choice)?$/.test(p))return 'primary name';
  if(/^(?:current )?(?:(?:therapy|treatment) )?(?:session |appointment )?(?:cadence|frequency)$/.test(p))return 'session cadence';
  if(p==='experience'&&/\bbackup (?:first )?name\b/i.test(content))return 'backup name';
  return p;
}
export function slot(f: Pick<Fact, 'subject' | 'predicate' | 'scope'>): string { return [canonical(f.subject),propertyFamily(f.predicate),canonical(f.scope)].join('\u001f'); }
type ScopeIdentity={scope:string;scopeHash?:string};
/** Opaque stored scopes remain comparable to explicit incoming coordinates.
 * The hash is internal metadata, never accepted in extraction/HTTP schemas. */
export function scopeKey(f:ScopeIdentity):string{return f.scopeHash??createHash('sha256').update(canonical(f.scope)).digest('hex');}
export function sameScope(a:ScopeIdentity,b:ScopeIdentity):boolean{return scopeKey(a)===scopeKey(b);}
export function sameSlot(a:Pick<Fact,'subject'|'predicate'|'scope'>&{scopeHash?:string},b:Pick<Fact,'subject'|'predicate'|'scope'>&{scopeHash?:string}):boolean{return canonical(a.subject)===canonical(b.subject)&&propertyFamily(a.predicate)===propertyFamily(b.predicate)&&sameScope(a,b);}
/** Report every known structural conflict for one bounded repair. Runtime
 * callers retain the original first-error priority through operationScopeProblem. */
export function operationScopeProblems(operation:Operation,targets:Pick<Fact,'subject'|'scope'|'predicate'>[]):('OPERATION_SCOPE'|'OPERATION_TARGET'|'AMBIGUOUS_OPERATION')[]{
  const problems:('OPERATION_SCOPE'|'OPERATION_TARGET'|'AMBIGUOUS_OPERATION')[]=[];
  if(targets.some(f=>canonical(f.subject)!==canonical(operation.subject)||(operation.scope&&!sameScope(f,operation))))problems.push('OPERATION_SCOPE');
  if(new Set(targets.map(scopeKey)).size>1)problems.push('AMBIGUOUS_OPERATION');
  if(['correct','update'].includes(operation.type)&&targets.some(f=>propertyFamily(f.predicate)!==propertyFamily(operation.predicate)))problems.push('OPERATION_TARGET');
  return problems;
}
export function operationScopeProblem(operation:Operation,targets:Pick<Fact,'subject'|'scope'|'predicate'>[]):'OPERATION_SCOPE'|'OPERATION_TARGET'|'AMBIGUOUS_OPERATION'|null {
  return operationScopeProblems(operation,targets)[0]??null;
}
export function replacementMatches(f:Pick<Fact,'subject'|'scope'|'predicate'>,target:Pick<Fact,'subject'|'scope'|'predicate'>):boolean {
  return canonical(f.subject)===canonical(target.subject)&&sameScope(f,target)&&propertyFamily(f.predicate)===propertyFamily(target.predicate);
}
/** Necessary wording guard shared by verification and commit, not semantic authorization. */
export function hasRestoreWording(quote:string):boolean{return /remember.*again|store.*again|重新.*记|再次.*记/i.test(quote);}
