import type {AddRequest, Extraction, Operation} from './types.js';
import {speakerPrefix} from './text.js';

export type InstructionSpan = {start:number;end:number;quote:string;intent:'forget'|'blocked'|'none'};
const verb=String.raw`(?:forget|delete|erase|remove|discard|stop (?:remembering|tracking|storing|retaining))`;
const retirement=/\b(?:I (?:do not|don't) need .{1,160}(?:stored|remembered|kept)(?: (?:here|by you))? anymore|I no longer (?:need|want) (?:you to )?(?:remember|store|keep)|I (?:do not|don't) want you to (?:remember|store|keep))\b|(?:^|,\s*(?:so\s+)?)(?:(?:there is|there's) )?no need (?:for you )?to (?:keep )?(?:track(?:ing)?|retain|store|remember|save|log)\b|不(?:需要|想).*再(?:保存|记住)|不要再记/iu;
// The negative applies to retaining the information, not to forgetting it.
// Sentence-level quotation, reporting and conditional guards still apply.
const secondPersonRetirement=/\byou (?:do not|don't) need to (?:keep track of|track|retain|store|remember|keep) .{1,160} anymore\b/iu;
const emphasizedSecondPersonRetirement=/\byou (?:do not|don't) really need to (?:keep track of|track|retain|store|remember|keep(?!\s+(?:forgetting|deleting|erasing|removing))) .{1,160} anymore\b/iu;
const nonDirectEmphasis=/\b(?:maybe|perhaps|possibly|probably|necessarily)\b|\bnot (?:sure|certain|saying|asking|telling)\b/iu;
const noStore=/^(?:(?:no|okay|ok|actually|well)\s*[,，:]\s*)?(?:please\s+)?(?:do not|don't|never)\s+(?:store|retain|save|keep(?!\s+(?:forgetting|deleting|erasing|removing))|remember|track|log)\b|^(?:请)?(?:不要|别)(?:保存|存储|记住)/iu;
const negative=new RegExp(String.raw`\b(?:(?:do not|don't|never|must not|mustn't|won't)\s+(?:(?:want|need)\s+(?:you\s+)?to\s+)?${verb}|(?:should not|shouldn't)\s+${verb})\b|别忘|不要忘|不想.*忘|不要(?:删除|移除)|别(?:删除|移除)`,'iu');
const request=new RegExp(String.raw`^(?:(?:now|okay|ok|also|then|actually|and)\s*[,，:]?\s*)?(?:(?:please|kindly|can you|could you|would you|you can|you may|you should|you must|I want you to|I need you to|let's)\s+)?${verb}\b|^(?:请|帮我|麻烦你|你可以|你应该)?(?:忘掉|忘记|删除|移除|不要再记)`,'iu');
const mention=new RegExp(String.raw`\b${verb}\b|忘掉|忘记|删除|移除|不要再记`,'iu');
// Narrative commands arrive mid-clause after discourse lead-ins ("Actually,
// now that I think about it — please forget the Tucson detail", "So you can
// go ahead and remove him"). The authorized-imperative bigram — you can/please/
// kindly before the verb, or the verb after a clause break — is distinctive
// enough to detect inside a declarative; questions stay guarded.
const imperativeMid=new RegExp(String.raw`\b(?:you\s+(?:can|could|should|may|might)\s+(?:go\s+ahead\s+and\s+|just\s+|simply\s+)?|please\s+|kindly\s+)${verb}\b|(?:^|[,;:—–]\s*)(?:just\s+|simply\s+|go\s+ahead\s+and\s+|please\s+|now\s+)*${verb}\b`,'iu');
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
  // A procedural direction ("Remove from heat and let cool") addresses the
  // task in hand, not the memory: an object-less imperative before a
  // preposition is never a retirement command.
  const procedural=/^\s*(?:just\s+|simply\s+|please\s+)?(?:remove|delete|erase|discard)\s+(?:from|into|onto|out|with|to)\b/iu.test(body);
  // Keep tentative cues and confirmation questions out of this new matching
  // branch. Existing non-emphasized recognition is unchanged.
  const emphasized=emphasizedSecondPersonRetirement.test(body)&&!/[?？]\s*$/.test(clause)&&!nonDirectEmphasis.test(body);
  const direct=!blocked&&!procedural&&(retirement.test(body)||secondPersonRetirement.test(body)||emphasized||noStore.test(body)||request.test(body)||(!/[?？]\s*$/.test(clause)&&imperativeMid.test(body)));
  spans.push({start,end,quote:text.slice(start,end).trim(),intent:direct?'forget':blocked&&mention.test(body)?'blocked':'none'});
 }
 return spans;
}
export const realControl=(text:string):boolean=>instructionSpans(text).some(s=>s.intent==='forget');

/** A conservative omission alarm, not a claim of complete natural-language
 * extraction: obvious personal declarations must have grounded user evidence. */
export function missingPersonalSources(req:AddRequest,parsed:Extraction):number[]{
 return req.messages.flatMap((m,index)=>{
  const named=!!speakerPrefix(m.content.replace(/\[Session time:[^\]]*\]/g,'').trim());
  if(m.role!=='user'&&!named)return [];
  const obvious=instructionSpans(m.content).some(s=>s.intent==='none'&&!/[?？]$/.test(s.quote)&&!reported.test(s.quote)&&!/["“”「」]/u.test(s.quote)&&/\b(?:my .{1,60}\b(?:is|are|was|were)|I (?:(?:also|now) )?(?:live|moved|work|use|own|have|set up|started|joined|chose|switched|bought|sold|called)|I(?:'m| am) (?:on|using|working|living)|please (?:update|correct)|need to (?:fix|correct))\b|我(?:现在)?(?:住在|搬到|使用|买了)|我的.{1,15}(?:是|改为)/iu.test(s.quote));
  if(!obvious)return [];
  const covered=parsed.facts.some(f=>f.sources.some(s=>s.index===index&&m.content.includes(s.quote)));
  // Retirement without replacement can legitimately have no new fact.
  const retired=parsed.operations.some(o=>['forget','retract'].includes(o.type)&&o.source.index===index&&m.content.includes(o.source.quote));
  return covered||retired?[]:[index];
 });
}

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
// Only an explicit removal FROM a current relationship list permits retaining
// history. Merely mentioning a current colleague inside an erasure is not enough.
export function currentRelationRemoval(span:InstructionSpan):boolean{
 return /\bremove\s+.{1,120}\s+from\s+(?:(?:my|our|the)\s+)?current\s+(?:colleagues?|contacts?|work contacts?)\b|从(?:我的|我们的)?当前(?:同事|联系人)(?:列表|名单)?中?(?:删除|移除)/iu.test(span.quote);
}
function effectMatches(o:Operation,span:InstructionSpan):boolean{
 return o.type==='forget'||o.type==='retract'&&o.boundary==='current_relation'&&currentRelationRemoval(span);
}
export function retirementEffectMismatch(o:Operation,req:AddRequest):boolean{
 if(o.type!=='retract')return false;
 const text=req.messages[o.source.index]?.content;if(!text)return false;
 const start=text.indexOf(o.source.quote);if(start<0)return false;
 return forgetObligations(req).some(({index,span})=>index===o.source.index&&start<span.end&&start+o.source.quote.length>span.start&&!effectMatches(o,span));
}
export function missingForgetObligations(req:AddRequest,parsed:Extraction):{index:number;span:InstructionSpan}[]{
 const obligations=forgetObligations(req);
 return obligations.filter(({index,span})=>!parsed.operations.some(o=>{
  if(o.source.index!==index||!effectMatches(o,span))return false;
  const start=req.messages[index]!.content.indexOf(o.source.quote);
  const covered=obligations.filter(item=>item.index===index&&start<item.span.end&&start+o.source.quote.length>item.span.start);
  return start>=0&&covered.length===1&&start<span.end&&start+o.source.quote.length>span.start;
 }));
}
