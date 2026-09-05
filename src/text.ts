import { lemmatizeForBm25 } from './mem0/lemmatization.js';
import { extractEntities } from './mem0/entity_extraction.js';
import type { QueryIntent } from './types.js';

export function speakerPrefix(text:string):RegExpMatchArray|null{
  const match=text.match(/^([\p{L}][\p{L} .'-]{0,40}):\s*/u);if(!match)return null;
  const name=match[1]!.trim();
  if(/\b(?:said|says|quoted)\b/i.test(name)||/^(?:correction|remember(?: again)?|reminder|update|note|please|forget|remove|actually|context|summary|important|question|answer)$/i.test(name)||/^(?:my|our|your|the|this|that)\b/i.test(name))return null;
  return match;
}

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
  const ignored=new Set(['I','My','We','Our','The','What','Who','Which','Where','When','How','Does','Can','Do','Is','It','That','This','User','Assistant']);
  const named=text.match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)*\b/g)??[];
  const upstream=extractEntities(text).map(e=>e.text).filter(e=>/[A-Z]/.test(e));
  return [...new Set([...named,...upstream,...(text.match(/[A-Z]{2,}[-\d][A-Z\d-]+/g)??[])])].filter(e=>e.length>=2&&!ignored.has(e));
}
export function intent(query: string): QueryIntent {
  const trajectory = /\b(history|progress|evolved|changed over|over (?:our|the) conversation|sequence|trajectory|initially)\b|变化|变迁|历程|最初|先后/.test(query.toLowerCase());
  const operation=/\b(?:ask(?:ed)? (?:you )?to|operation|affected|removed?|forgot|forget|forgotten|correct(?:ed|ion)?|retract(?:ed)?|restor(?:e|ed)|tak(?:e|ing) .{0,60} off|took .{0,60} off)\b|删除|忘记|移除|纠正|撤回|恢复/.test(query.toLowerCase());
  const list=/\b(all|list|which .*s|what .*s|summarize)\b|哪些|列出|所有|总结/.test(query.toLowerCase());
  const historical=trajectory||/\b(previous|previously|before|used to|in 20\d\d|as of|back then|last year)\b|以前|之前|曾经|当时|去年/.test(query.toLowerCase());
  return {mode:trajectory?'trajectory':operation?'operation':list?'list':historical?'historical':'current',operation,temporal:/\b(when|date|year|month|week|day|how long)\b|何时|什么时候|哪年|多久|哪天/.test(query.toLowerCase()),historical,trajectory,list,
    asOf: /\bas of\b|截至|截止/.test(query.toLowerCase())?(query.match(/\b20\d\d-\d\d-\d\d\b/)?.[0]??null):null, entities: entities(query) };
}
export function overlap(a: string, b: string): number { const x = new Set(tokens(a)), y = new Set(tokens(b)); return [...x].filter(t => y.has(t)).length / Math.max(1, x.size); }
export function estimateTokens(s: string): number { const han = s.match(/\p{Script=Han}/gu)?.length ?? 0; return Math.ceil((s.length - han) / 3 + han * 1.5); }
