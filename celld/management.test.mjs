import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes,hkdfSync,createCipheriv } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MayflySpaces } from './static/spaces.mjs';
import { wikiHarness, post, page, execute } from './wiki-test-helper.mjs';
import { identityProvider, login, admin, policy, setPolicy, action, settled, chat, managementVars, archiveFaults } from './management-test-helper.mjs';

test('managed resources: OIDC, policy, full backup, deletion, restart, and restoration',async t=>{
  const provider=await identityProvider(t);
  const vars=managementVars(provider);
  const h=await wikiHarness(t,{...vars,MANAGEMENT_ENABLED:'0',configureSource:archiveFaults(provider)});
  const legacy=await h.create('Legacy');await h.start(vars);
  await t.test('OIDC denies unauthenticated, invalid identity and replay; session and CSRF are enforced',async()=>{
    assert.equal((await h.http('/admin/api/resources')).status,401);
    assert.equal((await h.http('/admin/api/resources',{headers:{'X-Management-Actor':'admin',Authorization:'Bearer invented'}})).status,401);
    assert.equal((await h.http('/register',post({}))).status,404);
    for(const field of ['subject','nonce','issuer','audience','badSignature']){const old=provider[field];provider[field]=field==='badSignature'?true:'wrong';const l=await login(h,provider);assert.equal(l.response.status,403,field);provider[field]=old;}
    const l=await login(h,provider);assert.equal(l.response.status,303,JSON.stringify(l.response.body));
    assert.equal((await h.http(l.callback,{headers:{Cookie:l.loginCookie}})).status,400);
    assert.equal((await h.http('/admin/logout',{method:'POST',headers:{Cookie:l.cookie,Origin:h.base}})).status,403);
  });
  const signed=await login(h,provider),a=await admin(h,signed.cookie).init();
  assert.equal((await a.api('resources')).body.resources.length,0,'existing wiki is never adopted');
  const wiki=await h.create('Full history');wiki.kind='wiki';
  const p=(await wiki.request('/pages',post(page('Retained','First revision')))).body;
  await wiki.request('/pages/'+p.id,post({...page('Retained','Second revision')},'PUT',1));
  const deleted=(await wiki.request('/pages',post(page('Deleted','Recoverable deleted content')))).body;
  await wiki.request('/pages/'+deleted.id,{method:'DELETE',headers:{'If-Match':'"1"'}});
  const comment=(await wiki.request('/pages/'+p.id+'/comments',post({body:'Thread retained',author:'author'}))).body;
  await wiki.request('/comments/'+comment.id,post({resolved:true},'PATCH',1));
  const attachment=await wiki.request('/attachments',{method:'POST',headers:{'Content-Type':'text/plain','X-Filename':'note.txt'},body:'all attachment bytes'});assert.equal(attachment.status,201,JSON.stringify(attachment.body));
  const companion=await chat(h);
  await MayflySpaces.link(h.base+'/c/'+companion.id+'#'+companion.key.toString('base64url'),wiki.url);
  const links=(await wiki.request('/links')).body;
  const before=await wiki.request('/changes');
  await t.test('full wiki backup includes deleted pages, revisions, comments, search and attachments',async()=>{
    await action(a,wiki,'archive-delete');const erased=await settled(a,wiki,'deleted',true);
    assert.equal((await wiki.request()).status,410);
    const download=await fetch(h.base+'/admin/api/resources/wiki/'+wiki.id+'/download?archive_id='+erased.latest_archive.id,{headers:{Cookie:signed.cookie}});
    assert.equal(download.status,200);const tar=join(h.directory,'backup.tar');await writeFile(tar,Buffer.from(await download.arrayBuffer()));
    const {stdout}=await execute('tar',['-xOf',tar,'manifest.json']);const manifest=JSON.parse(stdout);assert.equal(manifest.resource.id,wiki.id);assert.ok(manifest.tables.includes('revisions'));assert.ok(manifest.objects.some(o=>o.file));
    await h.start(vars); // Durable catalog, receipts and opaque admin session survive a restart.
    await action(a,wiki,'restore',{archive_id:erased.latest_archive.id,confirm_original_links:true});const restored=await settled(a,wiki);
    assert.equal(restored.policy.paused,true);
    assert.equal((await wiki.request('/pages/'+p.id)).body.markdown,'Second revision');
    assert.equal((await wiki.request('/pages/'+p.id+'/history/1')).body.markdown,'First revision');
    assert.equal((await wiki.request('/pages/'+deleted.id)).status,404);
    assert.equal((await wiki.request('/pages/'+deleted.id+'/history/1')).body.markdown,'Recoverable deleted content');
    assert.equal((await wiki.request('/pages/'+p.id+'/comments')).body.comments[0].resolved,true);
    assert.equal((await wiki.request('/attachments/'+attachment.body.id)).text,'all attachment bytes');
    assert.deepEqual((await wiki.request('/changes')).body,before.body);
    assert.deepEqual((await wiki.request('/links')).body,links);
    assert.equal((await MayflySpaces.links(wiki.url))[0].id,companion.id);
    assert.equal((await wiki.request('/search?query=Second')).body.results[0].page_id,p.id);
  });
  const c=await chat(h);
  const envelope={nonce:randomBytes(12).toString('base64url'),from:'agent',text:'exact retained event'};
  assert.equal((await c.request('/events?last=-1',post(envelope))).status,200);
  const events=await c.request('/events?since=-1&wait=0');
  await t.test('chat restore preserves sequence and original authorization; paused TTL overrides legacy retention',async()=>{
    await action(a,c,'archive-delete');const archived=await settled(a,c,'deleted',true);
    await action(a,c,'restore',{archive_id:archived.latest_archive.id,confirm_original_links:true});await settled(a,c);
    assert.deepEqual((await c.request('/events?since=-1&wait=0')).body.events,events.body.events);
    assert.equal((await c.request('/events?last=0',post({...envelope,text:'next sequence'}))).body.id,1);
  });
  await t.test('only content writes advance idle time; age and idle deadlines both apply',async()=>{
    const resource=await h.create('TTL');resource.kind='wiki';
    await setPolicy(a,resource,policy(2,4));let start=(await a.api('resources/wiki/'+resource.id)).body;
    await delay(200);await resource.request('/pages');await resource.request('/search?query=read');
    assert.equal((await a.api('resources/wiki/'+resource.id)).body.last_activity_at,start.last_activity_at);
    await resource.request('/pages',post(page()));const changed=(await a.api('resources/wiki/'+resource.id)).body;
    assert.ok(changed.last_activity_at>start.last_activity_at);assert.equal(changed.age_at,start.age_at);
    const gone=await settled(a,resource,'deleted');assert.equal(gone.latest_archive,null);
    assert.equal((await resource.request('/pages',post(page('Late')))).status,410);
    const age=await h.create('Age');age.kind='wiki';await setPolicy(a,age,policy(null,1,true));await settled(a,age,'deleted',true);
  });
  await t.test('failed backup freezes writes and never deletes; retry resumes after restart',async()=>{
    const protectedWiki=await h.create('Failure');protectedWiki.kind='wiki';
    await protectedWiki.request('/pages',post(page('Protected','must survive failed backup')));
    provider.archiveFailure=true;
    await setPolicy(a,protectedWiki,policy(null,1,true));await delay(1500);
    const failure=(await a.api('resources/wiki/'+protectedWiki.id)).body;
    assert.equal(failure.state,'expiring');assert.ok(failure.error);assert.equal(failure.latest_archive,null);
    assert.equal((await protectedWiki.request('/pages',post(page('Late')))).status,410);
    provider.archiveFailure=false;
    await h.start(vars);await action(a,protectedWiki,'retry').catch(async error=>{if((await a.api('resources/wiki/'+protectedWiki.id)).body.state!=='deleted')throw error;});const done=await settled(a,protectedWiki,'deleted',true);
    await action(a,protectedWiki,'restore',{archive_id:done.latest_archive.id,confirm_original_links:true});await settled(a,protectedWiki);
    assert.equal((await protectedWiki.request('/pages')).body.pages[0].title,'Protected');
  });
  await t.test('corrupt archives never expose a partial restore; retry completes after storage repair',async()=>{
    await action(a,c,'archive-delete');const saved=await settled(a,c,'deleted',true);
    provider.corrupt=true;await action(a,c,'restore',{archive_id:saved.latest_archive.id,confirm_original_links:true});
    await delay(700);const failed=(await a.api('resources/chat/'+c.id)).body;
    assert.equal(failed.state,'restoring');assert.ok(failed.error);
    assert.equal((await c.request('/events?since=-1&wait=0')).status,423);
    provider.corrupt=false;await action(a,c,'retry');await settled(a,c);
    assert.equal((await c.request('/events?since=-1&wait=0')).body.events.length,2);
  });
  await t.test('slow writes crossing a deadline cannot enter the archived snapshot',async()=>{
    const resource=await h.create('Race');resource.kind='wiki';await setPolicy(a,resource,policy(null,1,true));
    let release;const pause=new Promise(r=>release=r);const input=JSON.stringify(page('Late content'));
    async function* stream(){yield input.slice(0,10);await pause;yield input.slice(10);}
    const pending=resource.request('/pages',{method:'POST',headers:{'Content-Type':'application/json'},body:stream(),duplex:'half'});
    await delay(1200);release();assert.equal((await pending).status,410);
    const expired=await settled(a,resource,'deleted',true);
    await action(a,resource,'restore',{archive_id:expired.latest_archive.id,confirm_original_links:true});await settled(a,resource);
    assert.deepEqual((await resource.request('/pages')).body.pages,[]);
    await delay(100);const old=(await a.api('resources/wiki/'+resource.id)).body;
    await setPolicy(a,resource,policy(null,null,false,true));
    assert.equal((await a.api('resources/wiki/'+resource.id+'/policy',{policy_version:old.policy_version,...policy()},'PUT')).status,409);
    await setPolicy(a,resource,policy(null,1));await settled(a,resource,'deleted');
  });
  await t.test('admin inventory and controls work in a browser with CSP',async()=>{
    const hsource=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
    const config={chrome:process.env.CHROME_BIN||'/usr/bin/google-chrome',profile:join(h.directory,'admin-chrome'),base:h.base,cookie:signed.cookie.split(';')[0],id:wiki.id};
    const exercise=String.raw`
(async()=>{try{
 const {targetInfos}=await cdp('Target.getTargets');const tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
 const [name,value]=config.cookie.split('=');await cdp('Network.setCookie',{name,value,url:config.base,path:'/'},tab.sessionId);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"window.testErrors=[];window.testViolations=[];window.confirm=()=>true;addEventListener('error',e=>testErrors.push(e.message));addEventListener('unhandledrejection',e=>testErrors.push(String(e.reason)));addEventListener('securitypolicyviolation',e=>testViolations.push(e.violatedDirective));"},tab.sessionId);
 await cdp('Page.navigate',{url:config.base+'/admin'},tab.sessionId);
 await until(()=>evaluate(tab,"document.querySelectorAll('#resources button').length>0"),'inventory');
 await evaluate(tab,"[...document.querySelectorAll('#resources button')].find(b=>b.textContent.includes("+JSON.stringify(config.id.slice(0,10))+" )).click()");
 await until(()=>evaluate(tab,"!!document.querySelector('#detail form')"),'resource policy');
 await evaluate(tab,"const f=document.querySelector('#detail form');f.querySelectorAll('input[type=number]')[0].value='999';f.requestSubmit();");
 await until(()=>evaluate(tab,"document.getElementById('status').textContent==='' && document.querySelector('#detail input[type=number]').value==='999'"),'saved policy');
 await evaluate(tab,"[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Archive now').click()");
 await sleep(1000);await evaluate(tab,"document.getElementById('refresh').click()");
 await until(()=>evaluate(tab,"document.querySelectorAll('#detail a').length>=2"),'new backup');
 assert.deepEqual(await evaluate(tab,'testErrors'),[]);assert.deepEqual(await evaluate(tab,'testViolations'),[]);
 await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false},tab.sessionId);
 assert.equal(await evaluate(tab,'getComputedStyle(document.querySelector("main")).gridTemplateColumns.split(" ").length'),1);
 console.log('Management browser: inventory, policy edit, archive action, responsive layout and CSP passed.');
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
    const script=join(h.directory,'admin-browser.cjs');await writeFile(script,`const config=${JSON.stringify(config)};
${hsource}
${exercise}`);
    const {stdout}=await execute(process.execPath,[script],{timeout:90000,maxBuffer:1024*1024});t.diagnostic(stdout);
  });
  await t.test('restart after an object upload resumes the same archive before deleting',async()=>{
    const resource=await chat(h);await resource.request('/events?last=-1',post({nonce:randomBytes(12).toString('base64url'),from:'writer',text:'survives interrupted backup'}));
    provider.holdReads=true;await action(a,resource,'archive-delete');
    const until=Date.now()+5000;while(!provider.held.length){assert.ok(Date.now()<until);await delay(50);}
    const audit=(await a.api('resources/chat/'+resource.id+'/audit')).body.events;
    const job=JSON.parse(audit.find(e=>e.action==='archive-delete-started').detail).job;
    await h.stop();provider.holdReads=false;for(const release of provider.held.splice(0))release();await h.start(vars);
    const saved=await settled(a,resource,'deleted',true);assert.equal(saved.latest_archive.id,job);
    await action(a,resource,'restore',{archive_id:saved.latest_archive.id,confirm_original_links:true});await settled(a,resource);
    assert.equal((await resource.request('/events?since=-1&wait=0')).body.events[0].text,'survives interrupted backup');
  });
  await t.test('encrypted chat envelopes round trip without plaintext or fragment keys',async()=>{
    await h.start({...vars,ENCRYPTION_ENABLED:'1'});const enc=await chat(h),nonce=randomBytes(12),key=hkdfSync('sha256',enc.key,'','mayfly enc',32);
    const cipher=createCipheriv('aes-256-gcm',key,nonce).setAAD(Buffer.from(enc.id+':0'));
    const padded=Buffer.alloc(256,32);padded.write(JSON.stringify({from:'private writer',text:'restored encrypted message'}));
    const ciphertext=Buffer.concat([cipher.update(padded),cipher.final(),cipher.getAuthTag()]);
    const payload={nonce:nonce.toString('base64url'),ct:ciphertext.toString('base64url')};
    assert.equal((await enc.request('/events?last=-1',post(payload))).status,200);
    const prior=(await enc.request('/events?since=-1&wait=0')).body;
    await action(a,enc,'archive-delete');const archived=await settled(a,enc,'deleted',true);
    await action(a,enc,'restore',{archive_id:archived.latest_archive.id,confirm_original_links:true});await settled(a,enc);
    assert.deepEqual((await enc.request('/events?since=-1&wait=0')).body.events,prior.events);
    const {stdout}=await execute(process.execPath,[new URL('./static/client.mjs',import.meta.url).pathname,h.base+'/c/'+enc.id+'#'+enc.key.toString('base64url'),'read','--last','-1','--wait','0']);
    assert.match(stdout,/restored encrypted message/);
  });
  await h.start(vars);assert.equal((await legacy.request()).status,200);
});

test('in-flight uploads publish the frozen state and cannot enter an expired backup',async t=>{
  const provider=await identityProvider(t);
  const h=await wikiHarness(t,managementVars(provider));
  const signed=await login(h,provider),a=await admin(h,signed.cookie).init();
  const resource=await h.create('Pending upload');resource.kind='wiki';await setPolicy(a,resource,policy(null,1,true));
  let release;const pause=new Promise(r=>release=r);async function* body(){yield 'unfinished';await pause;yield ' upload';}
  const pending=resource.request('/attachments',{method:'POST',headers:{'Content-Type':'text/plain','X-Filename':'pending.txt'},body:body(),duplex:'half'});
  let observed;
  try {
    await delay(1400);
    observed=(await a.api('resources')).body.resources.find(r=>r.id===resource.id);
  } finally { release(); }
  assert.equal((await pending).status,410);
  assert.equal(observed.state,'expiring','inventory exposes the frozen state while upload cleanup is pending');
  const deleted=await settled(a,resource,'deleted',true);
  await action(a,resource,'restore',{archive_id:deleted.latest_archive.id,confirm_original_links:true});await settled(a,resource);
  assert.equal((await resource.request()).body.attachment_bytes,0);
});
