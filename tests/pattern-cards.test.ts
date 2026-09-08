import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildServer} from '../dist/server.js';import {TenantStore} from '../dist/storage.js';import {configFromEnv} from '../dist/config.js';import type {Fact} from '../dist/types.js';

// Pattern cards (aggregate reflection layer): deterministic cross-session
// rollup of multiple-cardinality facts. Full e2e through the offline pipeline —
// the same code path serves the enhanced form, whose model stages never touch
// these directly-constructed cards.
const user='u';
const add=(app:any,request_id:string,content:string,session_id='s')=>app.inject({method:'POST',url:'/add',payload:{request_id,user_id:user,session_id,messages:[{role:'user',content,timestamp:'2026-01-02T03:04:05Z'}]}});
const search=(app:any,query:string)=>app.inject({method:'POST',url:'/search',payload:{query,user_id:user,top_k:100}});
const reflections=(dir:string):Fact[]=>new TenantStore(dir,user).facts().filter(f=>f.kind==='reflection');
async function withServer(env:Record<string,string>,run:(app:any,dir:string)=>Promise<void>):Promise<void>{
  const dir=mkdtempSync(join(tmpdir(),'pattern-cards-'));
  const app=await buildServer(configFromEnv({MEMORY_MODE:'offline',MEMORY_DATA_DIR:dir,MEMORY_EXPERIMENT_AGGREGATE:'true',...env}));
  try{await run(app,dir);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
}

test('hobbies accumulated across three adds surface as one card listing every value',async()=>{
  await withServer({},async(app,dir)=>{
    assert.equal((await add(app,'r1','I like hiking.','s1')).statusCode,200);
    assert.equal((await add(app,'r2','I enjoy rock climbing.','s2')).statusCode,200);
    assert.equal((await add(app,'r3','I love photography.','s3')).statusCode,200);
    const cards=reflections(dir);
    assert.equal(cards.filter(c=>c.state==='active').length,1,'exactly one active pattern card');
    const card=cards.find(c=>c.state==='active')!;
    // Values verbatim, deterministic order (sorted by canonical form).
    assert.equal(card.value,'hiking, photography, rock climbing');
    assert.ok(card.content.startsWith('[Aggregated pattern] user: hobby — hiking, photography, rock climbing'));
    assert.equal(card.modality,'inferred');assert.equal(card.cardinality,'multiple');
    assert.ok(card.depends_on.length>=3);
    // The reflection event fired: the ledger records the derived aggregation.
    assert.ok(new TenantStore(dir,user).events().some(e=>e.type==='reflection'));
    const response=await search(app,'list all my hobbies');
    assert.equal(response.statusCode,200);
    const items=JSON.parse(response.body).data as {content:string}[];
    const hit=items.find(i=>i.content.includes('[Aggregated pattern]'));
    assert.ok(hit,'card returned for a list query');
    for(const value of ['hiking','photography','rock climbing'])assert.ok(hit.content.includes(value),value);
  });
});

test('a repeated value keeps the family stable: no second card is produced',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    const before=reflections(dir);assert.equal(before.length,1);
    // Same value again: the member fact duplicate-merges and the family's
    // value set is unchanged, so card derivation is skipped entirely.
    assert.equal((await add(app,'r3','I like hiking.','s3')).statusCode,200);
    const after=reflections(dir);
    assert.equal(after.length,1);
    assert.equal(after[0]!.id,before[0]!.id);
    assert.equal(after[0]!.value,'hiking, rock climbing');
  });
});

test('a value-set change supersedes the old card; the stale card leaves current retrieval',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    const oldCard=reflections(dir)[0]!;
    await add(app,'r3','I love painting.','s3');
    const cards=reflections(dir);
    assert.equal(cards.length,2,'old superseded row + new card');
    const active=cards.filter(c=>c.state==='active');
    assert.equal(active.length,1);
    assert.equal(active[0]!.value,'hiking, painting, rock climbing');
    assert.deepEqual(active[0]!.supersedes,[oldCard.id]);
    assert.equal(cards.find(c=>c.id===oldCard.id)!.state,'superseded');
    const items=JSON.parse((await search(app,'list all my hobbies')).body).data as {content:string}[];
    assert.ok(items.some(i=>i.content.includes('painting')));
    assert.ok(!items.some(i=>i.content.includes('[Aggregated pattern]')&&!i.content.includes('painting')),'no stale card row');
  });
});

test('forgetting a member value erases the card on every retrieval path and the next add rebuilds it clean',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    await add(app,'r3','I love photography.','s3');
    assert.equal((await add(app,'r4','Forget that I like hiking.','s4')).statusCode,200);
    const store=new TenantStore(dir,user);
    // The card carried the deleted value and depends on the erased member:
    // propagation, not retrieval filtering, removes it.
    assert.ok(store.facts().every(f=>f.kind!=='reflection'||f.state==='erased'),'card erased');
    let items=JSON.parse((await search(app,'list all my hobbies')).body).data as {content:string}[];
    assert.ok(!items.some(i=>i.content.includes('[Aggregated pattern]')),'no card evidence after forget');
    assert.ok(!items.some(i=>i.content.includes('hiking')),'forgotten value absent everywhere');
    // The surviving members re-derive a clean card on the next content add.
    assert.equal((await add(app,'r5','I love painting.','s5')).statusCode,200);
    const active=reflections(dir).filter(c=>c.state==='active');
    assert.equal(active.length,1);
    assert.equal(active[0]!.value,'painting, photography, rock climbing');
    assert.ok(!active[0]!.content.includes('hiking'));
  });
});

