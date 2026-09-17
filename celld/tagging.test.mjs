import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test, { after } from "node:test";

const directory = await mkdtemp(join(tmpdir(), "mayfly-tagging-test-"));
after(() => rm(directory, { recursive: true, force: true }));
const modules = {};
for (const name of ["tagging", "moderation"]) {
  const bundle = join(directory, name + ".mjs");
  await promisify(execFile)("esbuild", [new URL(`./native/${name}.ts`, import.meta.url).pathname,
    "--bundle", "--platform=neutral", "--format=esm", "--outfile=" + bundle]);
  modules[name] = await import(pathToFileURL(bundle));
}
const { MESSAGE_TAGS, messageTags, taggingEnabled } = modules.tagging;
const { evaluateMessage, ModerationUnavailable } = modules.moderation;
const enabled = { JEV_TAGGING_ENABLED: "1", TYPESAFE_API_KEY: "test-only-tagging-key" };
const message = { from: "Test sender", text: "Please research this question." };
const answer = (scores = [0, 0, 0, 0, 0], attacks = [0, 0]) => ({ model: "fixture", answers: {
  ...Object.fromEntries(MESSAGE_TAGS.map((tag, i) => [tag, { type: "noul", noul: scores[i] }])),
  prompt_injection: { type: "noul", noul: attacks[0] }, data_exfiltration: { type: "noul", noul: attacks[1] },
} });

test("tag thresholds are inclusive at 75%, independent, and omit nonmatches", () => {
  for (let i = 0; i < 4; i++) {
    for (const score of [0, 0.749999, 0.75, 1]) {
      const scores = [0, 0, 0, 0, 0]; scores[i] = score;
      assert.deepEqual(messageTags(answer(scores)), score >= 0.75 ? [MESSAGE_TAGS[i]] : []);
    }
  }
  assert.deepEqual(messageTags(answer([0.75, 0.99, 0.76, 1, 1])), MESSAGE_TAGS.slice(0, 4));
  assert.deepEqual(messageTags(answer([0.74, 0.5, 0.5, 0.4, 0.9])), []);
});
test("undetermined needs at least 60% and every other label strictly below 30%", () => {
  assert.deepEqual(messageTags(answer([0.299999, 0.299999, 0.299999, 0.299999, 0.6])), ["undetermined"]);
  assert.deepEqual(messageTags(answer([0, 0, 0, 0, 0.599999])), []);
  for (let i = 0; i < 4; i++) {
    const scores = [0, 0, 0, 0, 1]; scores[i] = 0.3;
    assert.deepEqual(messageTags(answer(scores)), []);
  }
});
test("all five probabilities must be valid; missing or fabricated labels are never accepted", () => {
  for (const value of [null, [], {}, { model: "", answers: {} }, { model: "fixture", answers: [] }]) assert.throws(() => messageTags(value));
  for (const tag of MESSAGE_TAGS) {
    for (const bad of [undefined, null, "0.9", true, NaN, Infinity, -0.1, 1.01]) {
      const response = answer(); response.answers[tag].noul = bad;
      assert.throws(() => messageTags(response));
    }
    const missing = answer(); delete missing.answers[tag];
    assert.throws(() => messageTags(missing));
    const wrongType = answer(); wrongType.answers[tag] = { type: "choice", confidence: 1, choice: tag };
    assert.throws(() => messageTags(wrongType));
  }
  const extra = answer(); extra.answers["<script>unknown</script>"] = { type: "noul", noul: 1 };
  assert.deepEqual(messageTags(extra), []);
});
test("disabled tagging costs no calls and invalid flags do not silently disable it", async () => {
  for (const env of [{}, { JEV_TAGGING_ENABLED: "0" }]) {
    assert.equal(taggingEnabled(env), false);
    assert.deepEqual(await evaluateMessage(message, env, () => assert.fail("Unexpected request")), { moderation: { enabled: false }, tags: [] });
  }
  for (const flag of ["", "true", "false", "2"]) assert.throws(() => taggingEnabled({ JEV_TAGGING_ENABLED: flag }));
});
test("tagging alone sends only five questions; combined policy sends one request with seven", async () => {
  for (const moderation of [false, true]) {
    let calls = 0;
    const result = await evaluateMessage({ ...message, auth: "not-forwarded", tags: ["information"] }, { ...enabled, JEV_ENABLED: moderation ? "1" : "0" }, async (url, init) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer " + enabled.TYPESAFE_API_KEY);
      const body = JSON.parse(init.body);
      assert.deepEqual(body.state, { message });
      assert.equal(body.model, "jev-latest");
      assert.deepEqual(Object.keys(body.questions), [...(moderation ? ["prompt_injection", "data_exfiltration"] : []), ...MESSAGE_TAGS]);
      for (const q of Object.values(body.questions)) assert.equal(q.type, "noul");
      return Response.json(answer([0.9, 0.8, 0.1, 0.9, 0]));
    });
    assert.equal(calls, 1);
    assert.equal(result.moderation.enabled, moderation);
    assert.deepEqual(result.tags, ["research", "question", "command"]);
  }
});
test("tagging failures do not bypass moderation, invent labels, or expose provider diagnostics", async t => {
  const logs = [];
  t.mock.method(console, "warn", value => logs.push(JSON.parse(value)));
  const both = { ...enabled, JEV_ENABLED: "1" };
  const response = answer([1, 1, 1, 1, 0]); delete response.answers.question;
  const untagged = await evaluateMessage(message, both, async () => Response.json(response));
  assert.equal(untagged.moderation.allowed, true);
  assert.deepEqual(untagged.tags, []);
  response.answers.prompt_injection.noul = 0.7;
  const rejected = await evaluateMessage(message, both, async () => Response.json(response));
  assert.equal(rejected.moderation.allowed, false);
  assert.deepEqual(rejected.tags, []);
  delete response.answers.prompt_injection;
  await assert.rejects(evaluateMessage(message, both, async () => Response.json(response)), ModerationUnavailable);
  for (const provider of [
    () => new Response("private provider diagnostic", { status: 529 }),
    () => new Response("{broken"),
    () => new Response(" ".repeat(16385)),
    () => { throw new Error("private provider diagnostic"); },
  ]) {
    assert.deepEqual(await evaluateMessage(message, enabled, async () => provider()), { moderation: { enabled: false }, tags: [] });
    await assert.rejects(evaluateMessage(message, both, async () => provider()), ModerationUnavailable);
  }
  assert.deepEqual(await evaluateMessage(message, { JEV_TAGGING_ENABLED: "1" }, () => assert.fail("No key")), { moderation: { enabled: false }, tags: [] });
  assert.equal(logs.length, 6);
  for (const { timestamp, ...log } of logs) {
    assert.equal(new Date(timestamp).toISOString(), timestamp);
    assert.deepEqual(log, { event: "tagging_unavailable", provider: "typesafe" });
  }
});
test("a stalled tagging-only call releases the post after the shared ten-second deadline", { timeout: 12000 }, async t => {
  t.mock.method(console, "warn", () => {});
  let signal;
  const result = await evaluateMessage(message, enabled, async (_, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  assert.equal(signal.aborted, true);
  assert.deepEqual(result, { moderation: { enabled: false }, tags: [] });
});
