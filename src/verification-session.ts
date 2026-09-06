import {createHash} from 'node:crypto';
import {ServiceError,type AddRequest,type Extraction,type Fact} from './types.js';
import {forgetScopeContext,participantIndices,verificationIssues,VerificationProtocolError,type VerificationScope} from './verification.js';
import type {SourceCoverageWork,SourceCoverageRow} from './source-coverage.js';

const arrays=['fact_checks','operation_checks','replacement_checks','message_checks'] as const;
type CheckArray=typeof arrays[number];
type Check=Record<string,any>;
type Checks=Record<CheckArray,Check[]>;
const empty=():Checks=>({fact_checks:[],operation_checks:[],replacement_checks:[],message_checks:[]});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rawWitnessKey=({slot:_,...witness}:SourceCoverageWork['candidates'][number])=>digest(witness);
const checkKey=(type:CheckArray,c:Check)=>type==='replacement_checks'?`${type}:${c.fact_index}:${c.target_id}`:`${type}:${c.index}`;
// A fact's exact proposition, sources and transitive evidence define its
// certificate. Its array position may move when an unrelated fact is removed.
// Operations, replacements and message coverage retain their stricter keys.
const certificateKey=(key:string,fingerprint:string)=>key.startsWith('fact_checks:')?`fact_checks:${fingerprint}`:key;
type Plan={scope:VerificationScope;cached:Checks;fingerprints:Map<string,string|null>;blockedFindings:string[];req:AddRequest;proposal:Extraction;reused:number;sourceCoverage?:SourceCoverageWork};

/** Owned by one prepare() call, never kept on the shared Models instance.
 * Only validated checks become certificates. Semantic failures remain failures
 * until their evidence fingerprint changes; they cannot be favorably resampled. */
export class VerificationSession {
 constructor(private readonly reusePassed=true){}
 #context='';
 #passed=new Map<string,{fingerprint:string;check:Check;rawKeys?:string[]}>();
 #failed=new Map<string,{fingerprint:string;finding:string}>();
 #active:Plan|undefined;
 #accepted:{fingerprint:string;rows:SourceCoverageRow[]}|undefined;

