import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test, { after } from "node:test";

const directory = await mkdtemp(join(tmpdir(), "mayfly-jev-test-"));
after(() => rm(directory, { recursive: true, force: true }));
const bundle = join(directory, "moderation.mjs");
await promisify(execFile)("esbuild", [new URL("./native/moderation.ts", import.meta.url).pathname,
  "--bundle", "--platform=neutral", "--format=esm", "--outfile=" + bundle]);
const { screenMessage, moderationDecision, moderationEnabled, ModerationUnavailable } = await import(pathToFileURL(bundle));
const enabled = { JEV_ENABLED: "1", TYPESAFE_API_KEY: "test-only-provider-key" };
const message = { from: "test sender", text: "Hello, this is a test message." };
function answer(injection, exfiltration) {
  return { model: "jev-1.13", answers: {
    prompt_injection: { type: "noul", noul: injection },
    data_exfiltration: { type: "noul", noul: exfiltration },
  }, usage: { input_tokens: 50, output_tokens: 20 } };
}
test("disabled moderation needs no API key and performs no request", async () => {
  for (const env of [{}, { JEV_ENABLED: "0" }, { JEV_ENABLED: "0", TYPESAFE_API_KEY: "unused" }]) {
    assert.deepEqual(await screenMessage(message, env, () => assert.fail("Unexpected provider request")), { enabled: false });
  }
});
test("invalid enable flags and an enabled service without a key fail closed", async () => {
  for (const value of ["true", "false", "", "yes", "2"]) assert.throws(() => moderationEnabled({ JEV_ENABLED: value }), ModerationUnavailable);
  for (const key of [undefined, "", " ", "key\nHeader: injected"]) {
    await assert.rejects(screenMessage(message, { JEV_ENABLED: "1", TYPESAFE_API_KEY: key }, () => assert.fail("Unexpected request")), ModerationUnavailable);
  }
});
test("rejects either category at exactly 0.70, accepts only when both are below", () => {
  for (const [injection, exfiltration, expected] of [
    [0, 0, []], [0.699999, 0.699999, []], [0.7, 0.1, ["prompt_injection"]],
    [0.1, 0.7, ["data_exfiltration"]], [0.7, 0.7, ["prompt_injection", "data_exfiltration"]],
    [1, 0, ["prompt_injection"]], [0, 1, ["data_exfiltration"]],
  ]) {
    const result = moderationDecision(answer(injection, exfiltration));
    assert.equal(result.allowed, expected.length === 0);
    assert.deepEqual(result.blockedBy, expected);
    assert.equal(result.threshold, 0.7);
  }
});
test("sends two independent Noul questions with only the message in state", async () => {
  let calls = 0;
  const result = await screenMessage({ ...message, auth: "must-not-leak", ct: "must-not-leak", key: "must-not-leak" }, enabled, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-only-provider-key");
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(body.state, { message });
    assert.deepEqual(Object.keys(body.questions), ["prompt_injection", "data_exfiltration"]);
    for (const q of Object.values(body.questions)) {
      assert.equal(q.type, "noul");
      assert.equal(typeof q.instructions, "string");
      assert.deepEqual(Object.keys(q.criteria).sort(), ["false", "true"]);
    }
    assert.ok(!init.body.includes(enabled.TYPESAFE_API_KEY));
    return Response.json(answer(0.25, 0.3));
  });
  assert.equal(calls, 1);
  assert.equal(result.allowed, true);
});
test("rejects absent, mistyped, nonfinite, and out-of-range provider probabilities", () => {
  for (const value of [null, {}, [], { model: "jev", answers: {} }, { ...answer(0, 0), model: null }]) {
    assert.throws(() => moderationDecision(value), ModerationUnavailable);
  }
  for (const value of [undefined, null, "0.9", true, NaN, Infinity, -0.1, 1.01]) {
    assert.throws(() => moderationDecision(answer(value, 0.1)), ModerationUnavailable);
    assert.throws(() => moderationDecision(answer(0.1, value)), ModerationUnavailable);
  }
  const wrongType = answer(0.1, 0.1);
  wrongType.answers.prompt_injection = { type: "choice", choice: "safe", confidence: 0.99 };
  assert.throws(() => moderationDecision(wrongType), ModerationUnavailable);
});
test("provider errors, malformed JSON, and oversized responses fail closed without reflecting data", async () => {
  const secret = "private provider error: test-only-provider-key message contents";
  const cases = [
    ...[301, 401, 429, 500, 529].map(status => () => new Response(secret, { status })),
    () => new Response("{broken"),
    () => new Response(" ".repeat(16385) + JSON.stringify(answer(0, 0))),
    () => new Response(new Uint8Array([0xff, 0xfe])),
    () => { throw new Error(secret); },
  ];
  for (const run of cases) await assert.rejects(screenMessage(message, enabled, async () => run()), error => {
    assert.ok(error instanceof ModerationUnavailable);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.stack.includes(enabled.TYPESAFE_API_KEY));
    return true;
  });
});
test("a stalled provider is bounded, even if it ignores the abort signal", { timeout: 12000 }, async () => {
  let signal;
  const start = Date.now();
  await assert.rejects(screenMessage(message, enabled, async (_, init) => {
    signal = init.signal;
    return new Promise(() => {});
  }), ModerationUnavailable);
  assert.ok(signal.aborted);
  assert.ok(Date.now() - start >= 9900 && Date.now() - start < 11500);
});
