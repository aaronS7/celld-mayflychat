// Destructive fault injection against ONLY the isolated fleet created by fleet.mjs.
// Run alone, after the ordinary client/browser tests; it restarts these nodes.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Fleet } from "./fleet.mjs";

const fleet = await Fleet.open();
const previousSettings = { ENCRYPTION_ENABLED: fleet.state.vars?.ENCRYPTION_ENABLED ?? "0", JEV_ENABLED: fleet.state.vars?.JEV_ENABLED ?? "0", RETENTION_SECONDS: fleet.state.vars?.RETENTION_SECONDS ?? "86400" };
const nodes = fleet.state.nodes;
const report = { startedAt: new Date().toISOString(), bucket: fleet.state.bucket,
  topology: fleet.state.topology, checks: [], channels: [] };
const channels = [];
const frozen = new Set();
const blob = () => ({ nonce: randomBytes(12).toString("base64url"), ct: randomBytes(48).toString("base64url") });
async function save() {
  report.channels = channels.map(c => ({ id: c.id, scope: c.scope, acknowledgedEvents: c.events.length,
    ciphertextDigest: createHash("sha256").update(JSON.stringify(c.events)).digest("hex") }));
  await writeFile(join(fleet.directory, "fault-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  // Private local ledger supports exact comparisons, without recording bearers.
  await writeFile(join(fleet.directory, "acknowledged-ledger.json"), JSON.stringify(channels.map(c => ({ id: c.id, events: c.events })), null, 2) + "\n", { mode: 0o600 });
}
async function check(name, fn) {
  const start = Date.now();
  console.log(`RUN ${name}`);
  try {
    const detail = await fn();
    report.checks.push({ name, passed: true, durationMS: Date.now() - start, detail });
    console.log(`PASS ${name} (${Date.now() - start} ms)`);
  } catch (error) {
    report.checks.push({ name, passed: false, durationMS: Date.now() - start, error: fleet.redact(error.stack) });
    throw error;
  } finally { await save(); }
}
async function scopes() {
  const text = await fleet.command(["cell", "list", "Chat", "--all", "--json"], "cells");
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line).scope);
}
async function create(node = nodes[0]) {
  const before = new Set(await scopes());
  const id = randomBytes(16).toString("base64url"), auth = randomBytes(32).toString("base64url");
  const auth_hash = createHash("sha256").update(auth).digest("base64url");
  const response = await fleet.request(node, "/new", { method: "POST", body: JSON.stringify({ id, auth_hash }) });
  assert.equal(response.status, 303, JSON.stringify(response.body));
  const added = (await scopes()).filter(scope => !before.has(scope));
  assert.equal(added.length, 1, "Run this isolated fleet test without other clients creating chats");
  const chat = { id, path: `/c/${id}`, headers: { Authorization: `Bearer ${auth}` }, events: [], scope: added[0] };
  channels.push(chat);
  return chat;
}
async function owner(chat) {
  for (const node of nodes) {
    if (await fleet.running(node) && !frozen.has(node)) {
      const { body } = await fleet.request(node, "/state", {}, true);
      if (body.residents.includes(chat.scope)) return node;
    }
  }
  throw new Error(`No resident owner found for ${chat.scope}`);
}
const read = (chat, node, init = {}) => fleet.request(node, `${chat.path}/events`, { headers: chat.headers, ...init });
function compare(chat, response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.last, chat.events.length - 1);
  assert.equal(response.body.more, false);
  assert.deepEqual(response.body.events.map(({ seq, nonce, ct }) => ({ seq, nonce, ct })), chat.events);
  for (const event of response.body.events) {
    assert.match(event.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(event.src, "");
  }
}
async function append(chat, node) {
  const envelope = blob();
  const response = await fleet.request(node, `${chat.path}/events?last=${chat.events.length - 1}`, {
    method: "POST", headers: chat.headers, body: JSON.stringify(envelope),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.posted, true);
  assert.equal(response.body.id, chat.events.length);
  chat.events.push({ seq: response.body.id, ...envelope });
  return response;
}
async function recovered(chat, node, status = 200) {
  const start = Date.now();
  let last;
  while (Date.now() - start < 90000) {
    try {
      last = await read(chat, node, { signal: AbortSignal.timeout(12000) });
      if (last.status === status) return { response: last, recoveryMS: Date.now() - start };
      // Authentication failure must never be hidden by a retry.
      assert.notEqual(last.status, 401, "Stored bearer hash was lost");
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      last = error.message;
    }
    await delay(250);
  }
  throw new Error(`Recovery did not reach ${status}: ${JSON.stringify(last)}`);
}
async function restart(node) { await fleet.start(node); await fleet.ready(node); }
async function allRead(chat) { for (const node of nodes) compare(chat, await read(chat, node)); }
let durable, deleted, expiring;
try {
  assert.equal(nodes.length, 3);
  for (const node of nodes) assert.ok(await fleet.running(node), `Start the fleet first: node ${node.name} is down`);
  // This suite uses opaque encrypted envelopes; restore the operator's policy.
  await fleet.deploy({ ENCRYPTION_ENABLED: "1", JEV_ENABLED: "0" });

  await check("three peers, S3 conditional writes, and deployed Worker", async () => {
    const rows = (await fleet.command(["diagnose", "--json", ...nodes.flatMap(n => ["--peer", n.session])], "diagnose-fault-start")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter(r => r.check.startsWith("peer ") && r.verdict === "ok").length, 3);
    for (const node of nodes) {
      await fleet.ready(node);
      assert.equal((await fleet.request(node, "/llms.txt")).status, 200);
    }
    return { peers: 3, version: fleet.state.deployment.version };
  });
  await check("cross-node ciphertext, authentication, and one CAS winner", async () => {
    durable = await create();
    for (let i = 0; i < 30; i++) await append(durable, nodes[i % nodes.length]);
    for (const node of nodes) {
      assert.equal((await fleet.request(node, durable.path + "/events")).status, 401);
      assert.equal((await read(durable, node, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    }
    const envelopes = Array.from({ length: 12 }, blob);
    const replies = await Promise.all(envelopes.map((envelope, i) => fleet.request(nodes[i % 3], `${durable.path}/events?last=29`, {
      method: "POST", headers: durable.headers, body: JSON.stringify(envelope),
    })));
    assert.equal(replies.filter(r => r.status === 200).length, 1);
    assert.equal(replies.filter(r => r.status === 409 && r.body.posted === false).length, 11);
    const winner = replies.findIndex(r => r.status === 200);
    assert.equal(replies[winner].body.id, 30);
    durable.events.push({ seq: 30, ...envelopes[winner] });
    await allRead(durable);
    return { acknowledgedEvents: durable.events.length, simultaneousWriters: 12, winners: 1 };
  });
  await check("a write on another node wakes a held poll", async () => {
    const host = await owner(durable), others = nodes.filter(n => n !== host);
    const start = Date.now();
    const polling = fleet.request(others[0], `${durable.path}/events?since=${durable.events.length - 1}&wait=15`, { headers: durable.headers });
    await delay(700);
    await append(durable, others[1]);
    const response = await polling;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.events.map(({ seq, nonce, ct }) => ({ seq, nonce, ct })), [durable.events.at(-1)]);
    assert.ok(Date.now() - start < 10000);
    return { owner: host.name, pollingNode: others[0].name, postingNode: others[1].name };
  });
  await check("SIGKILL owner: all acknowledged events survive takeover and rejoin", async () => {
    const host = await owner(durable), survivor = nodes.find(n => n !== host);
    for (let i = 0; i < 20; i++) await append(durable, survivor);
    // Kill immediately after the final acknowledged write; no graceful flush.
    await fleet.stop(host, "SIGKILL");
    const result = await recovered(durable, survivor);
    compare(durable, result.response);
    await append(durable, survivor);
    await restart(host);
    await allRead(durable);
    return { killedNode: host.name, survivor: survivor.name, recoveryMS: result.recoveryMS, acknowledgedEvents: durable.events.length };
  });
  await check("expired owner lease: a paused owner is fenced after resuming", async () => {
    const host = await owner(durable), survivor = nodes.find(n => n !== host);
    const oldHead = durable.events.length - 1;
    await fleet.signal(host, "SIGSTOP"); frozen.add(host);
    let result;
    try {
      result = await recovered(durable, survivor);
      compare(durable, result.response);
      await append(durable, survivor);
    } finally { await fleet.signal(host, "SIGCONT"); frozen.delete(host); }
    // celld can terminate a process that has lost its lease; replace it if so.
    await delay(500);
    if (!await fleet.running(host)) await restart(host);
    await fleet.ready(host);
    const stale = await fleet.request(host, `${durable.path}/events?last=${oldHead}`, {
      method: "POST", headers: durable.headers, body: JSON.stringify(blob()),
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    await append(durable, host);
    await allRead(durable);
    return { pausedNode: host.name, recoveryMS: result.recoveryMS, staleAppendStatus: stale.status };
  });
  await check("interrupted POST: read before retry prevents a duplicate", async () => {
    const chat = await create(), host = await owner(chat), survivor = nodes.find(n => n !== host);
    const envelope = blob();
    const pending = fleet.request(host, `${chat.path}/events?last=-1&wait=30`, {
      method: "POST", headers: chat.headers, body: JSON.stringify(envelope),
    }).then(response => ({ status: response.status }), error => ({ transportError: error.cause?.code || error.name }));
    // A successful read is output-gated too. Wait until the pending post is
    // committed, then kill its owner before its requested wait can finish.
    const deadline = Date.now() + 15000;
    for (;;) {
      const response = await read(chat, survivor);
      assert.equal(response.status, 200);
      if (response.body.events.length) break;
      assert.ok(Date.now() < deadline, "Pending POST never became visible");
      await delay(25);
    }
    chat.events.push({ seq: 0, ...envelope });
    await fleet.stop(host, "SIGKILL");
    const outcome = await pending;
    assert.notEqual(outcome.status, 200, "The test must interrupt the POST response");
    const result = await recovered(chat, survivor);
    compare(chat, result.response); // The client sees its post and does not retry it.
    await append(chat, survivor);
    compare(chat, await read(chat, survivor));
    await restart(host);
    await allRead(chat);
    return { interruptedOutcome: outcome, recoveredEvents: 1, eventsAfterNextAppend: chat.events.length, recoveryMS: result.recoveryMS };
  });
  await check("acknowledged deletion survives an owner crash", async () => {
    deleted = await create();
    await append(deleted, nodes[1]);
    const host = await owner(deleted), survivor = nodes.find(n => n !== host);
    assert.equal((await fleet.request(survivor, deleted.path, { method: "DELETE", headers: deleted.headers })).status, 204);
    await fleet.stop(host, "SIGKILL");
    const result = await recovered(deleted, survivor, 404);
    await restart(host);
    for (const node of nodes) assert.equal((await read(deleted, node)).status, 404);
    return { killedNode: host.name, recoveryMS: result.recoveryMS };
  });
  await check("expiry alarm survives owner loss and wakes a held poll", async () => {
    await fleet.deploy({ RETENTION_SECONDS: "25" });
    const start = Date.now();
    expiring = await create();
    const host = await owner(expiring), survivor = nodes.find(n => n !== host);
    await fleet.stop(host, "SIGKILL");
    const result = await recovered(expiring, survivor);
    compare(expiring, result.response);
    assert.ok(Date.now() - start < 23000, "Must recover before expiry to test the alarm itself");
    // No requests arrive after this poll until its alarm wakes it.
    const response = await fleet.request(survivor, `${expiring.path}/events?wait=35`, { headers: expiring.headers });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.ok(Date.now() - start >= 23000);
    await restart(host);
    await fleet.deploy();
    return { recoveryMS: result.recoveryMS, expiryMS: Date.now() - start, heldPollStatus: response.status };
  });
  await check("cold recovery uses the bucket with three empty local disks", async () => {
    // Graceful shutdown uploads each final position. Simultaneously losing all
    // unflushed follower disks is outside celld's fleet durability guarantee.
    await allRead(durable);
    for (const node of nodes) await fleet.stop(node);
    for (const node of nodes) await fleet.start(node, { fresh: true });
    for (const node of nodes) await fleet.ready(node);
    await allRead(durable);
    for (const node of nodes) {
      assert.equal((await read(deleted, node)).status, 404);
      assert.equal((await read(expiring, node)).status, 404);
      assert.equal((await fleet.request(node, durable.path + "/events")).status, 401);
    }
    await append(durable, nodes[2]);
    await allRead(durable);
    return { acknowledgedEvents: durable.events.length, freshNodes: nodes.map(n => n.name) };
  });
  // Reused ports can briefly have both a retired session's unexpired lease
  // and the replacement's lease. Probe the current sessions explicitly.
  await fleet.command(["diagnose", "--json", ...nodes.flatMap(n => ["--peer", n.session])], "diagnose-final");
  await fleet.snapshot("state-final");
  report.passed = true;
} catch (error) {
  report.passed = false;
  console.error(fleet.redact(error.stack));
  process.exitCode = 1;
} finally {
  for (const node of frozen) await fleet.signal(node, "SIGCONT");
  // Restore a usable deployment even when a fault assertion fails.
  await fleet.deploy(previousSettings);
  for (const node of nodes) if (!await fleet.running(node)) await fleet.start(node);
  for (const node of nodes) await fleet.ready(node);
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(`Fault report: ${join(fleet.directory, "fault-report.json")}`);
}
