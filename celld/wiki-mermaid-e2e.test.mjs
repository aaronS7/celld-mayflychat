import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, page, post, wikiHarness } from './wiki-test-helper.mjs';

test('wiki Mermaid fences render as inert images in saved pages and previews', {timeout:90000}, async t=>{
  assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN for the Mermaid browser test');
  const h=await wikiHarness(t),wiki=await h.create('Diagram handbook');
  const plain=(await wiki.request('/pages',post(page('Plain','# Plain\n\nNo diagrams here.')))).body;
  const markdown=[
    '# Diagrams',
    '```mermaid\nflowchart LR\n  Start --> Finish\n```',
    '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n```',
    '```mermaid\nflowchart LR\n  X["<img src=x onerror=parent.mermaidUnsafe=true>"] --> Y\n```',
    '```mermaid\nnot a Mermaid diagram\n```',
    '```mermaid\n'+('x'.repeat(8200))+'\n```',
  ].join('\n\n');
  const diagrams=(await wiki.request('/pages',post(page('Diagrams',markdown)))).body;
  const url=id=>{const target=new URL(wiki.url);target.searchParams.set('page',id);return target.href;};
  const response=await h.http('/static/mermaid.js',{method:'HEAD'});
  assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/^text\/javascript/);
  const frameResponse=await h.http('/static/mermaid-frame',{method:'HEAD'});
  assert.equal(frameResponse.status,200);assert.match(frameResponse.headers.get('Content-Security-Policy'),/default-src 'none'/);
  const config={chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome'),plain:url(plain.id),diagrams:url(diagrams.id)};
  let harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
  harness=harness.replace('const msg=JSON.parse(raw), p=pending.get(msg.id);','const msg=JSON.parse(raw); if(msg.method==="Network.requestWillBeSent") requests.push(msg.params.request.url); const p=pending.get(msg.id);');
  const exercise=String.raw`
const requests=[];
(async()=>{try{
  const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
  await cdp('Network.enable',{},tab.sessionId);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.diagramErrors=[];window.diagramViolations=[];addEventListener("error",e=>{if(e.message)diagramErrors.push(e.message)});addEventListener("unhandledrejection",e=>diagramErrors.push(String(e.reason)));addEventListener("securitypolicyviolation",e=>diagramViolations.push(e.violatedDirective));'},tab.sessionId);
  await cdp('Page.navigate',{url:config.plain},tab.sessionId);
  await until(()=>evaluate(tab,'document.getElementById("wiki-content")?.textContent.includes("No diagrams here.")'),'plain page');
  assert.equal(await evaluate(tab,'document.querySelectorAll(".wiki-mermaid-frame").length'),0,'renderer is lazy');
  await cdp('Page.navigate',{url:config.diagrams},tab.sessionId);
  await until(()=>evaluate(tab,'document.querySelectorAll("#wiki-content .wiki-mermaid").length===5'),'diagram cards');
  await until(()=>evaluate(tab,'document.querySelectorAll("#wiki-content .wiki-mermaid img").length===2'),'rendered diagrams').catch(async error=>{console.error(await evaluate(tab,'({cards:[...document.querySelectorAll("#wiki-content .wiki-mermaid")].map(c=>({status:c.querySelector("p")?.textContent,source:c.querySelector("pre")?.textContent.slice(0,100)})),renderer:!!window.mayflyMermaid,errors:diagramErrors,violations:diagramViolations})'));console.error(requests.filter(url=>url.includes('mermaid')));throw error;});
  await until(()=>evaluate(tab,'[...document.querySelectorAll("#wiki-content .wiki-mermaid img")].every(i=>i.complete&&i.naturalWidth>0)'),'decoded diagrams');
  assert.equal(await evaluate(tab,'document.querySelectorAll(".wiki-mermaid-frame").length'),1,'one sandboxed renderer');
  assert.equal(await evaluate(tab,'document.querySelector(".wiki-mermaid-frame").sandbox.value'),'allow-scripts');
  assert.ok(await evaluate(tab,'[...document.querySelectorAll("#wiki-content .wiki-mermaid img")].every(i=>i.src.startsWith("data:image/svg+xml"))'));
  assert.equal(await evaluate(tab,'document.querySelector("#wiki-content .wiki-mermaid svg")'),null,'SVG is never inserted into page DOM');
  assert.equal(await evaluate(tab,'window.mermaidUnsafe'),undefined);
  await until(()=>evaluate(tab,'document.querySelectorAll("#wiki-content .wiki-mermaid")[3]?.querySelector("details")?.open'),'invalid source fallback');
  assert.ok(await evaluate(tab,'document.querySelectorAll("#wiki-content .wiki-mermaid")[4].querySelector("details").open'),'oversized source stays visible');
  assert.ok(await evaluate(tab,'document.querySelector("#wiki-content .wiki-mermaid:last-child")?.textContent.includes("8 KiB")'),'oversized diagram is bounded');
  assert.ok(!requests.some(url=>url.includes('example.invalid')||url.includes('/x')),'diagram does not request external assets');
  await evaluate(tab,'document.getElementById("wiki-edit").click()');
  await until(()=>evaluate(tab,'!document.getElementById("wiki-editor").hidden'),'editor');
  await evaluate(tab,'document.getElementById("wiki-preview-button").click()');
  await until(()=>evaluate(tab,'document.querySelector("#wiki-preview .wiki-mermaid img")?.naturalWidth>0'),'editor preview diagram');
  assert.deepEqual(await evaluate(tab,'diagramErrors'),[]);assert.deepEqual(await evaluate(tab,'diagramViolations'),[]);
  console.log('Mermaid diagrams render in saved pages and editor previews with lazy loading, source fallback and CSP.');
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const script=join(h.directory,'mermaid.cjs');await writeFile(script,'const config='+JSON.stringify(config)+';\n'+harness+'\n'+exercise);
  const {stdout}=await execute(process.execPath,[script],{timeout:80000,maxBuffer:1024*1024});t.diagnostic(stdout);
});
