import {spawn} from 'node:child_process';
import {watch} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Compile before starting: the database worker loads emitted .js files too.
const cwd=fileURLToPath(new URL('../',import.meta.url));
const debug=process.argv.includes('--debug');
const inspectPort=process.env.LOCAL_INSPECT_PORT??'9229';
if(debug&&(!/^\d+$/.test(inspectPort)||+inspectPort<1024||+inspectPort>65535))throw Error('Invalid LOCAL_INSPECT_PORT');
let server,compiler,closing=false,pending=false,running=false,timer;
const children=new Set();
function launch(args){
 const child=spawn(process.execPath,args,{cwd,env:process.env,stdio:'inherit'});
 children.add(child);
 child.done=new Promise(resolve=>{
  child.once('error',()=>{children.delete(child);resolve(1);});
  child.once('exit',(code,signal)=>{children.delete(child);resolve(code??(signal?1:0));});
 });
 return child;
}
async function stop(child){
 if(!child||!children.has(child))return;
 child.kill('SIGTERM');
 const timeout=setTimeout(()=>child.kill('SIGKILL'),125000);
 try{await child.done;}finally{clearTimeout(timeout);}
}
async function rebuild(){
 pending=true;if(running||closing)return;
 running=true;
 try{
  while(pending&&!closing){
   pending=false;
   // Do not mix newly emitted worker code with an old running server.
   await stop(server);if(closing)break;
   compiler=launch(['node_modules/typescript/bin/tsc','-p','tsconfig.json']);
   const code=await compiler.done;compiler=undefined;
   if(closing)break;
   if(code!==0){console.error('Build failed; fix the source to retry. Service is stopped.');continue;}
   if(pending)continue;
   server=launch(['--enable-source-maps',...(debug?[`--inspect=127.0.0.1:${inspectPort}`]:[]),'dist/server.js']);
  }
 }finally{running=false;}
}
function changed(){clearTimeout(timer);timer=setTimeout(()=>void rebuild(),150);}
const watchers=[watch(new URL('../src/',import.meta.url),{recursive:true},changed),watch(new URL('../tsconfig.json',import.meta.url),changed)];
async function shutdown(){
 if(closing)return;closing=true;clearTimeout(timer);watchers.forEach(w=>w.close());
 await Promise.all([stop(compiler),stop(server)]);
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void shutdown());
console.log(`Local ${debug?'debug':'development'} mode: watching src/ and tsconfig.json; Ctrl+C stops the service.`);
await rebuild();
