import {PreparationLedger} from './preparation-ledger.js';
import {validateSourceCoveragePlan,assertSourceCoverageStored} from './source-coverage.js';
import {validateSourceRoutePlan} from './source-operation-routing.js';
import {validateSourceBatchPlan} from './source-operation-batches.js';
import {hasRestoreWording} from './types.js';
import {validateSourceOperations} from './source-operations.js';
// Transactional evolution of mem0 vector_stores/memory.ts and storage/SQLiteManager.ts.
// One tenant owns one connection; history, facts, vectors, FTS, sources and receipts commit together.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, slot, sameScope, sameSlot, scopeKey, propertyFamily, replacementMatches, ServiceError, type AddRequest, type MemoryEvent, type Operation, type Fact, type Passage, type Prepared, type Receipt, type Snapshot, type StoredMessage, type QueryIntent } from './types.js';
import { tokens } from './text.js';
import {redactPassage} from './passages.js';
import {eventCategory} from './events.js';
import {resolveOperationTargets} from './binding.js';
import {retirementEffectMismatch,missingForgetObligations} from './operation-intent.js';
import {erasureAnchors,sourceErasureWork,validateSourceErasure,maskSource,assertErasedWitnessProgress} from './source-erasure.js';
import {valueWords,valueDigest,containsValue,factContainsValue,valueOccurrences,echoMentions,mentionsTokens,boundaryKey,protectBoundary,retainedAgainst,erasureWork,validateErasurePlan,validateRetainedValueContexts} from './erasure.js';
import type {ErasureBoundary} from './types.js';
import {transitionKey,transitionWork,validateTransitions} from './transitions.js';

