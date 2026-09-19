// Capture Mayfly's real summary dialog using disposable local data and a
// deterministic local streaming provider. No production keys or content.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.ok(process.env.CHROME_BIN, 'Set CHROME_BIN to Chrome or Chromium');
const root = resolve(process.env.MAYFLY_CHECKOUT || fileURLToPath(new URL('../../', import.meta.url)));
const output = resolve(process.env.SUMMARY_CAPTURE_DIR || join(root, 'website/public/media'));
const { summaryHarness } = await import(pathToFileURL(join(root, 'celld/summary-test-helper.mjs')));
const { execute, post } = await import(pathToFileURL(join(root, 'celld/wiki-test-helper.mjs')));
const cleanup = [];
await mkdir(output, { recursive: true });
try {
  const h = await summaryHarness({ after: finish => cleanup.push(finish) });
  h.mercury.output = '### Release overview\n\nShip the small release Friday after checks pass. [1]\n\n- Verify service health. [2]\n- Record the outcome before announcing completion. [2]';
  const wiki = await h.create('Release handbook');
  const release = await wiki.request('/pages', post({
    title: 'Release plan', path: 'release-plan', author: 'release-team',
    markdown: '# Release plan\n\nShip a small release on Friday after verification passes.\n\n## Decision\n\nKeep the change small and confirm service health before announcing completion.\n\n## Next step\n\nFollow the verification checklist and record the outcome.\n\n## Detailed checklist\n\n' +
      Array.from({ length: 50 }, (_, index) => '- Check ' + (index + 1) + ': Verify the release in the test environment, confirm service health, and record the observed outcome.').join('\n'),
  }));
  assert.equal(release.status, 201);
  const checklist = await wiki.request('/pages', post({
    title: 'Verification checklist', path: 'verification', author: 'release-team',
    markdown: '# Verification checklist\n\nConfirm service health after the release. Record the outcome before announcing completion.\n\n## Checks\n\n- Read a page.\n- Confirm the new behavior.\n- Record the result.',
  }));
  assert.equal(checklist.status, 201);
  const config = {
    chrome: process.env.CHROME_BIN, profile: join(h.directory, 'chrome'), output,
    url: wiki.url.replace('#', '?page=' + release.body.id + '#'),
  };
  const harness = await readFile(join(root, 'srv/testdata/chrome.cjs'), 'utf8');
  const exercise = String.raw`
(async () => { try {
  const { targetInfos } = await cdp('Target.getTargets');
  const tab = await attach(targetInfos.find(t => t.type === 'page').targetId);
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.captureErrors=[];window.addEventListener('error',e=>captureErrors.push(e.message));window.addEventListener('unhandledrejection',e=>captureErrors.push(String(e.reason)));"
  }, tab.sessionId);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
  await cdp('Page.navigate', { url: config.url }, tab.sessionId);
  await until(() => evaluate(tab, '!!document.getElementById("wiki-summary-all") && !document.getElementById("wiki-summary-page").disabled && !!document.querySelector("#wiki-content h1")'), 'summary controls');
  const click = async selector => {
    const point = await evaluate(tab, '(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, tab.sessionId);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, tab.sessionId);
  };
  await click('#wiki-summary-all');
  await until(() => evaluate(tab, 'document.getElementById("ai-summary-state").textContent === "Summary complete."'), 'completed summary');
  assert.match(await evaluate(tab, 'document.getElementById("ai-summary-coverage").textContent'), /Bounded overview.*2 of 2 pages.*Excerpts.*mercury-2\.5/);
  await click('.ai-summary-sources summary');
  assert.equal(await evaluate(tab, 'document.querySelectorAll(".ai-summary-sources a").length'), 2);
  for (const device of ['desktop', 'mobile']) {
    const mobile = device === 'mobile';
    await cdp('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 1040, deviceScaleFactor: 1, mobile }, tab.sessionId);
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: mobile }, tab.sessionId);
    for (const theme of ['light', 'dark']) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, tab.sessionId);
      await evaluate(tab, 'document.fonts.ready');
      await evaluate(tab, 'document.getElementById("ai-summary-dialog").scrollTop = 0');
      await sleep(100);
      const dimensions = await evaluate(tab, '(()=>{const dialog=document.getElementById("ai-summary-dialog");const last=document.querySelector(".ai-summary-actions button:last-child").getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth||dialog.scrollWidth>dialog.clientWidth,actionsVisible:last.bottom<=innerHeight,dialogScrollHeight:dialog.scrollHeight,dialogHeight:dialog.clientHeight};})()');
      assert.equal(dimensions.overflow, false, 'capture must not overflow horizontally');
      assert.equal(dimensions.actionsVisible, true, 'completed summary actions should be visible');
      const name = 'summary' + (mobile ? '-mobile' : '') + '-' + theme + '.png';
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, tab.sessionId);
      require('node:fs').writeFileSync(require('node:path').join(config.output, name), Buffer.from(data, 'base64'));
      console.log(name + ': ' + (mobile ? '390 x 844' : '1440 x 1040'));
    }
  }
  assert.deepEqual(await evaluate(tab, 'captureErrors'), []);
} finally { chrome.kill('SIGTERM'); await exited; } })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const script = join(h.directory, 'capture-summary.cjs');
  await writeFile(script, 'const config=' + JSON.stringify(config) + ';\n' + harness + '\n' + exercise, { mode: 0o600 });
  const { stdout } = await execute(process.execPath, [script], { timeout: 30000 });
  assert.equal(h.provider.requests.length, 0, 'capture must never call Jev');
  assert.equal(h.mercury.requests.length, 1, 'capture must use one local summary request');
  assert.equal((await wiki.request('', { method: 'DELETE' })).status, 204);
  console.log(stdout.trim());
  console.log('Captured the real summary dialog. Synthetic content and local provider fixture only; temporary wiki deleted.');
} finally {
  for (const finish of cleanup.reverse()) await finish();
}
