// Transactional evolution of mem0 vector_stores/memory.ts and storage/SQLiteManager.ts.
// One tenant owns one connection; history, facts, vectors, FTS, sources and receipts commit together.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, slot, propertyFamily, ServiceError, type AddRequest, type MemoryEvent, type Operation, type Fact, type Passage, type Prepared, type Receipt, type Snapshot, type StoredMessage, type QueryIntent } from './types.js';
import { tokens } from './text.js';
import {redactPassage} from './passages.js';
import {eventCategory} from './events.js';

const valueWords = (s:string):string[] => canonical(s).match(/[\p{L}\p{N}]+/gu) ?? [];
const valueDigest = (s:string):string => digest(valueWords(s).join(' '));
function containsValue(text:string,m:Marker):boolean { const w=valueWords(text), n=m.tokenCount??0; for(let i=0;n>0 && i+n<=w.length;i++){if(digest(w.slice(i,i+n).join(' '))===m.valueHash)return true;}return false;}
const digest = (s:string):string => createHash('sha256').update(s).digest('hex');
type Row = { body:string };
type Marker = { subject:string;predicate:string;scope:string;boundary:string;valueHash:string;tokenCount?:number;allowedValueHashes?:string[];revision:number };
function markerConcerns(m:Marker,f:Fact):boolean{
  // An unscoped replay remains guarded; an explicitly different subject/context
  // is not erased merely because it happens to contain the same literal value.
  return canonical(m.subject)===canonical(f.subject)&&(!f.scope||canonical(m.scope)===canonical(f.scope));
}
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
      CREATE TABLE IF NOT EXISTS memory_events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS markers (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS passages (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS passages_source ON passages(source_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
    `);
    const existing = this.meta('user_id');
    if (existing !== null && existing !== userId) throw new ServiceError('TENANT_ID','Tenant identity mismatch');
    this.setMeta('user_id',userId); if (this.meta('revision')===null) this.setMeta('revision','0');
  }
  meta(key:string):string|null { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value ?? null; }
  private setMeta(key:string,value:string):void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,value); }
  revision():number { return Number(this.meta('revision')??0); }
  facts():Fact[] { return (this.db.prepare('SELECT body FROM facts').all() as Row[]).map(r=>JSON.parse(r.body) as Fact); }
  events():MemoryEvent[]{return (this.db.prepare('SELECT body FROM memory_events').all() as Row[]).map(r=>JSON.parse(r.body) as MemoryEvent).sort((a,b)=>a.ordinal-b.ordinal||a.id.localeCompare(b.id));}
  passages():Passage[]{return (this.db.prepare('SELECT body FROM passages').all() as Row[]).map(r=>JSON.parse(r.body) as Passage);}
  private putPassage(p:Passage):void{
    this.db.prepare('INSERT OR REPLACE INTO passages VALUES (?,?,?)').run(p.id,p.source_id,JSON.stringify(p));
    this.db.prepare('DELETE FROM passage_fts WHERE id=?').run(p.id);
    if(p.state==='active'&&p.content)this.db.prepare('INSERT INTO passage_fts(id,text) VALUES (?,?)').run(p.id,tokens(`${p.speaker} ${p.content}`).join(' '));
  }
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
    // Extraction proposals carry a sources array, but persisted facts have one
    // canonical source_quotes field. Never preserve an untracked duplicate copy.
    delete (f as Fact & {sources?:unknown}).sources;
    if(f.state==='erased'){f.time_text='';delete f.event_time;delete f.transition_time;}
    this.db.prepare('INSERT OR REPLACE INTO facts VALUES (?,?)').run(f.id,JSON.stringify(f));
    this.db.prepare('DELETE FROM evidence_fts WHERE id=?').run(f.id);
    if (f.state!=='erased' && f.state!=='retracted') this.db.prepare('INSERT INTO evidence_fts(id,text) VALUES (?,?)').run(f.id,tokens(`${f.subject} ${f.predicate} ${f.scope} ${f.content}`).join(' '));
  }
  commit(req:AddRequest,payloadHash:string,prepared:Prepared,expectedRevision:number,failAt?:string):Receipt {
    return this.db.transaction(()=>{
      const already=this.receipt(req.request_id,payloadHash); if(already)return already;
      if(this.revision()!==expectedRevision)throw new ServiceError('REVISION_CONFLICT','Concurrent mutation; retry request');
      const revision=expectedRevision+1;
      if(prepared.sourceFormat){
        const format=this.meta('source_format');
        if((format===null&&this.facts().length)||(format!==null&&format!==prepared.sourceFormat))throw new ServiceError('SOURCE_FORMAT','Fresh data directory required before changing source representation');
        this.setMeta('source_format',prepared.sourceFormat);
      }
      const space=this.meta('embedding_space');
      const hasVectors=prepared.facts.some(f=>f.vector)||prepared.passages?.some(p=>p.vector);
      if(space && space!==prepared.embeddingSpace && hasVectors)throw new ServiceError('EMBEDDING_SPACE','Rebuild required before changing embedding model');
      if(hasVectors)this.setMeta('embedding_space',prepared.embeddingSpace);
      const offset=(this.db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS n FROM messages').get() as {n:number}).n;
      const inserted=prepared.messages.map(m=>({...m,ordinal:m.ordinal+offset}));
      for(const m of inserted)this.db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(m.id,m.session_id,m.ordinal,JSON.stringify(m));
      this.db.prepare('INSERT INTO sessions(id,anchor) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET anchor=excluded.anchor').run(req.session_id,prepared.anchor);
      const originalFacts=this.facts();const operationTargets=new Map<Operation,string[]>();
      let all=structuredClone(originalFacts); const suppressedSources=new Set<string>(); const redactedSources=new Set<string>(); const erasedIds=new Set<string>(all.filter(f=>f.state==='erased').map(f=>f.id));
      const erasedQuotes=new Map<string,Set<string>>();
      const rememberErasedQuotes=(f:Fact):void=>{for(const id of f.source_ids){const quotes=erasedQuotes.get(id)??new Set<string>();for(const quote of f.source_quotes)quotes.add(quote);erasedQuotes.set(id,quotes);}};
      for(const operation of prepared.operations){
        const source=prepared.messages[operation.source.index]; if(!source)throw new ServiceError('SOURCE','Missing operation source');
        suppressedSources.add(source.id);
        // New facts may be revoked later in the same HTTP chunk. Bind their
        // validated property/value without inventing externally addressable IDs.
        const pending=prepared.facts.filter(f=>f.source_ids.length>0&&f.source_ids.every(id=>{
          const i=prepared.messages.findIndex(m=>m.id===id);if(i<0||i>operation.source.index)return false;
          if(i<operation.source.index)return true;
          const text=prepared.messages[i]!.content,start=text.indexOf(operation.source.quote);
          const quotes=f.source_quotes.filter(q=>text.includes(q));
          return start>=0&&quotes.length>0&&quotes.every(q=>text.indexOf(q)===text.lastIndexOf(q)&&text.indexOf(q)+q.length<=start);
        }));
        const pool=[...all,...pending];
        let target=operation.target_ids.length ? pool.filter(f=>operation.target_ids.includes(f.id)) : pool.filter(f=>slot(f)===slot(operation) && (!operation.value || canonical(f.value)===canonical(operation.value)));
        if(operation.target_ids.some(id=>!target.some(f=>f.id===id)))throw new ServiceError('OPERATION_TARGET','Operation target is unavailable at its source position');
        if(target.some(f=>f.predicate==='memory_operation'))throw new ServiceError('OPERATION_TARGET','An operation trace is not the underlying property');
        if(target.some(f=>canonical(f.subject)!==canonical(operation.subject)||(operation.scope&&canonical(f.scope)!==canonical(operation.scope))))throw new ServiceError('OPERATION_SCOPE','Operation target is outside its subject or scope');
        if(new Set(target.map(f=>canonical(f.scope))).size>1)throw new ServiceError('AMBIGUOUS_OPERATION','Operation spans multiple unresolved scopes');
        if(operation.type==='forget'&&target.some(f=>f.state==='erased')){
          const priorMarkers=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
          for(const f of target.filter(f=>f.state==='erased')){
            const satisfied=priorMarkers.some(m=>slot(m)===slot(f)&&(operation.value?m.valueHash===valueDigest(operation.value):operation.boundary==='property'&&m.boundary==='property'));
            if(!satisfied)throw new ServiceError('OPERATION_TARGET','Already erased target does not prove the requested deletion boundary');
          }
        }
        const actionFamily=propertyFamily(operation.predicate,target[0]?.content??'');
        // Close duplicate representations of the same scoped value, including harmless
        // predicate wording differences. Do not extend deletion to other people/scopes.
        const families=new Set(target.map(f=>propertyFamily(f.predicate,f.content)));
        const value=operation.value||target.find(f=>f.value&&canonical(source.content).includes(canonical(f.value)))?.value;
        if(value&&target.length){for(const f of pool){if(f.state!=='active'||f.kind==='event'||canonical(f.value)!==canonical(value)||canonical(f.subject)!==canonical(operation.subject)||!families.has(propertyFamily(f.predicate,f.content)))continue;const scopeCompatible=target.some(t=>canonical(t.scope)===canonical(f.scope));if(scopeCompatible&&!target.some(t=>t.id===f.id))target.push(f);}}
        operationTargets.set(operation,target.map(f=>f.id));
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
            rememberErasedQuotes(f);
            f.state='erased'; f.content='';f.value='';f.vector=null;f.source_quotes=[];f.entities=[];
          }else{
            f.state=operation.type==='correct'?'retracted':'superseded';f.valid_to=source.timestamp;
          }
          f.revision=revision;this.put(f);
        }
      }
      if(failAt==='operations')throw new ServiceError('INJECTED_FAILURE','Fault injection before fact commit');
      const markers=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
      const mergedIds=new Map<string,string>();
      for(const incoming of prepared.facts){
        const f={...incoming,revision};
        if(f.state==='erased'||f.state==='retracted'||f.state==='superseded'){this.put(f);all.push(f);for(const id of f.source_ids)suppressedSources.add(id);continue;}
        // An exact old-value replay cannot resurrect forgotten material.
        if(markers.some(m=>markerConcerns(m,f)&&!(m.allowedValueHashes??[]).includes(valueDigest(f.value)) && ((slot(m)===slot(f) && (m.boundary==='property'||m.valueHash===valueDigest(f.value)))||containsValue(f.content,m)))){for(const id of f.source_ids){suppressedSources.add(id);redactedSources.add(id);}continue;}
        if(f.modality==='hypothetical'||f.modality==='quoted')continue;
        const same=all.filter(old=>(old.state==='active'||old.state==='conflicted')&&slot(old)===slot(f));
        const duplicate=same.find(old=>canonical(old.value)===canonical(f.value)&&old.modality===f.modality&&f.kind!=='event');
        if(duplicate){
          mergedIds.set(f.id,duplicate.id);
          duplicate.source_spans=[...(duplicate.source_spans??[]),...(f.source_spans??[])];
          duplicate.source_ids=[...new Set([...duplicate.source_ids,...f.source_ids])];duplicate.source_quotes=[...new Set([...duplicate.source_quotes,...f.source_quotes])];duplicate.revision=revision;
          this.put(duplicate);for(const id of f.source_ids)suppressedSources.add(id);continue;
        }
        if(f.modality==='confirmed'&&f.cardinality==='single'){
          const date=f.valid_from??f.observed_at;
          for(const old of same.filter(old=>old.modality==='confirmed')){
            const oldDate=old.valid_from??old.observed_at;
            const bounds=(fact:Fact):[number,number]=>{const start=Date.parse(fact.event_time?.start??fact.valid_from??fact.observed_at);return [start,fact.event_time?.end_exclusive?Date.parse(fact.event_time.end_exclusive):start+1];};
            const [a,b]=bounds(old),[c,d]=bounds(f);
            if(a<d&&c<b){old.state='conflicted';f.state='conflicted';old.revision=revision;this.put(old);}
            else if(a<c){old.state='superseded';old.valid_to=date;if(f.event_time?.resolution==='resolved')old.transition_time={start:f.event_time.start,end_exclusive:f.event_time.end_exclusive,precision:f.event_time.precision};old.revision=revision;this.put(old);for(const id of old.source_ids)suppressedSources.add(id);}
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
        const leaked=markers.some(m=>markerConcerns(m,f)&&!(m.allowedValueHashes??[]).includes(valueDigest(f.value))&&containsValue(f.content,m));
        if(dependent||leaked){erasedIds.add(f.id);rememberErasedQuotes(f);for(const id of f.source_ids){suppressedSources.add(id);redactedSources.add(id);}f.state='erased';f.content='';f.value='';f.vector=null;f.source_quotes=[];f.entities=[];f.revision=revision;this.put(f);changed=true;}
      }}
      for(const m of inserted){if(markers.some(marker=>containsValue(m.content,marker))){suppressedSources.add(m.id);redactedSources.add(m.id);}}
      // Retained neighbors must not carry a forgotten value inside a mixed quote.
      for(const f of all){
        if(f.state==='erased')continue;
        const quotes=f.source_quotes.filter(q=>{
          const sharesErasedSpan=f.source_ids.some(id=>[...(erasedQuotes.get(id)??[])].some(erased=>q.includes(erased)||erased.includes(q)));
          return !sharesErasedSpan&&!markers.some(m=>markerConcerns(m,f)&&containsValue(q,m)&&!(m.allowedValueHashes??[]).includes(valueDigest(f.value)));
        });
        if(quotes.length!==f.source_quotes.length){f.source_quotes=quotes;this.put(f);}
      }
      // Mixed source messages become non-searchable; their independent retained facts stay available.
      all=this.facts();
      const byId=new Map(all.map(f=>[f.id,f]));
      const newPassageIds=new Set((prepared.passages??[]).map(p=>p.id));
      for(const p of [...this.passages(),...(prepared.passages??[])]){
        if(p.state==='erased')continue;
        const previous=JSON.stringify(p);
        p.fact_ids=[...new Set(p.fact_ids.map(id=>mergedIds.get(id)??id))];
        const erased=p.fact_ids.map(id=>byId.get(id)).filter((f):f is Fact=>!!f&&f.state==='erased');
        for(const f of erased){
          const spans=f.source_spans?.filter(s=>s.source_id===p.source_id)??[];
          if(spans.length)redactPassage(p,spans);else{p.fragments=[];p.content='';p.vector=null;p.state='erased';}
        }
        p.fact_ids=p.fact_ids.filter(id=>!erased.some(f=>f.id===id));
        // Even unextracted echoes must not reintroduce a forgotten literal. A
        // different scoped record needs positively linked surviving facts.
        const linked=p.fact_ids.map(id=>byId.get(id)).filter((f):f is Fact=>!!f);
        if(markers.some(m=>containsValue(p.content,m)&&(!linked.length||linked.some(f=>markerConcerns(m,f)&&!(m.allowedValueHashes??[]).includes(valueDigest(f.value)))))){
          p.fragments=[];p.content='';p.vector=null;p.state='erased';
        }
        if(newPassageIds.has(p.id)||JSON.stringify(p)!==previous){p.revision=revision;this.putPassage(p);}
      }
      for(const sourceId of suppressedSources){
        const row=this.db.prepare('SELECT body FROM messages WHERE id=?').get(sourceId) as Row|undefined;if(!row)continue;
        const m=JSON.parse(row.body) as StoredMessage;
        m.searchable=!!m.partial&&all.filter(f=>f.source_ids.includes(sourceId)).every(f=>f.state==='active'||f.state==='conflicted')&&!prepared.operations.some(o=>prepared.messages[o.source.index]?.id===sourceId);
        if(redactedSources.has(sourceId) || all.some(f=>f.state==='erased'&&f.source_ids.includes(sourceId)) || prepared.operations.some(o=>o.type==='forget'&&prepared.messages[o.source.index]?.id===sourceId)){
          m.redacted=true;m.searchable=false;m.content=all.filter(f=>(f.state==='active'||f.state==='conflicted')&&f.source_ids.includes(sourceId)).map(f=>f.content).join('\n') || '[Memory content removed]';
        }
        this.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(m),sourceId);
      }
      // Event records refer to state IDs; they never copy before/after values.
      const events:MemoryEvent[]=[];
      const current=new Map(this.facts().map(f=>[f.id,f]));
      const event=(type:MemoryEvent['type'],f:Pick<Fact,'subject'|'predicate'|'scope'|'content'>,sourceIds:string[],beforeIds:string[],afterIds:string[],position=0,actor:MemoryEvent['actor']='observation'):void=>{
        const source=inserted.filter(m=>sourceIds.includes(m.id)).sort((a,b)=>a.ordinal-b.ordinal)[0];if(!source)return;
        events.push({id:'event-'+digest(`${req.user_id}\0${req.request_id}\0${events.length}`),type,actor,category:eventCategory(f),slot_hash:digest(slot(f)),source_ids:sourceIds,before_ids:beforeIds,after_ids:afterIds,ordinal:source.ordinal*10000000+position,observed_at:source.timestamp,time_basis:source.time_basis??'source',revision});
      };
      for(const f of prepared.facts){
        const id=mergedIds.get(f.id)??f.id;if(!current.has(id))continue;
        const explicit=prepared.operations.some(o=>['update','correct','restore'].includes(o.type)&&slot(o)===slot(f)&&f.source_ids.includes(prepared.messages[o.source.index]!.id));
        if(explicit)continue;
        const previous=originalFacts.filter(old=>slot(old)===slot(f)&&old.id!==id&&old.state!=='superseded'&&current.get(old.id)?.state==='superseded'&&current.get(old.id)?.revision===revision);
        event(f.kind==='reflection'||f.modality==='inferred'?'reflection':previous.length?'update':'remember',f,f.source_ids,previous.map(f=>f.id),[id],f.source_spans?.[0]?.start??0);
      }
      for(const o of prepared.operations){
        const source=prepared.messages[o.source.index]!;const ids=operationTargets.get(o)??[];
        const after=['forget','retract'].includes(o.type)?[]:prepared.facts.filter(f=>slot(f)===slot(o)&&f.source_ids.includes(source.id)).map(f=>mergedIds.get(f.id)??f.id).filter(id=>current.has(id));
        const original=originalFacts.find(f=>ids.includes(f.id))??prepared.facts.find(f=>ids.includes(f.id));
        event(o.type,{...o,content:original?.content??''},[source.id],ids,after,source.content.indexOf(o.source.quote),source.role==='user'?'user':'participant');
        this.db.prepare('INSERT INTO operations(body) VALUES (?)').run(JSON.stringify({type:o.type,target_ids:ids,subject:o.subject,predicate:o.predicate,scope:o.scope,boundary:o.boundary,source_id:source.id,revision}));
      }
      for(const e of events)this.db.prepare('INSERT INTO memory_events VALUES (?,?)').run(e.id,JSON.stringify(e));
      if(failAt==='indexes')throw new ServiceError('INJECTED_FAILURE','Fault injection after index writes');
      const receipt:Receipt={success:true,request_id:req.request_id,user_id:req.user_id,session_id:req.session_id};
      this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(req.request_id,payloadHash,JSON.stringify(receipt));this.setMeta('revision',String(revision));return receipt;
    })();
  }
  lexical(query:string,limit:number):{id:string;score:number}[]{
    return this.lexicalTable(query,limit,'evidence_fts');
  }
  lexicalPassages(query:string,limit:number):{id:string;score:number}[]{return this.lexicalTable(query,limit,'passage_fts');}
  private lexicalTable(query:string,limit:number,table:'evidence_fts'|'passage_fts'):{id:string;score:number}[]{
    const terms=[...new Set(tokens(query))].slice(0,64);if(!terms.length)return [];
    const expression=terms.map(t=>`"${t.replace(/"/g,'""')}"`).join(' OR ');
    const rows=this.db.prepare(`SELECT id,bm25(${table}) AS rank FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`).all(expression,limit) as {id:string;rank:number}[];
    return rows.map(r=>({id:r.id,score:-r.rank}));
  }
  source(id:string):StoredMessage|null{const row=this.db.prepare('SELECT body FROM messages WHERE id=?').get(id) as Row|undefined;return row?JSON.parse(row.body) as StoredMessage:null;}
  raw():StoredMessage[]{return (this.db.prepare('SELECT body FROM messages').all() as Row[]).map(r=>JSON.parse(r.body) as StoredMessage).filter(m=>m.searchable);}
  close():void{this.db.close();}
}

export function allowed(f:Fact,i:QueryIntent):boolean {
  if(f.state==='erased'||f.state==='retracted'||f.modality==='hypothetical'||f.modality==='quoted')return false;
  if(f.state==='superseded'&&!i.historical&&!i.asOf)return false;
  if(i.asOf){
    const at=Date.parse(i.asOf+'T23:59:59.999Z');
    if(f.time_basis!=='ordering'||f.event_time?.resolution==='resolved'){
      if(Date.parse(f.event_time?.start??f.valid_from??f.observed_at)>at)return false;
      const end=f.transition_time?.precision&&f.transition_time.precision!=='day'?f.transition_time.end_exclusive:f.valid_to;
      if(end&&Date.parse(end)<=at)return false;
    }
  }
  return true;
}