const digest = (s:string):string => createHash('sha256').update(s).digest('hex');
type Row = { body:string };
type Marker = ErasureBoundary;
function markerConcerns(m:Marker,f:Fact):boolean{
  if(retainedAgainst(f,m))return false;
  // An unscoped replay remains guarded; an explicitly different subject/context
  // is not erased merely because it happens to contain the same literal value.
  return canonical(m.subject)===canonical(f.subject)&&(!f.scope||sameScope(m,f));
}
export class TenantStore {
  readonly db: Database.Database;readonly preparation:PreparationLedger;
  constructor(dir:string, readonly userId:string, expectedFormat?:Prepared['sourceFormat']) {
    const folder = join(dir,digest(userId)); mkdirSync(folder,{recursive:true});
    this.db = new Database(join(folder,'memory.sqlite'));
    // Reject incompatible data before schema/pragma writes or serving old
    // receipts. A successful health probe does not open every tenant database.
    try{
      const hasMeta=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
      const format=hasMeta?this.meta('source_format'):null;
      if(format!==null&&(!/^(?:(?:dual-source|facts-only)-v[2-9]|dual-source-v10)-s1$/.test(format)||expectedFormat&&format!==expectedFormat))throw new ServiceError('SOURCE_FORMAT','Incompatible source representation; restore a compatible snapshot or use a fresh data directory');
      if(format===null&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='facts'").get()&&this.db.prepare('SELECT 1 FROM facts LIMIT 1').get())throw new ServiceError('SOURCE_FORMAT','Unversioned populated data requires explicit recovery; use a compatible snapshot or fresh data directory');
    }catch(error){this.db.close();throw error;}
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
      -- porter wraps unicode61: English terms fold to stems on BOTH sides of
      -- MATCH (hobbies <-> hobby, painting <-> paintings), digits and CJK pass
      -- through untouched. Existing unicode61 tables keep their tokenizer
      -- (IF NOT EXISTS), so only fresh data directories gain the folding.
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(id UNINDEXED,text,tokenize='porter unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(id UNINDEXED,text,tokenize='porter unicode61');
    `);
    this.preparation=new PreparationLedger(this.db);
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
    const boundaries=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
    return {revision:this.revision(),facts:this.facts(),tail:rows.reverse().map(r=>JSON.parse(r.body) as StoredMessage),anchor:(this.db.prepare('SELECT anchor FROM sessions WHERE id=?').get(session) as {anchor:string|null}|undefined)?.anchor??null,...(/-v(?:[3-9]|10)-s1$/.test(this.meta('source_format')??'')?{erasureBoundaries:boundaries}:{}),...(/-v(?:[4-9]|10)-s1$/.test(this.meta('source_format')??'')?{erasureSources:(this.db.prepare('SELECT body FROM messages').all() as Row[]).map(r=>JSON.parse(r.body) as StoredMessage)}:{})};
  }
  private put(f:Fact):void {
    // Extraction proposals carry a sources array, but persisted facts have one
    // canonical source_quotes field. Never preserve an untracked duplicate copy.
    delete (f as Fact & {sources?:unknown}).sources;
    if(f.state==='erased'){f.time_text='';delete f.event_time;delete f.transition_time;delete f.erasure_exemptions;}
    this.db.prepare('INSERT OR REPLACE INTO facts VALUES (?,?)').run(f.id,JSON.stringify(f.state==='erased'?{...f,scopeHash:scopeKey(f),scope:''}:f));
    this.db.prepare('DELETE FROM evidence_fts WHERE id=?').run(f.id);
    if (f.state!=='erased' && f.state!=='retracted') this.db.prepare('INSERT INTO evidence_fts(id,text) VALUES (?,?)').run(f.id,tokens(`${f.subject} ${f.predicate} ${f.scope} ${f.content}`).join(' '));
  }
  commit(req:AddRequest,payloadHash:string,prepared:Prepared,expectedRevision:number,failAt?:string):Receipt {
    if(prepared.sourceFormat&&!/^(?:(?:dual-source|facts-only)-v[2-9]|dual-source-v10)-s1$/.test(prepared.sourceFormat))throw new ServiceError('SOURCE_FORMAT','Unsupported source representation; use a fresh data directory');
    // A rejected/rolled-back transaction must not mutate a fingerprinted plan
    // or its transient target records in the caller's prepared object.
    if(/-v(?:[3-9]|10)-s1$/.test(prepared.sourceFormat??''))prepared=structuredClone(prepared);
    return this.db.transaction(()=>{
      const already=this.receipt(req.request_id,payloadHash); if(already)return already;
      if(this.revision()!==expectedRevision)throw new ServiceError('REVISION_CONFLICT','Concurrent mutation; retry request');
      if(prepared.operations.some(o=>retirementEffectMismatch(o,req)))throw new ServiceError('OPERATION_INTENT','Retraction cannot satisfy an erasure request');
      const semanticErasure=/-v(?:[3-9]|10)-s1$/.test(prepared.sourceFormat??''),sourceErasure=/-v(?:[4-9]|10)-s1$/.test(prepared.sourceFormat??''),semanticTransitions=/-v(?:[5-9]|10)-s1$/.test(prepared.sourceFormat??'');
      const sourceActions=/-v(?:[6-9]|10)-s1$/.test(prepared.sourceFormat??'')?validateSourceOperations(prepared.sourceOperationPlan,req,this.facts(),prepared.facts,prepared.messages,/-v(?:[7-9]|10)-s1$/.test(prepared.sourceFormat??'')?this.snapshot(req.session_id).erasureSources??[]:[]):undefined;
      if(/-v(?:9|10)-s1$/.test(prepared.sourceFormat??'')&&sourceActions){
        validateSourceRoutePlan(prepared.sourceOperationPlan!,sourceActions.work);
        const resolved=sourceActions.plan.decisions.filter(d=>d.action==='reject_source').map(d=>sourceActions.work.instructions[d.instruction]!);
        if(missingForgetObligations(req,{facts:[],operations:prepared.operations}).some(o=>!resolved.some(i=>i.message===o.index&&i.start===o.span.start&&i.end===o.span.end)))throw new ServiceError('OPERATION_INTENT','Ordinary routing does not fulfill an unexecuted forget instruction');
      }
      if(prepared.sourceFormat?.endsWith('-v8-s1')&&sourceActions?.work.enabled)validateSourceBatchPlan(prepared.sourceOperationPlan!,sourceActions.work);
      const coveragePrepared=prepared.sourceFormat==='dual-source-v10-s1'?{...prepared,facts:prepared.facts.map(({vector,...f})=>({...structuredClone(f),vector:null})),operations:structuredClone(prepared.operations),messages:structuredClone(prepared.messages)}:undefined;
      if(coveragePrepared)validateSourceCoveragePlan(prepared.sourceCoveragePlan,req,coveragePrepared);
      const transitions=semanticTransitions?validateTransitions(prepared.transitionPlan,transitionWork(req,this.facts(),prepared.facts,prepared.operations)):undefined;
      let sourceCuts=new Map<string,{start:number;end:number}[]>();const reviewedSources=new Set<string>();
      const forcedErased=new Set<string>();
      const retained=new Map<string,NonNullable<Fact['erasure_exemptions']>>();
      if(semanticErasure){
        const boundaries=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
        const work=erasureWork(req,this.facts(),prepared.facts,prepared.operations,boundaries,sourceErasure?[...(this.db.prepare('SELECT body FROM messages').all() as Row[]).map(r=>JSON.parse(r.body) as StoredMessage),...prepared.messages]:[]);
        validateErasurePlan(prepared.erasurePlan,work);
        for(const d of prepared.erasurePlan!.decisions){if(d.effect==='erase')forcedErased.add(d.fact_id);else retained.set(d.fact_id,[...(retained.get(d.fact_id)??[]),{key:d.key,quote:d.quote}]);}
      }
      if(sourceErasure){
        const boundaries=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
        const oldSources=(this.db.prepare('SELECT body FROM messages').all() as Row[]).map(r=>JSON.parse(r.body) as StoredMessage);
        const work=sourceErasureWork(req,this.facts(),prepared.facts,prepared.operations,boundaries,oldSources,prepared.messages,[...forcedErased]);
        const validated=validateSourceErasure(prepared.sourceErasurePlan,work);sourceCuts=validated.cuts;
        for(const id of validated.erasedFacts)forcedErased.add(id);
        for(const c of work.candidates)if(c.kind==='source')reviewedSources.add(c.id);
      }
      if(sourceActions)for(const [id,cuts] of sourceActions.cuts)sourceCuts.set(id,[...(sourceCuts.get(id)??[]),...cuts]);
      // Only independently validated cuts discharge coverage. Later fallback
      // redaction must not excuse loss of an unrelated accepted raw witness.
      const coverageErasureCuts=coveragePrepared?structuredClone(sourceCuts):new Map<string,{start:number;end:number}[]>();
      const sourceWitnesses=sourceErasure?[...this.facts(),...prepared.facts].map(f=>({id:f.id,source_ids:[...f.source_ids],source_quotes:[...f.source_quotes]})):[];
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
      const priorErasedIds=new Set(originalFacts.filter(f=>f.state==='erased').map(f=>f.id));
      let all=structuredClone(originalFacts); const suppressedSources=new Set<string>(); const redactedSources=new Set<string>(); const erasedIds=new Set<string>(priorErasedIds);
      for(const f of all)if(retained.has(f.id)){f.erasure_exemptions=[...(f.erasure_exemptions??[]),...retained.get(f.id)!];this.put(f);}
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
          const spans=f.source_spans?.filter(s=>s.source_id===id)??[];
          if(spans.length)return start>=0&&spans.every(s=>s.end<=start);
          const quotes=f.source_quotes.filter(q=>text.includes(q));
          return start>=0&&quotes.length>0&&quotes.every(q=>text.indexOf(q)===text.lastIndexOf(q)&&text.indexOf(q)+q.length<=start);
        }));
        const pool=[...all,...pending];
        const allowEmpty=operation.type==='restore'||operation.type==='update'&&prepared.facts.some(f=>slot(f)===slot(operation)&&f.source_ids.includes(source.id));
        const binding=resolveOperationTargets(operation,pool,allowEmpty);
        if(binding.status!=='resolved')throw new ServiceError(binding.code,binding.reason);
        const target=binding.target_ids.map(id=>pool.find(f=>f.id===id)!);
        if(operation.type==='forget'&&target.some(f=>f.state==='erased')){
          const priorMarkers=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
          for(const f of target.filter(f=>f.state==='erased')){
            const satisfied=priorMarkers.some(m=>sameSlot(m,f)&&(operation.value?m.valueHash===valueDigest(operation.value):operation.boundary==='property'&&m.boundary==='property'));
            if(!satisfied)throw new ServiceError('OPERATION_TARGET','Already erased target does not prove the requested deletion boundary');
          }
        }
        const actionFamily=propertyFamily(operation.predicate,target[0]?.content??'');
        operationTargets.set(operation,target.map(f=>f.id));
        if(operation.type==='restore'){
          if(!hasRestoreWording(operation.source.quote))throw new ServiceError('RESTORE','Explicit reauthorization required');
          const markerRows=this.db.prepare('SELECT id,body FROM markers').all() as {id:number;body:string}[];
          for(const row of markerRows){const m=JSON.parse(row.body) as Marker;if(sameSlot(m,operation)){if(!operation.value)throw new ServiceError('RESTORE','Explicit new value required');m.allowedValueHashes=[...new Set([...(m.allowedValueHashes??[]),valueDigest(operation.value)])];this.db.prepare('UPDATE markers SET body=? WHERE id=?').run(JSON.stringify(m),row.id);}}
          continue;
        }
        if(!target.length && operation.type!=='update')throw new ServiceError('OPERATION_TARGET','No unambiguous existing target');
        for(const f of target){
          if(f.state==='erased')continue;
          for(const id of f.source_ids)suppressedSources.add(id);
          if(operation.type==='forget'){
            // A narrative instruction binds by the named phrase ("the Tucson
            // detail"), not by the erased sentence's wording: the marker
            // carries the phrase so differently-worded echoes of it match.
            const boundaryValue=operation.value||f.value;
            const phrase=valueWords(operation.value);
            const marker:Marker={subject:f.subject,predicate:f.predicate,scope:f.scope,boundary:operation.boundary,valueHash:valueDigest(boundaryValue),tokenCount:valueWords(boundaryValue).length,allowedValueHashes:[],revision,...(sourceErasure?{anchorHashes:erasureAnchors(f)}:{}),...(phrase.length&&phrase.length<=8?{phraseTokens:phrase}:{})};
            this.db.prepare('INSERT INTO markers(body) VALUES (?)').run(JSON.stringify(protectBoundary(marker)));
            erasedIds.add(f.id);for(const id of f.source_ids)redactedSources.add(id);
            rememberErasedQuotes(f);
            f.state='erased'; f.content='';f.value='';f.vector=null;f.source_quotes=[];f.entities=[];
          }else{
            f.state=operation.type==='correct'?'retracted':'superseded';f.valid_to=source.timestamp??null;
          }
          f.revision=revision;this.put(f);
        }
      }
      if(failAt==='operations')throw new ServiceError('INJECTED_FAILURE','Fault injection before fact commit');
      const markers=(this.db.prepare('SELECT body FROM markers').all() as Row[]).map(r=>JSON.parse(r.body) as Marker);
      const mergedIds=new Map<string,string>();
      const markerAbsorbed=new Set<string>();
      for(const incoming of prepared.facts){
        const f={...incoming,revision,...(retained.has(incoming.id)?{erasure_exemptions:retained.get(incoming.id)!}:{})};
        if(forcedErased.has(f.id)){rememberErasedQuotes(f);erasedIds.add(f.id);if(f.kind!=='reflection')for(const id of f.source_ids){suppressedSources.add(id);redactedSources.add(id);}f.state='erased';f.content='';f.value='';f.vector=null;f.source_quotes=[];f.entities=[];}
        for(const id of f.supersedes){const old=all.find(x=>x.id===id);if(old&&!replacementMatches(f,old))throw new ServiceError('FACT_TARGET','Replacement targets a different subject, property or scope');}
        if(f.state==='erased'||f.state==='retracted'||f.state==='superseded'){this.put(f);all.push(f);for(const id of f.source_ids)suppressedSources.add(id);continue;}
        // An exact old-value replay cannot resurrect forgotten material.
        // Pattern cards are absorbed at member granularity instead: their
        // source union spans innocent sibling members, so absorbing a card
        // wholesale would redact those siblings' messages, and a stale marker
        // on one constituent value (forgotten, then explicitly restored)
        // must not suppress the family card forever. A card skips commit only
        // when one of its value representatives was itself absorbed in this
        // commit; every stored member already passed its own marker check.
        const patternCard=f.kind==='reflection'&&f.modality==='inferred';
        if(patternCard?(f.depends_on??[]).some(id=>markerAbsorbed.has(id)):markers.some(m=>markerConcerns(m,f)&&!(m.allowedValueHashes??[]).includes(valueDigest(f.value)) && ((sameSlot(m,f) && (m.boundary==='property'||m.valueHash===valueDigest(f.value)))||factContainsValue(f,m)||(m.phraseTokens?.length?echoMentions(f.content,m.phraseTokens):false)))){
          if(!patternCard){markerAbsorbed.add(f.id);for(const id of f.source_ids){suppressedSources.add(id);redactedSources.add(id);}}
          continue;
        }
        if(f.modality==='hypothetical'||f.modality==='quoted')continue;
        const same=all.filter(old=>(old.state==='active'||old.state==='conflicted')&&slot(old)===slot(f));
        const duplicate=same.find(old=>canonical(old.value)===canonical(f.value)&&old.modality===f.modality&&f.kind!=='event');
        if(duplicate){
          // A fresh corroboration can resolve a previously conflicted value once
          // verified operations have removed every differing current alternative.
          if(semanticTransitions&&duplicate.state==='conflicted'&&f.modality==='confirmed'&&f.cardinality==='single'&&same.every(old=>canonical(old.value)===canonical(f.value)))duplicate.state='active';
          mergedIds.set(f.id,duplicate.id);
          duplicate.source_spans=[...(duplicate.source_spans??[]),...(f.source_spans??[])];
          duplicate.source_ids=[...new Set([...duplicate.source_ids,...f.source_ids])];duplicate.source_quotes=[...new Set([...duplicate.source_quotes,...f.source_quotes])];duplicate.revision=revision;
          if(f.erasure_exemptions)duplicate.erasure_exemptions=[...(duplicate.erasure_exemptions??[]),...f.erasure_exemptions];
          this.put(duplicate);for(const id of f.source_ids)suppressedSources.add(id);continue;
        }
        if(f.modality==='confirmed'&&f.cardinality==='single'){
          const date=f.valid_from??f.observed_at;
          for(const old of same.filter(old=>old.modality==='confirmed')){
            if(transitions&&!f.supersedes.includes(old.id)){
              const relation=transitions.get(transitionKey(f.id,old.id));
              if(!relation)throw new ServiceError('EVIDENCE_VALIDATION','Unverified implicit state transition');
              if(relation==='compatible')continue;
              if(relation==='uncertain'){old.state='conflicted';f.state='conflicted';old.revision=revision;this.put(old);continue;}
            }
            const oldDate=old.valid_from??old.observed_at;
            const bounds=(fact:Fact):[number,number]=>{const start=Date.parse(fact.event_time?.start??fact.valid_from??fact.observed_at);return [start,fact.event_time?.end_exclusive?Date.parse(fact.event_time.end_exclusive):start+1];};
            const [a,b]=bounds(old),[c,d]=bounds(f);
            if(a<d&&c<b){old.state='conflicted';f.state='conflicted';old.revision=revision;this.put(old);}
            else if(a<c){old.state='superseded';old.valid_to=date;if(f.event_time?.resolution==='resolved')old.transition_time={start:f.event_time.start,end_exclusive:f.event_time.end_exclusive,precision:f.event_time.precision};old.revision=revision;this.put(old);for(const id of old.source_ids)suppressedSources.add(id);}
            else {f.state='superseded';f.valid_to=oldDate;}
          }
        }
        // A reflection card also retires its predecessor on value-set change:
        // without this extension every re-derived pattern card would leave
        // the stale card active (cards are inferred, never confirmed) and pile
        // one obsolete aggregation per value change into current retrieval.
        for(const id of f.supersedes){const old=all.find(x=>x.id===id);if(old&&old.state==='active'&&(f.modality==='confirmed'||f.kind==='reflection')){old.state='superseded';old.valid_to=f.valid_from??f.observed_at;old.revision=revision;this.put(old);for(const source of old.source_ids)suppressedSources.add(source);}}
        this.put(f);all.push(f);for(const id of f.source_ids)suppressedSources.add(id);
      }
      // Invalidate derived facts transitively; do not retain deleted values in another predicate.
      all=this.facts();let changed=true;
      while(changed){changed=false;for(const f of all){
        if(f.state==='erased')continue;
        const dependent=(f.depends_on??[]).some(id=>erasedIds.has(id)) || (f.modality==='inferred'&&f.source_ids.some(id=>redactedSources.has(id)));
        // A card leaks only through its members — replay defense already ran
        // per member in the commit loop — so a member's marker never erases
        // the card here, and erasing a card never redacts its member-spanning
        // source union (each member's own lifecycle owns its sources).
        const card=f.kind==='reflection';
        // Without semantic binding the offline layer cannot adjudicate every
        // same-literal record: only a same-slot record or an echo sharing a
        // redacted source is a leak. An independent record in another slot
        // survives the deletion (the semantic layer keeps exempting it).
        const leaked=!card&&markers.some(m=>markerConcerns(m,f)&&!(m.allowedValueHashes??[]).includes(valueDigest(f.value))&&factContainsValue(f,m)&&(sameSlot(m,f)||f.source_ids.some(id=>redactedSources.has(id))));
        if(dependent||leaked||forcedErased.has(f.id)){erasedIds.add(f.id);rememberErasedQuotes(f);if(!card)for(const id of f.source_ids){suppressedSources.add(id);redactedSources.add(id);}f.state='erased';f.content='';f.value='';f.vector=null;f.source_quotes=[];f.entities=[];f.revision=revision;this.put(f);changed=true;}
      }}
      for(const m of inserted){if(markers.some(marker=>containsValue(m.content,marker)||(marker.phraseTokens?.length?echoMentions(m.content,marker.phraseTokens):false))){suppressedSources.add(m.id);redactedSources.add(m.id);}}
      if(prepared.operations.some(o=>o.type==='forget')){
        // Old assistant echoes have no fact links. They must not remain raw
        // searchable evidence or return through the next session's tail. This
        // marker-driven sweep is deterministic and applies to every write
        // mode: an offline forget erases echoes just as finally.
        for(const row of this.db.prepare('SELECT body FROM messages').all() as Row[]){const m=JSON.parse(row.body) as StoredMessage;if(markers.some(marker=>containsValue(m.content,marker)||(marker.phraseTokens?.length?echoMentions(m.content,marker.phraseTokens):false))){suppressedSources.add(m.id);redactedSources.add(m.id);}}
      }
      if(sourceErasure){
        // A short nonlexical value may have no model candidate; its authorized
        // target/source span and command still have deterministic deletion proof.
        // Historical erasures already committed their reviewed partial cuts.
        // Reapplying their original broad spans could erase preserved neighbors.
        // Keep historical IDs in dependency propagation, but only newly erased
        // facts can trigger this transaction's deterministic source fallback.
        for(const f of this.facts().filter(f=>f.state==='erased'&&!priorErasedIds.has(f.id)))for(const span of f.source_spans??[]){
          if(!reviewedSources.has(span.source_id))sourceCuts.set(span.source_id,[...(sourceCuts.get(span.source_id)??[]),{start:span.start,end:span.end}]);
        }
        for(const o of prepared.operations.filter(o=>o.type==='forget')){const m=prepared.messages[o.source.index];if(m&&!reviewedSources.has(m.id)){const start=m.content.indexOf(o.source.quote);if(start>=0)sourceCuts.set(m.id,[...(sourceCuts.get(m.id)??[]),{start,end:start+o.source.quote.length}]);}}
        const originals=new Map((this.db.prepare('SELECT body FROM messages').all() as Row[]).map(r=>{const m=JSON.parse(r.body) as StoredMessage;return [m.id,m] as const;}));
        validateRetainedValueContexts(prepared.erasurePlan,sourceCuts,erasedIds);
        assertErasedWitnessProgress(sourceWitnesses,originals,sourceCuts,erasedIds);
        for(const f of all.filter(f=>f.state!=='erased')){
          const quotes:string[]=[];
          for(const q of f.source_quotes){let located=false;
            for(const id of f.source_ids){const m=originals.get(id);if(!m)continue;
              for(let start=m.content.indexOf(q);start>=0;start=m.content.indexOf(q,start+Math.max(1,q.length))){located=true;const safe=maskSource(q,sourceCuts.get(id)??[],start).trim();if(safe)quotes.push(safe);}
            }if(!located)quotes.push(q);
          }
          if(f.source_quotes.length&&!quotes.length)throw new ServiceError('EVIDENCE_VALIDATION','Source erasure removed every witness for a retained fact');
          f.source_quotes=[...new Set(quotes)];this.put(f);
        }
      }
      // Retained neighbors must not carry a forgotten value inside a mixed quote.
      for(const f of all){
        if(f.state==='erased')continue;
        if(semanticErasure&&!sourceErasure){
          // Independence certifies only the witnessed clause, never a mixed
          // source quote which also repeats the erased neighbor.
          f.source_quotes=[...new Set(f.source_quotes.flatMap(q=>{
            const colliding=markers.filter(m=>containsValue(q,m));if(!colliding.length)return [q];
            const safe=(f.erasure_exemptions??[]).filter(x=>colliding.some(m=>boundaryKey(m)===x.key)&&q.includes(x.quote)).map(x=>x.quote);
            return safe.filter(w=>colliding.every(m=>!containsValue(w,m)||f.erasure_exemptions?.some(x=>x.key===boundaryKey(m)&&x.quote===w)));
          }))];this.put(f);
        }
        const quotes=sourceErasure?f.source_quotes:f.source_quotes.filter(q=>{
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
          if(sourceErasure&&reviewedSources.has(p.source_id)){}
          else if(spans.length)redactPassage(p,spans);else{p.fragments=[];p.content='';p.vector=null;p.state='erased';}
        }
        p.fact_ids=p.fact_ids.filter(id=>!erased.some(f=>f.id===id));
        if(sourceErasure)redactPassage(p,sourceCuts.get(p.source_id)??[]);
        // Even unextracted echoes must not reintroduce a forgotten literal. A
        // different scoped record needs positively linked surviving facts.
        const linked=p.fact_ids.map(id=>byId.get(id)).filter((f):f is Fact=>!!f);
        if(semanticErasure&&!sourceErasure&&markers.some(m=>containsValue(p.content,m))){
          // Every occurrence needs its own independently witnessed original
          // span. Remove unprotected literal echoes, not unrelated unextracted
          // neighbors. Whole erased fact spans were already removed above.
          const cuts=p.fragments.flatMap(fragment=>markers.flatMap(m=>{
            const quotes=linked.flatMap(f=>f.erasure_exemptions??[]).filter(x=>x.key===boundaryKey(m)).map(x=>x.quote);
            const safe=quotes.flatMap(q=>{const spans:{start:number;end:number}[]=[];for(let i=fragment.text.indexOf(q);i>=0;i=fragment.text.indexOf(q,i+Math.max(1,q.length)))spans.push({start:i,end:i+q.length});return spans;});
            return valueOccurrences(fragment.text,m).filter(v=>!safe.some(s=>s.start<=v.start&&s.end>=v.end)).map(v=>({start:fragment.start+v.start,end:fragment.start+v.end}));
          }));
          redactPassage(p,cuts);
        }
        if(!semanticErasure&&markers.some(m=>(containsValue(p.content,m)||(m.phraseTokens?.length?echoMentions(p.content,m.phraseTokens):false))&&(!linked.length||linked.some(f=>markerConcerns(m,f)&&!(m.allowedValueHashes??[]).includes(valueDigest(f.value)))))){
          p.fragments=[];p.content='';p.vector=null;p.state='erased';
        }
        if(newPassageIds.has(p.id)||JSON.stringify(p)!==previous){p.revision=revision;this.putPassage(p);}
      }
      if(sourceErasure)for(const id of sourceCuts.keys())suppressedSources.add(id);
      for(const sourceId of suppressedSources){
        const row=this.db.prepare('SELECT body FROM messages WHERE id=?').get(sourceId) as Row|undefined;if(!row)continue;
        const m=JSON.parse(row.body) as StoredMessage;
        // Reflection cards are derived fact-layer evidence whose source unions
        // span member messages: the message layer's redaction bookkeeping skips
        // them entirely, so a card (committed, erased or otherwise) can never
        // cause a member message to be redacted or rewritten.
        m.searchable=!!m.partial&&all.filter(f=>f.kind!=='reflection'&&f.source_ids.includes(sourceId)).every(f=>f.state==='active'||f.state==='conflicted')&&!prepared.operations.some(o=>prepared.messages[o.source.index]?.id===sourceId);
        if(sourceErasure){
          const cuts=sourceCuts.get(sourceId)??[];
          if(cuts.length){m.content=maskSource(m.content,cuts);m.redacted=true;m.partial=true;m.searchable=/[\p{L}\p{N}]/u.test(m.content);}
        }else if(redactedSources.has(sourceId) || all.some(f=>f.state==='erased'&&f.kind!=='reflection'&&f.source_ids.includes(sourceId)) || prepared.operations.some(o=>o.type==='forget'&&prepared.messages[o.source.index]?.id===sourceId)){
          m.redacted=true;m.searchable=false;m.content=all.filter(f=>(f.state==='active'||f.state==='conflicted')&&f.kind!=='reflection'&&f.source_ids.includes(sourceId)).map(f=>f.content).join('\n') || '[Memory content removed]';
        }
        this.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(m),sourceId);
      }
      // Event records refer to state IDs; they never copy before/after values.
      const events:MemoryEvent[]=[];
      const current=new Map(this.facts().map(f=>[f.id,f]));
      const event=(type:MemoryEvent['type'],f:Pick<Fact,'subject'|'predicate'|'scope'|'content'>,sourceIds:string[],beforeIds:string[],afterIds:string[],position=0,actor:MemoryEvent['actor']='observation',descriptor?:string):void=>{
        const source=inserted.filter(m=>sourceIds.includes(m.id)).sort((a,b)=>a.ordinal-b.ordinal)[0];if(!source)return;
        events.push({id:'event-'+digest(`${req.user_id}\0${req.request_id}\0${events.length}`),type,actor,category:eventCategory(f),slot_hash:digest(slot(f)),source_ids:sourceIds,before_ids:beforeIds,after_ids:afterIds,ordinal:source.ordinal*10000000+position,observed_at:source.timestamp!,time_basis:source.time_basis??'source',revision,...(descriptor?{descriptor}:{})});
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
        // "What did I ask you to remove?" is answerable only if the trace
        // names the removed category in the user's own words, value-free.
        const tracePhrase=o.type==='forget'&&o.value?valueWords(o.value):[];
        const traceDescriptor=o.type==='forget'&&o.reason&&o.reason.length<=40&&!(tracePhrase.length&&mentionsTokens(o.reason,tracePhrase))?o.reason:undefined;
        event(o.type,{...o,content:original?.content??''},[source.id],ids,after,source.content.indexOf(o.source.quote),source.role==='user'?'user':'participant',traceDescriptor);
        this.db.prepare('INSERT INTO operations(body) VALUES (?)').run(JSON.stringify({type:o.type,target_ids:ids,subject:o.subject,predicate:o.predicate,scope:'',scopeHash:scopeKey(o),boundary:o.boundary,source_id:source.id,revision}));
      }
      if(sourceActions)for(const d of sourceActions.plan.decisions.filter(d=>d.action==='reject_source')){
        const instruction=sourceActions.work.instructions[d.instruction]!,source=inserted[instruction.message]!;
        event('forget',{subject:'user',predicate:'rejected assistant assertion',scope:'source',content:''},[source.id],[],[],instruction.start,'user');
        this.db.prepare('INSERT INTO operations(body) VALUES (?)').run(JSON.stringify({type:'reject_source',source_id:source.id,target_ids:d.target_slots.map(i=>sourceActions.work.sources[i]!.id),revision}));
      }
      for(const e of events)this.db.prepare('INSERT INTO memory_events VALUES (?,?)').run(e.id,JSON.stringify(e));
      if(coveragePrepared)assertSourceCoverageStored(prepared.sourceCoveragePlan!,req,coveragePrepared,this.passages(),new Set((this.db.prepare('SELECT id FROM passage_fts').all() as {id:string}[]).map(x=>x.id)),coverageErasureCuts);
      if(failAt==='indexes')throw new ServiceError('INJECTED_FAILURE','Fault injection after index writes');
      const receipt:Receipt={success:true,request_id:req.request_id,user_id:req.user_id,session_id:req.session_id};
      this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(req.request_id,payloadHash,JSON.stringify(receipt));this.setMeta('revision',String(revision));this.preparation.committed(req.request_id);return receipt;
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
