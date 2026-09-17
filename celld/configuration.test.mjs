import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Fleet } from "./fleet.mjs";

test("configuration never silently downgrades encryption or enables Jev with it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mayfly-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, "settings.mjs");
  await promisify(execFile)("esbuild", [new URL("./native/settings.ts", import.meta.url).pathname,
    "--bundle", "--platform=neutral", "--format=esm", "--outfile=" + bundle]);
  const { settings } = await import(pathToFileURL(bundle));
  assert.deepEqual(settings({}), { protocol: 2, encryption: false, moderation: false, postingAllowed: true });
  assert.equal(settings({ JEV_ENABLED: "1" }).moderation, true);
  for (const flag of [undefined, "0", "1", "invalid"]) {
    assert.deepEqual(settings({ ENCRYPTION_ENABLED: "1", JEV_ENABLED: flag }), { protocol: 2, encryption: true, moderation: false, postingAllowed: true });
  }
  for (const env of [{ ENCRYPTION_ENABLED: "true" }, { ENCRYPTION_ENABLED: "" }, { JEV_ENABLED: "bad" }]) {
    assert.throws(() => settings(env), error => error.status === 503 && error.code === "configuration_error");
  }
  const old = settings({ ENCRYPTION_ENABLED: "0", JEV_ENABLED: "1" }, true);
  assert.equal(old.encryption, true);
  assert.equal(old.moderation, false);
  assert.equal(old.postingAllowed, false);
});

test("retention requires explicit decimal seconds and preserves millisecond precision", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mayfly-retention-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, "pages.mjs");
  await promisify(execFile)("esbuild", [new URL("./native/pages.ts", import.meta.url).pathname,
    "--bundle", "--platform=neutral", "--format=esm", "--outfile=" + bundle]);
  const { retentionMS } = await import(pathToFileURL(bundle));
  assert.equal(retentionMS({}), 86400000);
  for (const [raw, milliseconds] of [
    ["0", 0], ["0.000", 0], ["0.001", 1], ["0.01", 10], ["0.1", 100],
    ["1", 1000], ["1.001", 1001], ["001.001", 1001], ["86400", 86400000],
    ["315359999.999", 315359999999], ["315360000", 315360000000], ["315360000.000", 315360000000],
  ]) assert.equal(retentionMS({ RETENTION_SECONDS: raw }), milliseconds, raw);
  for (const raw of [
    "", " ", "\t", " 1", "1 ", "1\n", "-1", "-0", "+1", "0.0001", "1.0000",
    ".1", "1.", "0x10", "1e2", "NaN", "Infinity", "315360000.001", "315360001",
    "999999999999999999999999999999999999999999999999999999999999", null, 0, true,
  ]) assert.throws(() => retentionMS({ RETENTION_SECONDS: raw }),
    error => error.status === 503 && error.code === "configuration_error", JSON.stringify(raw));
});

test("fleet deploy keeps TypeSafe credentials in private bindings and removes them when unused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mayfly-deployment-settings-"));
  const names = ["ENCRYPTION_ENABLED", "JEV_ENABLED", "TYPESAFE_API_KEY", "TYPESAFE_MODEL"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(async () => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of names) delete process.env[name];
  const key = "test-only-private-deployment-key";
  process.env.TYPESAFE_API_KEY = key;
  const fleet = new Fleet(directory, { nodes: [] }, {});
  let deployed;
  fleet.command = async () => {
    deployed = JSON.parse(await readFile(join(fleet.project, "wrangler.jsonc"), "utf8"));
    return JSON.stringify({ version: "fixture-no-external-deployment" });
  };
  await fleet.deploy({ ENCRYPTION_ENABLED: "0", JEV_ENABLED: "1" });
  assert.equal(deployed.vars.TYPESAFE_API_KEY, key);
  assert.equal((await stat(join(fleet.project, "wrangler.jsonc"))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(directory, "fleet.json"), "utf8")).includes(key));
  assert.equal(fleet.redact(key), "[REDACTED]");
  await fleet.deploy({ ENCRYPTION_ENABLED: "1" });
  assert.ok(!("TYPESAFE_API_KEY" in deployed.vars));
  assert.equal(deployed.vars.JEV_ENABLED, "1", "Preserve the operator's selection while encryption suppresses its use");
  await fleet.deploy({ ENCRYPTION_ENABLED: "0", JEV_ENABLED: "0" });
  assert.ok(!("TYPESAFE_API_KEY" in deployed.vars));
});
