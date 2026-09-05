import { z } from 'zod';

export const messageSchema = z.object({ role: z.string(), content: z.string(), timestamp: z.string().datetime({ offset: true }) });
export const addSchema = z.object({ request_id: z.string(), user_id: z.string(), session_id: z.string(), messages: z.array(messageSchema) });
export const searchSchema = z.object({ query: z.string(), user_id: z.string(), top_k: z.number().finite().nonnegative(), options: z.array(z.unknown()).optional() });
export type Message = z.infer<typeof messageSchema>;
export type AddRequest = z.infer<typeof addSchema>;
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
  depends_on: z.array(z.string()).default([]), sources: z.array(sourceSchema).min(1), supersedes: z.array(z.string()).default([]),
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
export type MemoryEvent={id:string;type:'remember'|'update'|'correct'|'retract'|'forget'|'restore'|'reflection';category:string;slot_hash:string;source_ids:string[];before_ids:string[];after_ids:string[];ordinal:number;observed_at:string;time_basis:'source'|'ordering';revision:number;actor?:'user'|'participant'|'observation'};
export type Fact = Omit<ExtractedFact, 'sources'> & {
  event_time?:TemporalEvidence;
  transition_time?:Pick<TemporalEvidence,'start'|'end_exclusive'|'precision'>;
  source_spans?: {source_id:string;start:number;end:number}[];
  time_basis?: 'source' | 'ordering'; id: string; source_ids: string[]; source_quotes: string[]; created_at: string; observed_at: string;
  state: 'active' | 'conflicted' | 'superseded' | 'retracted' | 'erased'; vector: number[] | null; entities: string[]; revision: number;
};
export type StoredMessage = Message & { id: string; session_id: string; ordinal: number; searchable: boolean; partial?: boolean; time_basis?: 'source' | 'ordering'; redacted?: boolean; external_id?:string };
export type Passage = {id:string;source_id:string;speaker:string;external_id?:string;fragments:{start:number;end:number;text:string}[];fact_ids:string[];content:string;vector:number[]|null;observed_at:string;time_basis:'source'|'ordering';revision:number;state:'active'|'erased'};
export type Snapshot = { revision: number; facts: Fact[]; tail: StoredMessage[]; anchor: string | null };
export type Prepared = { facts: Fact[]; operations: Operation[]; messages: StoredMessage[]; passages?:Passage[]; sourceFormat?:'dual-source-v2'|'facts-only-v2'; anchor: string | null; degraded: string[]; embeddingSpace: string };
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
