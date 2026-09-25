import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MayflySpaces as spaces } from './static/spaces.mjs';
import { execute, page, post, wikiHarness } from './wiki-test-helper.mjs';

const call = async (h,url,path='',options={}) => {
  const cap = await spaces.capability(url);
  return h.http(cap.path+path,{...options,headers:{Authorization:'Bearer '+cap.auth,...options.headers}});
};
async function pair(h,title='Linked knowledge') { return spaces.complete(await spaces.plan(h.base,{chat:true,wiki:true,title})); }

test('linked resources survive restart, support multiple chats, and keep capabilities out of content', {timeout:60000}, async t=>{
  const h=await wikiHarness(t,{JEV_WIKI_SEARCH_ENABLED:'1',TYPESAFE_API_KEY:'fixture-key'});
  const first=await pair(h), chat=await spaces.capability(first.chat_url), wiki=await spaces.capability(first.wiki_url);
  assert.equal((await spaces.links(chat.url))[0].url,wiki.url);
  assert.equal((await spaces.links(wiki.url))[0].url,chat.url);
  await spaces.link(chat.url,wiki.url);assert.equal((await spaces.links(wiki.url)).length,1,'link retries do not duplicate records');
  const second=await spaces.complete(await spaces.plan(h.base,{wiki:wiki.url,chat:true}));
  assert.equal((await spaces.links(wiki.url)).length,2);
  const third=await spaces.complete(await spaces.plan(h.base,{chat:second.chat_url,wiki:true,title:'Another knowledge base'}));
  assert.equal((await spaces.links(second.chat_url)).length,2);
  assert.equal((await spaces.links(third.wiki_url))[0].url,second.chat_url);
  const raw=await call(h,chat.url,'/links');
  for(const secret of [chat.key,wiki.key,chat.auth,wiki.auth])assert.ok(!raw.text.includes(secret));
  assert.equal((await h.http(chat.path+'/links')).status,401);
  assert.equal((await h.http(wiki.path+'/links')).status,401);
  assert.equal((await h.http(wiki.path+'/links',{headers:{Authorization:'Bearer '+chat.auth}})).status,401);
  const shell=await h.http(chat.path,{headers:{Accept:'text/html'}});assert.ok(!shell.text.includes(wiki.key));assert.ok(!shell.text.includes('Linked knowledge'));
  assert.equal((await call(h,chat.url,'/events?since=-1')).body.events.length,0,'linking never posts a chat message');
  await call(h,wiki.url,'/pages',post(page()));
  await call(h,wiki.url,'/search',post({query:'Recovery',mode:'relevance'}));
  assert.ok(h.provider.requests.length);for(const secret of [chat.key,wiki.key,chat.auth,wiki.auth])assert.ok(!JSON.stringify(h.provider.requests).includes(secret));
  await h.start();assert.equal((await spaces.links(chat.url))[0].url,wiki.url);
  await spaces.remove(wiki.url,chat.id);assert.equal((await spaces.links(wiki.url)).length,1);
  assert.equal((await spaces.links(chat.url)).length,1,'removing a shortcut is local and is not revocation');
  await spaces.link(chat.url,wiki.url);assert.equal((await spaces.links(wiki.url)).length,2);
  await call(h,chat.url,'',{method:'DELETE'});
  assert.equal((await call(h,wiki.url)).status,200,'deleting a chat preserves its wiki');
  assert.equal((await call(h,second.chat_url,'/config')).status,200);
  await call(h,wiki.url,'',{method:'DELETE'});
  assert.equal((await call(h,second.chat_url,'/config')).status,200,'deleting a wiki preserves its chats');
});

test('partial creation and reciprocal writes can be resumed using the same URLs', {timeout:60000}, async t=>{
  const h=await wikiHarness(t), realFetch=globalThis.fetch;
  let failLink=true, loseCreation=true, creates=0;
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;
    if(options?.method==='POST' && ['/new','/wiki/new'].includes(path))creates++;
    if(loseCreation && path==='/new' && options?.method==='POST'){
      loseCreation=false;const r=await realFetch(url,options);await r.body?.cancel();throw new Error('Lost create response');
    }
    if(failLink && /^\/w\/.+\/links\//.test(path) && options?.method==='PUT'){
      failLink=false;return Response.json({error:'Injected reciprocal write failure'},{status:503});
    }
    return realFetch(url,options);
  };
  t.after(()=>{globalThis.fetch=realFetch;});
  const pending=await spaces.plan(h.base,{chat:true,wiki:true});
  await assert.rejects(spaces.complete(pending),e=>e.message==='Lost create response' && e.recovery.chat_url===pending.chat_url);
  await assert.rejects(spaces.complete(pending),e=>e.status===503 && e.recovery.created_chat && e.recovery.created_wiki);
  assert.equal((await spaces.links(pending.chat_url)).length,1);assert.equal((await spaces.links(pending.wiki_url)).length,0);
  const resumed=JSON.parse(JSON.stringify(pending));await spaces.complete(resumed);
  assert.equal(creates,2,'one actual creation request for each resource despite both failures');
  assert.equal((await spaces.links(pending.wiki_url))[0].url,pending.chat_url);
  await call(h,pending.chat_url,'',{method:'DELETE'});
  await assert.rejects(spaces.complete(resumed),e=>e.status===404);
  assert.equal(creates,2,'link repair must not resurrect a deleted chat');
  const client=join(h.directory,'spaces.mjs'), recoveryFile=join(h.directory,'recovery.json');
  await writeFile(client,(await h.http('/static/spaces.mjs')).text);
  const standalone=await spaces.complete(await spaces.plan(h.base,{wiki:true,title:'Agent-first wiki'}));
  const {stdout}=await execute(process.execPath,[client,'chat',standalone.wiki_url]);const output=JSON.parse(stdout);
  const {stdout:discovered}=await execute(process.execPath,[client,'links',standalone.wiki_url]);assert.equal(JSON.parse(discovered).links[0].url,output.chat_url);
  await writeFile(recoveryFile,JSON.stringify({recovery:{...output,create_chat:false,create_wiki:false}}));
  const {stdout:repaired}=await execute(process.execPath,[client,'resume',recoveryFile]);assert.deepEqual(JSON.parse(repaired),output);
});

