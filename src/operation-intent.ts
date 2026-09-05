import type {AddRequest, Extraction, Operation} from './types.js';
import {speakerPrefix} from './text.js';

export type InstructionSpan = {start:number;end:number;quote:string;intent:'forget'|'blocked'|'none'};
const verb=String.raw`(?:forget|delete|erase|remove|stop remembering)`;
const retirement=/\b(?:I (?:do not|don't) need .{1,160}(?:stored|remembered|kept)(?: (?:here|by you))? anymore|I no longer (?:need|want) (?:you to )?(?:remember|store|keep)|I (?:do not|don't) want you to (?:remember|store|keep))\b|不(?:需要|想).*再(?:保存|记住)|不要再记/iu;
const negative=new RegExp(String.raw`\b(?:(?:do not|don't|never|must not|mustn't)\s+(?:(?:want|need)\s+(?:you\s+)?to\s+)?${verb}|(?:should not|shouldn't)\s+${verb})\b|别忘|不要忘|不想.*忘|不要(?:删除|移除)|别(?:删除|移除)`,'iu');
const request=new RegExp(String.raw`^(?:(?:now|okay|ok|also|then|actually|and)\s*[,，:]?\s*)?(?:(?:please|kindly|can you|could you|would you|you can|you may|you should|you must|I want you to|I need you to|let's)\s+)?${verb}\b|^(?:请|帮我|麻烦你|你可以|你应该)?(?:忘掉|忘记|删除|移除|不要再记)`,'iu');
const mention=new RegExp(String.raw`\b${verb}\b|忘掉|忘记|删除|移除|不要再记`,'iu');
const reported=/\b(?:said|says|quoted|example|hypothetical|suppose|what if|if I|if you|should I|how do I)\b|^(?:if|unless|when)\b|假如|假设|举例|引用|他说|她说/iu;

/** Offsets always address the original source. Mask quotations before segmenting,
 * retaining sentence boundaries so another direct request remains independent. */
export function instructionSpans(text:string):InstructionSpan[]{
 const chars=text.split('');let closing='';
 const pairs:Record<string,string>={'"':'"','“':'”','‘':'’','「':'」',"'":"'"};
 for(let i=0;i<chars.length;i++){
  const c=text[i]!;
  if(closing){if(!/[.!?。！？;；\n]/u.test(c))chars[i]=' ';if(c===closing&&text[i-1]!=='\\')closing='';continue;}
  // Don't consume a contraction and the start of a later quoted sentence as a
  // pair of quote delimiters. Preserve UTF-16 positions used by String.indexOf.
  if(pairs[c]&&!(c==="'"&&/[\p{L}\p{N}]/u.test(text[i-1]??''))){closing=pairs[c]!;chars[i]=' ';}
 }
 const masked=chars.join('');
 const spans:InstructionSpan[]=[];
 for(const match of masked.matchAll(/[^.!?。！？;；\n]+[.!?。！？;；]?/gu)){
  const start=match.index!,end=start+match[0].length;
  const clause=match[0].replace(/\[Session time:[^\]]*\]|\[Source id:[^\]]*\]/g,'').trim();
  if(!clause)continue;
  const prefix=speakerPrefix(clause);const body=prefix?clause.slice(prefix[0].length):clause;
  const blocked=reported.test(clause)||negative.test(body)||/\bforget it\b/iu.test(body);
  const direct=!blocked&&(retirement.test(body)||request.test(body));
  spans.push({start,end,quote:text.slice(start,end).trim(),intent:direct?'forget':blocked&&mention.test(body)?'blocked':'none'});
 }
 return spans;
}
export const realControl=(text:string):boolean=>instructionSpans(text).some(s=>s.intent==='forget');

export function forgetObligations(req:AddRequest):{index:number;span:InstructionSpan}[]{
 return req.messages.flatMap((m,index)=>{
  const named=!!speakerPrefix(m.content.replace(/\[Session time:[^\]]*\]/g,'').trim());
  return m.role==='user'||named?instructionSpans(m.content).filter(s=>s.intent==='forget').map(span=>({index,span})):[];
 });
}
export function authorizesForget(o:Operation,req:AddRequest):boolean{
 const text=req.messages[o.source.index]?.content;if(!text)return false;
 const start=text.indexOf(o.source.quote);if(start<0)return false;
 // A command elsewhere in the message does not authorize a quoted/negated span.
 return instructionSpans(text).some(s=>s.intent==='forget'&&s.start<start+o.source.quote.length&&s.end>start);
}
export function missingForgetObligations(req:AddRequest,parsed:Extraction):{index:number;span:InstructionSpan}[]{
 const obligations=forgetObligations(req);
 return obligations.filter(({index,span})=>!parsed.operations.some(o=>{
  if(o.source.index!==index||!['forget','retract'].includes(o.type))return false;
  const start=req.messages[index]!.content.indexOf(o.source.quote);
  const covered=obligations.filter(item=>item.index===index&&start<item.span.end&&start+o.source.quote.length>item.span.start);
  return start>=0&&covered.length===1&&start<span.end&&start+o.source.quote.length>span.start;
 }));
}