test('an operation add never rewrites pattern cards',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    await add(app,'r3','My door code is 1234.','s3');
    const before=new TenantStore(dir,user).facts().find(f=>f.kind==='reflection');
    assert.ok(before,'card exists');
    assert.equal((await add(app,'r4','Forget my door code 1234.','s4')).statusCode,200);
    const after=new TenantStore(dir,user).facts().find(f=>f.id===before!.id);
    assert.deepEqual(after,before,'card byte-identical across an operation add');
  });
});

test('single-cardinality slots never aggregate and duplicate statements leave no dead depends_on',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I live in Boston.','s1');
    assert.equal(reflections(dir).length,0,'single slot produces no card');
    await add(app,'r2','I like hiking.','s2');
    await add(app,'r3','I like hiking.','s3');
    await add(app,'r4','I love photography.','s4');
    const cards=reflections(dir);
    assert.equal(cards.filter(c=>c.state==='active').length,1);
    const card=cards.find(c=>c.state==='active')!;
    assert.equal(card.value,'hiking, photography');
    const alive=new Set(new TenantStore(dir,user).facts().filter(f=>f.state==='active'||f.state==='conflicted').map(f=>f.id));
    assert.ok(card.depends_on.length>=2);
    for(const id of card.depends_on)assert.ok(alive.has(id),`depends_on ${id} survives commit (no dead representative)`);
    assert.ok(card.depends_on.every((id,i)=>card.depends_on.indexOf(id)===i),'one representative per distinct value');
  });
});

test('MEMORY_EXPERIMENT_REFLECTION=false hides cards from retrieval while keeping them stored',async()=>{
  await withServer({MEMORY_EXPERIMENT_REFLECTION:'false'},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    assert.equal(reflections(dir).filter(c=>c.state==='active').length,1,'card committed');
    const items=JSON.parse((await search(app,'list all my hobbies')).body).data as {content:string}[];
    assert.ok(!items.some(i=>i.content.includes('[Aggregated pattern]')),'reflection gate filters the card');
    assert.ok(items.length>0,'member facts still retrievable');
  });
});

const messageRows=(dir:string):{content:string;redacted?:boolean}[]=>{const store=new TenantStore(dir,user);const rows=store.db.prepare('SELECT body FROM messages').all() as {body:string}[];store.close();return rows.map(r=>JSON.parse(r.body));};

test('forgetting one member redacts no sibling message (member-granular erasure)',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    assert.equal((await add(app,'r3','Forget that I like hiking.','s3')).statusCode,200);
    // The card dies with its member, but its source union spans the innocent
    // sibling: erasing that union would over-erase the sibling's raw message.
    const sibling=messageRows(dir).find(m=>m.content.includes('rock climbing'));
    assert.ok(sibling,'sibling message present');
    assert.ok(!sibling.redacted,'innocent sibling message stays unredacted');
    assert.equal(sibling.content,'I enjoy rock climbing.','raw message text untouched');
    assert.ok(!messageRows(dir).some(m=>m.content.includes('I like hiking')),'forgotten member message redacted away');
  });
});

test('an exact replay of a forgotten member resurrects nothing and hurts no sibling',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    await add(app,'r3','Forget that I like hiking.','s3');
    assert.equal((await add(app,'r4','I like hiking.','s4')).statusCode,200);
    assert.equal(reflections(dir).filter(c=>c.state==='active').length,0,'no card carries the replayed value');
    const items=JSON.parse((await search(app,'hiking')).body).data as {content:string}[];
    assert.equal(items.length,0,'replay cannot resurrect the forgotten value');
    const sibling=messageRows(dir).find(m=>m.content.includes('rock climbing'));
    assert.equal(sibling?.content,'I enjoy rock climbing.','sibling untouched by the replay');
  });
});

test('a restored member rejoins the family card on the next content add',async()=>{
  await withServer({},async(app,dir)=>{
    await add(app,'r1','I like hiking.','s1');
    await add(app,'r2','I enjoy rock climbing.','s2');
    await add(app,'r3','Forget that I like hiking.','s3');
    // Explicit reauthorization, then the value returns as a normal statement.
    assert.equal((await add(app,'r4','Remember that my hobby is hiking again.','s4')).statusCode,200);
    const store=new TenantStore(dir,user);
    const restored=store.facts().find(f=>f.value==='hiking');
    assert.ok(restored&&restored.state==='active','restored member is active again');
    store.close();
    assert.equal((await add(app,'r5','I love painting.','s5')).statusCode,200);
    const active=reflections(dir).filter(c=>c.state==='active');
    assert.equal(active.length,1,'family card re-derived');
    assert.equal(active[0]!.value,'hiking, painting, rock climbing');
    const sibling=messageRows(dir).find(m=>m.content.includes('rock climbing'));
    assert.equal(sibling?.content,'I enjoy rock climbing.','no derived text ever rewrites member messages');
  });
});
