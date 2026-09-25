import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, page, post, wikiHarness } from './wiki-test-helper.mjs';

test('desktop and mobile humans export whole wikis and single saved pages to real ZIP downloads', {timeout:180000}, async t=>{
  assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN for the export browser test');
  const h=await wikiHarness(t,{WIKI_BOOK_LAYOUT_ENABLED:'1'}),wiki=await h.create('Export workshop');
  const uploaded=(await wiki.request('/attachments',{method:'POST',headers:{'X-Filename':'agent.json','Content-Type':'application/octet-stream'},body:'{"exact":90071992547409931234}\n'})).body;
  const saved='# Portable knowledge\n\n'+uploaded.markdown+'\n';
  const p=(await wiki.request('/pages',post(page('Knowledge',saved)))).body;
  await wiki.request('/pages/'+p.id,{method:'PUT',headers:{'Content-Type':'text/markdown','If-Match':'"1"'},body:saved+'\nCurrent saved revision only.\n'});
  await wiki.request('/pages/'+p.id+'/comments',post({body:'Keep this discussion',author:'agent'}));
  const url=new URL(wiki.url);url.searchParams.set('page',p.id);
  const historyURL=new URL(url);historyURL.searchParams.set('revision','1');
  const downloadPath=join(h.directory,'downloads');await mkdir(downloadPath);
  const capture=process.env.MAYFLY_EXPORT_CAPTURE_DIR;if(capture)await mkdir(capture,{recursive:true});
  for(const layout of ['book','classic']){
    await h.start({WIKI_BOOK_LAYOUT_ENABLED:layout==='book'?'1':'0'});
    const config={chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome-'+layout),base:h.base,url:url.href,historyURL:historyURL.href,downloadPath,layout,capture};
    let harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
    harness=harness.replace('const msg=JSON.parse(raw), p=pending.get(msg.id);','const msg=JSON.parse(raw); if(msg.method==="Network.requestWillBeSent") requests.push(msg.params.request); const p=pending.get(msg.id);');
    const exercise=String.raw`
const fs=require('node:fs'),path=require('node:path');
(async()=>{try{
  const {targetInfos}=await cdp('Target.getTargets');const tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
  await cdp('Network.enable',{},tab.sessionId);
  await cdp('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:config.downloadPath});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.exportErrors=[];window.exportViolations=[];addEventListener("error",e=>{if(e.message)exportErrors.push(e.message)});addEventListener("unhandledrejection",e=>exportErrors.push(String(e.reason)));addEventListener("securitypolicyviolation",e=>exportViolations.push(e.violatedDirective));'},tab.sessionId);
  const click=async id=>{
    await cdp('Page.bringToFront',{},tab.sessionId);
    await evaluate(tab,'document.getElementById('+JSON.stringify(id)+').scrollIntoView({block:"center"})');
    await evaluate(tab,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const box=await evaluate(tab,'(()=>{const r=document.getElementById('+JSON.stringify(id)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box},tab.sessionId);
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box},tab.sessionId);
  };
  for(const mobile of [false,true])for(const scope of ['wiki','page']){
    const downloadsDir=path.join(config.downloadPath,config.layout+'-'+(mobile?'mobile':'desktop')+'-'+scope);fs.mkdirSync(downloadsDir,{recursive:true});
    await cdp('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadsDir});
    await cdp('Emulation.setDeviceMetricsOverride',{width:mobile?390:1440,height:mobile?844:1040,deviceScaleFactor:1,mobile},tab.sessionId);
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:mobile?'dark':'light'},{name:'prefers-reduced-motion',value:'reduce'}]},tab.sessionId);
    const targetURL=scope==='page'?config.historyURL:config.url;
    await cdp('Page.navigate',{url:targetURL},tab.sessionId);
    await until(()=>evaluate(tab,'document.getElementById("wiki-content")?.textContent.includes("Portable knowledge")'),'wiki ready');
    await click('wiki-edit');await until(()=>evaluate(tab,'!document.getElementById("wiki-editor").hidden'),'editor ready');await evaluate(tab,'document.getElementById("wiki-markdown").value="UNSAVED DRAFT MUST NOT BE EXPORTED"');
    if(scope==='wiki'&&config.layout==='book'){
      if(mobile)await click('wiki-pages-toggle');
      await evaluate(tab,'document.getElementById("wiki-book-options").open=true');
    }
    await click(scope==='page'?'wiki-export-page':'wiki-export');
    assert.ok(await evaluate(tab,'document.getElementById("wiki-export-dialog").open'));
    assert.equal(await evaluate(tab,'document.getElementById("wiki-export-heading").textContent'),scope==='page'?'Export this page':'Export this wiki');
    if(scope==='page'){
      assert.match(await evaluate(tab,'document.getElementById("wiki-export-description").textContent'),/saved revision 1/);
      assert.match(await evaluate(tab,'document.getElementById("wiki-export-help").textContent'),/repository branch/);
    }
    if(mobile&&config.layout==='book')assert.equal(await evaluate(tab,'document.getElementById("wiki-navigation-drawer").open'),false);
    assert.ok(await evaluate(tab,'document.getElementById("wiki-markdown").value.includes("UNSAVED DRAFT")'),'opening export preserves the draft');
    await click('wiki-export-prepare');
    await until(()=>evaluate(tab,'!document.getElementById("wiki-export-download").hidden'),'prepared ZIP');
    assert.match(await evaluate(tab,'document.getElementById("wiki-export-status").textContent'),/1 page and 1 uploaded file/);
    if(config.capture){const image=await cdp('Page.captureScreenshot',{format:'png'},tab.sessionId);fs.writeFileSync(path.join(config.capture,'export-'+scope+'-'+config.layout+'-'+(mobile?'mobile-dark':'desktop-light')+'.png'),Buffer.from(image.data,'base64'));}
    const before=fs.readdirSync(downloadsDir).filter(f=>f.endsWith('.zip')).length;
    await click('wiki-export-save');
    try {await until(()=>Promise.resolve(fs.readdirSync(downloadsDir).filter(f=>f.endsWith('.zip')).length===before+1),'real ZIP file saved');}
    catch(error){console.error(JSON.stringify({files:fs.readdirSync(downloadsDir),status:await evaluate(tab,'document.getElementById("wiki-export-status").textContent'),errors:await evaluate(tab,'exportErrors'),csp:await evaluate(tab,'exportViolations')}));throw error;}
    await until(()=>evaluate(tab,'document.getElementById("wiki-export-status").textContent.includes("ZIP sent")'),'export completion feedback');
    assert.equal(await evaluate(tab,'location.href'),targetURL,'download preserves the wiki and URL fragment');
    assert.ok(await evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),'no mobile overflow');
    assert.deepEqual(await evaluate(tab,'exportErrors'),[]);assert.deepEqual(await evaluate(tab,'exportViolations'),[]);
    // Cancel a prepared export without navigating or losing the unsaved page.
    await click('wiki-export-prepare');await until(()=>evaluate(tab,'!document.getElementById("wiki-export-download").hidden'),'second export ready');
    await click('wiki-export-cancel');await until(()=>evaluate(tab,'document.getElementById("wiki-export-status").textContent.includes("canceled")'),'cancel feedback');
    await evaluate(tab,'document.getElementById("wiki-export-dialog").close();document.getElementById("wiki-editor").hidden=true');
  }
  const downloads=requests.filter(r=>r.url.endsWith('/download'));
  assert.equal(downloads.length,4);assert.ok(downloads.every(r=>r.method==='POST'&&!r.headers.Authorization&&!r.headers.Referer));
  assert.ok(requests.every(r=>!r.url.includes('ticket=')&&!r.url.includes(config.url.split('#')[1])),'credentials never enter request URLs');
  console.log('PASS '+config.layout+': desktop/mobile wiki and page downloads, saved history, draft preservation, cancel, CSP and credential isolation');
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
    const script=join(h.directory,'export-'+layout+'.cjs');await writeFile(script,'const config='+JSON.stringify(config)+';\nconst requests=[];\n'+harness+'\n'+exercise);
    try {t.diagnostic((await execute(process.execPath,[script],{timeout:90000,maxBuffer:1024*1024})).stdout);}
    catch(error){throw new Error((error.stdout||'')+(error.stderr||error.message));}
  }
  const archives=[];for(const dir of await readdir(downloadPath))for(const file of await readdir(join(downloadPath,dir)))if(file.endsWith('.zip'))archives.push(join(downloadPath,dir,file));assert.equal(archives.length,8);
  for(const name of archives)await execute('python3',['-c',`import zipfile,sys,json
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 single='_mayfly/manifest.json' in z.namelist()
 page=z.read('README.md' if single else 'pages/knowledge.md').decode()
 assert '# Portable knowledge' in page and 'UNSAVED DRAFT' not in page
 assert ('Current saved revision only.' in page) != single
 if single:
  assert json.loads(z.read('_mayfly/page.json'))['revision'] == 1
  assert 'Keep this discussion' in z.read('_mayfly/discussion.jsonl').decode()
  assert 'attachments/' in page and 'attachment:' not in page
 else:
  assert any('Keep this discussion' in z.read(n).decode() for n in z.namelist() if n.startswith('discussion/'))
 attachment=next(n for n in z.namelist() if n.startswith('attachments/'))
 assert z.read(attachment) == b'{"exact":90071992547409931234}\\n'
`,name]);
});
