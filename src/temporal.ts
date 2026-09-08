import type {AddRequest,ExtractedFact,Snapshot,TemporalEvidence} from './types.js';

/** Fill absent per-message timestamps with deterministic synthetic ISO stamps,
 * strictly increasing from the latest stored observation so ordering, date-based
 * lifecycle arbitration and zod ingestion keep working. Synthetic stamps are
 * ordering markers only: the caller flags those messages time_basis='ordering'. */
export function normalizeMissingTimestamps(req:AddRequest,snapshot:Snapshot):void{
 if(!req.messages.some(m=>m.timestamp===undefined))return;
 const observed=[...snapshot.facts.map(f=>f.observed_at),...snapshot.tail.map(m=>m.timestamp),...req.messages.map(m=>m.timestamp)]
  .filter((s):s is string=>!!s).map(Date.parse).filter(Number.isFinite);
 const base=Math.max(Date.UTC(2000,0,1),...(observed.length?observed:[0]))+60_000;
 for(const [i,m] of req.messages.entries())m.timestamp??=new Date(base+i*60_000).toISOString();
}

/** Present event time separately from observation time without inventing precision. */
export function temporalEvidenceText(time:TemporalEvidence|undefined):string{
 if(!time)return '';
 if(time.resolution!=='resolved'||!time.start)return time.expression?`Event date unresolved. Original expression: ${time.expression}.`:'';
 const label=time.precision==='day'?`Event date: ${time.start} (day precision).`
  :time.precision==='month'?`Event month: ${time.start.slice(0,7)}; exact day unknown.`
  :time.precision==='year'?`Event year: ${time.start.slice(0,4)}; exact month and day unknown.`
  :`Event interval: ${time.start} inclusive to ${time.end_exclusive} exclusive (${time.precision} precision).`;
 return label+(time.anchor?` Resolved from "${time.expression}" relative to source date ${time.anchor}.`:'');
}

