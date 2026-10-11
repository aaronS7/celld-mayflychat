// Catalog replica, inventory, availability and download behavior of the
// management plane. One celld harness serves every subtest (starts are slow).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { wikiHarness, post, page } from './wiki-test-helper.mjs';
import { identityProvider, login, admin, policy, setPolicy, action, settled, chat, managementVars, archiveFaults } from './management-test-helper.mjs';

// A control server that can take the catalog's /register endpoint down. While
// down, each registration hangs until the catalog is restored and then fails,
// so resource pushes hit their 5s timeout. Admin routes are never affected.
async function catalogControl(t){
  const state={down:false,held:[],registrations:0};
  const server=createServer((req,res)=>{
    state.registrations++;
    if(state.down)return state.held.push(()=>res.end(JSON.stringify({fail:true})));
    res.end(JSON.stringify({fail:false}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));state.origin='http://127.0.0.1:'+server.address().port;
  state.restore=()=>{state.down=false;for(const release of state.held.splice(0))release();};
  t.after(()=>{state.restore();server.closeAllConnections();server.close();});
  return state;
}
function catalogFaults(control){
  return async directory=>{
    const path=join(directory,'celld/native/management.ts'),source=await readFile(path,'utf8');
    const anchor="if (path === '/register' && request.method === 'PUT') {";
    assert.ok(source.includes(anchor),'catalog registration route moved; update the fault patch');
    await writeFile(path,source.replace(anchor,anchor+`if((await (await fetch('${control.origin}/catalog')).json()).fail)throw new Error('Injected catalog outage');`));
  };
}
const compose=(...patches)=>async directory=>{for(const patch of patches)await patch(directory);};
const elapsed=async run=>{const start=Date.now();const result=await run();return {result,ms:Date.now()-start};};
// Chat posts must name the current head; track it per chat.
async function say(c,text){
  c.head??=-1;
  const r=await c.request('/events?last='+c.head,post({nonce:randomBytes(12).toString('base64url'),from:'agent',text}));
  if(r.status===200)c.head=r.body.id;
  return r;
}
async function inventory(a,query={}){
  const all=[],pages=[];let after='';
  for(;;){
    const r=await a.api('resources?'+new URLSearchParams({...query,...(after?{after}:{})}));
    assert.equal(r.status,200,JSON.stringify(r.body));
    pages.push(r.body);all.push(...r.body.resources);
    if(!r.body.next)return {all,pages};
    after=r.body.next;
  }
}
const listed=async(a,r)=>(await inventory(a,{kind:r.kind})).all.find(x=>x.id===r.id);
async function until(check,ms,label){
  const deadline=Date.now()+ms;let last;
  for(;;){last=await check();if(last.ok)return last;assert.ok(Date.now()<deadline,label+': '+JSON.stringify(last.value));await delay(200);}
}

test('management catalog replica, inventory, availability and downloads',async t=>{
  const provider=await identityProvider(t),control=await catalogControl(t);
  const vars=managementVars(provider);
  const h=await wikiHarness(t,{...vars,configureSource:compose(archiveFaults(provider),catalogFaults(control))});
  const signed=await login(h,provider),a=await admin(h,signed.cookie).init();

  await t.test('inventory validates filters, filters by kind and state, and paginates with cursors',async()=>{
    assert.equal((await a.api('resources?kind=space')).status,400);
    assert.equal((await a.api('resources?kind=CHAT')).status,400);
    assert.equal((await a.api('resources?state=archived')).status,400);
    assert.equal((await a.api('resources?state=active&kind=bogus')).status,400);
    const wikis=[];for(let i=0;i<3;i++){const w=await h.create('Inventory '+i);w.kind='wiki';wikis.push(w);}
    const chats=[];const queue=Array.from({length:55},(_,i)=>i);
    await Promise.all(Array.from({length:4},async()=>{while(queue.length){queue.pop();chats.push(await chat(h));}}));
    const gone=chats[0];await action(a,gone,'delete');await settled(a,gone,'deleted');
    const created=new Set([...wikis,...chats].map(r=>r.kind+':'+r.id));
    // Registration is a background push; wait until the replica has caught up.
    await until(async()=>{const {all}=await inventory(a);const keys=new Set(all.map(r=>r.kind+':'+r.id));const missing=[...created].filter(k=>!keys.has(k));const deleted=all.find(r=>r.id===gone.id)?.state==='deleted';return {ok:!missing.length&&deleted,value:{missing,deleted}};},20000,'catalog registration');
    const {all,pages}=await inventory(a);
    assert.ok(pages.length>=2);
    for(const p of pages.slice(0,-1)){assert.equal(p.resources.length,50);assert.equal(p.next,p.resources[49].kind+':'+p.resources[49].id);}
    assert.ok(pages.at(-1).resources.length<=50);assert.equal(pages.at(-1).next,null);
    const keys=all.map(r=>r.kind+':'+r.id);
    assert.equal(new Set(keys).size,keys.length,'no duplicates across pages');
    assert.deepEqual(keys,[...keys].sort(),'pages are ordered by key');
    for(const key of created)assert.ok(keys.includes(key),key);
    // Every listed record carries computed deadlines alongside the replica.
    assert.ok(all.every(r=>'expires_at' in r&&'idle_at' in r&&'age_at' in r));
    // after resumes exactly after the cursor, including a cursor taken mid-page.
    const second=await a.api('resources?after='+encodeURIComponent(pages[0].next));
    assert.deepEqual(second.body.resources.map(r=>r.id),pages[1].resources.map(r=>r.id));
    const mid=await a.api('resources?after='+encodeURIComponent(keys[9]));
    assert.deepEqual(mid.body.resources.map(r=>r.kind+':'+r.id),keys.slice(10,60));
    const past=await a.api('resources?after='+encodeURIComponent(keys.at(-1)));
    assert.deepEqual(past.body,{resources:[],next:null});

    const chatPages=await inventory(a,{kind:'chat'});
    assert.ok(chatPages.pages.length>=2,'kind filter paginates');assert.equal(chatPages.pages[0].resources.length,50);
    assert.ok(chatPages.all.every(r=>r.kind==='chat'));
    assert.equal(chatPages.all.length,keys.filter(k=>k.startsWith('chat:')).length);
    const wikiPages=await inventory(a,{kind:'wiki'});
    assert.ok(wikiPages.all.every(r=>r.kind==='wiki'));
    assert.equal(wikiPages.pages.length,1);assert.equal(wikiPages.pages[0].next,null);
    for(const w of wikis)assert.ok(wikiPages.all.some(r=>r.id===w.id));

    const deleted=(await inventory(a,{state:'deleted'})).all;
    assert.ok(deleted.some(r=>r.id===gone.id));assert.ok(deleted.every(r=>r.state==='deleted'));
    const active=(await inventory(a,{state:'active'})).all;
    assert.ok(active.every(r=>r.state==='active'));assert.ok(!active.some(r=>r.id===gone.id));
    assert.ok(chats.slice(1).every(c=>active.some(r=>r.id===c.id)));
    const both=(await inventory(a,{kind:'wiki',state:'deleted'})).all;
    assert.ok(!both.some(r=>r.id===gone.id));assert.ok(both.every(r=>r.kind==='wiki'&&r.state==='deleted'));
    assert.deepEqual((await a.api('resources?kind=chat&state=restoring')).body,{resources:[],next:null});
  });

  await t.test('catalog outages never block content or policy, and the outbox catches up',async()=>{
    const c1=await chat(h),c2=await chat(h),c3=await chat(h),w1=await h.create('Catalog outage');w1.kind='wiki';
    assert.equal((await say(c1,'before')).status,200);assert.equal((await say(c2,'before')).status,200);
    // Healthy catalog: state and policy changes reach the inventory promptly.
    let start=Date.now();await setPolicy(a,c1,policy(3600,null));
    await until(async()=>{const r=await listed(a,c1);return {ok:r?.policy.idle_seconds===3600,value:r};},3000,'policy change within 3s');
    t.diagnostic(`healthy policy push visible after ${Date.now()-start}ms`);
    const doomed=await chat(h);await until(async()=>({ok:!!await listed(a,doomed),value:null}),3000,'registration');
    start=Date.now();await action(a,doomed,'delete');
    await until(async()=>{const r=await listed(a,doomed);return {ok:r?.state==='deleted',value:r};},3000,'state change within 3s');
    t.diagnostic(`healthy state push visible after ${Date.now()-start}ms`);
    // Reads never advance idle time; activity-only writes wait for the alarm.
    const quiet=(await a.api('resources/chat/'+c2.id)).body;
    await delay(50);assert.equal((await c2.request('/events?since=-1&wait=0')).status,200);assert.equal((await c2.request('/links')).status,200);
    assert.equal((await a.api('resources/chat/'+c2.id)).body.last_activity_at,quiet.last_activity_at);
    const replicaBefore=await listed(a,c2);
    await delay(50);assert.equal((await say(c2,'activity only')).status,200);
    const advanced=(await a.api('resources/chat/'+c2.id)).body;assert.ok(advanced.last_activity_at>quiet.last_activity_at);
    await delay(500);assert.equal((await listed(a,c2)).last_activity_at,replicaBefore.last_activity_at,'activity is not pushed per write');

    control.down=true;const before=control.registrations;
    const stale={c1:await listed(a,c1),w1:await listed(a,w1)};
    // Policy edits go through the catalog DO's admin routes, which stay up.
    const p1=await elapsed(()=>setPolicy(a,c1,policy(7200,null)));
    const p2=await elapsed(()=>setPolicy(a,w1,policy(null,7200)));
    assert.ok(p1.ms<3000&&p2.ms<3000,`policy edits took ${p1.ms}ms and ${p2.ms}ms`);
    // Both resources now have state-level dirty records whose pushes hang; content stays fast.
    for(const [resource,write] of [[c1,()=>say(c1,'during outage')],[c2,()=>say(c2,'during outage')],[w1,()=>w1.request('/pages',post(page('Outage','written while the catalog is down')))],[c1,()=>say(c1,'again')]]){
      const {result,ms}=await elapsed(write);
      assert.ok([200,201].includes(result.status),JSON.stringify(result.body));
      assert.ok(ms<3000,`${resource.kind} write took ${ms}ms during the catalog outage`);
    }
    const reads=await elapsed(()=>w1.request('/pages'));assert.equal(reads.result.status,200);assert.ok(reads.ms<3000,`wiki read took ${reads.ms}ms`);
    await action(a,c3,'delete');await settled(a,c3,'deleted');
    const truth={c1:(await a.api('resources/chat/'+c1.id)).body,c2:(await a.api('resources/chat/'+c2.id)).body,w1:(await a.api('resources/wiki/'+w1.id)).body};
    assert.equal(truth.c1.policy.idle_seconds,7200);assert.equal(truth.w1.policy.age_seconds,7200);
    await until(async()=>({ok:control.registrations>before,value:control.registrations}),10000,'registration attempted during outage');
    // The replica is stale while the catalog is down.
    assert.equal((await listed(a,c1)).policy_version,stale.c1.policy_version);
    assert.equal((await listed(a,w1)).policy_version,stale.w1.policy_version);
    assert.equal((await listed(a,c3)).state,'active');

    // Restore without touching the resources: only their alarms can push.
    control.restore();start=Date.now();
    await until(async()=>{
      const r={c1:await listed(a,c1),c2:await listed(a,c2),c3:await listed(a,c3),w1:await listed(a,w1)};
      const ok=r.c1.policy_version===truth.c1.policy_version&&r.c1.last_activity_at===truth.c1.last_activity_at
        &&r.w1.policy_version===truth.w1.policy_version&&r.w1.last_activity_at===truth.w1.last_activity_at
        &&r.c2.last_activity_at===truth.c2.last_activity_at&&r.c3.state==='deleted';
      return {ok,value:{replica:r,truth}};
    },50000,'catalog caught up after restore');
    t.diagnostic(`catalog caught up ${Date.now()-start}ms after restore`);
    // Prompt pushes resume once the catalog is healthy.
    start=Date.now();await setPolicy(a,w1,policy(null,null));
    await until(async()=>{const r=await listed(a,w1);return {ok:r.policy.age_seconds===null,value:r};},3000,'prompt push after restore');
  });

  let archived;
  await t.test('archiving holds writes with 423; TTL expiry and overdue writes return 410',async()=>{
    const c=await chat(h);assert.equal((await say(c,'before archive')).status,200);
    provider.holdReads=true;
    try {
      await action(a,c,'archive');
      const deadline=Date.now()+10000;while(!provider.held.length){assert.ok(Date.now()<deadline,'archive read never reached storage');await delay(50);}
      const write=await say(c,'during archive');assert.equal(write.status,423,JSON.stringify(write.body));
      assert.equal((await c.request('/events?since=-1&wait=0')).status,423);
      assert.equal((await a.api('resources/chat/'+c.id)).body.state,'archiving');
    } finally { provider.holdReads=false;for(const release of provider.held.splice(0))release(); }
    archived=await settled(a,c,'active',true);archived.chat=c;
    assert.equal((await say(c,'after archive')).status,200);
    assert.deepEqual((await c.request('/events?since=-1&wait=0')).body.events.map(e=>e.text),['before archive','after archive']);

    // A TTL archive in progress is expiring, not temporarily locked.
    const w=await h.create('Expiring');w.kind='wiki';
    provider.holdReads=true;
    try {
      await setPolicy(a,w,policy(null,1,true));
      const deadline=Date.now()+10000;while(!provider.held.length){assert.ok(Date.now()<deadline,'TTL archive read never reached storage');await delay(50);}
      assert.equal((await a.api('resources/wiki/'+w.id)).body.state,'expiring');
      const late=await w.request('/pages',post(page('Late')));assert.equal(late.status,410,JSON.stringify(late.body));
    } finally { provider.holdReads=false;for(const release of provider.held.splice(0))release(); }
    await settled(a,w,'deleted',true);

    // Idle deadline passed: writes are refused as gone, never as locked.
    const idle=await chat(h);await setPolicy(a,idle,policy(1,null));await delay(1200);
    const overdue=await say(idle,'too late');assert.equal(overdue.status,410,JSON.stringify(overdue.body));
  });

  await t.test('archive downloads require a session and a known archive id',async()=>{
    assert.ok(archived,'requires the archive subtest');
    const c=archived.chat,id=archived.latest_archive.id,base=h.base+'/admin/api/resources/chat/'+c.id+'/download';
    const get=(query,cookie=signed.cookie)=>fetch(base+query,{headers:cookie?{Cookie:cookie}:{}});
    assert.equal((await get('?archive_id='+id,null)).status,401);
    assert.equal((await get('?archive_id='+id,'mayfly_admin=invented')).status,401);
    assert.equal((await get('')).status,404);
    assert.equal((await get('?archive_id=')).status,404);
    assert.equal((await get('?archive_id='+crypto.randomUUID())).status,404);
    const other=await chat(h);
    assert.equal((await fetch(h.base+'/admin/api/resources/chat/'+other.id+'/download?archive_id='+id,{headers:{Cookie:signed.cookie}})).status,404,'archive ids are scoped to their resource');
    const r=await get('?archive_id='+id);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('content-type'),'application/x-tar');
    const disposition=r.headers.get('content-disposition');
    assert.ok(disposition.startsWith('attachment;'),disposition);assert.ok(disposition.includes(id),disposition);
    const tar=Buffer.from(await r.arrayBuffer());
    assert.equal(tar.length%512,0);
    assert.equal(tar.subarray(0,100).toString('latin1').replace(/\0+$/,''),'manifest.json');
    assert.equal(tar.subarray(257,262).toString('latin1'),'ustar');
    const size=parseInt(tar.subarray(124,135).toString('latin1'),8),manifest=JSON.parse(tar.subarray(512,512+size).toString('utf8'));
    assert.equal(manifest.archive_id,id);assert.equal(manifest.resource.id,c.id);
  });
});
