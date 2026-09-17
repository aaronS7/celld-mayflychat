// Run after fleet-https.mjs up, and before the ordinary client tests.
// This check deliberately kills one node of the isolated test fleet.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Fleet } from "./fleet.mjs";

const fleet = await Fleet.open();
assert.ok(fleet.state.ingress && fleet.state.trustProxy, "Start the private HTTPS ingress first");
const base = fleet.state.ingress.url;
const config = await (await fetch(base + "/config")).json();
assert.equal(config.moderation, false, "Run fault injection with Jev off to avoid real provider calls");
const report = { startedAt: new Date().toISOString(), url: base };
const id = randomBytes(16).toString("base64url"), auth = randomBytes(32).toString("base64url");
const headers = { Authorization: `Bearer ${auth}`, "X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "ftp",
  "X-Forwarded-For": "203.0.113.123", "X-Mayfly-Source": "spoofed" };
const path = `/c/${id}`;
let host, created = false;
const envelope = () => ({ nonce: randomBytes(12).toString("base64url"), ...(config.encryption
  ? { ct: randomBytes(32).toString("base64url") } : { from: "Ingress fixture", text: "Synthetic " + randomBytes(8).toString("hex") }) });
const payload = event => config.encryption ? event.ct : event.text;
async function request(path, init = {}) {
  const response = await fetch(base + path, { headers, redirect: "manual", signal: AbortSignal.timeout(15000), ...init });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}
async function scopes() {
  return new Set((await fleet.command(["cell", "list", "Chat", "--all", "--json"], "ingress-cells"))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line).scope));
}
try {
  const self = JSON.parse((await promisify(execFile)("tailscale", ["status", "--json"])).stdout).Self;
  const before = await scopes();
  assert.equal((await request("/new", { method: "POST", body: JSON.stringify({ id, auth_hash: createHash("sha256").update(auth).digest("base64url"), encryption: config.encryption ? "1" : "0" }) })).status, 303);
  created = true;
  const added = [...await scopes()].filter(scope => !before.has(scope));
  assert.equal(added.length, 1);
  const page = await request(path, { headers: { ...headers, Accept: "text/plain" } });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(base + "/static/client.mjs"));
  assert.ok(!page.body.includes("attacker.invalid"));
  const first = envelope();
  assert.equal((await request(path + "/events?last=-1", { method: "POST", body: JSON.stringify(first) })).status, 200);
  const initial = await request(path + "/events");
  assert.equal(initial.status, 200);
  assert.equal(payload(initial.body.events[0]), payload(first));
  assert.ok(self.TailscaleIPs.includes(initial.body.events[0].src), `Unexpected source IP ${initial.body.events[0].src}`);
  report.forwardedOrigin = base;
  report.observedSourceIP = initial.body.events[0].src;
  report.spoofedHeadersRejected = true;
  for (const node of fleet.state.nodes) {
    if ((await fleet.request(node, "/state", {}, true)).body.residents.includes(added[0])) { host = node; break; }
  }
  assert.ok(host, "Could not identify the chat owner");
  const started = Date.now();
  await fleet.stop(host, "SIGKILL");
  let recovered;
  while (Date.now() - started < 90000) {
    try {
      const response = await request(path + "/events");
      if (response.status === 200) { recovered = response; break; }
    } catch { /* GET is safe to retry while the old owner's lease expires. */ }
    await delay(250);
  }
  assert.ok(recovered, "HTTPS reads did not recover through the surviving backends");
  assert.deepEqual(recovered.body, initial.body);
  report.killedNode = host.name;
  report.recoveryMS = Date.now() - started;
  const second = envelope();
  const posted = await request(path + "/events?last=0", { method: "POST", body: JSON.stringify(second) });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.id, 1);
  const final = await request(path + "/events");
  assert.equal(final.body.events.length, 2);
  assert.deepEqual(final.body.events.map(payload), [payload(first), payload(second)]);
  assert.equal(final.body.events[1].src, report.observedSourceIP);
  report.passed = true;
  console.log("PASS HTTPS: valid TLS, public origin, spoof-resistant source IP, and owner failover through nginx");
} catch (error) {
  report.passed = false; report.error = fleet.redact(error.stack);
  console.error(report.error); process.exitCode = 1;
} finally {
  if (host && !await fleet.running(host)) { await fleet.start(host); await fleet.ready(host); }
  if (created) {
    const deleted = await request(path, { method: "DELETE" });
    assert.equal(deleted.status, 204);
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(fleet.directory, "ingress-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
