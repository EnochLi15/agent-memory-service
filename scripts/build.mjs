import {spawn} from 'node:child_process';
import {rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=new URL('../',import.meta.url);
// TypeScript does not remove outputs for files moved or deleted from src/.
rmSync(new URL('dist/',root),{recursive:true,force:true});
const compiler=spawn(process.execPath,[fileURLToPath(new URL('node_modules/typescript/bin/tsc',root)),'-p','tsconfig.json'],{
 cwd:fileURLToPath(root),stdio:'inherit',
});
// Development shutdown must also stop the compiler before releasing dist/.
const handlers=['SIGINT','SIGTERM'].map(signal=>{
 const handler=()=>compiler.kill(signal);
 process.on(signal,handler);
 return [signal,handler];
});
try{
 process.exitCode=await new Promise((resolve,reject)=>{
  compiler.once('error',reject);
  compiler.once('close',code=>resolve(code??1));
 });
}finally{
 for(const [signal,handler] of handlers)process.off(signal,handler);
}
