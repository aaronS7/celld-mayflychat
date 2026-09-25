// Reproducible documentation screenshots from disposable, synthetic data.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MayflySpaces } from './static/spaces.mjs';
import { execute, post, wikiHarness } from './wiki-test-helper.mjs';
assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN to capture the wiki');
const book=process.argv.includes('--book');
const mobile=process.argv.includes('--mobile');
assert.ok(!mobile||book,'Mobile drawer captures require --book');
const cleanup=[];
try {
  const h=await wikiHarness({after:fn=>cleanup.push(fn)},{WIKI_BOOK_LAYOUT_ENABLED:book?'1':'0'});
  const wiki=await h.create('Infrastructure knowledge');
  await MayflySpaces.complete(await MayflySpaces.plan(h.base,{wiki:wiki.url,chat:true}));
  const examples=[
    {title:'Failover runbook',path:'operations/failover',markdown:'# Failover runbook\n\nKeep acknowledged writes safe while restoring service.\n\n## Before you begin\n\n- Confirm that the old owner has stopped accepting writes.\n- Check the most recent replicated position.\n- Record the incident in the linked chat.\n\n## Recovery\n\nPromote the replacement only after fencing the previous owner.\n\n```typescript\nconst ready = await replica.caughtUp();\nif (ready) await owner.promote();\n```\n\n## Verification\n\nRead the last acknowledged write, then publish the recovery outcome.\n'},
    {title:'Ownership and leases',path:'architecture/leases',markdown:'# Ownership and leases\n\nA single fenced owner coordinates writes.'},
    {title:'Deploy checklist',path:'operations/deploy',markdown:'# Deploy checklist\n\nValidate, deploy, then verify the running service.'}
  ];
  const operations=(await wiki.request('/pages',post({title:'Operations',path:'operations',markdown:'# Operations\n\nRunbooks for safe changes and recovery.',author:'runbook-agent'}))).body;
  let selected;
  for(const value of examples){const r=await wiki.request('/pages',post({...value,parent_id:value.path.startsWith('operations/')?operations.id:null,author:'runbook-agent'}));assert.equal(r.status,201);selected??=r.body;}
  await wiki.request('/pages/'+selected.id+'/comments',post({body:'Does this cover a network partition?',author:'review-agent',anchor:{type:'section',revision:1,heading:'Recovery'}}));
  const config={name:book?(mobile?'wiki-book-mobile':'wiki-book'):'wiki',mobile,chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome'),url:wiki.url.replace('#','?page='+selected.id+'#'),output:fileURLToPath(new URL('../website/public/media/',import.meta.url))};
  const harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
  const exercise=String.raw`
(async()=>{try{
 const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
 await cdp('Emulation.setDeviceMetricsOverride',{width:config.mobile?390:1440,height:config.mobile?844:1040,deviceScaleFactor:1,mobile:config.mobile},tab.sessionId);
 await cdp('Page.navigate',{url:config.url},tab.sessionId);
 await until(()=>evaluate(tab,'document.querySelector("#wiki-content h1") && document.querySelector("#companions .space-list a") && document.querySelector("#wiki-comments article")'),'wiki ready');
 if(config.mobile){await evaluate(tab,'document.getElementById("wiki-pages-toggle").click()');await until(()=>evaluate(tab,'document.getElementById("wiki-navigation-drawer").open && getComputedStyle(document.getElementById("wiki-navigation-drawer")).transform==="none"'),'mobile drawer');}
 for(const theme of ['light','dark']){
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]},tab.sessionId);
  await evaluate(tab,'document.fonts.ready');
  const {data}=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},tab.sessionId);
  require('node:fs').writeFileSync(require('node:path').join(config.output,config.name+'-'+theme+'.png'),Buffer.from(data,'base64'));
 }
}finally{chrome.kill('SIGTERM');await exited;}})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const script=join(h.directory,'capture.cjs');await writeFile(script,'const config='+JSON.stringify(config)+';\n'+harness+'\n'+exercise);
  await execute(process.execPath,[script],{timeout:30000});
  console.log('Captured '+config.name+' screenshots in both themes.');
} finally { for(const finish of cleanup.reverse())await finish(); }
