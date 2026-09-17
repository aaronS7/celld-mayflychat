import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("real Chrome creates, chats across tabs, renders safely, and deletes on native celld", { timeout: 60000 }, async t => {
  assert.ok(process.env.CHROME_BIN, "Set CHROME_BIN to run the real browser check");
  const dir = await mkdtemp(join(tmpdir(), "mayfly-native-browser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { chrome: process.env.CHROME_BIN, profile: join(dir, "profile"), base: process.env.MAYFLY_BASE_URL || "http://127.0.0.1:9890", rejectionText: process.env.MAYFLY_TEST_REJECTION_TEXT, tags: process.env.MAYFLY_TEST_TAGS ? JSON.parse(process.env.MAYFLY_TEST_TAGS) : undefined };
  const harness = await readFile(new URL("../srv/testdata/chrome.cjs", import.meta.url), "utf8");
  const exercise = String.raw`
  (async () => {
    const {targetId} = await cdp('Target.createTarget', {url:'about:blank'});
    const alice = await attach(targetId);
    const guard = "window.testViolations=[]; addEventListener('securitypolicyviolation', e=>testViolations.push(e.violatedDirective)); window.testErrors=[]; addEventListener('error', e=>testErrors.push(e.message));";
    await cdp('Page.addScriptToEvaluateOnNewDocument', {source:guard}, alice.sessionId);
    await cdp('Page.navigate', {url:config.base+'/'}, alice.sessionId);
    await until(()=>evaluate(alice, "document.readyState==='complete' && typeof newChannel==='function'"), 'landing scripts');
    await evaluate(alice, "document.getElementById('newbtn').click()");
    await until(()=>evaluate(alice, "typeof KS!=='undefined' && KS && !document.getElementById('main').hidden"), 'created chat');
    const url = await evaluate(alice, 'location.href');
    assert.match(url, /\/c\/[\w-]{22}#[\w-]{43}$/);
    const created = await cdp('Target.createTarget', {url:'about:blank'});
    const bob = await attach(created.targetId);
    await cdp('Page.addScriptToEvaluateOnNewDocument', {source:guard}, bob.sessionId);
    await cdp('Page.navigate', {url}, bob.sessionId);
    await until(()=>evaluate(bob, "typeof KS!=='undefined' && KS && !document.getElementById('main').hidden"), 'second reader');
    const send = async (tab, text) => {
      await evaluate(tab, "document.getElementById('text').value="+JSON.stringify(text)+"; document.getElementById('compose').requestSubmit()");
      await until(()=>evaluate(tab, "document.getElementById('text').value==='' && !document.getElementById('sendbtn').disabled"), 'post acknowledged');
    };
    const privacy = await evaluate(alice, "document.getElementById('privacy').textContent");
    assert.match(privacy, /Messages are (end-to-end encrypted|readable by this server)/);
    if (config.rejectionText) {
      await evaluate(alice, "document.getElementById('text').value="+JSON.stringify(config.rejectionText)+"; document.getElementById('compose').requestSubmit()");
      await until(()=>evaluate(alice, "document.getElementById('status').textContent.includes('rejected') && !document.getElementById('sendbtn').disabled"), 'rejected post');
      assert.equal(await evaluate(alice, "document.getElementById('text').value"), config.rejectionText);
      assert.equal(await evaluate(alice, 'identity.locked'), false);
      assert.equal(await evaluate(bob, 'session.last'), -1);
      assert.match(privacy, /screened by TypeSafe Jev/);
    }
    await send(alice, 'Hello **native celld** 👋');
    await until(()=>evaluate(bob, "document.getElementById('log').textContent.includes('Hello native celld 👋')"), 'cross-tab delivery');
    assert.equal(await evaluate(bob, "document.querySelector('#log strong').textContent"), 'native celld');
    if (config.tags) {
      assert.deepEqual(await evaluate(bob, "[...document.querySelectorAll('#m0 .message-tag')].map(el=>el.textContent)"), config.tags);
      await cdp('Page.reload', {}, bob.sessionId);
      await until(()=>evaluate(bob, "document.querySelectorAll('#m0 .message-tag').length > 0"), 'tags restored after reload');
      assert.deepEqual(await evaluate(bob, "[...document.querySelectorAll('#m0 .message-tag')].map(el=>el.textContent)"), config.tags);
      // Even hostile metadata must not render HTML or arbitrary tag names.
      await evaluate(bob, "row({seq:999,ts:new Date().toISOString(),src:'',tags:['research','<img src=x onerror=window.pwned=1>','research']},'safe','test',null,null)");
      assert.deepEqual(await evaluate(bob, "[...document.querySelectorAll('#m999 .message-tag')].map(el=>el.textContent)"), ['research']);
    }
    await send(bob, '/title Native durable chat');
    await until(()=>evaluate(alice, "document.getElementById('title').textContent==='Native durable chat'"), 'title delivered');
    await send(bob, '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>');
    await until(()=>evaluate(alice, 'session.last===2'), 'opaque HTML message delivered');
    assert.equal(await evaluate(alice, '!!window.pwned'), false);
    const missingKey = await cdp('Target.createTarget', {url:'about:blank'});
    const guest = await attach(missingKey.targetId);
    await cdp('Page.navigate', {url:url.split('#')[0]}, guest.sessionId);
    await until(()=>evaluate(guest, "document.readyState==='complete' && document.getElementById('nokey') && !document.getElementById('nokey').hidden"), 'missing key warning');
    for (const tab of [alice,bob]) {
      assert.deepEqual(await evaluate(tab, 'testViolations'), [], 'CSP violations');
      assert.deepEqual(await evaluate(tab, 'testErrors'), [], 'browser errors');
    }
    // The missing-key check left another tab active. Chrome can defer a
    // background dialog's close event, so exercise the visible confirmation
    // button as a person would; the other tab must still react by polling.
    await cdp('Page.bringToFront', {}, alice.sessionId);
    await evaluate(alice, "document.getElementById('delbtn').click()");
    await until(()=>evaluate(alice, "document.getElementById('deldialog').open"), 'delete confirmation');
    await evaluate(alice, "document.querySelector('#deldialog button[value=delete]').click()");
    await until(()=>evaluate(bob, "document.querySelector('h1')?.textContent==='No such channel'"), 'deletion wakes the other tab');
    await cdp('Page.navigate', {url:config.base+'/docs/protocol.md'}, guest.sessionId);
    await until(()=>evaluate(guest, "document.querySelector('#document h1')?.textContent==='Protocol'"), 'documentation rendering');
    console.log('Chrome: creation, configured transport, long polling, Markdown, title, key warning, CSP, docs, deletion passed');
    await cdp('Browser.close'); await exited;
  })().then(()=>process.exit(0), async error=>{console.error(error);chrome.kill();await exited;process.exit(1)});
  `;
  const path = join(dir, "browser.cjs");
  await writeFile(path, `const config=${JSON.stringify(config)};\n${harness}\n${exercise}`);
  const child = spawn(process.execPath, [path], { stdio: ["ignore", "pipe", "pipe"], timeout: 55000 });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, output);
  t.diagnostic(output.trim());
});
