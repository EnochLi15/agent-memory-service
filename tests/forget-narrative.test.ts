import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Extractor,hash} from '../dist/extraction.js';
import {TenantStore} from '../dist/storage.js';
import {configFromEnv} from '../dist/config.js';

// The four official MemOps narrative-forget shapes that previously produced
// no operation at all (intent=none) or leaked rewritten echoes.
const config=configFromEnv({MEMORY_MODE:'offline'});
const extractor=new Extractor(config,{} as any);
const dir=()=>mkdtempSync(join(tmpdir(),'narrative-forget-'));
const req=(id:string,messages:{role:string;content:string}[])=>({request_id:id,user_id:'u',session_id:'s',messages:messages.map((m,i)=>({...m,timestamp:`2026-01-0${(i%9)+1}T00:00:00Z`}))});

async function fixture(script:{role:string;content:string}[][]){
  const d=dir();const store=new TenantStore(d,'u');
  for(const [i,messages] of script.entries()){
    const r=req(`r${i}`,messages);
    store.commit(r,hash(JSON.stringify(r)),await extractor.prepare(r,store.snapshot('s'),AbortSignal.timeout(1000)),store.revision());
  }
  return {store,done:()=>{store.close();rmSync(d,{recursive:true,force:true});}};
}

test('A04: "please forget the Tucson detail" erases Tucson, keeps Portland via the retention clause, and records a value-free descriptor',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'I used to live in Tucson before I moved here.'}],
    [{role:'user',content:'My current city is Portland.'}],
    [{role:'user',content:'Actually, now that I think about it — please forget the Tucson detail — I don\'t want my previous city stored anymore. I\'m trying to move on from that chapter and I don\'t need it coming up in our conversations. Everything else about Portland should stay, just remove the Tucson part.'}],
  ]);
  try{
    assert.ok(store.facts().filter(f=>/tucson/i.test(`${f.content} ${f.value}`)).every(f=>f.state==='erased'),'every Tucson record is erased');
    const portland=store.facts().find(f=>f.predicate==='current_city');
    assert.ok(portland);assert.equal(portland.state,'active','the retention clause keeps Portland');
    const trace=store.events().find(e=>e.type==='forget'&&e.descriptor==='previous city');
    assert.ok(trace,'the forget trace names the removed category value-free');
    assert.equal(store.events().filter(e=>e.type==='forget').length,2,'both command sentences executed');
  }finally{done();}
});

test('A02: "you can go ahead and remove him" erases the stale work record but keeps the same-message transfer update',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'My manager is David Lam at Meridian.'}],
    [{role:'user',content:'David Lam actually transferred out of Meridian last week. He moved to a firm in Vancouver. So you can go ahead and remove him from my work contacts or anything you have on him.'}],
  ]);
  try{
    assert.equal(store.facts().find(f=>f.predicate==='manager')?.state,'erased','the stale work record is erased');
    const transfer=store.facts().find(f=>/transferred out of Meridian/i.test(f.content));
    assert.ok(transfer);assert.equal(transfer.state,'active','the transfer news survives the removal');
    const vancouver=store.facts().find(f=>/firm in Vancouver/i.test(f.content));
    assert.ok(vancouver);assert.equal(vancouver.state,'active','the same-message update stays memorable');
  }finally{done();}
});

test('A07: "you can discard the cetirizine detail entirely" erases the medication but keeps the doctor-switch news told alongside',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'I take cetirizine for my allergies every day.'}],
    [{role:'user',content:'Well, his doctor switched him to a new medication a couple weeks ago, so you can discard the cetirizine detail entirely.'}],
  ]);
  try{
    assert.ok(store.facts().filter(f=>/cetirizine/i.test(`${f.content} ${f.value}`)).every(f=>f.state==='erased'),'the cetirizine record is erased');
    const news=store.facts().find(f=>/doctor switched/i.test(f.content));
    assert.ok(news);assert.equal(news.state,'active','the narrative prefix before the command is retained');
  }finally{done();}
});