 plan(req:AddRequest,proposal:Extraction,facts:Fact[],identity:unknown,sourceCoverage?:SourceCoverageWork):Plan{
  this.#accepted=undefined;
  // Candidate slot numbers can shift when an unrelated message is repaired.
  // Bind coverage per message below; numbering is not a new semantic context.
  const context=digest({req,identity,sourceCoverage:!!sourceCoverage});
  if(context!==this.#context){this.#context=context;this.#passed.clear();this.#failed.clear();}
  const fingerprints=new Map<string,string|null>();
  const byId=new Map(facts.map(f=>[f.id,f]));
  const memo=new Map<string,string|null>(),visiting=new Set<string>();
  const reference=(id:string):string|null=>{
   if(memo.has(id))return memo.get(id)!;
   const fact=byId.get(id);if(!fact||visiting.has(id))return null;
   visiting.add(id);
   // Include sources, state, temporal metadata and revision, but not embeddings.
   const {vector,...semantic}=fact;
   const refs=[...fact.depends_on,...fact.supersedes].map(reference);
   const value=refs.some(x=>x===null)?null:digest({semantic,refs});
   visiting.delete(id);memo.set(id,value);return value;
  };
  const withReferences=(value:unknown,ids:string[]):string|null=>{
   const refs=ids.map(reference);return refs.some(x=>x===null)?null:digest({value,refs});
  };
  const factPrints=proposal.facts.map((f,index)=>{
   const value=withReferences(f,[...f.depends_on,...f.supersedes]);fingerprints.set(`fact_checks:${index}`,value);return value;
  });
  const opPrints=proposal.operations.map((o,index)=>{
   const related=proposal.facts.flatMap((f,i)=>f.sources.some(s=>s.index===o.source.index)||f.supersedes.some(id=>o.target_ids.includes(id))?[[i,factPrints[i]]]:[]);
   const value=related.some(x=>x[1]===null)?null:withReferences({operation:o,related},o.target_ids);fingerprints.set(`operation_checks:${index}`,value);return value;
  });
  const replacements=proposal.facts.flatMap((f,fact_index)=>f.supersedes.map(target_id=>{
   fingerprints.set(`replacement_checks:${fact_index}:${target_id}`,factPrints[fact_index]??null);return {fact_index,target_id};
  }));
  const forgetContext=new Map(forgetScopeContext(proposal,facts).map(c=>[c.message,c]));
  for(const index of participantIndices(req)){
   const factItems=proposal.facts.flatMap((f,i)=>f.sources.some(s=>s.index===index)?[[i,factPrints[i]]]:[]);
   const opItems=proposal.operations.flatMap((o,i)=>o.source.index===index?[[i,opPrints[i]]]:[]);
   const rawCandidates=sourceCoverage?.candidates.filter(c=>c.message===index).map(rawWitnessKey);
   fingerprints.set(`message_checks:${index}`,[...factItems,...opItems].some(x=>x[1]===null)?null:digest({message:req.messages[index],factItems,opItems,rawCandidates,forgetContext:forgetContext.get(index)}));
  }
  const rawSlots=new Map<string,number[]>();
  for(const candidate of sourceCoverage?.candidates??[]){
   const key=rawWitnessKey(candidate);rawSlots.set(key,[...(rawSlots.get(key)??[]),candidate.slot]);
  }
  const cached=empty(),needed=new Set<string>(),blockedFindings:string[]=[];
  for(const [key,fingerprint] of fingerprints){
   if(fingerprint===null){
    const [type,index]=key.split(':');const label=type==='fact_checks'?'fact':type==='operation_checks'?'operation':type==='message_checks'?'message':'replacement fact';
    blockedFindings.push(`${label} ${index}: Verification dependency evidence is missing or cyclic`);
   }
   const storedKey=fingerprint?certificateKey(key,fingerprint):key;
   const failed=this.#failed.get(storedKey);if(fingerprint&&failed?.fingerprint===fingerprint)blockedFindings.push(key.startsWith('fact_checks:')?failed.finding.replace(/^fact \d+:/,`fact ${key.split(':')[1]}:`):failed.finding);
   const passed=this.#passed.get(storedKey);
   if(this.reusePassed&&fingerprint&&passed?.fingerprint===fingerprint&&
      (passed.rawKeys??[]).every(k=>rawSlots.get(k)?.length===1)){
    const check=structuredClone(passed.check);
    if(key.startsWith('fact_checks:'))check.index=Number(key.split(':')[1]);
    if(passed.rawKeys?.length)check.raw_slots=passed.rawKeys.map(k=>rawSlots.get(k)![0]!);
    cached[key.split(':')[0] as CheckArray].push(check);
   }else needed.add(key);
  }
  const scope:VerificationScope={fact_indices:proposal.facts.flatMap((_,i)=>needed.has(`fact_checks:${i}`)?[i]:[]),operation_indices:proposal.operations.flatMap((_,i)=>needed.has(`operation_checks:${i}`)?[i]:[]),replacements:replacements.filter(c=>needed.has(`replacement_checks:${c.fact_index}:${c.target_id}`)),message_indices:participantIndices(req).filter(i=>needed.has(`message_checks:${i}`))};
  const plan:Plan={scope,cached,fingerprints,blockedFindings:[...new Set(blockedFindings)],req:structuredClone(req),proposal:structuredClone(proposal),reused:arrays.reduce((n,k)=>n+cached[k].length,0),sourceCoverage};
  this.#active=plan;return plan;
 }

 evaluate(plan:Plan,raw:unknown,protocolErrors:string[]=[]):string[]{
  if(this.#active!==plan)throw new ServiceError('EVIDENCE_VALIDATION','Verification session changed during an in-flight check');
  const merged=empty();
  if(!raw||typeof raw!=='object')throw new VerificationProtocolError('Missing structured verification arrays');
  for(const type of arrays){
   const values=(raw as Record<string,unknown>)[type];
   if(!Array.isArray(values))throw new VerificationProtocolError('Missing structured verification arrays');
   merged[type]=[...values,...plan.cached[type]];
  }
  let findings:string[];
  try{findings=verificationIssues(merged,plan.req,plan.proposal,plan.sourceCoverage);if(protocolErrors.length)throw new VerificationProtocolError(protocolErrors[0]!,findings);}
  catch(error){
   if(error instanceof VerificationProtocolError){
    // A malformed earlier array must not hide a valid rejection in a later
    // array. Validate each available check independently only on this error path.
    const failures=new Set(error.findings);
    for(const type of arrays)for(const check of merged[type]){
     const single=empty();single[type]=[check];
     try{for(const finding of verificationIssues(single,plan.req,plan.proposal,plan.sourceCoverage))failures.add(finding);}
     catch(partial){if(partial instanceof VerificationProtocolError)for(const finding of partial.findings)failures.add(finding);}
    }
    const findings=[...failures];this.rememberFailures(plan,findings);
    throw new VerificationProtocolError(error.message,findings);
   }
   // No positive certificate is created from a malformed protocol response.
   throw error;
  }
  const rejected=this.rememberFailures(plan,findings);
  const rejectedCertificates=new Set([...rejected].flatMap(key=>{const fp=plan.fingerprints.get(key);return fp?[certificateKey(key,fp)]:[];}));
  for(const type of arrays)for(const check of merged[type]){
   const key=checkKey(type,check),fingerprint=plan.fingerprints.get(key);
   if(fingerprint&&!rejectedCertificates.has(certificateKey(key,fingerprint))){
    const rawKeys=type==='message_checks'?(check.raw_slots??[]).map((slot:number)=>rawWitnessKey(plan.sourceCoverage!.candidates[slot]!)):undefined;
    const storedKey=certificateKey(key,fingerprint);
    this.#passed.set(storedKey,{fingerprint,check:structuredClone(check),rawKeys});this.#failed.delete(storedKey);
   }
  }
  if(!findings.length&&plan.sourceCoverage)this.#accepted={fingerprint:digest({req:plan.req,proposal:plan.proposal}),rows:structuredClone(merged.message_checks) as SourceCoverageRow[]};
  return findings;
 }

 acceptedSourceCoverage(req:AddRequest,proposal:Extraction):SourceCoverageRow[]{
  if(!this.#accepted||this.#accepted.fingerprint!==digest({req,proposal}))throw new ServiceError('EVIDENCE_VALIDATION','Source coverage lacks an accepted independent verification');
  return structuredClone(this.#accepted.rows);
 }

 private rememberFailures(plan:Plan,findings:string[]):Set<string>{
  const rejected=new Set<string>();
  for(const finding of findings){
   const match=finding.match(/^(fact|operation|replacement fact|message) (\d+):/);if(!match)continue;
   const type=match[1]==='fact'?'fact_checks':match[1]==='operation'?'operation_checks':match[1]==='message'?'message_checks':'replacement_checks';
   const prefix=`${type}:${match[2]}`;
   for(const [key,fingerprint] of plan.fingerprints){
    if(key!==prefix&&!(type==='replacement_checks'&&key.startsWith(prefix+':')))continue;
    rejected.add(key);
    const storedKey=fingerprint?certificateKey(key,fingerprint):key;this.#passed.delete(storedKey);
    if(fingerprint)this.#failed.set(storedKey,{fingerprint,finding});
   }
  }
  return rejected;
 }
}