const months='january february march april may june july august september october november december'.split(' ');
const day=(date:Date):string=>date.toISOString().slice(0,10);
function calendar(y:number,m:number,d:number):Date|null{
 const date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?date:null;
}
function absolute(text:string):{date:Date;precision:'day'|'month'|'year'}|null{
 let m=text.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})(?=T|\b)|((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日/u);
 if(m){const date=calendar(Number(m[1]??m[4]),Number(m[2]??m[5]),Number(m[3]??m[6]));return date?{date,precision:'day'}:null;}
 const names=months.join('|');
 m=text.match(new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+((?:19|20)\\d{2})\\b`,'i'));
 if(m){const date=calendar(Number(m[3]),months.indexOf(m[1]!.toLowerCase())+1,Number(m[2]));return date?{date,precision:'day'}:null;}
 m=text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${names})[,]?\\s+((?:19|20)\\d{2})\\b`,'i'));
 if(m){const date=calendar(Number(m[3]),months.indexOf(m[2]!.toLowerCase())+1,Number(m[1]));return date?{date,precision:'day'}:null;}
 m=text.match(new RegExp(`\\b(${names})\\s+((?:19|20)\\d{2})\\b`,'i'));
 if(m)return {date:new Date(Date.UTC(Number(m[2]),months.indexOf(m[1]!.toLowerCase()),1)),precision:'month'};
 m=text.match(/\b((?:19|20)\d{2})-(\d{2})\b|((?:19|20)\d{2})年(\d{1,2})月/u);
 if(m){const date=calendar(Number(m[1]??m[3]),Number(m[2]??m[4]),1);return date?{date,precision:'month'}:null;}
 m=text.match(/\b((?:19|20)\d{2})\b|((?:19|20)\d{2})年/u);
 return m?{date:new Date(Date.UTC(Number(m[1]??m[2]),0,1)),precision:'year'}:null;
}
function interval(date:Date,precision:TemporalEvidence['precision'],expression:string,anchor:string|null):TemporalEvidence{
 const end=new Date(date);
 if(precision==='year')end.setUTCFullYear(end.getUTCFullYear()+1);
 else if(precision==='month')end.setUTCMonth(end.getUTCMonth()+1);
 else end.setUTCDate(end.getUTCDate()+(precision==='week'?7:1));
 return {expression,anchor,start:day(date),end_exclusive:day(end),precision,resolution:'resolved'};
}
export function normalizeTime(expression:string,anchor:string|null,ordering=false):TemporalEvidence{
 const pending:TemporalEvidence={expression,anchor,start:null,end_exclusive:null,precision:'unknown',resolution:'unresolved'};
 if(!expression.trim())return {...pending,reason:'No explicit event time'};
 if(/\b(?:between|through|until|or|to)\b|至|到/u.test(expression)&&/\b(?:19|20)\d{2}\b/.test(expression))return {...pending,reason:'A range or alternative date needs explicit disambiguation'};
 const exact=absolute(expression);
 if(exact)return interval(exact.date,exact.precision,expression,null);
 if(ordering||/synthetic ordering/i.test(anchor??''))return {...pending,resolution:'ordering',anchor:null,reason:'Ordering markers cannot anchor event dates'};
 const base=anchor?absolute(anchor):null;
 if(!base||base.precision!=='day')return {...pending,reason:'No unique day anchor'};
 const text=expression.toLowerCase().trim();const date=new Date(base.date);
 const part='(?: (?:morning|afternoon|evening|night))?';
 const offset=new RegExp('^yesterday'+part+'$|^昨天(?:上午|下午|晚上)?$').test(text)?-1:new RegExp('^today'+part+'$|^今天(?:上午|下午|晚上)?$').test(text)?0:new RegExp('^tomorrow'+part+'$|^明天(?:上午|下午|晚上)?$').test(text)?1:null;
 if(offset!==null){date.setUTCDate(date.getUTCDate()+offset);return interval(date,'day',expression,day(base.date));}
 const number=text.match(/^(\d{1,3}) days? ago$|^in (\d{1,3}) days?$|^(\d{1,3})天前$|^(\d{1,3})天后$/);
 if(number){const n=number[1]?-Number(number[1]):number[2]?Number(number[2]):number[3]?-Number(number[3]):Number(number[4]);date.setUTCDate(date.getUTCDate()+n);return interval(date,'day',expression,day(base.date));}
 const weekdays='monday tuesday wednesday thursday friday saturday sunday'.split(' ');
 const weekday=text.match(/^(last|this|next) (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
 if(weekday){
  const current=(date.getUTCDay()+6)%7,target=weekdays.indexOf(weekday[2]!);let shift=target-current;
  if(weekday[1]==='last'&&shift>=0)shift-=7;if(weekday[1]==='next'&&shift<=0)shift+=7;
  date.setUTCDate(date.getUTCDate()+shift);return interval(date,'day',expression,day(base.date));
 }
 const unit=text.match(/^(last|this|next) (week|month|year)$/);
 const chinese:Record<string,[number,string]>={'上周':[-1,'week'],'本周':[0,'week'],'下周':[1,'week'],'上个月':[-1,'month'],'这个月':[0,'month'],'下个月':[1,'month'],'去年':[-1,'year'],'今年':[0,'year'],'明年':[1,'year']};
 const step=unit?({last:-1,this:0,next:1}[unit[1]!]??0):chinese[text]?.[0];const period=unit?.[2]??chinese[text]?.[1];
 if(step!==undefined&&period){
  if(period==='year'){date.setUTCMonth(0,1);date.setUTCFullYear(date.getUTCFullYear()+step);}
  else if(period==='month'){date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+step);}
  else date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7)+7*step);
  return interval(date,period as 'week'|'month'|'year',expression,day(base.date));
 }
 return {...pending,reason:'Expression is not uniquely resolved by the supported calendar rules'};
}
export function temporalExpression(text:string):string{
 const patterns=[/\b(?:yesterday|today|tomorrow|(?:last|this|next) (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,3} days? ago|in \d{1,3} days?)\b/gi,/昨天|今天|明天|去年|今年|明年|上周|本周|下周|上个月|这个月|下个月|\d{1,3}天[前后]/g,/\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/g,new RegExp(`\\b(?:(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(?:${months.join('|')})\\s+(?:\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+)?(?:19|20)\\d{2})\\b`,'gi'),/(?:19|20)\d{2}年(?:\d{1,2}月(?:\d{1,2}日)?)?/g,/\b(?:in|during|since) ((?:19|20)\d{2})\b/gi];
 const found=patterns.flatMap(pattern=>[...text.matchAll(pattern)].map(m=>({text:m[1]??m[0],start:m.index!,end:m.index!+m[0].length})));
 const unique=found.filter((f,i)=>!found.some((other,j)=>j!==i&&other.start<=f.start&&other.end>=f.end&&(other.end-other.start>f.end-f.start||j<i)));
 return unique.length===1?unique[0]!.text:'';
}
export function messageAnchors(req:AddRequest,previous:string|null,sourceTimestamped?:boolean[]):{anchors:(string|null)[];last:string|null}{
 // A synthesized stamp orders messages; it must never pose as a real date that
 // relative event expressions ("last year") could resolve against, and it must
 // never inherit as a session anchor over later real timestamps.
 let explicit=previous&&!previous.includes('synthetic ordering')&&!/^\d{4}-\d\d-\d\dT/.test(previous)?previous:null;const anchors:(string|null)[]=[];
 const stamp=(i:number):string|null=>sourceTimestamped?.[i]===false?'synthetic ordering':req.messages[i]?.timestamp??null;
 for(const [i,m] of req.messages.entries()){explicit=m.content.match(/\[Session time:\s*([^\]]+)\]/i)?.[1]??explicit;anchors.push(explicit??stamp(i));}
 return {anchors,last:explicit??stamp(req.messages.length-1)??previous};
}
export function normalizeFactTime(f:ExtractedFact,req:AddRequest,anchors:(string|null)[]):TemporalEvidence{
 const strip=(s:string):string=>s.replace(/\[Session time:[^\]]*\]/gi,'');
 const source=strip(f.sources.map(s=>req.messages[s.index]?.content??'').join('\n'));
 const grounded=f.time_text&&source.toLowerCase().includes(f.time_text.toLowerCase());
 const expression=grounded?f.time_text:temporalExpression(strip(f.sources.map(s=>s.quote).join('\n')));
 const distinct=[...new Set(f.sources.map(s=>anchors[s.index]??null))];const anchor=distinct.length===1?distinct[0]!:null;
 const time=normalizeTime(expression,anchor,!!anchor?.includes('synthetic ordering'));
 f.time_text=expression;
 if(time.resolution==='resolved')f.valid_from=time.precision==='year'?time.start!.slice(0,4):time.precision==='month'?time.start!.slice(0,7):time.start;
 else if(anchor?.includes('synthetic ordering'))f.valid_from=null;
 else if(f.valid_from){const literal=normalizeTime(f.valid_from,null);if(literal.resolution!=='resolved'||!source.includes(f.valid_from))f.valid_from=null;}
 if(f.valid_to&&!source.includes(f.valid_to))f.valid_to=null;
 return time;
}
