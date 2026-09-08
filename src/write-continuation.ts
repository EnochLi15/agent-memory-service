import OpenAI from 'openai';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {modelRetryDelay} from './model-retry.js';
import {ServiceError} from './types.js';

const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
export const CONTINUATION_TTL=300000;
const MAX_ENTRY_BYTES=8*1024*1024,MAX_TOTAL_BYTES=64*1024*1024,MAX_ENTRIES=32;
type Packet={json:string;bytes:number};
/** Engine-local, bounded, ephemeral responses. Includes rejected verifier output;
 * no stored response is a success certificate. All validators execute again. */
export class ContinuationEntry {
 readonly packets=new Map<string,Packet>();bytes=0;valid=true;
 readonly expires:number;
 constructor(readonly tenant:string,readonly identity:string,now=Date.now(),readonly onGrowth:()=>void=()=>{}){this.expires=now+CONTINUATION_TTL;}
 clear():void{this.valid=false;this.packets.clear();this.bytes=0;}
}
export class ContinuationCache {
 private entries=new Map<string,ContinuationEntry>();private timers=new Map<string,NodeJS.Timeout>();
 get(key:string,identity:string):ContinuationEntry|undefined{
  this.prune();const entry=this.entries.get(key);return entry?.valid&&entry.identity===identity?entry:undefined;
 }
 create(key:string,tenant:string,identity:string):ContinuationEntry{
  this.prune();this.drop(key);
  while(this.entries.size>=MAX_ENTRIES)this.drop(this.entries.keys().next().value!);
  const entry=new ContinuationEntry(tenant,identity,Date.now(),()=>this.prune());this.entries.set(key,entry);
  const timer=setTimeout(()=>{if(this.entries.get(key)===entry)this.drop(key);},CONTINUATION_TTL);timer.unref();this.timers.set(key,timer);
  return entry;
 }
 prune():void{
  for(const [key,entry] of this.entries)if(!entry.valid||Date.now()>=entry.expires)this.drop(key);
  let total=[...this.entries.values()].reduce((n,e)=>n+e.bytes,0);
  while(total>MAX_TOTAL_BYTES){const key=this.entries.keys().next().value!,entry=this.entries.get(key)!;total-=entry.bytes;this.drop(key);}
 }
 drop(key:string):void{this.entries.get(key)?.clear();this.entries.delete(key);const timer=this.timers.get(key);if(timer)clearTimeout(timer);this.timers.delete(key);}
 invalidateTenant(tenant:string):void{for(const [key,entry] of this.entries)if(entry.tenant===tenant)this.drop(key);}
 clear():void{for(const key of this.entries.keys())this.drop(key);}
}
export class ContinuationAttempt {
 private counts=new Map<string,number>();private initial:Set<string>;private consumed=new Set<string>();pending=false;terminalModelFailure=false;replayed=0;fresh=0;
 constructor(readonly entry:ContinuationEntry,readonly caller:AbortSignal){this.initial=new Set(entry.packets.keys());}
 assertComplete():void{this.assertValid();if([...this.initial].some(key=>!this.consumed.has(key)))throw new ServiceError('EVIDENCE_VALIDATION','Write continuation did not replay its complete prior decisions');}
 assertValid():void{if(!this.entry.valid||Date.now()>=this.entry.expires)throw new ServiceError('EVIDENCE_VALIDATION','Write continuation state is no longer available');this.caller.throwIfAborted();}
 private failed(error:unknown,signal:AbortSignal):void{
  const deadline=signal.aborted&&signal.reason?.name==='TimeoutError'&&(error===signal.reason||error instanceof OpenAI.APIUserAbortError||error instanceof DOMException&&['AbortError','TimeoutError'].includes(error.name));
  if(!this.caller.aborted&&(modelRetryDelay(error,signal)!==null||deadline))this.pending=true;
  else if(!signal.aborted||!deadline&&signal.reason?.name==='TimeoutError')this.terminalModelFailure=true;
 }
 async call(identity:unknown,signal:AbortSignal,generate:()=>Promise<unknown>):Promise<unknown>{
  this.assertValid();try{signal.throwIfAborted();}catch(error){this.failed(error,signal);throw error;}
  const base=digest(JSON.stringify(identity)),ordinal=this.counts.get(base)??0;this.counts.set(base,ordinal+1);const key=base+':'+ordinal;
  const packet=this.entry.packets.get(key);
  if(packet){this.replayed++;this.consumed.add(key);return JSON.parse(packet.json);}
  this.fresh++;
  let raw:unknown;
  try{raw=await generate();}
  catch(error){
   // Only typed transient transport failures or the inner model deadline permit
   // another HTTP attempt. Syntax, semantic, refusal and provider 4xx do not.
   this.failed(error,signal);
   throw error;
  }
  this.assertValid();
  const json=JSON.stringify(raw);if(json===undefined)throw new ServiceError('MODEL_OUTPUT','Missing model object');
  const bytes=Buffer.byteLength(json);
  if(this.entry.bytes+bytes>MAX_ENTRY_BYTES){this.entry.clear();throw new ServiceError('EVIDENCE_VALIDATION','Write continuation capacity exceeded');}
  this.entry.packets.set(key,{json,bytes});this.entry.bytes+=bytes;this.entry.onGrowth();this.assertValid();try{signal.throwIfAborted();}catch(error){this.failed(error,signal);throw error;}return JSON.parse(json);
 }
}
const context=new AsyncLocalStorage<ContinuationAttempt>();
export const withContinuation=<T>(attempt:ContinuationAttempt,run:()=>Promise<T>):Promise<T>=>context.run(attempt,run);
export const continuationCall=(identity:unknown,signal:AbortSignal,generate:()=>Promise<unknown>):Promise<unknown>=>context.getStore()?.call(identity,signal,generate)??generate();
/** True while a resumable continuation wraps this preparation. Callers use it
 * to keep continuation mode's strict no-degraded-fallback contract. */
export const continuationActive=():boolean=>context.getStore()!==undefined;
