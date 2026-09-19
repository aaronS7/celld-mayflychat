// Exercise first paint and image/theme races against the production build.
// Only a loopback static server and disposable Chrome profile are used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert.ok(process.env.CHROME_BIN, 'Set CHROME_BIN to Chrome or Chromium');
const dist = fileURLToPath(new URL('../.vitepress/dist/', import.meta.url));
await readFile(join(dist, 'index.html')); // Run npm run build first.
const base = process.env.BASE_PATH || '/celld-mayflychat/';
const directory = await mkdtemp(join(tmpdir(), 'mayfly-doc-images-'));
const pending = new Set();
let scripts = true, images = true, failure = false;
const blocked = path => path.endsWith('.js') ? scripts : path.endsWith('.png') ? images : false;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/__control') {
    let body = ''; for await (const chunk of request) body += chunk;
    const values = JSON.parse(body);
    if ('scripts' in values) scripts = values.scripts;
    if ('images' in values) images = values.images;
    if ('failure' in values) failure = values.failure;
    for (const item of pending) if (!blocked(item.path)) item.release();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }
  if (!url.pathname.startsWith(base)) { response.writeHead(404).end(); return; }
  const path = resolve(dist, decodeURIComponent(url.pathname.slice(base.length)) || 'index.html');
  if (!path.startsWith(resolve(dist) + '/')) { response.writeHead(404).end(); return; }
  try {
    if (blocked(path)) await new Promise(release => {
      const item = { path, release: () => { pending.delete(item); release(); } };
      pending.add(item); response.on('close', item.release);
    });
    if (response.destroyed) return;
    if (failure && path.endsWith('chat-dark.png')) { response.writeHead(404).end(); return; }
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const config = { chrome: process.env.CHROME_BIN, profile: join(directory, 'chrome'), origin, base: origin + base };
const harness = await readFile(new URL('../../srv/testdata/chrome.cjs', import.meta.url), 'utf8');
const exercise = String.raw`
const control = async values => { await fetch(config.origin + '/__control', { method: 'POST', body: JSON.stringify(values) }); };
(async () => { try {
  const { targetInfos } = await cdp('Target.getTargets');
  const tab = await attach(targetInfos.find(t => t.type === 'page').targetId);
  await cdp('Network.enable', {}, tab.sessionId);
  await cdp('Network.setCacheDisabled', { cacheDisabled: true }, tab.sessionId);
  const probe = () => evaluate(tab, '(()=>{const f=document.querySelector(".demo-image-frame"),i=f?.querySelector("img");return {theme:document.documentElement?.classList.contains("dark")?"dark":"light",src:i?.getAttribute("src"),visible:!!i?.naturalWidth&&getComputedStyle(i).visibility==="visible",busy:f?.getAttribute("aria-busy"),label:f?.textContent.trim(),height:f?.getBoundingClientRect().height,href:f?.getAttribute("href"),spinner:f?.querySelector(".demo-image-spinner")?getComputedStyle(f.querySelector(".demo-image-spinner")).animationName:null};})()');
  const ready = theme => until(async()=>{const p=await probe();return p.theme===theme&&p.visible&&p.src.endsWith('-'+theme+'.png')&&p.busy==='false';},theme+' image ready');
  const placeholder = () => until(async()=>{const p=await probe();return p.height>100&&!p.visible&&p.label==='Loading screenshot…'&&p.busy==='true';},'loading placeholder');
  const toggle = () => evaluate(tab, 'document.querySelector(".VPSwitchAppearance").click()');
  let injected;
  for (const scenario of [
    { system: 'dark', saved: null, expected: 'dark', mobile: false },
    { system: 'light', saved: 'dark', expected: 'dark', mobile: true },
    { system: 'dark', saved: 'light', expected: 'light', mobile: false },
  ]) {
    if(injected) await cdp('Page.removeScriptToEvaluateOnNewDocument', {identifier:injected}, tab.sessionId);
    const setup = 'localStorage.'+(scenario.saved?'setItem("vitepress-theme-appearance",'+JSON.stringify(scenario.saved)+')':'removeItem("vitepress-theme-appearance")')+';window.wrongPaint=[];window.pageErrors=[];window.addEventListener("error",e=>{if(e.message)pageErrors.push(e.message)});window.addEventListener("unhandledrejection",e=>pageErrors.push(String(e.reason)));function inspect(){const theme=document.documentElement.classList.contains("dark")?"dark":"light";for(const img of document.querySelectorAll(".demo-image img")){if(img.naturalWidth&&getComputedStyle(img).visibility==="visible"&&!img.src.endsWith("-"+theme+".png"))wrongPaint.push(img.src);}requestAnimationFrame(inspect)}requestAnimationFrame(inspect);';
    injected=(await cdp('Page.addScriptToEvaluateOnNewDocument',{source:setup},tab.sessionId)).identifier;
    await control({ scripts: true, images: false, failure: false });
    await cdp('Emulation.setDeviceMetricsOverride',{width:scenario.mobile?390:1440,height:scenario.mobile?844:1040,deviceScaleFactor:1,mobile:scenario.mobile},tab.sessionId);
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scenario.system}]},tab.sessionId);
    await cdp('Page.navigate',{url:config.base},tab.sessionId);
    await placeholder();
    const before=await probe();assert.equal(before.theme,scenario.expected);
    await sleep(120);
    assert.deepEqual(await evaluate(tab,'wrongPaint'),[],'no opposite-theme screenshot before hydration');
    await control({scripts:false,images:true});
    await until(async()=>Boolean((await probe()).src),'theme resolved after hydration');
    await placeholder();
    await control({images:false});await ready(scenario.expected);
    assert.ok(Math.abs((await probe()).height-before.height)<1,'reserved image area prevents layout shift');
    assert.ok((await probe()).href.endsWith('-'+scenario.expected+'.png'),'full-size link follows theme');
    assert.deepEqual(await evaluate(tab,'wrongPaint'),[]);assert.deepEqual(await evaluate(tab,'pageErrors'),[]);
    console.log('PASS cold load: system='+scenario.system+', saved='+scenario.saved+', mobile='+scenario.mobile);
  }
  // A ready light image must disappear immediately while the new dark image is slow.
  await control({images:true});await toggle();await placeholder();
  // setEmulatedMedia replaces all media overrides; keep the system theme stable.
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]},tab.sessionId);
  assert.equal((await probe()).spinner,'none','loader respects reduced motion');
  await toggle();
  await until(async()=>{const p=await probe();return p.theme==='light'&&(!p.visible||p.src.endsWith('-light.png'));},'cached light image or placeholder');
  await toggle();await placeholder();
  await control({images:false});await ready('dark');
  assert.deepEqual(await evaluate(tab,'wrongPaint'),[],'rapid switches never expose stale imagery');
  console.log('PASS delayed and rapid theme switches, reduced motion');
  // A failed screenshot must finish loading with readable feedback.
  await cdp('Page.navigate',{url:config.base},tab.sessionId);
  await ready('light');await control({failure:true});await toggle();
  await until(async()=>{const p=await probe();return p.label==='Screenshot unavailable'&&p.busy==='false'&&!p.visible;},'image failure feedback');
  await control({failure:false});await toggle();await ready('light');await toggle();await ready('dark');
  console.log('PASS failed image feedback and recovery');
  // Lazy screenshots, including an initially collapsed mobile example.
  await cdp('Page.navigate',{url:config.base+'guide/summaries.html'},tab.sessionId);
  await until(()=>evaluate(tab,'!!document.querySelector(".demo-image-frame img")'),'lazy screenshot mounted');
  await evaluate(tab,'document.querySelector(".demo-image-frame").scrollIntoView({block:"center"})');await ready('light');
  await evaluate(tab,'document.querySelector(".demo-image").nextElementSibling.open=true;document.querySelectorAll(".demo-image-frame")[1].scrollIntoView({block:"center"})');
  await until(()=>evaluate(tab,'document.querySelectorAll(".demo-image-frame img.is-ready").length===2'),'expanded mobile screenshot loaded');
  assert.deepEqual(await evaluate(tab,'wrongPaint'),[]);assert.deepEqual(await evaluate(tab,'pageErrors'),[]);
  console.log('PASS lazy screenshots and collapsed mobile example');
} finally {chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
try {
  const script = join(directory, 'images.cjs');
  await writeFile(script, 'const config=' + JSON.stringify(config) + ';\n' + harness + '\n' + exercise);
  const result = await promisify(execFile)(process.execPath, [script], { timeout: 60000 });
  process.stdout.write(result.stdout);
} catch (error) {
  process.stdout.write(error.stdout || '');
  process.stderr.write(error.stderr || String(error));
  process.exitCode = 1;
} finally {
  for (const item of pending) item.release();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
