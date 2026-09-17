// Differential wire tests: run the Go reference and celld, then set both URLs.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { nativeDocumentation } from "./documentation.mjs";

const native = process.env.MAYFLY_BASE_URL || "http://127.0.0.1:9890";
const reference = process.env.MAYFLY_REFERENCE_URL || "http://127.0.0.1:9891";
const bases = [native, reference];
const ip = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const envelope = (length = 16) => ({ nonce: randomBytes(12).toString("base64url"), ct: randomBytes(length).toString("base64url") });
const identity = () => {
  const auth = randomBytes(32).toString("base64url");
  const id = randomBytes(16).toString("base64url");
  return { id, auth, path: `/c/${id}`, auth_hash: createHash("sha256").update(auth).digest("base64url") };
};
async function request(base, path, init = {}) {
  const response = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(30000), ...init, headers: { "X-Forwarded-For": ip, ...init.headers } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, headers: response.headers, body };
}
function comparable(body) {
  if (typeof body === "object" && body && body.events) return { ...body, events: body.events.map(({ ts, src, ...event }) => {
    assert.match(ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(src, ip, "source must be the trusted last-hop IP");
    return event;
  }) };
  return body;
}
async function both(path, init, expected) {
  const [a, b] = await Promise.all(bases.map(base => request(base, path, init)));
  assert.equal(a.status, b.status, `${init?.method || "GET"} ${path}: native ${JSON.stringify(a.body)}; reference ${JSON.stringify(b.body)}`);
  if (expected !== undefined) assert.equal(a.status, expected, JSON.stringify(a.body));
  assert.deepEqual(comparable(a.body), comparable(b.body), `${init?.method || "GET"} ${path}`);
  for (const header of ["content-type", "cache-control", "referrer-policy", "x-robots-tag", "x-content-type-options", "allow", "location", "vary", "content-security-policy"]) {
    assert.equal(a.headers.get(header), b.headers.get(header), header);
  }
  return a;
}
const authenticated = (channel, init = {}) => ({ ...init, headers: { Authorization: `Bearer ${channel.auth}`, ...init.headers } });
const post = (channel, last, blob = envelope(), query = "") => both(`${channel.path}/events?last=${last}${query}`, authenticated(channel, { method: "POST", body: JSON.stringify(blob) }));
async function create(t, channel = identity()) {
  await both("/new", { method: "POST", body: JSON.stringify(channel) }, 303);
  t.after(() => both(channel.path, authenticated(channel, { method: "DELETE" })));
  return channel;
}

test("native celld matches the Go HTTP protocol", { timeout: 600000 }, async t => {
  await t.test("creation validation, JSON field rules, and body limit", async () => {
    const c = identity();
    const cases = ["", "{}", "null", "[]", "42", '"string"', "{", '{"id":4}', '{"id":null}', '{"id":[],"id":""}', '\ufeff{}',
      JSON.stringify({ id: c.id + "=", auth_hash: c.auth_hash }), JSON.stringify({ id: c.id, auth_hash: "bad" }),
      '{"id":"' + c.id + '","auth_hash":true}', " ".repeat(4097), '{"id":"x", "unknown":{"deep":[1,2]}}'];
    for (const body of cases) await both("/new", { method: "POST", body }, body.length > 4096 ? 413 : 400);
    for (const body of [JSON.stringify({ ID: c.id, AUTH_HASH: c.auth_hash + "====" }), JSON.stringify(c)]) {
      await both("/new", { method: "POST", body });
    }
    await both(c.path, authenticated(c, { method: "DELETE" }), 204);
    // Go ignores null for an already populated string field.
    await both("/new", { method: "POST", body: `{"id":"${c.id}","id":null,"auth_hash":"${c.auth_hash}"}` }, 303);
    await both(c.path, authenticated(c, { method: "DELETE" }), 204);
  });
  await t.test("cross-origin creation protections", async () => {
    for (const headers of [
      { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "invalid" },
      { Origin: "null" }, { Origin: "https://attacker.invalid" }, { Origin: "bad" },
      { "Sec-Fetch-Site": "same-origin", Origin: "https://attacker.invalid" }, { "Sec-Fetch-Site": "none" },
    ]) await both("/new", { method: "POST", headers, body: "{}" });
  });
  await t.test("missing channel precedes auth and parsing; unknown routes/methods", async () => {
    const c = identity();
    for (const path of [c.path, `${c.path}/events?since=bad`, `${c.path}/anything`, `${c.path}/`, "/c/bad/events"]) {
      for (const method of ["GET", "HEAD", "POST", "DELETE", "PUT", "OPTIONS"]) await both(path, { method });
    }
    for (const path of ["/unknown", "/docs", "/docs/", "/docs/missing.md", "/static/missing.py", "/new"]) {
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) await both(path, { method });
    }
  });
  await t.test("auth, validation precedence, and integer boundaries", async () => {
    const c = await create(t);
    for (const auth of ["", "Bearer ", "bearer " + c.auth, "Bearer wrong", "Basic " + c.auth]) {
      for (const method of ["GET", "POST", "DELETE"]) await both(method === "DELETE" ? c.path : `${c.path}/events?last=bad&since=bad`, { method, headers: { Authorization: auth }, ...(method === "POST" ? { body: "bad" } : {}) }, 401);
    }
    for (const method of ["PUT", "PATCH", "OPTIONS"]) await both(`${c.path}/events`, { method }, 404);
    for (const n of ["", "-1", "0", "-0", "%2B0", "00001", "-2", "1.0", "1e2", "+1", "%201", "NaN", "Infinity", "9007199254740993", "9223372036854775807", "9223372036854775808", "-9223372036854775809"]) {
      await both(`${c.path}/events?since=${n}`, authenticated(c));
      await both(`${c.path}/events?last=${n}`, authenticated(c, { method: "POST", body: "{}" }));
    }
    for (const n of ["", "0", "-0", "%2B0", "-1", "1.5", "+0", "NaN", "9223372036854775808"]) await both(`${c.path}/events?wait=${n}`, authenticated(c));
    for (const q of ["since=bad&since=0", "since=0&since=bad", "since=%ZZ", "since=0;bad", "unknown=yes"]) await both(`${c.path}/events?${q}`, authenticated(c));
  });
  await t.test("envelopes: opaque bytes, padded encodings, size limits", async () => {
    const c = await create(t);
    const good = envelope();
    for (const body of ["", "null", "[]", '"x"', "{}", JSON.stringify({ ...good, nonce: "" }), JSON.stringify({ ...good, nonce: good.nonce.slice(1) }), JSON.stringify({ ...good, ct: "AA" }), JSON.stringify({ ...good, ct: "/".repeat(24) }), JSON.stringify({ ...good, nonce: 12 }), `{"nonce":0,"nonce":"${good.nonce}","ct":"${good.ct}"}`, JSON.stringify(envelope(524289)), " ".repeat(700075)]) {
      await both(`${c.path}/events?last=-1`, authenticated(c, { method: "POST", body }));
    }
    const first = { NONCE: good.nonce.slice(0, 4) + "\r\n" + good.nonce.slice(4) + "====", CT: good.ct + "====" };
    await post(c, -1, first);
    const read = await both(`${c.path}/events`, authenticated(c), 200);
    assert.deepEqual({ nonce: read.body.events[0].nonce, ct: read.body.events[0].ct }, good);
    await both(`${c.path}/events?since=9007199254740993`, authenticated(c), 200);
    await post(c, 9223372036854775807n);
  });
  await t.test("simultaneous CAS appends accept exactly one", async () => {
    const c = await create(t);
    for (const base of bases) {
      const blob = JSON.stringify(envelope());
      const replies = await Promise.all(Array.from({ length: 12 }, () => request(base, `${c.path}/events?last=-1`, authenticated(c, { method: "POST", body: blob }))));
      assert.equal(replies.filter(r => r.status === 200).length, 1);
      assert.equal(replies.filter(r => r.status === 409 && r.body.posted === false).length, 11);
      const read = await request(base, `${c.path}/events`, authenticated(c));
      assert.equal(read.body.events.length, 1);
      assert.equal(read.body.last, 0);
    }
  });
  await t.test("long polls, append-and-wait, deletion, and no lost wakeups", async () => {
    const c = await create(t);
    const waits = bases.map(base => request(base, `${c.path}/events?since=-1&wait=10`, authenticated(c)));
    await delay(100);
    const blob = JSON.stringify(envelope());
    const postWaits = bases.map(base => request(base, `${c.path}/events?last=-1&wait=10`, authenticated(c, { method: "POST", body: blob })));
    for (const r of await Promise.all(waits)) assert.equal(r.body.events[0].seq, 0);
    await post(c, 0);
    for (const r of await Promise.all(postWaits)) {
      assert.equal(r.body.id, 0);
      assert.deepEqual(r.body.events.map(e => e.seq), [1]);
      assert.equal(r.body.last, 1);
    }
    const deleting = bases.map(base => request(base, `${c.path}/events?since=1&wait=10`, authenticated(c)));
    await delay(100);
    await both(c.path, authenticated(c, { method: "DELETE" }), 204);
    for (const r of await Promise.all(deleting)) assert.equal(r.status, 404);
    // Re-create the same ID with a different bearer; old credentials must fail.
    const next = { ...identity(), id: c.id, path: c.path };
    await both("/new", { method: "POST", body: JSON.stringify(next) }, 303);
    await both(`${c.path}/events`, authenticated(c), 401);
    await both(`${c.path}/events`, authenticated(next), 200);
    await both(c.path, authenticated(next, { method: "DELETE" }), 204);
  });
  await t.test("byte budget: exact capacity, then no partial append", async () => {
    const c = await create(t);
    await post(c, -1, envelope(524288));
    await post(c, 0, envelope(524288));
    const full = await post(c, 1);
    assert.equal(full.status, 429);
    const stale = await post(c, 0);
    assert.equal(stale.status, 409, "CAS precedes capacity validation");
    const read = await both(`${c.path}/events`, authenticated(c), 200);
    assert.equal(read.body.events.length, 2);
  });
  await t.test("pagination and conflict pages acknowledge only delivered events", async () => {
    const c = await create(t);
    const blob = envelope();
    const count = process.env.MAYFLY_TEST_FULL === "1" ? 10000 : 503;
    for (let seq = 0; seq < count; seq++) assert.equal((await post(c, seq - 1, blob)).body.id, seq);
    const first = await both(`${c.path}/events`, authenticated(c), 200);
    assert.equal(first.body.events.length, 500);
    assert.equal(first.body.last, 499);
    assert.equal(first.body.more, true);
    const conflict = await post(c, -1, blob);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body.events, first.body.events);
    let last = 499, total = 500;
    while (last < count - 1) {
      const r = await both(`${c.path}/events?since=${last}`, authenticated(c), 200);
      assert.equal(r.body.events[0].seq, last + 1);
      last = r.body.last;
      total += r.body.events.length;
    }
    assert.equal(total, count);
    if (count === 10000) assert.equal((await post(c, 9999, blob)).status, 429);
  });
  await t.test("mode-aware client downloads and native docs match their sources; HEAD remains compatible", async () => {
    const upstreamDocs = {};
    for (const name of await readdir(new URL("../srv/docs/", import.meta.url))) upstreamDocs[`docs/${name}`] = await readFile(new URL(`../srv/docs/${name}`, import.meta.url), "utf8");
    const nativeDocs = await nativeDocumentation(upstreamDocs);
    const files = ["/emoji.txt", "/llms.txt", "/docs/llms.txt"];
    for (const lang of ["py", "mjs", "go"]) for (const kind of ["create", "client"]) files.push(`/static/${kind}.${lang}`);
    for (const name of await readdir(new URL("../srv/docs/", import.meta.url))) if (name.endsWith(".md")) files.push(`/docs/${name}`);
    for (const path of files) {
      const local = path === "/emoji.txt" ? "static/emoji.txt" : path === "/llms.txt" ? "docs/llms.txt" : path.slice(1);
      if (path.startsWith("/static/")) {
        const r = await request(native, path);
        assert.equal(r.status, 200);
        assert.equal(r.body, await readFile(new URL(`./${local}`, import.meta.url), "utf8"));
        await both(path, { method: "HEAD" }, 200);
        continue;
      }
      if (local in nativeDocs && nativeDocs[local] !== upstreamDocs[local]) {
        const r = await request(native, path);
        assert.equal(r.status, 200);
        assert.equal(r.body, nativeDocs[local]);
        await both(path, { method: "HEAD" }, 200);
        continue;
      }
      const result = await both(path, {}, 200);
      assert.equal(result.body, await readFile(new URL(`../srv/${local}`, import.meta.url), "utf8"));
      await both(path, { method: "HEAD" }, 200);
    }
  });
  await t.test("HTML negotiation agrees with Go for preferences and malformed Accept headers", async () => {
    const c = await create(t);
    const accepts = ["", "*/*", "text/*", "text/html", "TEXT/HTML", "text/plain, text/html;q=0.5", "text/html, text/plain;q=0", "text/html;q=0", "text/html;q=NaN", 'text/html;q="0.5", text/plain;q=0.2', "text/html;q=0.7;q=0.2", "text/html;q=0.7;q=0.7", "text/html;q=0.5, */*;q=1, text/plain;q=0", "text/html;q=0.5, text/*;q=0.1, */*;q=1", "text/html;", "text/html;broken", "text/html;q=0x1p-1", Array(65).fill("text/html").join(","), "text/html;v=" + "a".repeat(8192)];
    for (const accept of accepts) {
      for (const path of [c.path, "/docs/protocol.md", "/c/absent"]) {
        const [a,b] = await Promise.all(bases.map(base => request(base, path, { headers: { Accept: accept } })));
        assert.equal(a.status, b.status, accept);
        assert.equal(a.headers.get("content-type"), b.headers.get("content-type"), accept);
        assert.equal(a.headers.get("vary"), b.headers.get("vary"), accept);
        if (a.headers.get("content-type").includes("html")) {
          const nonce = a.headers.get("content-security-policy").match(/script-src 'nonce-([\w-]{43})'/)?.[1];
          assert.ok(nonce);
          for (const tag of a.body.matchAll(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/g)) assert.ok(tag[2].includes(`nonce="${nonce}"`));
          assert.ok(!a.body.includes("{{.CSPNonce}}"));
        }
      }
    }
  });
  await t.test("100-create quota, conflict refunds, and deletion does not refund", async () => {
    const quotaIP = `198.19.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    const channels = [];
    const headers = { "X-Forwarded-For": quotaIP };
    for (let i = 0; i < 100; i++) {
      const c = identity();
      channels.push(c);
      await both("/new", { method: "POST", headers, body: JSON.stringify(c) }, 303);
      if (i < 3) await both("/new", { method: "POST", headers, body: JSON.stringify(c) }, 409);
    }
    await both("/new", { method: "POST", headers, body: JSON.stringify(identity()) }, 429);
    await both("/new", { method: "POST", headers, body: JSON.stringify(channels[0]) }, 429);
    for (const c of channels) await both(c.path, authenticated(c, { method: "DELETE" }), 204);
    await both("/new", { method: "POST", headers, body: JSON.stringify(identity()) }, 429);
  });
});
