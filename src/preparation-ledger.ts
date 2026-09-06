import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {ServiceError} from './types.js';
const key=(id:string)=>createHash('sha256').update(id).digest('hex');
type Row={payload:string;identity:string;owner:string;attempts:number;expires:number;state:string};
/** Durable metadata only. No messages, proposed facts, model output or reasons.
 * A lost in-memory prefix cannot silently become a fresh semantic generation. */
export class PreparationLedger {
 constructor(private db:Database.Database){db.exec('CREATE TABLE IF NOT EXISTS preparation_attempts (id TEXT PRIMARY KEY,payload TEXT NOT NULL,identity TEXT NOT NULL,owner TEXT NOT NULL,attempts INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL)');}
 has(id:string,payload:string):boolean{const row=this.db.prepare('SELECT payload FROM preparation_attempts WHERE id=?').get(key(id)) as {payload:string}|undefined;if(row&&row.payload!==payload)throw new ServiceError('REQUEST_CONFLICT','request_id was already used for another payload',409);return !!row;}
 begin(id:string,payload:string,identity:string,owner:string,resumable:boolean,expires:number):number{
  return this.db.transaction(()=>{
   const prior=this.db.prepare('SELECT * FROM preparation_attempts WHERE id=?').get(key(id)) as Row|undefined;
   if(prior){
    if(prior.payload!==payload)throw new ServiceError('REQUEST_CONFLICT','request_id was already used for another payload',409);
    if(prior.identity!==identity||prior.owner!==owner||prior.state!=='retryable'||!resumable||Date.now()>=prior.expires||prior.attempts>=3)
     throw new ServiceError('EVIDENCE_VALIDATION','Write continuation cannot resume this request');
    this.db.prepare("UPDATE preparation_attempts SET attempts=attempts+1,state='running' WHERE id=?").run(key(id));return prior.attempts+1;
   }
   if(resumable)throw new ServiceError('EVIDENCE_VALIDATION','Write continuation ledger is missing');
   this.db.prepare("INSERT INTO preparation_attempts VALUES (?,?,?,?,1,?,'running')").run(key(id),payload,identity,owner,expires);return 1;
  })();
 }
 finish(id:string,owner:string,retryable:boolean):void{this.db.prepare("UPDATE preparation_attempts SET state=? WHERE id=? AND owner=? AND state='running'").run(retryable?'retryable':'closed',key(id),owner);}
 committed(id:string):void{
  this.db.prepare('DELETE FROM preparation_attempts WHERE id=?').run(key(id));
  this.db.prepare("UPDATE preparation_attempts SET state='closed' WHERE state!='closed'").run();
 }
}
