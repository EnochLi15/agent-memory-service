// HTTP transport protection only; the pinned upstream memory pipeline is unchanged.
export class IngestionGuard {
 private completed=new Map<string,string>();
 private pending=new Map<string,{signature:string;promise:Promise<void>}>();
 private queues=new Map<string,Promise<void>>();
 async run(user:string,request:string,signature:string,work:()=>Promise<void>):Promise<void>{
  const key=JSON.stringify([user,request]);const prior=this.pending.get(key);const known=this.completed.get(key)??prior?.signature;
  if(known!==undefined&&known!==signature)throw Object.assign(new Error('Request payload conflict'),{statusCode:409});
  if(this.completed.has(key))return;
  if(prior)return prior.promise;
  const run=(this.queues.get(user)??Promise.resolve()).catch(()=>{}).then(work).then(()=>{this.completed.set(key,signature);});
  this.pending.set(key,{signature,promise:run});this.queues.set(user,run);
  try{await run;}finally{if(this.pending.get(key)?.promise===run)this.pending.delete(key);if(this.queues.get(user)===run)this.queues.delete(user);}
 }
}
