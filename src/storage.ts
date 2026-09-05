// Transactional evolution of mem0 vector_stores/memory.ts and storage/SQLiteManager.ts.
// One tenant owns one connection; history, facts, vectors, FTS, sources and receipts commit together.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, slot, ServiceError, type AddRequest, type Fact, type Prepared, type Receipt, type Snapshot, type StoredMessage, type QueryIntent } from './types.js';
import { tokens } from './text.js';

const valueWords = (s:string):string[] => canonical(s).match(/[\p{L}\p{N}]+/gu) ?? [];
const valueDigest = (s:string):string => digest(valueWords(s).join(' '));
function containsValue(text:string,m:Marker):boolean { const w=valueWords(text), n=m.tokenCount??0; for(let i=0;n>0 && i+n<=w.length;i++){if(digest(w.slice(i,i+n).join(' '))===m.valueHash)return true;}return false;}
const digest = (s:string):string => createHash('sha256').update(s).digest('hex');
type Row = { body:string };
type Marker = { subject:string;predicate:string;scope:string;boundary:string;valueHash:string;tokenCount?:number;allowedValueHashes?:string[];revision:number };
export class TenantStore {
  readonly db: Database.Database;
  constructor(dir:string, readonly userId:string) {
    const folder = join(dir,digest(userId)); mkdirSync(folder,{recursive:true});
    this.db = new Database(join(folder,'memory.sqlite'));
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,ordinal);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, anchor TEXT);
      CREATE TABLE IF NOT EXISTS operations (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS markers (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
    `);
    const existing = this.meta('user_id');
    if (existing !== null && existing !== userId) throw new ServiceError('TENANT_ID','Tenant identity mismatch');
    this.setMeta('user_id',userId); if (this.meta('revision')===null) this.setMeta('revision','0');
  }
  meta(key:string):string|null { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value ?? null; }
  private setMeta(key:string,value:string):void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,value); }
  revision():number { return Number(this.meta('revision')??0); }
  facts():Fact[] { return (this.db.prepare('SELECT body FROM facts').all() as Row[]).map(r=>JSON.parse(r.body) as Fact); }
  receipt(id:string,hash:string):Receipt|null {
    const row=this.db.prepare('SELECT hash,receipt FROM requests WHERE id=?').get(id) as {hash:string;receipt:string}|undefined;
    if (!row) return null; if (row.hash!==hash) throw new ServiceError('REQUEST_CONFLICT','request_id was already used for another payload',409);
    return JSON.parse(row.receipt) as Receipt;
  }
  snapshot(session:string):Snapshot {
    const rows=this.db.prepare('SELECT body FROM messages WHERE session_id=? ORDER BY ordinal DESC LIMIT 10').all(session) as Row[];
    return {revision:this.revision(),facts:this.facts(),tail:rows.reverse().map(r=>JSON.parse(r.body) as StoredMessage),anchor:(this.db.prepare('SELECT anchor FROM sessions WHERE id=?').get(session) as {anchor:string|null}|undefined)?.anchor??null};
  }
  private put(f:Fact):void {
    this.db.prepare('INSERT OR REPLACE INTO facts VALUES (?,?)').run(f.id,JSON.stringify(f));
    this.db.prepare('DELETE FROM evidence_fts WHERE id=?').run(f.id);
    if (f.state!=='erased' && f.state!=='retracted') this.db.prepare('INSERT INTO evidence_fts(id,text) VALUES (?,?)').run(f.id,tokens(`${f.subject} ${f.predicate} ${f.scope} ${f.content}`).join(' '));
  }
  commit(req:AddRequest,payloadHash:string,prepared:Prepared,expectedRevision:number,failAt?:string):Receipt {
    return this.db.transaction(()=>{
      const already=this.receipt(req.request_id,payloadHash); if(already)return already;
      if(this.revision()!==expectedRevision)throw new ServiceError('REVISION_CONFLICT','Concurrent mutation; retry request');
      const revision=expectedRevision+1;
      const space=this.meta('embedding_space');
      if(space && space!==prepared.embeddingSpace && prepared.facts.some(f=>f.vector))throw new ServiceError('EMBEDDING_SPACE','Rebuild required before changing embedding model');
      if(prepared.facts.some(f=>f.vector))this.setMeta('embedding_space',prepared.embeddingSpace);
      const offset=(this.db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS n FROM messages').get() as {n:number}).n;
      const inserted=prepared.messages.map(m=>({...m,ordinal:m.ordinal+offset}));
      for(const m of inserted)this.db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(m.id,m.session_id,m.ordinal,JSON.stringify(m));
      this.db.prepare('INSERT INTO sessions(id,anchor) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET anchor=excluded.anchor').run(req.session_id,prepared.anchor);
      let all=this.facts(); const suppressedSources=new Set<string>(); const redactedSources=new Set<string>(); const erasedIds=new Set<string>();
      for(const operation of prepared.operations){
        const source=prepared.messages[operation.source.index]; if(!source)throw new ServiceError('SOURCE','Missing operation source');
        suppressedSources.add(source.id);
        const target=operation.target_ids.length ? all.filter(f=>operation.target_ids.includes(f.id)) : all.filter(f=>slot(f)===slot(operation) && (!operation.value || canonical(f.value)===canonical(operation.value)));
        if(operation.type==='restore'){
          if(!/remember.*again|store.*again|重新.*记|再次.*记/i.test(operation.source.quote))throw new ServiceError('RESTORE','Explicit reauthorization required');
          const markerRows=this.db.prepare('SELECT id,body FROM markers').all() as {id:number;body:string}[];
          for(const row of markerRows){const m=JSON.parse(row.body) as Marker;if(slot(m)===slot(operation)){if(!operation.value)throw new ServiceError('RESTORE','Explicit new value required');m.allowedValueHashes=[...new Set([...(m.allowedValueHashes??[]),valueDigest(operation.value)])];this.db.prepare('UPDATE markers SET body=? WHERE id=?').run(JSON.stringify(m),row.id);}}
          continue;
        }
        if(!target.length && operation.type!=='update')throw new ServiceError('OPERATION_TARGET','No unambiguous existing target');
        for(const f of target){
          if(f.state==='erased')continue;
          for(const id of f.source_ids)suppressedSources.add(id);
          if(operation.type==='forget'){
            const marker:Marker={subject:f.subject,predicate:f.predicate,scope:f.scope,boundary:operation.boundary,valueHash:valueDigest(f.value),tokenCount:valueWords(f.value).length,allowedValueHashes:[],revision};
            this.db.prepare('INSERT INTO markers(body) VALUES (?)').run(JSON.stringify(marker));
            erasedIds.add(f.id);for(const id of f.source_ids)redactedSources.add(id);
            f.state='erased'; f.content='';f.value='';f.vector=null;f.source_quotes=[];f.entities=[];
          }else{
            f.state=operation.type==='correct'?'retracted':'superseded';f.valid_to=source.timestamp;
          }
          f.revision=revision;this.put(f);
        }
        // Audit keeps target IDs and a category, never a forgotten raw value or source quote.
        this.db.prepare('INSERT INTO operations(body) VALUES (?)').run(JSON.stringify({type:operation.type,target_ids:target.map(f=>f.id),subject:operation.subject,predicate:operation.predicate,scope:operation.scope,boundary:operation.boundary,source_id:source.id,revision}));
      }
      if(failAt==='operations')throw new ServiceError('INJECTED_FAILURE','Fault injection before fact commit');
      const markers=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
      for(const incoming of prepared.facts){
        const f={...incoming,revision};
        // An exact old-value replay cannot resurrect forgotten material.
        if(markers.some(m=>!(m.allowedValueHashes??[]).includes(valueDigest(f.value)) && ((slot(m)===slot(f) && (m.boundary==='property'||m.valueHash===valueDigest(f.value)))||containsValue(f.content,m)))){for(const id of f.source_ids){suppressedSources.add(id);redactedSources.add(id);}continue;}
        if(f.modality==='hypothetical'||f.modality==='quoted')continue;
        const same=all.filter(old=>(old.state==='active'||old.state==='conflicted')&&slot(old)===slot(f));
        const duplicate=same.find(old=>canonical(old.value)===canonical(f.value)&&old.modality===f.modality&&f.kind!=='event');
        if(duplicate){
          duplicate.source_ids=[...new Set([...duplicate.source_ids,...f.source_ids])];duplicate.source_quotes=[...new Set([...duplicate.source_quotes,...f.source_quotes])];duplicate.revision=revision;
          this.put(duplicate);for(const id of f.source_ids)suppressedSources.add(id);continue;
        }
        if(f.modality==='confirmed'&&f.cardinality==='single'){
          const date=f.valid_from??f.observed_at;
          for(const old of same.filter(old=>old.modality==='confirmed')){
            const oldDate=old.valid_from??old.observed_at;
            if(Date.parse(oldDate)===Date.parse(date)){old.state='conflicted';f.state='conflicted';old.revision=revision;this.put(old);}
            else if(oldDate<date){old.state='superseded';old.valid_to=date;old.revision=revision;this.put(old);for(const id of old.source_ids)suppressedSources.add(id);}
            else {f.state='superseded';f.valid_to=oldDate;}
          }
        }
        for(const id of f.supersedes){const old=all.find(x=>x.id===id);if(old&&old.state==='active'&&f.modality==='confirmed'){old.state='superseded';old.valid_to=f.valid_from??f.observed_at;old.revision=revision;this.put(old);for(const source of old.source_ids)suppressedSources.add(source);}}
        this.put(f);all.push(f);for(const id of f.source_ids)suppressedSources.add(id);
      }
      // Invalidate derived facts transitively; do not retain deleted values in another predicate.
      all=this.facts();let changed=true;
      while(changed){changed=false;for(const f of all){
        if(f.state==='erased')continue;
        const dependent=(f.depends_on??[]).some(id=>erasedIds.has(id)) || (f.modality==='inferred'&&f.source_ids.some(id=>redactedSources.has(id)));
        const leaked=markers.some(m=>!(m.allowedValueHashes??[]).includes(valueDigest(f.value))&&containsValue(f.content,m));
        if(dependent||leaked){erasedIds.add(f.id);for(const id of f.source_ids){suppressedSources.add(id);redactedSources.add(id);}f.state='erased';f.content='';f.value='';f.vector=null;f.source_quotes=[];f.entities=[];f.revision=revision;this.put(f);changed=true;}
      }}
      for(const m of inserted){if(markers.some(marker=>containsValue(m.content,marker))){suppressedSources.add(m.id);redactedSources.add(m.id);}}
      // Mixed source messages become non-searchable; their independent retained facts stay available.
      all=this.facts();
      for(const sourceId of suppressedSources){
        const row=this.db.prepare('SELECT body FROM messages WHERE id=?').get(sourceId) as Row|undefined;if(!row)continue;
        const m=JSON.parse(row.body) as StoredMessage;m.searchable=false;
        if(redactedSources.has(sourceId) || all.some(f=>f.state==='erased'&&f.source_ids.includes(sourceId)) || prepared.operations.some(o=>o.type==='forget'&&prepared.messages[o.source.index]?.id===sourceId)){
          m.content=all.filter(f=>(f.state==='active'||f.state==='conflicted')&&f.source_ids.includes(sourceId)).map(f=>f.content).join('\n') || '[Memory content removed]';
        }
        this.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(m),sourceId);
      }
      if(failAt==='indexes')throw new ServiceError('INJECTED_FAILURE','Fault injection after index writes');
      const receipt:Receipt={success:true,request_id:req.request_id,user_id:req.user_id,session_id:req.session_id};
      this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(req.request_id,payloadHash,JSON.stringify(receipt));this.setMeta('revision',String(revision));return receipt;
    })();
  }
  lexical(query:string,limit:number):{id:string;score:number}[]{
    const terms=[...new Set(tokens(query))].slice(0,64);if(!terms.length)return [];
    const expression=terms.map(t=>`"${t.replace(/"/g,'""')}"`).join(' OR ');
    const rows=this.db.prepare('SELECT id,bm25(evidence_fts) AS rank FROM evidence_fts WHERE evidence_fts MATCH ? ORDER BY rank LIMIT ?').all(expression,limit) as {id:string;rank:number}[];
    return rows.map(r=>({id:r.id,score:-r.rank}));
  }
  raw():StoredMessage[]{return (this.db.prepare('SELECT body FROM messages').all() as Row[]).map(r=>JSON.parse(r.body) as StoredMessage).filter(m=>m.searchable);}
  close():void{this.db.close();}
}

export function allowed(f:Fact,i:QueryIntent):boolean {
  if(f.state==='erased'||f.state==='retracted'||f.modality==='hypothetical'||f.modality==='quoted')return false;
  if(f.state==='superseded'&&!i.historical&&!i.asOf)return false;
  if(i.asOf){const at=Date.parse(i.asOf+'T23:59:59.999Z');if(Date.parse(f.valid_from??f.observed_at)>at)return false;if(f.valid_to&&Date.parse(f.valid_to)<=at)return false;}
  return true;
}
