import {createHash} from 'node:crypto';
import type {Fact,StoredMessage,Passage,Operation} from './types.js';
import {instructionSpans} from './operation-intent.js';
import {speakerPrefix} from './text.js';

const digest=(s:string):string=>createHash('sha256').update(s).digest('hex');
export function sourceSpans(f:{sources:{index:number;quote:string}[]},messages:StoredMessage[]):NonNullable<Fact['source_spans']>{
 return f.sources.flatMap(s=>{
  const m=messages[s.index];if(!m)return [];
  const spans:NonNullable<Fact['source_spans']>=[];
  for(let start=m.content.indexOf(s.quote);start>=0;start=m.content.indexOf(s.quote,start+Math.max(1,s.quote.length)))spans.push({source_id:m.id,start,end:start+s.quote.length});
  return spans;
 });
}

/** Each passage carries original UTF-16 offsets. No synthesized summary is
 * labelled verbatim, and quoted assistant suggestions cannot become user facts. */
export function preparePassages(messages:StoredMessage[],facts:Fact[],operations:Operation[],revision:number):Passage[]{
 const result:Passage[]=[];const segmenter=new Intl.Segmenter('en',{granularity:'sentence'});
 for(const m of messages){
  const cleaned=m.content.replace(/\[(?:Session time|Source id):[^\]]*\]/g,'').trim();
  const named=speakerPrefix(cleaned)?.[1];
  if(m.role!=='user'&&!named)continue;
  const controls=instructionSpans(m.content).filter(s=>s.intent!=='none');
  const operationSpans=operations.filter(o=>messages[o.source.index]?.id===m.id).map(o=>({start:m.content.indexOf(o.source.quote),end:m.content.indexOf(o.source.quote)+o.source.quote.length}));
  for(const sentence of segmenter.segment(m.content)){
   for(let offset=0;offset<sentence.segment.length;){
    let length=Math.min(900,sentence.segment.length-offset);
    if(offset+length<sentence.segment.length){const split=sentence.segment.lastIndexOf(' ',offset+length);if(split>offset+450)length=split-offset;}
    const start=sentence.index+offset,end=start+length,text=m.content.slice(start,end);offset+=length;
    if(!text.trim())continue;
    // An operation is represented by a safe event, never a raw command echo.
    if([...controls,...operationSpans].some(s=>s.start<end&&s.end>start))continue;
    const linked=facts.filter(f=>f.source_spans?.some(s=>s.source_id===m.id&&s.start<end&&s.end>start));
    result.push({id:'source-'+digest(`${m.id}\0${start}\0${end}`),source_id:m.id,speaker:named??m.role,external_id:m.external_id,fragments:[{start,end,text}],content:text,fact_ids:linked.map(f=>f.id),vector:null,observed_at:m.timestamp,time_basis:m.time_basis??'source',revision,state:'active'});
   }
  }
 }
 return result;
}

export function redactPassage(p:Passage,intervals:{start:number;end:number}[]):boolean{
 let fragments=p.fragments;
 for(const interval of intervals){
  fragments=fragments.flatMap(f=>{
   if(interval.end<=f.start||interval.start>=f.end)return [f];
   const out:Passage['fragments']=[];
   if(interval.start>f.start)out.push({start:f.start,end:interval.start,text:f.text.slice(0,interval.start-f.start)});
   if(interval.end<f.end)out.push({start:interval.end,end:f.end,text:f.text.slice(interval.end-f.start)});
   return out;
  });
 }
 if(JSON.stringify(fragments)===JSON.stringify(p.fragments))return false;
 p.fragments=fragments.filter(f=>/[\p{L}\p{N}]/u.test(f.text));
 p.content=p.fragments.map(f=>f.text).join(' […] ');p.vector=null;
 if(!p.content)p.state='erased';
 return true;
}