test('B04: a rewritten echo of a forgotten phrase cannot re-enter as a later fact or searchable message',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'We brought on three new hires at B04 last quarter.'}],
    [{role:'user',content:'So specifically, please forget the detail about how many new hires B04 brought on last quarter, I don\'t need that stored anymore.'}],
    [{role:'user',content:'Like I said before, we added three new hires last quarter.'}],
  ]);
  try{
    assert.ok(store.facts().filter(f=>/new hires/i.test(`${f.content} ${f.value}`)).every(f=>f.state!=='active'),'no active record still carries the forgotten hiring count');
    const tail=store.snapshot('s').tail;
    assert.equal(tail.length,3,'all three messages are in the session tail');
    assert.equal(tail[1]!.searchable,false,'the command message itself is suppressed');
    assert.equal(tail[2]!.searchable,false,'the rewritten replay message is suppressed');
    assert.ok(tail[2]!.content.includes('removed'),'the replay message content is redacted');
  }finally{done();}
});

// The residual command shapes that previously 503'd atomically: an emphatic
// tail restating a bound command, a numbered retirement echo, an unwrapped
// definite phrase, and a procedural imperative that is not a command at all.
test('B22: an emphatic tail with a numeric echo mirrors the same-message command instead of failing unbound',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'Sarah Chen: My salary is $58,500 per year.'}],
    [{role:'user',content:'Please go ahead and forget Sarah\'s salary information. The $58,500 figure, just remove it entirely.'}],
  ]);
  try{
    assert.equal(store.facts().find(f=>f.predicate==='salary')?.state,'erased','the salary record is erased');
    assert.equal(store.events().filter(e=>e.type==='forget').length,2,'both the command and its restatement executed');
  }finally{done();}
});

test('A28: "Just remove all of that." restates the bound Mehta command and must not reject the write',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'My former advisor is Professor Anil Mehta.'}],
    [{role:'user',content:'Please forget the information about Professor Anil Mehta. Just remove all of that.'}],
  ]);
  try{
    // Erased records are wiped, so locate them by slot, not by content.
    const experiences=store.facts().filter(f=>f.subject==='user'&&f.predicate==='experience');
    assert.ok(experiences.length>0,'the advisor record exists');
    assert.ok(experiences.every(f=>f.state!=='active'),'the advisor record is erased');
  }finally{done();}
});

test('C01: a retirement sentence echoing the erased target\'s number mirrors the same-message command',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'I got a quote from BrightFix Home Services for $240 to install the bathroom fan.'}],
    [{role:'user',content:'I also love hiking on weekends with the trail club.'}],
    [{role:'user',content:'You can forget the BrightFix quote entirely. I\'m doing this myself now, so I don\'t need that $240 figure stored anymore.'}],
  ]);
  try{
    const experiences=store.facts().filter(f=>f.subject==='user'&&f.predicate==='experience');
    assert.equal(experiences.filter(f=>f.state==='erased').length,1,'exactly the quote record is erased');
    assert.ok(experiences.some(f=>/hiking/i.test(f.content)&&f.state==='active'),'the unrelated preference stays active');
    assert.ok(store.facts().every(f=>!/BrightFix/i.test(`${f.content} ${f.value}`)),'no visible record still names the erased vendor');
  }finally{done();}
});

test('A26: an unwrapped definite phrase ("the L6 comp band floor") binds by phrase as a last chance before rejection',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'Sarah Chen: The L6 comp band floor for our team is $210,000.'}],
    [{role:'user',content:'My salary is $145,000.'}],
    [{role:'user',content:'Please forget the L6 comp band floor I mentioned.'}],
  ]);
  try{
    assert.equal(store.facts().find(f=>f.subject==='Sarah Chen')?.state,'erased','the band record is erased');
    assert.equal(store.facts().find(f=>f.predicate==='salary')?.state,'active','the user\'s own salary survives the retention intent');
  }finally{done();}
});

test('B14: a recipe direction ("Remove from heat") is procedural, not a retirement command',async()=>{
  const {store,done}=await fixture([
    [{role:'user',content:'I\'m definitely going to make this recipe for my next dinner party.'}],
    [{role:'user',content:'The recipe says the following. Remove from heat and let cool completely. Then dust with cocoa powder.'}],
  ]);
  try{
    assert.equal(store.events().filter(e=>e.type==='forget').length,0,'a cooking direction never executes a forget');
    assert.ok(store.facts().some(f=>f.state==='active'),'the recipe note stays stored');
  }finally{done();}
});