test('links honor feature flags, chat encryption, and original idle expiry', {timeout:60000}, async t=>{
  const h=await wikiHarness(t), first=await pair(h), chat=await spaces.capability(first.chat_url);
  await h.start({WIKI_ENABLED:'0'});
  assert.equal((await call(h,chat.url,'/links')).status,404);
  assert.equal((await call(h,first.wiki_url,'/links')).status,404);
  assert.match((await h.http('/')).text,/id="paired-creation"[^>]+ hidden/);
  await assert.rejects(spaces.complete(await spaces.plan(h.base,{chat:true,wiki:true})),/Wikis are disabled/);
  await h.start({ENCRYPTION_ENABLED:'1'});
  const encrypted=await spaces.complete(await spaces.plan(h.base,{chat:true}));
  await h.start();
  await assert.rejects(spaces.link(encrypted.chat_url,first.wiki_url),/Encrypted chats/);
  const blocked=await spaces.plan(h.base,{chat:encrypted.chat_url,wiki:true});
  await assert.rejects(spaces.complete(blocked),/Encrypted chats/);
  assert.equal((await call(h,blocked.wiki_url)).status,404,'invalid existing chat is rejected before companion creation');
  assert.equal((await call(h,encrypted.chat_url,'/links')).status,412);
  await assert.rejects(spaces.link(chat.url,first.wiki_url.replace(h.base,'https://example.invalid')),/same origin/);
  await h.start({RETENTION_SECONDS:'3'});
  const expiring=await pair(h);await delay(1100);
  await spaces.links(expiring.chat_url);await delay(2200);
  assert.equal((await call(h,expiring.chat_url,'/links')).status,404,'discovery does not extend chat lifetime');
  assert.equal((await call(h,expiring.wiki_url)).status,200);
  const next=await spaces.complete(await spaces.plan(h.base,{wiki:expiring.wiki_url,chat:true}));assert.notEqual(next.chat_url,expiring.chat_url);
});

test('sealed link validation, tampering detection, and per-resource storage bounds', {timeout:60000}, async t=>{
  const h=await wikiHarness(t), first=await pair(h), cap=await spaces.capability(first.chat_url);
  const row=(await call(h,first.chat_url,'/links')).body.links[0];
  for(const input of [{...row,kind:'chat'},{...row,nonce:'a'},{...row,ct:'a'},{...row,title:'\n'},{...row,title:'x'.repeat(161)}]){
    assert.equal((await call(h,first.chat_url,'/links/'+row.id,post(input,'PUT'))).status,400);
  }
  assert.equal((await call(h,first.chat_url,'/links/not-an-id',post(row,'PUT'))).status,400);
  assert.equal((await call(h,first.chat_url,'/links/'+row.id,post({...row,ct:'A'.repeat(5000)},'PUT'))).status,413);
  await spaces.remove(first.chat_url,row.id);
  assert.equal((await call(h,first.chat_url,'/links/'+row.id,post({...row,title:'Changed title'},'PUT'))).status,201);
  assert.match((await spaces.links(first.chat_url))[0].error,/cannot be decrypted/);
  await spaces.remove(first.chat_url,row.id);await spaces.link(first.chat_url,first.wiki_url);
  for(let i=1;i<100;i++)assert.equal((await call(h,first.chat_url,'/links/'+randomBytes(16).toString('base64url'),post(row,'PUT'))).status,201);
  assert.equal((await call(h,first.chat_url,'/links/'+randomBytes(16).toString('base64url'),post(row,'PUT'))).status,429);
  assert.equal((await call(h,first.chat_url,'/links/'+row.id,post(row,'PUT'))).status,200,'retry remains possible at capacity');
  assert.equal((await spaces.links(first.chat_url)).length,100);
  await call(h,first.chat_url,'',{method:'DELETE'});
  // Chat recreation uses the same user capability, but a new generation with no old shortcuts.
  await spaces.complete({chat_url:cap.url,create_chat:true});assert.equal((await spaces.links(cap.url)).length,0);
});
