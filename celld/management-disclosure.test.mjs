import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wikiHarness, post, page, execute } from './wiki-test-helper.mjs';
import { identityProvider, login, admin, managementVars, policy, setPolicy } from './management-test-helper.mjs';

test('managed wiki users see retention and backup disclosure; malformed internal creates leave no resource', {timeout:180000}, async t=>{
  const provider=await identityProvider(t),vars=managementVars(provider);
  const h=await wikiHarness(t,{...vars,MANAGEMENT_ENABLED:'0',configureSource:async directory=>{
    // Expose the private creation handler only in this disposable test Worker.
    const path=join(directory,'celld/native/worker.ts'),source=await readFile(path,'utf8');
    const anchor='async function route(request: Request, env: Env): Promise<Response> {';
    assert.ok(source.includes(anchor));
    await writeFile(path,source.replace(anchor,anchor+`
      if(new URL(request.url).pathname === '/_test/internal-create')return env.CHATS.get(env.CHATS.idFromName(new URL(request.url).searchParams.get('target')!)).fetch(new Request('https://test.internal/_create',{method:'POST',body:await request.text()}));`));
  }});
  const legacy=await h.create('Unmanaged wiki');await h.start(vars);
  const signed=await login(h,provider),a=await admin(h,signed.cookie).init();
  const wiki=await h.create('Managed wiki');wiki.kind='wiki';
  await wiki.request('/pages',post(page('Notice','A saved page.')));
  assert.equal((await legacy.request()).body.retention,null);
  assert.deepEqual((await wiki.request()).body.retention,{expires_at:null,paused:false});
  assert.equal((await h.http(wiki.path,{headers:{Authorization:'Bearer wrong'}})).status,401,'retention metadata requires the wiki bearer');
  assert.match((await h.http('/wiki')).text,/New wikis use administrator-managed retention/);

  await t.test('invalid private create IDs fail before channel or lifecycle initialization',async()=>{
    const id=randomBytes(16).toString('base64url'),auth=randomBytes(32).toString('base64url');
    const body={auth_hash:createHash('sha256').update(auth).digest('base64url'),encryption:'0'};
    for(const value of [undefined,null,'not-an-id','a'.repeat(22),17]){
      const rejected=await h.http('/_test/internal-create?target='+id,post({...body,id:value}));
      assert.equal(rejected.status,400,JSON.stringify(rejected));
    }
    assert.equal((await h.http('/_test/internal-create?target='+id,post({...body,id}))).status,204,'invalid attempts did not initialize the target');
    assert.equal((await h.http('/c/'+id+'/events?since=-1&wait=0',{headers:{Authorization:'Bearer '+auth}})).status,200);
  });

  for(const layout of ['0','1'])await t.test('wiki disclosure and policy refresh in layout '+layout,async()=>{
    if(layout==='1')await h.start({...vars,WIKI_BOOK_LAYOUT_ENABLED:'1'});
    await setPolicy(a,wiki,policy(1800,3600));
    const meta=(await wiki.request()).body,record=(await a.api('resources/wiki/'+wiki.id)).body;
    assert.equal(meta.retention.expires_at,record.expires_at);
    assert.ok(meta.retention.expires_at>Date.now());
    const session=(await a.api('session')).body;
    const config={chrome:process.env.CHROME_BIN||'/usr/bin/google-chrome',profile:join(h.directory,'notice-chrome-'+layout),base:h.base,url:wiki.url,legacy:legacy.url,id:wiki.id,version:record.policy_version,cookie:signed.cookie,csrf:session.csrf,deadline:new Date(meta.retention.expires_at).toISOString()};
    const harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
    const exercise=String.raw`
(async()=>{try{
 const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
 await cdp('Page.navigate',{url:config.url},tab.sessionId);
 await until(()=>evaluate(tab,'document.getElementById("wiki-retention")?.checkVisibility()'), 'retention notice visible');
 const notice=await evaluate(tab,'document.getElementById("wiki-retention").textContent');
 assert.ok(notice.includes(config.deadline));assert.match(notice,/Administrators may retain backups after deletion/);assert.match(notice,/original wiki links/);
 await evaluate(tab,'document.getElementById("wiki-delete").click()');
 await until(()=>evaluate(tab,'document.getElementById("wiki-delete-dialog").open'),'delete dialog');
 assert.equal(await evaluate(tab,'document.getElementById("wiki-delete-backup").checkVisibility()'),true);
 assert.match(await evaluate(tab,'document.getElementById("wiki-delete-backup").textContent'),/original links/);
 await evaluate(tab,'document.getElementById("wiki-delete-dialog").close("cancel")');
 const paused=await fetch(config.base+'/admin/api/resources/wiki/'+config.id+'/policy',{method:'PUT',headers:{Cookie:config.cookie,Origin:config.base,'X-CSRF-Token':config.csrf,'Content-Type':'application/json'},body:JSON.stringify({policy_version:config.version,idle_seconds:1800,age_seconds:3600,archive_on_ttl:false,paused:true})});
 assert.equal(paused.status,202,await paused.text());
 await evaluate(tab,'document.getElementById("wiki-refresh").click()');
 await until(()=>evaluate(tab,'document.getElementById("wiki-retention").textContent.includes("Retention is paused.")'),'refresh shows current policy');
 await cdp('Page.navigate',{url:config.legacy},tab.sessionId);
 await until(()=>evaluate(tab,'document.getElementById("wiki-main")&&!document.getElementById("wiki-main").hidden'),'legacy wiki loaded');
 assert.equal(await evaluate(tab,'document.getElementById("wiki-retention").hidden'),true);
 assert.equal(await evaluate(tab,'document.getElementById("wiki-delete-backup").hidden'),true);
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
    const script=join(h.directory,'disclosure-'+layout+'.cjs');await writeFile(script,`const config=${JSON.stringify(config)};\n${harness}\n${exercise}`);
    await execute(process.execPath,[script],{timeout:70000,maxBuffer:1024*1024});
    assert.deepEqual((await wiki.request()).body.retention,{expires_at:null,paused:true});
  });
});
