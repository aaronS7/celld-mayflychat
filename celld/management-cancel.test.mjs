import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { wikiHarness, post, page } from './wiki-test-helper.mjs';
import { identityProvider, login, admin, policy, setPolicy, action, settled, chat, managementVars, archiveFaults } from './management-test-helper.mjs';

test('cancel abandons failing management jobs without losing content',async t=>{
  const provider=await identityProvider(t);
  const h=await wikiHarness(t,{...managementVars(provider),configureSource:archiveFaults(provider)});
  const a=await admin(h,(await login(h,provider)).cookie).init();
  const path=r=>'resources/'+r.kind+'/'+r.id;
  const get=async r=>(await a.api(path(r))).body;
  const cancel=r=>a.api(path(r)+'/action',{action:'cancel'});
  const audit=async(r,name)=>{const e=(await a.api(path(r)+'/audit')).body.events.find(e=>e.action===name);assert.ok(e,name);return JSON.parse(e.detail);};
  // Waits for a recorded failure: the state in which an operator cancels.
  async function failed(r){const until=Date.now()+30000;for(;;){const b=await get(r);if(b.error&&b.job)return b;assert.ok(Date.now()<until,JSON.stringify(b));await delay(100);}}
  const objects=async r=>(await get(r)).latest_archive.objects;

  await t.test('no pending operation cannot be canceled',async()=>{
    const w=await h.create('Idle');w.kind='wiki';
    const r=await cancel(w);assert.equal(r.status,409);assert.match(JSON.stringify(r.body),/No pending operation/);
  });

  await t.test('a failing admin archive cancels back to an active, writable resource',async()=>{
    const w=await h.create('Archive');w.kind='wiki';
    const p=(await w.request('/pages',post(page('Kept','intact after cancel')))).body;
    provider.archiveFailure=true;
    try {
      await action(a,w,'archive');
      const f=await failed(w);assert.equal(f.state,'archiving');
      assert.deepEqual(f.job,{action:'archive',stage:'snapshot',cancellable:true});
      const r=await cancel(w);assert.equal(r.status,202,JSON.stringify(r.body));assert.equal(r.body.state,'active');
      const b=await get(w);
      assert.equal(b.job,null);assert.equal(b.latest_archive,null);assert.equal(b.error,null);assert.equal(b.retry_at,null);assert.equal(b.attempts,0);assert.equal(b.policy.paused,false);
      const detail=await audit(w,'archive-canceled');
      assert.equal(detail.stage,'snapshot');assert.ok(detail.attempts>=1);assert.match(detail.partial_prefix,new RegExp(`^mayfly/v1/wiki/${w.id}/${detail.job}/$`));
      assert.equal((await w.request('/pages/'+p.id)).body.markdown,'intact after cancel');
      assert.equal((await w.request('/pages',post(page('After','written after cancel')))).status,201);
      assert.equal((await a.api(path(w)+'/action',{action:'retry'})).status,409);
      assert.equal((await cancel(w)).status,409);
    } finally { provider.archiveFailure=false; }
    await action(a,w,'archive');assert.ok((await settled(a,w,'active',true)).latest_archive);
  });

  await t.test('a failing TTL archive-delete cancels to active and pauses expiry',async()=>{
    const w=await h.create('Expiring');w.kind='wiki';
    await w.request('/pages',post(page('Survivor','must not expire')));
    provider.archiveFailure=true;
    try {
      const before=await setPolicy(a,w,policy(null,1,true));
      const f=await failed(w);assert.equal(f.state,'expiring');assert.equal(f.reason,'ttl');assert.equal(f.job.cancellable,true);
      const r=await cancel(w);assert.equal(r.status,202,JSON.stringify(r.body));
      assert.equal(r.body.state,'active');assert.equal(r.body.policy.paused,true);assert.equal(r.body.policy_version,before.policy_version+1);
      assert.equal((await audit(w,'archive-delete-canceled')).paused,true);
    } finally { provider.archiveFailure=false; }
    // Every request ticks the overdue deadline; a paused policy keeps it from restarting.
    assert.equal((await w.request('/pages',post(page('Later','written after cancel')))).status,201);
    await delay(300);
    const b=await get(w);assert.equal(b.state,'active');assert.equal(b.job,null);assert.equal(b.expires_at,null);
    assert.deepEqual((await w.request('/pages')).body.pages.map(p=>p.title).sort(),['Later','Survivor']);
  });

  await t.test('a restore failing verification cancels back to deleted; a repaired restore succeeds',async()=>{
    const c=await chat(h);
    await c.request('/events?last=-1',post({nonce:randomBytes(12).toString('base64url'),from:'writer',text:'verify me'}));
    await action(a,c,'archive-delete');const gone=await settled(a,c,'deleted',true);
    provider.corrupt=true;
    try {
      await action(a,c,'restore',{archive_id:gone.latest_archive.id,confirm_original_links:true});
      const f=await failed(c);assert.equal(f.state,'restoring');assert.deepEqual(f.job,{action:'restore',stage:'restore-verify',cancellable:true});
      const r=await cancel(c);assert.equal(r.status,202,JSON.stringify(r.body));assert.equal(r.body.state,'deleted');
    } finally { provider.corrupt=false; }
    const b=await get(c);assert.equal(b.job,null);assert.equal(b.error,null);assert.equal(b.deleted_at,gone.deleted_at);
    assert.equal((await audit(c,'restore-canceled')).stage,'restore-verify');
    assert.equal((await c.request('/events?since=-1&wait=0')).status,410);
    await action(a,c,'restore',{archive_id:gone.latest_archive.id,confirm_original_links:true});await settled(a,c);
    assert.equal((await c.request('/events?since=-1&wait=0')).body.events[0].text,'verify me');
  });

  // Restore reads each object to verify, again to write, and table objects a third time to check.
  async function partialRestore(r,reads,stage){
    const gone=await settled(a,r,'deleted',true);
    provider.corruptAfter=reads;
    try {
      await action(a,r,'restore',{archive_id:gone.latest_archive.id,confirm_original_links:true});
      const f=await failed(r);assert.deepEqual(f.job,{action:'restore',stage,cancellable:true});
      const c=await cancel(r);assert.equal(c.status,202,JSON.stringify(c.body));assert.equal(c.body.state,'deleting');assert.equal(c.body.reason,'restore-canceled');
      const rollback=await audit(r,'restore-canceled');assert.equal(rollback.stage,stage);assert.ok(rollback.rollback);
      const done=await settled(a,r,'deleted');
      assert.equal(done.deleted_at,gone.deleted_at);assert.equal(done.job,null);assert.equal(done.error,null);assert.equal(done.attempts,0);
      assert.equal((await audit(r,'delete-completed')).job,rollback.rollback);
      const failures=(await a.api(path(r)+'/audit')).body.events.filter(e=>e.action==='operation-failed').map(e=>JSON.parse(e.detail).job);
      assert.ok(!failures.includes(rollback.rollback),'the abandoned restore step never fails the rollback');
    } finally { provider.corruptAfter=null; }
    return gone.latest_archive.id;
  }

  await t.test('a restore failing after content writes rolls back to deleted, then restores cleanly',async()=>{
    const w=await h.create('Partial');w.kind='wiki';
    const p=(await w.request('/pages',post(page('Restored','exactly once')))).body;
    const file=await w.request('/attachments',{method:'POST',headers:{'Content-Type':'text/plain','X-Filename':'note.txt'},body:'attachment bytes'});assert.equal(file.status,201);
    await action(a,w,'archive-delete');await settled(a,w,'deleted',true);
    // Every object verifies and is written; the first check read fails.
    const id=await partialRestore(w,2*await objects(w),'restore-check');
    assert.equal((await w.request('/pages')).status,410);
    await action(a,w,'restore',{archive_id:id,confirm_original_links:true});await settled(a,w);
    assert.equal((await w.request('/pages/'+p.id)).body.markdown,'exactly once');
    assert.equal((await w.request('/attachments/'+file.body.id)).text,'attachment bytes');
    assert.equal((await w.request('/pages')).body.pages.length,1);
  });

  await t.test('a restore failing mid-write rolls back the rows already written',async()=>{
    const c=await chat(h);
    await c.request('/events?last=-1',post({nonce:randomBytes(12).toString('base64url'),from:'writer',text:'partial write'}));
    await action(a,c,'archive-delete');await settled(a,c,'deleted',true);
    const n=await objects(c);assert.ok(n>=2);
    // Verify everything, write the first object, then fail on the second.
    const id=await partialRestore(c,n+1,'restore-write');
    assert.equal((await c.request('/events?since=-1&wait=0')).status,410);
    await action(a,c,'restore',{archive_id:id,confirm_original_links:true});await settled(a,c);
    const events=(await c.request('/events?since=-1&wait=0')).body.events;
    assert.deepEqual(events.map(e=>e.text),['partial write']);
  });

  await t.test('a cancel landing during an in-flight step abandons that step',async()=>{
    // Cancel while the step awaits a held archive read, then let the stale step finish.
    async function midStep(r,start,state){
      provider.holdReads=true;
      try {
        await start();
        const until=Date.now()+10000;while(!provider.held.length){assert.ok(Date.now()<until);await delay(20);}
        const c=await cancel(r);assert.equal(c.status,202,JSON.stringify(c.body));assert.equal(c.body.state,state);
      } finally { provider.holdReads=false;for(const release of provider.held.splice(0))release(); }
      await delay(300);
      const b=await get(r);assert.equal(b.state,state);assert.equal(b.job,null);assert.equal(b.error,null);assert.equal(b.attempts,0);
      assert.ok(!(await a.api(path(r)+'/audit')).body.events.some(e=>e.action==='operation-failed'));
    }
    const w=await h.create('In flight');w.kind='wiki';await w.request('/pages',post(page('Flight','still here')));
    await midStep(w,()=>action(a,w,'archive'),'active');
    assert.equal((await get(w)).latest_archive,null);
    await action(a,w,'archive');await settled(a,w,'active',true);
    const c=await chat(h);
    await c.request('/events?last=-1',post({nonce:randomBytes(12).toString('base64url'),from:'writer',text:'in flight'}));
    await action(a,c,'archive-delete');const gone=await settled(a,c,'deleted',true);
    await midStep(c,()=>action(a,c,'restore',{archive_id:gone.latest_archive.id,confirm_original_links:true}),'deleted');
    await action(a,c,'restore',{archive_id:gone.latest_archive.id,confirm_original_links:true});await settled(a,c);
    assert.equal((await c.request('/events?since=-1&wait=0')).body.events[0].text,'in flight');
  });

  await t.test('deletion that has started cannot be canceled',async()=>{
    const w=await h.create('Erasing');w.kind='wiki';await w.request('/pages',post(page()));
    // Held uploads postpone lifecycle work, keeping the erase stage observable.
    let release;const pause=new Promise(r=>release=r);
    async function* body(){yield 'held';await pause;yield ' upload';}
    const held=[];
    try {
      // Every upload is held, so the first 429 proves the two-upload limit is held open.
      for(let rejected=false;!rejected;){
        assert.ok(held.length<20);
        const upload=w.request('/attachments',{method:'POST',headers:{'Content-Type':'text/plain','X-Filename':'held.txt'},body:body(),duplex:'half'});held.push(upload);
        rejected=await Promise.race([upload.then(r=>r.status===429),delay(200).then(()=>false)]);
      }
      await action(a,w,'delete');
      const b=await get(w);assert.equal(b.state,'deleting');assert.deepEqual(b.job,{action:'delete',stage:'erase',cancellable:false});
      const r=await cancel(w);assert.equal(r.status,409);assert.match(JSON.stringify(r.body),/cannot be canceled/);
    } finally { release(); }
    await Promise.all(held);
    await settled(a,w,'deleted');
  });
});
