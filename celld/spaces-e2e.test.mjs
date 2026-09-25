import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, wikiHarness } from './wiki-test-helper.mjs';

test('humans and downloaded agent clients create and navigate linked chats and wikis', {timeout:90000}, async t=>{
  assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN for the real browser test');
  const h=await wikiHarness(t), client=join(h.directory,'spaces.mjs');
  await writeFile(client,(await h.http('/static/spaces.mjs')).text);
  const config={chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome'),base:h.base,client};
  const harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
  const exercise=String.raw`
const execFile=require('node:util').promisify(require('node:child_process').execFile);
async function agent(...args){const {stdout}=await execFile(process.execPath,[config.client,...args],{timeout:20000});return JSON.parse(stdout);}
(async()=>{try{
 const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"window.testErrors=[];window.testViolations=[];window.addEventListener('error',e=>testErrors.push(e.message));window.addEventListener('unhandledrejection',e=>testErrors.push(String(e.reason)));window.addEventListener('securitypolicyviolation',e=>testViolations.push(e.violatedDirective));"},tab.sessionId);
 const click=selector=>evaluate(tab,'document.querySelector('+JSON.stringify(selector)+').click()');
 const set=(selector,value)=>evaluate(tab,'document.querySelector('+JSON.stringify(selector)+').value='+JSON.stringify(value));
 const nav=url=>cdp('Page.navigate',{url},tab.sessionId);
 const links=n=>until(()=>evaluate(tab,'document.querySelectorAll("#companions .space-list a").length==='+n),'companion links '+n);
 const healthy=async()=>{assert.deepEqual(await evaluate(tab,'testErrors'),[]);assert.deepEqual(await evaluate(tab,'testViolations'),[]);};
 await nav(config.base+'/');await until(()=>evaluate(tab,'!!document.getElementById("create-with-wiki")'),'paired chat form');
 assert.equal(await evaluate(tab,'document.getElementById("create-with-wiki").checked'),false);
 await click('#create-with-wiki');await set('#create-wiki-title','Human project');
 // The second reciprocal write fails once, after both resources exist.
 await evaluate(tab,"{const real=window.fetch;let fail=true;window.fetch=async(url,options)=>{if(fail && String(url).includes('/w/') && String(url).includes('/links/') && options?.method==='PUT'){fail=false;return Response.json({error:'Retry test'},{status:503});}return real(url,options);};}");
 await click('#newbtn');await until(()=>evaluate(tab,'document.querySelectorAll("#creation-recovery a").length===2'),'recovery URLs after partial failure');
 const recovery=await evaluate(tab,'[...document.querySelectorAll("#creation-recovery a")].map(a=>a.href)');
 await healthy();await click('#newbtn');await links(1);
 const chat=await evaluate(tab,'location.href');assert.equal(chat,recovery[0]);
 const wiki=(await agent('links',chat)).links[0].url;assert.equal(wiki,recovery[1]);
 assert.equal(await evaluate(tab,'document.querySelector("#companions .space-list a").href'),wiki);
 await healthy();await click('#companions .space-list a');await links(1);
 assert.equal(await evaluate(tab,'location.href'),wiki);assert.equal((await agent('links',wiki)).links[0].url,chat);
 const second=await agent('chat',wiki);await click('#companions .space-actions button');await links(2);
 assert.ok(await evaluate(tab,'[...document.querySelectorAll("#companions .space-list a")].some(a=>a.href==='+JSON.stringify(second.chat_url)+')'));
 await click('#companions > form button');await links(3);assert.equal((await agent('links',wiki)).links.length,3);
 await healthy();await nav(config.base+'/wiki');await until(()=>evaluate(tab,'!!document.getElementById("wiki-create") && !document.getElementById("wiki-create").hidden'),'wiki creation');
 await set('#wiki-create-title','Wiki first');await click('#wiki-create-chat');await click('#wiki-create button');await links(1);
 const wikiFirst=await evaluate(tab,'location.href'), wikiFirstChat=(await agent('links',wikiFirst)).links[0].url;
 await healthy();await click('#companions .space-list a');await links(1);assert.equal(await evaluate(tab,'location.href'),wikiFirstChat);
 // Existing chat -> new wiki, without losing the chat composer draft.
 const solo=await agent('create-chat',config.base);await nav(solo.chat_url);await links(0);
 await until(()=>evaluate(tab,'!document.getElementById("main").hidden'),'chat authenticated');
 await set('#text','Keep this unsent message');await set('#companions > form input','Later knowledge');await click('#companions > form button');await links(1);
 assert.equal(await evaluate(tab,'document.getElementById("text").value'),'Keep this unsent message');
 assert.equal((await agent('links',solo.chat_url)).links.length,1);
 // Humans can attach existing resources too, with reciprocal discovery for agents.
 const existing=await agent('create-wiki',config.base,'Existing knowledge');
 await click('#companions details summary');await set('#companions details input',existing.wiki_url);await click('#companions details button');await links(2);
 assert.equal((await agent('links',existing.wiki_url)).links[0].url,solo.chat_url);
 await healthy();await nav(wiki);await links(3);
 await click('#wiki-agent');assert.ok(await evaluate(tab,'document.getElementById("wiki-agent-text").value.includes("node spaces.mjs links")'));
 await evaluate(tab,'document.getElementById("wiki-agent-dialog").close()');
 await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false},tab.sessionId);
 assert.ok(await evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),'mobile navigation fits');
 await click('#companions .space-list button');await links(2);assert.equal((await agent('links',wiki)).links.length,2);
 await healthy();
 const guest=await attach((await cdp('Target.createTarget',{url:'about:blank'})).targetId);
 await cdp('Page.navigate',{url:wiki.split('#')[0]},guest.sessionId);
 await until(()=>evaluate(guest,'document.getElementById("wiki-status")?.textContent.includes("missing its key")'),'missing key');
 assert.equal(await evaluate(guest,'document.getElementById("companions").hidden'),true);
 console.log('Companion E2E passed: optional creation in both directions, partial-write recovery, browser navigation, downloaded agent discovery, multiple chats, existing links, preserved drafts, mobile layout, missing keys and CSP.');
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});
`;
  const script=join(h.directory,'browser.cjs');await writeFile(script,'const config='+JSON.stringify(config)+';\n'+harness+'\n'+exercise);
  const {stdout}=await execute(process.execPath,[script],{timeout:70000,maxBuffer:1024*1024});t.diagnostic(stdout);
});
