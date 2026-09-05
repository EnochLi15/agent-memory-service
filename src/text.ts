import { lemmatizeForBm25 } from './mem0/lemmatization.js';
import { extractEntities } from './mem0/entity_extraction.js';
import type { QueryIntent } from './types.js';

export function tokens(text: string): string[] {
  const english = lemmatizeForBm25(text.replace(/\p{Script=Han}/gu, ' ')).match(/[a-z0-9]+/g) ?? [];
  const chinese: string[] = [];
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i < chars.length; i++) { chinese.push(chars[i]!); if (i + 1 < chars.length) chinese.push(chars[i]! + chars[i + 1]!); }
  }
  return [...english, ...chinese];
}
export function entities(text: string): string[] {
  return [...new Set(extractEntities(text).map(e => e.text).concat(text.match(/[A-Z]{2,}[-\d][A-Z\d-]+/g) ?? []))];
}
export function intent(query: string): QueryIntent {
  const trajectory = /\b(history|progress|evolved|changed over|over (?:our|the) conversation|sequence|trajectory|initially)\b|变化|变迁|历程|最初|先后/.test(query.toLowerCase());
  return { historical: trajectory || /\b(previous|previously|before|used to|in 20\d\d|as of|back then|last year)\b|以前|之前|曾经|当时|去年/.test(query.toLowerCase()), trajectory,
    list: /\b(all|list|which .*s|what .*s|summarize)\b|哪些|列出|所有|总结/.test(query.toLowerCase()),
    asOf: query.match(/\b20\d\d-\d\d-\d\d\b/)?.[0] ?? null, entities: entities(query) };
}
export function overlap(a: string, b: string): number { const x = new Set(tokens(a)), y = new Set(tokens(b)); return [...x].filter(t => y.has(t)).length / Math.max(1, x.size); }
export function estimateTokens(s: string): number { const han = s.match(/\p{Script=Han}/gu)?.length ?? 0; return Math.ceil((s.length - han) / 3 + han * 1.5); }
