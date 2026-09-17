// Reproducible tests with isolated local storage and listeners. No bucket needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = new URL("../", import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), "mayfly-celld-check-"));
const project = join(dir, "project");
const processes = new Set();
const runtimeEnv = { ...process.env, CELLD_FETCH_TIMEOUT_S: "86500", CELLD_HANDLER_BUDGET_S: "86500" };
const go = process.env.GO_BIN || "go";
function start(command, args, name, env = runtimeEnv, inherit = false) {
  const child = spawn(command, args, { cwd: root, env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", data => { output += data; });
  child.stderr?.on("data", data => { output += data; });
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code)); });
  // Observe startup failures immediately; run()/ready() still report the error.
  done.catch(() => {});
  const process = { child, done, name, output: () => output };
  processes.add(process);
  return process;
}
async function run(command, args, name, env = runtimeEnv, inherit = false) {
  const process = start(command, args, name, env, inherit);
  const code = await process.done;
  processes.delete(process);
  await writeFile(join(dir, name + ".log"), process.output());
  assert.equal(code, 0, `${name} failed:\n${process.output()}`);
}
async function stop(process) {
  if (!process) return;
  if (process.child.exitCode === null) process.child.kill("SIGINT");
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 8000);
  try { await process.done; } finally { clearTimeout(timer); processes.delete(process); }
  await writeFile(join(dir, process.name + ".log"), process.output());
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const nativePort = await port(), referencePort = await port();
const base = `http://127.0.0.1:${nativePort}`;
async function ready(process, origin) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) throw new Error(process.output());
    try {
      const r = await fetch(origin + "/llms.txt", { signal: AbortSignal.timeout(500) });
      await r.text();
      if (r.status === 200) return;
    } catch { /* listener starting */ }
    await delay(100);
  }
  throw new Error("Server did not start: " + process.output());
}
let native;
let generation = 0;
async function restart(retention = 86400, trust = 1) {
  await stop(native);
  await writeFile(join(project, ".dev.vars"), `TRUST_PROXY=${trust}\nRETENTION_SECONDS=${retention}\nENCRYPTION_ENABLED=1\n`);
  native = start("celld", ["dev", project, "--port", String(nativePort), "--no-watch"], `native-${++generation}`);
  await ready(native, base);
}
async function http(path, init = {}) {
  const r = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(15000), ...init });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
}
async function channel() {
  const id = randomBytes(16).toString("base64url"), auth = randomBytes(32).toString("base64url");
  const headers = { Authorization: `Bearer ${auth}`, "X-Forwarded-For": "203.0.113.50", "X-Mayfly-Source": "spoofed" };
  const auth_hash = createHash("sha256").update(auth).digest("base64url");
  assert.equal((await http("/new", { method: "POST", body: JSON.stringify({ id, auth_hash }) })).status, 303);
  return { path: `/c/${id}`, headers, auth, auth_hash };
}
const blob = () => JSON.stringify({ nonce: randomBytes(12).toString("base64url"), ct: randomBytes(16).toString("base64url") });
let succeeded = false;
try {
  await cp(join(root, "celld/native"), join(project, "celld/native"), { recursive: true });
  await cp(join(root, "wrangler.jsonc"), join(project, "wrangler.jsonc"));
  await run(go, ["build", "-p", "1", "-o", join(dir, "mayfly"), "./cmd/mayfly"], "go-build");
  const reference = start(join(dir, "mayfly"), ["-listen", `127.0.0.1:${referencePort}`, "-db", join(dir, "reference.sqlite3"), "-trust-proxy"], "reference");
  await ready(reference, `http://127.0.0.1:${referencePort}`);
  await restart();
  const env = { ...runtimeEnv, MAYFLY_BASE_URL: base, MAYFLY_REFERENCE_URL: `http://127.0.0.1:${referencePort}` };
  await run(process.execPath, ["--test", "--test-concurrency=1", "celld/protocol.test.mjs", "celld/clients.test.mjs", "celld/browser.test.mjs", "celld/hosting.test.mjs"], "integration", env, true);

  const c = await channel();
  const posted = await http(`${c.path}/events?last=-1`, { method: "POST", headers: c.headers, body: blob() });
  assert.equal(posted.status, 200);
  const before = await http(`${c.path}/events`, { headers: c.headers });
  assert.equal(before.body.events[0].src, "203.0.113.50");
  await restart();
  assert.deepEqual((await http(`${c.path}/events`, { headers: c.headers })).body, before.body);
  assert.equal((await http(`${c.path}/events`)).status, 401);
  assert.equal((await http(`${c.path}/events?last=-1`, { method: "POST", headers: c.headers, body: blob() })).status, 409);
  assert.equal((await http(`${c.path}/events?last=0`, { method: "POST", headers: c.headers, body: blob() })).body.id, 1);
  await http(c.path, { method: "DELETE", headers: c.headers });
  await restart();
  assert.equal((await http(`${c.path}/events`, { headers: c.headers })).status, 404);
  console.log("Restart: acknowledged ciphertext, bearer hash, cursor, and deletion persist");

  await restart(4);
  const expiring = await channel();
  // Reads repeatedly happen before the deadline; none may refresh activity.
  const waiting = http(`${expiring.path}/events?wait=10`, { headers: expiring.headers });
  for (let i = 0; i < 4; i++) {
    await delay(450);
    assert.equal((await http(`${expiring.path}/events`, { headers: expiring.headers })).status, 200);
  }
  assert.equal((await waiting).status, 404);
  assert.equal((await http(expiring.path)).status, 404);
  const refreshed = await channel();
  await delay(2100);
  assert.equal((await http(`${refreshed.path}/events?last=-1`, { method: "POST", headers: refreshed.headers, body: blob() })).status, 200);
  await delay(1500);
  assert.equal((await http(`${refreshed.path}/events`, { headers: refreshed.headers })).status, 200);
  assert.equal((await http(`${refreshed.path}/events?since=0&wait=10`, { headers: refreshed.headers })).status, 404);
  console.log("Expiry: alarms wake polls; reads do not refresh; accepted posts do refresh");
  await restart(8);
  const persistedAlarm = await channel();
  await restart(8);
  assert.equal((await http(`${persistedAlarm.path}/events?wait=15`, { headers: persistedAlarm.headers })).status, 404);
  console.log("Expiry alarm survives a celld restart");

  await restart(0, 0);
  const untrusted = await channel();
  await http(`${untrusted.path}/events?last=-1`, { method: "POST", headers: untrusted.headers, body: blob() });
  const unknownIP = await http(`${untrusted.path}/events`, { headers: untrusted.headers });
  assert.equal(unknownIP.body.events[0].src, "", "untrusted forwarded headers must not become an observed IP");
  assert.match((await http(untrusted.path, { headers: { Accept: "text/html" } })).body, /id="expwrap" hidden/);
  await delay(4100);
  assert.equal((await http(`${untrusted.path}/events`, { headers: untrusted.headers })).status, 200);
  console.log("Disabled retention and untrusted-proxy metadata behave as configured");
  await run("celld", ["deploy", project, "--dry-run", "--json"], "native-deploy");
  console.log("celld deployment dry-run passed");
  succeeded = true;
} finally {
  await Promise.allSettled([...processes].map(stop));
  if (succeeded && !process.env.MAYFLY_KEEP_TEST_STATE) await rm(dir, { recursive: true, force: true });
  else console.log(`Test evidence: ${dir}`);
}
