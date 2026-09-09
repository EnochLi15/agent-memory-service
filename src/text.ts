import { lemmatizeForBm25 } from './text/lemmatization.js';
import { extractEntities } from './text/entity-extraction.js';
import type { QueryIntent } from './types.js';

export function speakerPrefix(text:string):RegExpMatchArray|null{
  const match=text.match(/^([\p{L}][\p{L} .'-]{0,40}):\s*/u);if(!match)return null;
  const name=match[1]!.trim();
  // A draft introduction is not a person. Periods in a speaker label must
  // belong to initials or conventional titles, rather than whole sentences.
  if(/\bhere(?:\s+(?:is|are)|'s)\b/i.test(name))return null;
  for(const period of name.matchAll(/\./g)){
    const word=name.slice(0,period.index).match(/([\p{L}]+)$/u)?.[1];
    if(!word||[...word].length!==1&&!/^(?:dr|prof|st|mr|mrs|ms|mx|jr|sr|rev|fr)$/i.test(word))return null;
  }
  // Assistant document headings are not a named human participant. Treating
  // recipe steps as human speech can turn "Remove from heat" into erasure.
  if(/^(?:ingredients|instructions|steps|directions|recipe|requirements|examples?|output|input|method|procedure|materials|preparation|serving suggestions)$/i.test(name))return null;
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
  const q=query.toLowerCase();
  // Trajectory regexes validated against the full LoCoMo refined + MemOps
  // longitudinal question sets (1,544 questions, zero false positives):
  // co-occurrence constrained; bare before/in 20xx/last year removed because
  // they mis-route current-state and multi-hop questions to chain arbitration.
  // Re-validated 2026-09-07 (validation-data/intent-check.mjs): becam/becom
  // stems dropped ("journey to becoming" mis-routed a single-hop question);
  // the what-have-i gap is optional so "what have I shared" matches directly.
  const trajectory=/how (?:did|has|does) [^.?!]{0,80} (?:chang|evolv|switch|turn|progress|grow|develop|end(?:ed)? up)|walk me through|full sequence|sequence of changes|over (?:the|our) (?:time|conversations)|over the course of (?:our|the) conversations?|summariz\w* [^.?!]{0,60} (?:i(?:'ve| have)? (?:shared|told|mentioned)|we(?:'ve| have)? (?:discussed|talked)|key (?:details|things))|what [^.?!]{0,40} (?:have|did) i (?:[^.?!]{0,40} )?(?:shar\w+|describ\w+|mention\w+|tell|told|talked about)|history of\b|evolved|progression|all the (?:changes|steps)|which specific messages|变化|变迁|历程|先后|怎么演变|如何演变/.test(q);
  const history=/\b(?:used to|previous(?:ly)?|back then|at the time|earlier version|originally)\b|when (?:i|he|she|we|they) first|what was [^.?!]{0,60}\bbefore|以前|之前|曾经|当时|最初/.test(q);
  const operation=/\b(?:ask(?:ed)? (?:you )?to|operation|affected|removed?|forgot|forget|forgotten|correct(?:ed|ion)?|retract(?:ed)?|restor(?:e|ed)|tak(?:e|ing) .{0,60} off|took .{0,60} off)\b|删除|忘记|移除|纠正|撤回|恢复/.test(q);
  const list=/\b(?:all|list|summarize)\b|\b(?:which|what)\s+(?:(?:my|your|our|the|his|her|their)\s+)?(?!is\b|was\b|has\b|does\b|this\b|its\b)[a-z]{2,}s\b|哪些|列出|所有|总结/.test(q);
  const historical=trajectory||history;
  const statementTrace=/\b(?:which|what)\b[^.?!]{0,60}\b(?:messages?|statements?)\b|\bwhat (?:did|have) (?:i|we)\b[^.?!]{0,40}\b(?:say|said|report|mention|tell|told)\b|(?:哪|哪些|什么).{0,20}(?:消息|原话|说法)|(?:最初|之前|曾经).{0,20}(?:说过|说了|告诉|提到)/.test(q);
  return {mode:trajectory?'trajectory':operation?'operation':list?'list':historical?'historical':'current',operation,statementTrace,temporal:/\b(?:when|date|year|month|week|day|how long)\b|何时|什么时候|哪年|多久|哪天|去年|今年/.test(q),historical,trajectory,list,
    asOf: /\bas of\b|截至|截止/.test(q)?(query.match(/\b20\d\d-\d\d-\d\d\b/)?.[0]??null):null, entities: entities(query) };
}
export function overlap(a: string, b: string): number { const x = new Set(tokens(a)), y = new Set(tokens(b)); return [...x].filter(t => y.has(t)).length / Math.max(1, x.size); }
export function estimateTokens(s: string): number { const han = s.match(/\p{Script=Han}/gu)?.length ?? 0; return Math.ceil((s.length - han) / 3 + han * 1.5); }
