// Integration tests against a running celld instance, using Mayfly's real clients.
// Start `npm run dev`, then `npm run test:hosting` (or set MAYFLY_BASE_URL).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { hkdfSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const base = process.env.MAYFLY_BASE_URL || "http://127.0.0.1:9876";
const waitSeconds = Number(process.env.MAYFLY_TEST_WAIT_SECONDS || 1);
assert.ok(Number.isInteger(waitSeconds) && waitSeconds >= 1 && waitSeconds <= 86400);
const timeout = Math.max(30_000, (waitSeconds + 30) * 1000);

function run(program, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [program, ...args], {
      stdio: ["pipe", "pipe", "pipe"], timeout,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function request(path, init) {
  return fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000), ...init });
}

test("Mayfly works through celld with the mode-aware clients", { timeout: timeout + 120_000 }, async t => {
  const config = await (await request("/config")).json();
  const dir = await mkdtemp(join(tmpdir(), "mayfly-hosting-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let channel, bearer;
  t.after(async () => {
    if (channel) await request(channel.pathname, {
      method: "DELETE", headers: { Authorization: `Bearer ${bearer}` },
    });
  });

  await t.test("serves HTML, security headers, documentation, and exact client sources", async () => {
    const page = await request("/", { headers: { Accept: "text/html", "cf-container-target-port": "1" } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(await page.text(), /Mayfly/i);
    const docs = await request("/llms.txt");
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /protocol\.md/);
    for (const name of ["create.mjs", "client.mjs"]) {
      const reply = await request(`/static/${name}`);
      assert.equal(reply.status, 200);
      const source = await reply.text();
      assert.equal(source, await readFile(new URL(`./static/${name}`, import.meta.url), "utf8"));
      await writeFile(join(dir, name), source);
    }
  });

  await t.test("creates a channel and preserves its external origin", async () => {
    const created = await run(join(dir, "create.mjs"), [base]);
    assert.equal(created.code, 0, created.stderr);
    channel = new URL(created.stdout.trim());
    assert.equal(channel.origin, new URL(base).origin);
    const key = Buffer.from(channel.hash.slice(1), "base64url");
    bearer = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "mayfly auth", 32)).toString("base64url");
    const instructions = await request(channel.pathname, {
      headers: { Accept: "text/plain", "X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "ftp" },
    });
    assert.equal(instructions.status, 200);
    const body = await instructions.text();
    assert.ok(body.includes(`${channel.origin}/static/client.mjs`));
    assert.ok(!body.includes("attacker.invalid"));
    const denied = await request(`${channel.pathname}/events`);
    assert.equal(denied.status, 401);
    await denied.text();
  });

  async function client(args, input = "", code = 0) {
    const result = await run(join(dir, "client.mjs"), [channel.href, ...args], input);
    assert.equal(result.code, code, result.stderr);
    return JSON.parse(result.stdout);
  }

  await t.test("posts and reads messages using the configured wire format", async () => {
    const posted = await client(["post", "--from", "Alice", "--last", "-1"], "celld encrypted hello");
    assert.equal(posted.posted, true);
    assert.equal(posted.id, 0);
    const received = await client(["read", "--last", "-1"]);
    assert.equal(received.messages[0].text, "celld encrypted hello");
    assert.equal(received.messages[0].from, "Alice");
    const wire = await request(`${channel.pathname}/events?since=-1`, { headers: { Authorization: `Bearer ${bearer}` } });
    const raw = await wire.text();
    assert.equal(raw.includes("celld encrypted hello"), !config.encryption);
    assert.equal(raw.includes("Alice"), !config.encryption);
    assert.equal(JSON.parse(raw).events.length, 1);
  });

  await t.test("a concurrent post wakes a held long poll", async () => {
    const waiting = client(["read", "--last", "0", "--wait", "10"]);
    await delay(500);
    const posted = await client(["post", "--from", "Bob", "--last", "0"], "reply from Bob");
    assert.equal(posted.id, 1);
    const received = await waiting;
    assert.equal(received.messages[0].text, "reply from Bob");
    assert.equal(received.last, 1);
  });

  await t.test("rejects a stale append without adding a duplicate", async () => {
    const conflict = await client(["post", "--from", "Alice", "--last", "0"], "stale message", 1);
    assert.equal(conflict.posted, false);
    assert.equal(conflict.messages[0].text, "reply from Bob");
    const received = await client(["read", "--last", "-1"]);
    assert.equal(received.messages.length, 2);
  });

  await t.test(`an idle long poll completes after ${waitSeconds} seconds`, async () => {
    const started = Date.now();
    const received = await client(["read", "--last", "1", "--wait", String(waitSeconds)]);
    assert.deepEqual(received.messages, []);
    assert.equal(received.last, 1);
    assert.ok(Date.now() - started >= waitSeconds * 1000 - 200);
  });

  await t.test("blocks cross-origin browser channel creation", async () => {
    const reply = await request("/new", {
      method: "POST", headers: { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: "{}", redirect: "manual",
    });
    assert.equal(reply.status, 403);
    await reply.text();
    const sameOrigin = await request("/new", {
      method: "POST", headers: { Origin: new URL(base).origin, "Content-Type": "application/json" },
      body: "{}", redirect: "manual",
    });
    // Invalid payload, but a valid origin must reach Mayfly's JSON validation.
    assert.equal(sameOrigin.status, 400);
    await sameOrigin.text();
  });

  await t.test("deletes a channel and makes its events inaccessible", async () => {
    const deleted = await request(channel.pathname, { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal(deleted.status, 204);
    const missing = await request(`${channel.pathname}/events`, { headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal(missing.status, 404);
    await missing.text();
    channel = null;
  });
});
