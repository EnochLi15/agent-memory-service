// Opt-in benchmark instrumentation; never imported by the production image.
import {Worker,isMainThread,parentPort,threadId} from 'node:worker_threads';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {appendFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';
const directory=process.env.MEMORY_PERF_AUDIT_DIR;
if(directory){
 mkdirSync(directory,{recursive:true});const path=join(directory,`thread-${threadId}.jsonl`);
 const record=x=>appendFileSync(path,JSON.stringify({at:new Date().toISOString(),thread_id:threadId,...x})+'\n');
 const clock=()=>performance.timeOrigin+performance.now();
 if(isMainThread){
  const original=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message,...args){return original.call(this,message&&typeof message==='object'&&typeof message.method==='string'?{...message,__performanceSentAt:clock()}:message,...args);};
  const histogram=monitorEventLoopDelay({resolution:10});histogram.enable();
  setInterval(()=>{record({kind:'main_event_loop_delay',window_ms:1000,resolution_ms:10,p50_ms:histogram.percentile(50)/1e6,p95_ms:histogram.percentile(95)/1e6,p99_ms:histogram.percentile(99)/1e6,max_ms:histogram.max/1e6});histogram.reset();},1000).unref();
 }else if(parentPort){
  const original=parentPort.on;
  parentPort.on=function(event,listener){return original.call(this,event,event==='message'?function(message){
   const started=clock();try{return listener.call(this,message);}finally{if(typeof message?.__performanceSentAt==='number')record({kind:'worker_dispatch',method:message.method,dispatch_wait_ms:Math.max(0,started-message.__performanceSentAt),handler_ms:clock()-started});}
  }:listener);};
 }
}
