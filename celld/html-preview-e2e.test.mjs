import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, page, post, wikiHarness } from './wiki-test-helper.mjs';

test('opt-in HTML previews isolate untrusted wiki and attachment content', {timeout:120000}, async t=>{
  assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN for the real browser test');
  const h=await wikiHarness(t),wiki=await h.create('HTML handbook');
  const hits=[];
  const external=createServer((req,res)=>{hits.push(req.url);res.writeHead(200,{'Content-Type':'text/plain'}).end('external');});
  await new Promise(resolve=>external.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{external.closeAllConnections();external.close(resolve);}));
  const externalBase='http://127.0.0.1:'+external.address().port;
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  const hostile=[
    '<!doctype html><html><head>',
    '<style>.preview-ok{color:rgb(24, 113, 72);background-image:url("'+externalBase+'/css-image")}@import url("'+externalBase+'/import.css");#rendered{border-image:url(/config?html-preview-probe) 1}</style>',
    '<meta http-equiv="refresh" content="0;url='+externalBase+'/refresh">',
    '<base href="'+externalBase+'/base/">',
    '</head><body>',
    '<div id="rendered" class="preview-ok" style="font-weight: 700">Rendered <strong>HTML</strong></div>',
    '<img id="remote" src="'+externalBase+'/image" onerror="parent.previewPwned=true">',
    '<img id="data-image" src="data:image/png;base64,'+png+'" alt="local pixel">',
    '<img id="srcset" src="data:image/png;base64,'+png+'" srcset="'+externalBase+'/srcset 2x">',
    '<img id="svg-image" src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+">',
    '<svg onload="parent.previewPwned=true"><image href="'+externalBase+'/svg-resource"></image></svg>',
    '<a href="'+externalBase+'/link">External link</a>',
    '<form action="'+externalBase+'/form"><input name="secret" value="no"></form>',
    '<iframe src="'+externalBase+'/nested"></iframe>',
    '<script>parent.previewPwned=true;fetch("'+externalBase+'/script")</script>',
    '</body></html>'
  ].join('');
  const attachmentPath=join(h.directory,'sample.html');await writeFile(attachmentPath,'<h2 id="attachment-rendered">Attached HTML</h2><script>parent.previewPwned=true</script>');
  const client=join(h.directory,'wiki.mjs');await writeFile(client,(await h.http('/static/wiki.mjs')).text);
  const uploaded=JSON.parse((await execute(process.execPath,[client,'upload',wiki.url,attachmentPath])).stdout);
  const markdown='# HTML previews\n\n```html\n'+hostile+'\n```\n\n'+uploaded.markdown+'\n\n<script>parent.rawPwned=true</script>';
  const created=(await wiki.request('/pages',post(page('HTML previews',markdown)))).body;
  const target=new URL(wiki.url);target.searchParams.set('page',created.id);
  const frameResponse=await h.http('/static/html-preview-frame',{method:'HEAD'});
  assert.equal(frameResponse.status,200);
  const policy=frameResponse.headers.get('Content-Security-Policy');
  for(const rule of ["sandbox allow-scripts","default-src 'none'","style-src 'unsafe-inline'","img-src data:","connect-src 'none'","frame-src 'none'","form-action 'none'","base-uri 'none'"])assert.ok(policy.includes(rule),rule);
  assert.ok(/script-src 'nonce-[^']+'/.test(policy));
  const config={chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome'),url:target.href,externalBase};
  let harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
  harness=harness.replace('const msg=JSON.parse(raw), p=pending.get(msg.id);','const msg=JSON.parse(raw); if(msg.method==="Network.requestWillBeSent") requests.push(msg.params.request.url); const p=pending.get(msg.id);');
  const exercise=String.raw`
const requests=[];
(async()=>{try{
  const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
  await cdp('Network.enable',{},tab.sessionId);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.previewErrors=[];addEventListener("error",e=>previewErrors.push(e.message));addEventListener("unhandledrejection",e=>previewErrors.push(String(e.reason)));'},tab.sessionId);
  await cdp('Page.navigate',{url:config.url},tab.sessionId);
  await until(()=>evaluate(tab,'document.querySelector("#wiki-content .wiki-html")?.textContent.includes("Rendered")'),'HTML fence source');
  assert.equal(await evaluate(tab,'document.querySelectorAll(".wiki-html-frame").length'),0,'HTML iframe is lazy');
  assert.equal(await evaluate(tab,'window.rawPwned'),undefined,'raw Markdown HTML stays inert');
  await until(()=>evaluate(tab,'!!document.querySelector("#wiki-content .mayfly-media .wiki-html")'),'attachment preview control');
  const fence='document.querySelector("#wiki-content > .wiki-html")';
  await evaluate(tab,fence+'.querySelector("button").click()');
  await until(()=>evaluate(tab,fence+'.querySelector(".wiki-html-frame") && '+fence+'.querySelector("[role=status]").textContent===""'),'fenced HTML rendered');
  assert.equal(await evaluate(tab,fence+'.querySelector("iframe").sandbox.value'),'allow-scripts');
  assert.equal(await evaluate(tab,'(()=>{try{return !!'+fence+'.querySelector("iframe").contentWindow.document}catch(e){return e.name}})()'),'SecurityError','frame has opaque origin');
  const previewTarget=(await cdp('Target.getTargets')).targetInfos.find(target=>target.type==='iframe' && target.url.includes('/static/html-preview-frame'));
  assert.ok(previewTarget,'preview iframe target exists');
  const previewTab=await attach(previewTarget.targetId);
  await cdp('Network.enable',{},previewTab.sessionId);
  async function inside(expression){return evaluate(previewTab,expression);}
  const dom=await inside('({text:document.getElementById("content").textContent,script:document.querySelectorAll("#content script").length,frames:document.querySelectorAll("#content iframe").length,svg:document.querySelectorAll("#content svg").length,links:document.querySelectorAll("#content a[href]").length,forms:document.querySelectorAll("#content form").length,refresh:document.querySelectorAll("#content meta[http-equiv=refresh]").length,remote:document.getElementById("remote")?.getAttribute("src"),srcset:document.getElementById("srcset")?.getAttribute("srcset"),svgImage:document.getElementById("svg-image")?.getAttribute("src"),pixel:document.getElementById("data-image")?.naturalWidth,color:getComputedStyle(document.getElementById("rendered")).color,origin:self.origin,hash:location.hash})');
  assert.ok(dom.text.includes('Rendered HTML'),'normal HTML renders');
  assert.equal(dom.script,0);assert.equal(dom.frames,0);assert.equal(dom.svg,0);assert.equal(dom.links,0);assert.equal(dom.forms,0);assert.equal(dom.refresh,0);
  assert.equal(dom.remote,null,'remote URL removed');assert.equal(dom.srcset,null,'responsive image URL removed');assert.equal(dom.svgImage,null,'SVG data URL removed');assert.equal(dom.pixel,1,'raster data image renders');
  assert.equal(dom.color,'rgb(24, 113, 72)','inline stylesheet applies');
  assert.equal(dom.origin,'null','opaque origin');assert.equal(dom.hash,'','frame has no wiki key');
  assert.equal(await inside('fetch('+JSON.stringify(config.externalBase+'/fetch')+').then(()=>"allowed",()=>"blocked")'),'blocked','frame CSP blocks fetch');
  const sameOrigin=await inside('new Promise(resolve=>{const image=new Image();const timer=setTimeout(()=>resolve("no violation"),500);addEventListener("securitypolicyviolation",event=>{if(event.blockedURI.includes("html-preview-probe")){clearTimeout(timer);resolve(event.violatedDirective)}},{once:true});image.src="/config?html-preview-probe=1"})');
  assert.match(sameOrigin,/img-src/,'frame CSP blocks same-origin images');
  await inside('(()=>{try{top.location.href='+JSON.stringify(config.externalBase+'/top-navigation')+'}catch{}})()');
  await sleep(100);
  assert.equal(await evaluate(tab,'location.href'),config.url,'sandbox blocks top-level navigation');
  assert.equal(await evaluate(tab,'window.previewPwned'),undefined,'source script cannot access parent');
  await evaluate(tab,'document.querySelector("#wiki-content .mayfly-media .wiki-html button").click()');
  await until(()=>evaluate(tab,'document.querySelector("#wiki-content .mayfly-media .wiki-html iframe") && document.querySelector("#wiki-content .mayfly-media .wiki-html [role=status]").textContent===""'),'attachment HTML rendered');
  assert.equal(await evaluate(tab,'document.querySelectorAll("#wiki-content .wiki-html-frame").length'),2);
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false},tab.sessionId);
  assert.ok(await evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),'previews fit mobile viewport');
  await evaluate(tab,fence+'.querySelector("button").click()');
  assert.equal(await evaluate(tab,'document.querySelectorAll("#wiki-content > .wiki-html iframe").length'),0,'hide removes iframe');
  await evaluate(tab,'document.getElementById("wiki-edit").click()');
  await until(()=>evaluate(tab,'!document.getElementById("wiki-editor").hidden'),'editor');
  await evaluate(tab,'document.getElementById("wiki-preview-button").click()');
  await until(()=>evaluate(tab,'!!document.querySelector("#wiki-preview .wiki-html button")'),'editor preview control');
  assert.equal(await evaluate(tab,'document.querySelectorAll("#wiki-preview .wiki-html iframe").length'),0,'editor preview also opt-in');
  const bounded=await evaluate(tab,'(()=>{const block=wikiHtmlBlock("x".repeat(262145));return {disabled:block.querySelector("button").disabled,status:block.querySelector("[role=status]").textContent}})()');
  assert.equal(bounded.disabled,true);assert.match(bounded.status,/256 KiB/);
  assert.ok(!requests.some(url=>url.startsWith(config.externalBase)),'no external requests');
  assert.ok(!requests.some(url=>url.includes('/refresh')||url.includes('/form')||url.includes('/css-image')),'no navigation or CSS request');
  assert.deepEqual(await evaluate(tab,'previewErrors'),[]);
  console.log('HTML preview iframe isolated source, blocked scripts/resources/navigation, rendered safe content, and stayed opt-in.');
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const script=join(h.directory,'html-preview.cjs');await writeFile(script,'const config='+JSON.stringify(config)+';\n'+harness+'\n'+exercise);
  const {stdout}=await execute(process.execPath,[script],{timeout:95000,maxBuffer:1024*1024});t.diagnostic(stdout);
  assert.deepEqual(hits,[],'sandbox must make no outside HTTP requests');
});
