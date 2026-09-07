import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

/** One process-wide lane per provider credential, shared by all tenants/stages.
 * Waiting retains the original request signal; cancellation must not let a
 * later waiter jump past a still-running predecessor. No cross-process claim. */
export class ModelGate {
 private tail:Promise<void>=Promise.resolve();
 private nextStart=0;
 private blockedUntil=0;
 constructor(private intervalMs=0){}
 tighten(intervalMs:number):void{this.intervalMs=Math.max(this.intervalMs,intervalMs);}
 defer(delayMs:number):void{this.blockedUntil=Math.max(this.blockedUntil,Date.now()+delayMs);}
 async run<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();
  const previous=this.tail;let release!:()=>void;
  this.tail=new Promise<void>(resolve=>{release=resolve;});
  try{
   await new Promise<void>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    previous.then(()=>{signal.removeEventListener('abort',abort);resolve();});
    if(signal.aborted)abort();
   });
   signal.throwIfAborted();
   return await work();
  }finally{void previous.then(release);}
 }
 async startAttempt(signal:AbortSignal):Promise<void>{
  for(;;){
   signal.throwIfAborted();
   const delay=Math.max(this.nextStart,this.blockedUntil)-Date.now();
   if(delay<=0)break;
   await sleep(Math.min(delay,2147483647),undefined,{signal});
  }
  this.nextStart=Date.now()+this.intervalMs;
 }
}
const gates=new Map<string,ModelGate>();
export function sharedModelGate(base:string,key:string,intervalMs=0):ModelGate{
 const identity=createHash('sha256').update(base.replace(/\/+$/,'')+'\0'+key).digest('hex');
 let gate=gates.get(identity);
 if(!gate){gate=new ModelGate(intervalMs);gates.set(identity,gate);}
 else gate.tighten(intervalMs);
 return gate;
}
