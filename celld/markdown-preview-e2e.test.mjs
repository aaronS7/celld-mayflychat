import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, page, post, wikiHarness } from './wiki-test-helper.mjs';

test('Markdown files and fences render safely on demand in wiki and chat', {timeout:120000}, async t=>{
  assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN for Markdown preview browser tests');
  const h=await wikiHarness(t,{WIKI_BOOK_LAYOUT_ENABLED:'1'}), wiki=await h.create('Markdown previews');
  const linked=(await wiki.request('/pages',post(page('Linked page')))).body;
  const requests=[];
  let source;
  const external=createServer((req,res)=>{
    requests.push({path:req.url,authorization:req.headers.authorization,referer:req.headers.referer,cookie:req.headers.cookie});
    const headers={'Content-Type':'text/markdown',...(req.url==='/denied.md'?{}:{'Access-Control-Allow-Origin':'*'})};
    if(req.url==='/large.md'){res.writeHead(200,{...headers,'Content-Length':262145});res.end('x'.repeat(262145));}
    else if(req.url==='/chunked.md'){res.writeHead(200,headers);res.write('x'.repeat(131073));res.end('x'.repeat(131073));}
    else if(req.url==='/binary.md')res.writeHead(200,headers).end(Buffer.from([255,0,128]));
    else res.writeHead(200,headers).end(source);
  });
  await new Promise(resolve=>external.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{external.closeAllConnections();external.close(resolve);}));
  const externalBase='http://127.0.0.1:'+external.address().port;
  source=['# Rendered handbook','','**Bold** and *italic* with `inline code`.','','- First item','- Second item','','| Name | Value |','| --- | --- |','| Test | Passed |','',
    '[Linked page](page:'+linked.id+')','[Website](https://example.com/guide)','[Relative](guide)','![Remote image]('+externalBase+'/never.png)',
    '[Unsafe](javascript:window.markdownPwned=true)','<img src="'+externalBase+'/raw.png" onerror="window.markdownPwned=true">','<script>window.markdownPwned=true</script>','',
    '```javascript','const answer = 42;','```','','```md','# Nested example','```','',
    ...Array.from({length:60},(_,i)=>'Paragraph '+i+'.\n'),'## Final section','The entire document is rendered.',''].join('\r\n');
  const files=[];
  for(const [name,body] of [['README.MD',source],['empty.markdown','\r\n'],['large.md','é'.repeat(131073)]]) {
    const result=await wiki.request('/attachments',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':name},body});
    assert.equal(result.status,201);files.push(result.body);
  }
  const fenced='````markdown\n'+source+'\n````';
  const saved=(await wiki.request('/pages',post(page('Preview examples','# Preview examples\n\n'+files.map(f=>f.markdown).join('\n\n')+'\n\n'+fenced+'\n\n[External handbook]('+externalBase+'/handbook.markdown)')))).body;
  const url=new URL(wiki.url);url.searchParams.set('page',saved.id);
  const frame=await h.http('/static/markdown-file-frame');assert.equal(frame.status,200);
  for(const rule of ["sandbox allow-scripts","default-src 'none'","connect-src http: https:","frame-ancestors 'self'"])assert.ok(frame.headers.get('Content-Security-Policy').includes(rule));
  assert.ok((await h.http(url.pathname+url.search,{headers:{Accept:'text/html'}})).headers.get('Content-Security-Policy').includes("connect-src 'self'"));
  const downloads=join(h.directory,'downloads');await mkdir(downloads);
  const capture=process.env.MAYFLY_MARKDOWN_CAPTURE_DIR;if(capture)await mkdir(capture,{recursive:true});
  const config={chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome'),base:h.base,url:url.href,source,fenced,externalBase,linkedID:linked.id,downloads,capture};
  const harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
  const exercise=String.raw`
const fs=require('node:fs'),path=require('node:path');
(async()=>{try{
  const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
  await cdp('Browser.grantPermissions',{origin:config.base,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await cdp('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:config.downloads});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.markdownErrors=[];window.markdownCSP=[];addEventListener("error",e=>markdownErrors.push(e.message));addEventListener("unhandledrejection",e=>markdownErrors.push(String(e.reason)));addEventListener("securitypolicyviolation",e=>markdownCSP.push(e.violatedDirective));'},tab.sessionId);
  const card=name=>'[...document.querySelectorAll(".mayfly-media")].find(c=>c.querySelector(".media-name").textContent==='+JSON.stringify(name)+')';
  const click=async expression=>{
    await cdp('Page.bringToFront',{},tab.sessionId);
    const box=await evaluate(tab,'(()=>{const e='+expression+';e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box},tab.sessionId);
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box},tab.sessionId);
  };
  const render=async root=>{
    assert.ok(await evaluate(tab,root+'.querySelector(".text-rendered").hidden'),'starts as source');
    await click(root+'.querySelector(".text-markdown")');
    const result=await evaluate(tab,'(()=>{const root='+root+',e=root.querySelector(".text-rendered");return {heading:e.querySelector("h1")?.textContent,bold:e.querySelector("strong")?.textContent,italic:e.querySelector("em")?.textContent,items:e.querySelectorAll("li").length,table:e.querySelector("td")?.textContent,last:e.textContent.includes("The entire document is rendered."),scripts:e.querySelectorAll("script,img,iframe,svg").length,unsafe:e.querySelector("a[href^=javascript]"),hidden:e.hidden,sourceHidden:root.querySelector(".text-source").hidden,expanded:root.querySelector(".text-markdown").getAttribute("aria-expanded"),label:root.querySelector(".text-markdown").textContent}})()');
    assert.equal(result.heading,'Rendered handbook');assert.equal(result.bold,'Bold');assert.equal(result.italic,'italic');assert.equal(result.items,2);assert.equal(result.table,'Test');assert.equal(result.last,true);assert.equal(result.scripts,0);assert.equal(result.unsafe,null);assert.equal(result.hidden,false);assert.equal(result.sourceHidden,true);assert.equal(result.expanded,'true');assert.equal(result.label,'Show source');
    assert.equal(await evaluate(tab,'window.markdownPwned'),undefined);
  };
  const screenshot=async name=>{if(config.capture){const {data}=await cdp('Page.captureScreenshot',{format:'png'},tab.sessionId);fs.writeFileSync(path.join(config.capture,name+'.png'),Buffer.from(data,'base64'));}};
  await cdp('Page.navigate',{url:config.url},tab.sessionId);
  const attachment=card('README.MD');
  await until(()=>evaluate(tab,attachment+'?.querySelector(".text-markdown")'),'uploaded Markdown controls');
  assert.equal(await evaluate(tab,attachment+'.querySelector(".text-source code").textContent.split("\\n").length'),50);
  assert.equal(await evaluate(tab,'document.querySelectorAll(".text-rendered h1").length'),0,'no eager rendering');
  await render(attachment);
  assert.ok(await evaluate(tab,attachment+'.querySelector('+JSON.stringify('a[href*="page='+config.linkedID+'"]')+')!==null'),'wiki links retain their context');
  assert.equal(await evaluate(tab,attachment+'.querySelectorAll(".text-rendered [id^=s]").length'),0,'preview headings do not collide with page sections');
  assert.equal(await evaluate(tab,'document.querySelectorAll("#s1").length'),1);
  await evaluate(tab,attachment+'.scrollIntoView({block:"start"})');await screenshot('wiki-desktop');
  await click(attachment+'.querySelector(".text-minimize")');assert.ok(await evaluate(tab,attachment+'.querySelector(".text-rendered").hidden'));
  await click(attachment+'.querySelector(".text-minimize")');assert.equal(await evaluate(tab,attachment+'.querySelector(".text-rendered").hidden'),false);
  await click(attachment+'.querySelector(".text-markdown")');assert.equal(await evaluate(tab,attachment+'.querySelector(".text-source code").textContent.split("\\n").length'),50,'return to source');
  await click(attachment+'.querySelector(".text-expand")');
  assert.equal(await evaluate(tab,attachment+'.querySelector(".text-source code").textContent'),config.source.replace(/\r\n/g,'\n').replace(/\n$/,''));
  await render(attachment);
  await click(attachment+'.querySelector(".media-copy > summary")');await click(attachment+'.querySelector(".text-copy-contents")');
  await until(()=>evaluate(tab,attachment+'.querySelector(".text-copy-status").textContent.includes("copied")'),'copy from rendered mode');
  assert.equal(await evaluate(tab,'navigator.clipboard.readText()'),config.source,'copy keeps full original CRLF source');
  await click(attachment+'.querySelector(".media-download")');
  await until(()=>fs.existsSync(path.join(config.downloads,'README.MD')),'download Markdown');
  assert.equal(fs.readFileSync(path.join(config.downloads,'README.MD'),'utf8'),config.source);
  await render('document.querySelector("#wiki-content > .mayfly-text")');
  const nested='document.querySelector("#wiki-content > .mayfly-text .text-rendered .text-markdown")';
  await click(nested);assert.ok(await evaluate(tab,'document.querySelector("#wiki-content > .mayfly-text .text-rendered .text-rendered h1")?.textContent==="Nested example"'),'nested Markdown stays lazy and renders on demand');
  await until(()=>evaluate(tab,card('empty.markdown')+'?.querySelector(".text-markdown")'),'empty file controls');
  await click(card('empty.markdown')+'.querySelector(".text-markdown")');assert.equal(await evaluate(tab,card('empty.markdown')+'.querySelector(".text-rendered").textContent'),'Nothing to preview.');
  await until(()=>evaluate(tab,card('large.md')+'?.querySelector(".text-markdown")'),'large file controls');
  assert.ok(await evaluate(tab,card('large.md')+'.querySelector(".text-markdown").disabled'),'UTF-8 byte limit');
  assert.match(await evaluate(tab,card('large.md')+'.querySelector(".text-copy-status").textContent'),/256 KiB/);
  const external=card('External handbook');await click(external+'.querySelector(".media-load")');
  await until(()=>evaluate(tab,external+'?.querySelector(".text-rendered h1")'),'external wiki Markdown rendered');
  assert.equal(await evaluate(tab,external+'.querySelector(".text-rendered").hidden'),false);
  assert.equal(await evaluate(tab,external+'.querySelector('+JSON.stringify('a[href*="page='+config.linkedID+'"]')+')'),null,'external source cannot resolve private wiki links');
  assert.equal(await evaluate(tab,'[...'+external+'.querySelectorAll("a")].find(a=>a.textContent==="Relative").href'),config.externalBase+'/guide');
  assert.equal(await evaluate(tab,'document.querySelector("iframe[src*=markdown-file-frame]")'),null,'loader removed after completion');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},tab.sessionId);
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},tab.sessionId);
  assert.ok(await evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),'mobile wiki width');
  assert.deepEqual(await evaluate(tab,'markdownErrors'),[]);assert.deepEqual(await evaluate(tab,'markdownCSP'),[]);
  console.log('PASS wiki: Markdown attachments/fences, nested previews, full source/copy/download, limits, safe links and external loading.');
  await cdp('Page.navigate',{url:config.base+'/'},tab.sessionId);
  await until(()=>evaluate(tab,'typeof newChannel==="function"'),'chat creation');await click('document.getElementById("newbtn")');
  await until(()=>evaluate(tab,'!!document.getElementById("compose")&&!document.getElementById("main").hidden'),'chat ready');
  const message=config.fenced+'\n\n'+['handbook.markdown','denied.md','large.md','chunked.md','binary.md'].map(name=>'['+name+']('+config.externalBase+'/'+name+')').join('\n\n')+'\n\n[Local guide]('+config.base+'/docs/wiki.md)';
  await evaluate(tab,'document.getElementById("text").value='+JSON.stringify(message)+';document.getElementById("compose").requestSubmit()');
  const code='document.querySelector("#log .mayfly-text")';await until(()=>evaluate(tab,code+'?.querySelector(".text-markdown")'),'chat Markdown fence');
  await render(code);
  await evaluate(tab,code+'.scrollIntoView({block:"start"})');await screenshot('chat-mobile-dark');
  assert.ok(await evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),'mobile chat width');
  await click(card('handbook.markdown')+'.querySelector(".media-load")');
  await until(()=>evaluate(tab,card('handbook.markdown')+'?.querySelector(".text-rendered h1")'),'chat external Markdown');
  assert.equal(await evaluate(tab,'[...'+card('handbook.markdown')+'.querySelectorAll("a")].find(a=>a.textContent==="Relative").href'),config.externalBase+'/guide');
  for(const name of ['denied.md','large.md','chunked.md','binary.md']) {
    const root=card(name);await click(root+'.querySelector(".media-load")');
    await until(()=>evaluate(tab,root+'.querySelector(".media-status").textContent.includes('+JSON.stringify(['large.md','chunked.md'].includes(name)?'256 KiB':'unavailable')+')'),'failure fallback '+name);
    assert.equal(await evaluate(tab,root+'.querySelector(".media-load").disabled'),false,'can retry');
    assert.ok(await evaluate(tab,root+'.querySelector(".media-download").href'),'download stays available');
  }
  await click(card('Local guide')+'.querySelector(".media-load")');
  await until(()=>evaluate(tab,card('Local guide')+'?.querySelector(".text-rendered h1")'),'same-origin Markdown file');
  assert.equal(await evaluate(tab,'document.querySelector("iframe[src*=markdown-file-frame]")'),null);
  assert.deepEqual(await evaluate(tab,'markdownErrors'),[]);assert.deepEqual(await evaluate(tab,'markdownCSP'),[]);
  console.log('PASS chat: full fenced Markdown, external/local files, CORS and binary fallback, bounded downloads, mobile and CSP.');
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const script=join(h.directory,'markdown-preview.cjs');await writeFile(script,'const config='+JSON.stringify(config)+';\n'+harness+'\n'+exercise);
  try {const {stdout}=await execute(process.execPath,[script],{timeout:95000,maxBuffer:1024*1024});t.diagnostic(stdout);}
  catch(error){throw new Error((error.stdout||'')+(error.stderr||error.message));}
  assert.equal(requests.filter(r=>r.path==='/handbook.markdown').length,2,'one explicit request per file preview');
  assert.ok(requests.every(r=>!r.authorization&&!r.referer&&!r.cookie),'external hosts receive no credentials or referrers');
  assert.ok(!requests.some(r=>r.path==='/never.png'||r.path==='/raw.png'),'rendering does not activate external resources');
});
