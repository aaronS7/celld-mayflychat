import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, wikiHarness } from './wiki-test-helper.mjs';

test('chat scroll controls show at the right thresholds and reach both ends', {timeout:90000}, async t=>{
  assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN for the real browser test');
  const h=await wikiHarness(t);
  const config={chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome'),base:h.base};
  const harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
  const exercise=String.raw`
(async()=>{try{
  const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"window.scrollErrors=[];addEventListener('error',e=>scrollErrors.push(e.message));addEventListener('unhandledrejection',e=>scrollErrors.push(String(e.reason)));"},tab.sessionId);
  await cdp('Page.navigate',{url:config.base+'/'},tab.sessionId);
  await until(()=>evaluate(tab,'typeof newChannel==="function"'),'landing');
  await evaluate(tab,'document.getElementById("newbtn").click()');
  await until(()=>evaluate(tab,'document.getElementById("main")?.hidden===false'),'chat');
  const state=()=>evaluate(tab,'({y:scrollY,height:innerHeight,total:document.scrollingElement.scrollHeight,top:!document.getElementById("scroll-top").hidden,bottom:!document.getElementById("scroll-bottom").hidden})');
  assert.equal((await state()).top,false);
  assert.equal((await state()).bottom,false);
  const paragraphs=Array.from({length:90},(_,i)=>'Paragraph '+i+' with enough words to occupy the message view.').join('\n\n');
  await evaluate(tab,'append({from:identity.name,text:'+JSON.stringify(paragraphs)+'})');
  await until(async()=>{const s=await state();return s.total>s.height*3&&s.y>s.height;},'long chat follows latest');
  assert.equal((await state()).bottom,false);
  await evaluate(tab,'window.scrollTo(0,0)');
  await until(async()=>{const s=await state();return s.y===0&&s.bottom;},'away from latest');
  assert.equal((await state()).top,false);
  await evaluate(tab,'document.getElementById("scroll-bottom").click()');
  await until(async()=>{const s=await state();return s.total-s.y-s.height<=24&&!s.bottom;},'latest button reaches bottom');
  await evaluate(tab,'window.scrollTo(0,innerHeight+80)');
  await until(async()=>{const s=await state();return s.top&&s.bottom;},'top button after one screen');
  const before=await state();
  await evaluate(tab,'append({from:identity.name,text:"A new latest message"})');
  await until(()=>evaluate(tab,'document.getElementById("log").textContent.includes("A new latest message")'),'new message');
  const after=await state();
  assert.ok(Math.abs(after.y-before.y)<10,'incoming message does not move a reader away from history');
  await evaluate(tab,'document.getElementById("scroll-top").click()');
  await until(async()=>{const s=await state();return s.y<10&&!s.top;},'top button reaches start');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:700,deviceScaleFactor:1,mobile:true},tab.sessionId);
  await evaluate(tab,'window.scrollTo(0,innerHeight+80)');
  await until(async()=>{const s=await state();return s.top&&s.bottom;},'mobile controls visible');
  const mobile=await evaluate(tab,'(()=>{const buttons=[document.getElementById("scroll-top"),document.getElementById("scroll-bottom")];const composer=document.getElementById("compose").getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,buttons:buttons.map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}}),composerTop:composer.top}})()');
  assert.equal(mobile.overflow,false);
  for(const b of mobile.buttons){assert.ok(b.left>=0&&b.right<=390,'button fits mobile viewport');assert.ok(b.bottom<mobile.composerTop,'button clears composer');}
  await evaluate(tab,'document.getElementById("scroll-bottom").click()');
  await until(async()=>{const s=await state();return s.total-s.y-s.height<=24;},'mobile latest button');
  assert.deepEqual(await evaluate(tab,'scrollErrors'),[]);
  console.log('Chat scroll controls passed on desktop and mobile.');
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});
`;
  const script=join(h.directory,'browser.cjs');
  await writeFile(script,'const config='+JSON.stringify(config)+';\n'+harness+'\n'+exercise);
  const {stdout}=await execute(process.execPath,[script],{timeout:75000,maxBuffer:1024*1024});
  t.diagnostic(stdout);
});
