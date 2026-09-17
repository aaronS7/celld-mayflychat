// Exercise the Jev adapter in celld 0.5 with a local HTTP provider fixture.
// No real TypeSafe credentials or messages are sent to an external service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTCPServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("Jev adapter runs inside actual celld: thresholds, failure, and disabled mode", { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "mayfly-jev-celld-"));
  const requests = [];
  let injection = 0.1, exfiltration = 0.1, status = 200;
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { model: "fixture", answers: {
      prompt_injection: { type: "noul", noul: injection },
      data_exfiltration: { type: "noul", noul: exfiltration },
    } } : { error: "private provider diagnostic" }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const portPicker = createTCPServer();
  await new Promise(resolve => portPicker.listen(0, "127.0.0.1", resolve));
  const port = portPicker.address().port;
  await new Promise(resolve => portPicker.close(resolve));
  await cp(new URL("./native/moderation.ts", import.meta.url), join(directory, "moderation.ts"));
  await cp(new URL("./native/tagging.ts", import.meta.url), join(directory, "tagging.ts"));
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "mayfly-jev-adapter-test", main: "worker.ts", compatibility_date: "2026-09-15" }));
  await writeFile(join(directory, "worker.ts"), `
import { screenMessage, ModerationUnavailable } from "./moderation.ts";
export default {
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    const body = await request.json();
    try {
      const result = await screenMessage(body.message, { JEV_ENABLED: body.enabled, TYPESAFE_API_KEY: "fixture-key" },
        (_, init) => fetch("http://127.0.0.1:${provider.address().port}/v1/systemone", init));
      return Response.json(result);
    } catch (error) {
      return Response.json({ unavailable: error instanceof ModerationUnavailable, message: error.message }, { status: 503 });
    }
  }
};`);
  const child = spawn("celld", ["dev", directory, "--port", String(port), "--no-watch"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  done.catch(() => {});
  t.after(async () => {
    child.kill("SIGINT");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try { await done; } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(500) });
      if (response.ok) { await response.text(); break; }
    } catch { /* Listener is starting. */ }
    assert.ok(Date.now() < deadline, output);
    await delay(100);
  }
  const message = { from: "A test sender", text: "Only synthetic test data." };
  async function check(enabled = "1") {
    const response = await fetch(base, { method: "POST", body: JSON.stringify({ message, enabled }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  }
  let result = await check();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.allowed, true);
  assert.deepEqual(requests.at(-1).body.state, { message });
  assert.equal(requests.at(-1).authorization, "Bearer fixture-key");
  injection = 0.7;
  result = await check();
  assert.equal(result.body.allowed, false);
  assert.deepEqual(result.body.blockedBy, ["prompt_injection"]);
  injection = 0; exfiltration = 0.7;
  result = await check();
  assert.equal(result.body.allowed, false);
  assert.deepEqual(result.body.blockedBy, ["data_exfiltration"]);
  status = 529;
  result = await check();
  assert.equal(result.status, 503);
  assert.equal(result.body.unavailable, true);
  assert.ok(!JSON.stringify(result).includes("private provider diagnostic"));
  const count = requests.length;
  result = await check("0");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { enabled: false });
  assert.equal(requests.length, count);
});
