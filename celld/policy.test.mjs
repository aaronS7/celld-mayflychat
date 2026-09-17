// Exercise admission in the real celld runtime, with a local TypeSafe fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("encryption and Jev message admission on celld 0.5", { timeout: 240000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "mayfly-policy-"));
  let child, done, output = "", generation = 0;
  let injection = 0, exfiltration = 0, providerStatus = 200, hold;
  const requests = [];
  const rejectedText = "Synthetic rejected sample for admission testing.";
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ authorization: req.headers.authorization, body });
    if (hold) await hold;
    res.writeHead(providerStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "fixture", answers: {
      prompt_injection: { type: "noul", noul: body.state.message.text === rejectedText ? 0.7 : injection },
      data_exfiltration: { type: "noul", noul: exfiltration },
    } }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  async function stop() {
    if (!child) return;
    child.kill("SIGINT");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try { await done; } finally { clearTimeout(timer); child = undefined; }
  }
  t.after(async () => {
    await stop();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await cp(new URL("./native/", import.meta.url), join(dir, "celld/native"), { recursive: true });
  const config = JSON.parse((await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
  delete config.vars.ENCRYPTION_ENABLED;
  delete config.vars.JEV_ENABLED;
  await writeFile(join(dir, "wrangler.json"), JSON.stringify(config));
  // Only the isolated copy points to the fixture. Production has no endpoint override.
  const adapter = join(dir, "celld/native/moderation.ts");
  const source = await readFile(adapter, "utf8");
  assert.ok(source.includes('"https://api.typesafe.ai/v1/systemone"'));
  await writeFile(adapter, source.replace('"https://api.typesafe.ai/v1/systemone"', JSON.stringify(`http://127.0.0.1:${provider.address().port}/v1/systemone`)));
  const picker = tcpServer();
  await new Promise(resolve => picker.listen(0, "127.0.0.1", resolve));
  const port = picker.address().port;
  await new Promise(resolve => picker.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  async function http(path, init = {}) {
    const response = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(20000), ...init });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  }
  async function start(vars = {}) {
    await stop();
    await writeFile(join(dir, ".dev.vars"), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    child = spawn("celld", ["dev", dir, "--port", String(port), "--no-watch", "--logs"], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CELLD_TOKIO_THREADS: "2" },
    });
    output = "";
    child.stdout.on("data", b => { output += b; });
    child.stderr.on("data", b => { output += b; });
    done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    done.catch(() => {});
    const end = Date.now() + 20000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await http("/.well-known/celld/health", { signal: AbortSignal.timeout(500) })).status === 200) break; } catch {}
      assert.ok(Date.now() < end, output);
      await delay(100);
    }
    generation++;
  }
  async function create(encryption = "0", previous) {
    const key = randomBytes(32);
    const derive = (label, n) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), label, n)).toString("base64url");
    const c = previous || { id: derive("mayfly id", 16), auth: derive("mayfly auth", 32), key: key.toString("base64url") };
    c.auth_hash = createHash("sha256").update(c.auth).digest("base64url");
    c.path = `/c/${c.id}`;
    c.headers = { Authorization: `Bearer ${c.auth}` };
    assert.equal((await http("/new", { method: "POST", body: JSON.stringify({ id: c.id, auth_hash: c.auth_hash, encryption }) })).status, 303);
    return c;
  }
  const plain = (text = "Synthetic test message", from = "Alice") => ({ nonce: randomBytes(12).toString("base64url"), from, text });
  const cipher = () => ({ nonce: randomBytes(12).toString("base64url"), ct: randomBytes(16).toString("base64url") });
  const post = (c, message, last = -1) => http(c.path + `/events?last=${last}`, { method: "POST", headers: c.headers, body: JSON.stringify(message) });
  const read = c => http(c.path + "/events", { headers: c.headers });
  const remove = c => http(c.path, { method: "DELETE", headers: c.headers });
  async function clientChecks(moderated = false) {
    const paths = ["celld/clients.test.mjs", "celld/hosting.test.mjs"];
    if (process.env.CHROME_BIN) paths.push("celld/browser.test.mjs");
    const env = { ...process.env, MAYFLY_BASE_URL: base };
    delete env.NODE_TEST_CONTEXT; // A nested Node runner otherwise silently skips its files.
    if (moderated) env.MAYFLY_TEST_REJECTION_TEXT = rejectedText;
    const run = spawn(process.execPath, ["--test", "--test-concurrency=1", ...paths], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    run.stdout.on("data", b => { log += b; });
    run.stderr.on("data", b => { log += b; });
    const code = await new Promise((resolve, reject) => { run.on("error", reject); run.on("close", resolve); });
    assert.equal(code, 0, log);
    assert.doesNotMatch(log, /skipping running files/);
    t.diagnostic(log);
  }
  let first;
  await t.test("defaults are plaintext, authenticated, and unmoderated; format cannot be bypassed", async () => {
    await start();
    assert.deepEqual((await http("/config")).body, { protocol: 2, encryption: false, moderation: false, postingAllowed: true });
    first = await create();
    assert.equal((await http(first.path + "/config")).status, 401);
    assert.equal((await http(first.path + "/events")).status, 401);
    assert.equal((await post(first, cipher())).status, 400);
    for (const message of [plain(" "), plain("ok", " bad"), plain("ok", "\u0001bad"), plain("\ud800"), { ...plain(), ct: cipher().ct }]) {
      assert.equal((await post(first, message)).status, 400);
    }
    const message = plain("Default plaintext hello 👋");
    assert.equal((await post(first, message)).body.id, 0);
    const events = (await read(first)).body.events;
    assert.equal(events[0].text, message.text);
    assert.equal(events[0].from, "Alice");
    assert.equal(events[0].nonce, message.nonce);
    assert.ok(!("ct" in events[0]));
    assert.equal((await post(first, plain())).status, 409);
    assert.equal(requests.length, 0);
    assert.doesNotMatch(output, /"event":"moderation_rejected"/);
    const page = await http(first.path, { headers: { Accept: "text/html" } });
    assert.match(page.body, /Messages are readable by this server/);
    assert.match(page.body, /"encryption":false/);
  });
  await t.test("all downloadable clients and Chrome work in plaintext mode", async () => {
    await clientChecks();
  });
  await t.test("enabled Jev without a key fails closed without appending", async () => {
    await start({ JEV_ENABLED: "1" });
    const c = await create();
    const r = await post(c, plain());
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "moderation_unavailable");
    assert.equal(r.body.posted, false);
    assert.equal((await read(c)).body.last, -1);
    assert.equal(requests.length, 0);
  });
  const jev = { JEV_ENABLED: "1", TYPESAFE_API_KEY: "fixture-key" };
  await t.test("70% in either category rejects before delivery; errors fail closed and stale posts cost no call", async () => {
    await start(jev);
    const c = await create();
    const page = await http(c.path, { headers: { Accept: "text/html" } });
    const before = (await read(c)).body;
    const rejected = plain("Private moderation-log test body", "Private test sender");
    const logs = () => output.split("\n").flatMap(line => {
      const start = line.indexOf('{"event":"moderation_rejected"');
      if (start < 0) return [];
      // celld can prefix console lines with runtime context / color codes.
      return [JSON.parse(line.slice(start, line.lastIndexOf("}") + 1))];
    });
    for (const scores of [[0.7, 0], [0, 0.7], [1, 1]]) {
      [injection, exfiltration] = scores;
      const count = logs().length;
      const r = await post(c, rejected);
      assert.equal(r.status, 422);
      assert.deepEqual(r.body, { error: "Message rejected by Jev screening.", code: "moderation_rejected", posted: false });
      assert.doesNotMatch(JSON.stringify(Object.fromEntries(r.headers)), /blockedBy|probabilities|threshold|prompt_injection|data_exfiltration/);
      const deadline = Date.now() + 2000;
      while (logs().length <= count && Date.now() < deadline) await delay(20);
      const entries = logs();
      assert.equal(entries.length, count + 1, "One operator log per rejection");
      const entry = entries.at(-1);
      const { timestamp, ...details } = entry;
      assert.equal(new Date(timestamp).toISOString(), timestamp);
      assert.deepEqual(details, {
        event: "moderation_rejected", provider: "typesafe", threshold: 0.7,
        blockedBy: ["prompt_injection", "data_exfiltration"].filter((_, i) => scores[i] >= 0.7),
        probabilities: { prompt_injection: injection, data_exfiltration: exfiltration },
      });
      for (const value of [rejected.text, rejected.from, rejected.nonce, c.id, c.auth, c.key, jev.TYPESAFE_API_KEY]) {
        assert.ok(!JSON.stringify(entry).includes(value), "Operator entry must not include message or identifying secrets");
      }
      assert.deepEqual((await read(c)).body, before);
    }
    assert.equal((await http(c.path, { headers: { Accept: "text/html" } })).body.match(/const EXPIRES_AT = [^;]+/)[0], page.body.match(/const EXPIRES_AT = [^;]+/)[0]);
    injection = exfiltration = 0.699999;
    const message = plain();
    assert.equal((await post(c, message)).body.id, 0);
    assert.equal(logs().length, 3, "Allowed messages produce no rejection log");
    assert.deepEqual(requests.at(-1).body.state, { message: { from: message.from, text: message.text } });
    assert.equal(requests.at(-1).authorization, "Bearer fixture-key");
    const count = requests.length;
    assert.equal((await post(c, plain())).status, 409);
    assert.equal((await post(c, { ...plain(), ct: cipher().ct }, 0)).status, 400);
    assert.equal(requests.length, count);
    providerStatus = 529;
    const r = await post(c, plain(), 0);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "Message screening is unavailable. The message was not accepted.", code: "moderation_unavailable", posted: false });
    assert.equal(logs().length, 3, "Provider failures must not fabricate a scored rejection");
    assert.equal((await read(c)).body.last, 0);
    providerStatus = 200;
    injection = exfiltration = 0;
  });
  await t.test("browser and all three CLIs handle explicit moderation rejection", async () => {
    await clientChecks(true);
  });
  await t.test("moderation awaits cannot overwrite concurrent posts or a recreated channel", async () => {
    const c = await create();
    let release;
    hold = new Promise(resolve => { release = resolve; });
    let count = requests.length;
    const waiting = Array.from({ length: 4 }, () => post(c, plain()));
    const end = Date.now() + 5000;
    while (requests.length < count + 4) { assert.ok(Date.now() < end); await delay(20); }
    release(); hold = undefined;
    const replies = await Promise.all(waiting);
    assert.equal(replies.filter(r => r.status === 200).length, 1);
    assert.equal(replies.filter(r => r.status === 409).length, 3);
    hold = new Promise(resolve => { release = resolve; });
    count = requests.length;
    const oldPost = post(c, plain(), 0);
    while (requests.length === count) await delay(20);
    assert.equal((await remove(c)).status, 204);
    await create("0", c); // Same ID AND bearer: generation must still be checked.
    release(); hold = undefined;
    assert.equal((await oldPost).status, 412);
    assert.equal((await read(c)).body.last, -1);
  });
  await t.test("expiry during moderation cannot revive a channel", async () => {
    await start({ ...jev, RETENTION_SECONDS: "2" });
    const c = await create();
    let release;
    hold = new Promise(resolve => { release = resolve; });
    const count = requests.length;
    const waiting = post(c, plain());
    while (requests.length === count) await delay(20);
    await delay(2200);
    release(); hold = undefined;
    assert.equal((await waiting).status, 404);
    assert.equal((await read(c)).status, 404);
  });
  await t.test("encryption overrides Jev and preserves existing histories without changing their format", async () => {
    const count = requests.length;
    await start({ ENCRYPTION_ENABLED: "1", JEV_ENABLED: "1", TYPESAFE_API_KEY: "fixture-key" });
    assert.equal((await http("/config")).body.moderation, false);
    assert.equal((await http(first.path + "/config", { headers: first.headers })).body.postingAllowed, false);
    assert.equal((await read(first)).body.events[0].text, "Default plaintext hello 👋");
    assert.equal((await post(first, plain(), 0)).status, 412);
    const c = await create("1");
    assert.equal((await post(c, plain())).status, 400);
    const blob = cipher();
    assert.equal((await post(c, blob)).body.id, 0);
    assert.equal((await read(c)).body.events[0].ct, blob.ct);
    assert.equal(requests.length, count);
    await start({ ENCRYPTION_ENABLED: "1", JEV_ENABLED: "invalid" });
    assert.equal((await post(c, cipher(), 0)).status, 200);
    assert.equal(requests.length, count);
    assert.doesNotMatch(output, /"event":"moderation_rejected"/);
    await start();
    assert.equal((await post(c, plain(), 1)).status, 412);
    assert.equal((await read(c)).body.events[0].ct, blob.ct);
  });
  await t.test("invalid retention fails closed before reads, writes, or object construction", async () => {
    const count = requests.length;
    for (const retention of ["", "0.0001"]) {
      await start({ RETENTION_SECONDS: retention });
      for (const response of [await http("/config"), await read(first), await post(first, plain(), 0)]) {
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "configuration_error");
        assert.equal(response.body.posted, false);
      }
    }
    await start();
    assert.equal((await read(first)).body.last, 0, "Invalid retention must not modify existing history");
    assert.equal(requests.length, count);
  });
  t.diagnostic(`Tested ${generation} configurations with isolated local storage; no TypeSafe API traffic.`);
});
