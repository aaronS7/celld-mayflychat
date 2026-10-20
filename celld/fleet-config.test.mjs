// Offline checks for the fleet helper's management settings: a stub `celld` on
// PATH records each deployment, so no S3, network or daemon is involved.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Fleet } from "./fleet.mjs";

const credentials = { accessKeyId: "AKIAFLEETCONFIGTEST", secretAccessKey: "fleet-config-s3-secret", sessionToken: "fleet-config-s3-session",
  bucket: "fleet-config-test", s3Endpoint: "http://127.0.0.1:9", region: "us-test-1", forcePathStyle: true, signatureVersion: "s3v4" };
const secrets = { OIDC_CLIENT_SECRET: "oidcSecretValue123", ARCHIVE_S3_SECRET_ACCESS_KEY: "archiveSecretValue456", ARCHIVE_S3_SESSION_TOKEN: "archiveTokenValue789" };
const settings = { MANAGEMENT_ENABLED: "1", MANAGEMENT_ORIGIN: "https://admin.example.test", OIDC_ISSUER: "https://issuer.example.test",
  OIDC_CLIENT_ID: "mayfly-admin", OIDC_ADMIN_SUBJECTS: "alice,bob", MANAGEMENT_CHAT_IDLE_SECONDS: "3600", MANAGEMENT_AUDIT_DAYS: "30",
  ARCHIVE_STORAGE: "s3", ARCHIVE_S3_ENDPOINT: "https://s3.example.test", ARCHIVE_S3_BUCKET: "mayfly-archive", ARCHIVE_S3_REGION: "eu-test-1",
  ARCHIVE_S3_ACCESS_KEY_ID: "AKIAARCHIVEPUBLIC" };
// Variables the helper reads from the shell; the runner's own values must not leak into these tests.
const controlled = [...Object.keys(secrets), ...Object.keys(settings), "MANAGEMENT_CHAT_AGE_SECONDS", "MANAGEMENT_WIKI_IDLE_SECONDS",
  "MANAGEMENT_WIKI_AGE_SECONDS", "MANAGEMENT_ARCHIVE_ON_TTL", "ENCRYPTION_ENABLED", "JEV_ENABLED", "JEV_TAGGING_ENABLED", "WIKI_ENABLED",
  "JEV_WIKI_SEARCH_ENABLED", "WIKI_BOOK_LAYOUT_ENABLED", "TYPESAFE_MODEL", "TYPESAFE_API_KEY", "AI_SUMMARY_ENABLED", "MERCURY_BASE_URL",
  "MERCURY_MODEL", "MERCURY_API_KEY", "FAKE_CELLD_ECHO", "FAKE_CELLD_FAIL"];

const original = Object.fromEntries([...controlled, "PATH", "FAKE_CELLD_CAPTURE"].map(name => [name, process.env[name]]));
function setEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
setEnv(Object.fromEntries(controlled.map(name => [name, undefined])));
const work = await mkdtemp(join(tmpdir(), "mayfly-fleet-config-"));
after(async () => { setEnv(original); await rm(work, { recursive: true, force: true }); });

// The stub records the deployment config, echoes it to stderr (which lands in
// deploy.log unless redacted) and can echo a value or fail on request.
const bin = join(work, "bin");
await mkdir(bin);
await writeFile(join(bin, "celld"), `#!/bin/sh
set -e
if [ "$1" = deploy ]; then
  n=$(ls "$FAKE_CELLD_CAPTURE" | wc -l)
  cp "$2/wrangler.jsonc" "$FAKE_CELLD_CAPTURE/deploy-$n.json"
  cat "$2/wrangler.jsonc" >&2
  if [ -n "$FAKE_CELLD_FAIL" ]; then echo "failed with $FAKE_CELLD_FAIL" >&2; exit 3; fi
  printf '{"version":"v%s","echo":"%s"}\\n' "$n" "$FAKE_CELLD_ECHO"
  exit 0
fi
echo "unexpected celld $*" >&2
exit 2
`);
await chmod(join(bin, "celld"), 0o755);
process.env.PATH = bin + delimiter + (original.PATH || "");
const credentialsFile = join(work, "s3.json");
await writeFile(credentialsFile, JSON.stringify(credentials));

let counter = 0;
async function setup(t, state) {
  const directory = join(work, `fleet-${++counter}`);
  const capture = join(work, `capture-${counter}`);
  await mkdir(capture);
  process.env.FAKE_CELLD_CAPTURE = capture;
  if (state) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "fleet.json"), JSON.stringify(state));
  }
  t.after(() => setEnv(Object.fromEntries(controlled.map(name => [name, undefined]))));
  return {
    directory,
    open: () => Fleet.open(directory, credentialsFile),
    stateText: () => readFile(join(directory, "fleet.json"), "utf8"),
    deployLog: () => readFile(join(directory, "deploy.log"), "utf8"),
    async deployed() {
      const files = (await readdir(capture)).sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7)));
      return Promise.all(files.map(async file => JSON.parse(await readFile(join(capture, file), "utf8")).vars));
    },
  };
}
function assertNoSecrets(text, label) {
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(!text.includes(value), `${label} contains the ${name} value`);
    assert.ok(!text.includes(name), `${label} mentions ${name}`);
  }
}

test("non-secret management settings are saved; secrets are deployed but never saved or logged", async t => {
  const h = await setup(t);
  setEnv({ ...settings, ...secrets, FAKE_CELLD_ECHO: secrets.OIDC_CLIENT_SECRET });
  const fleet = await h.open();
  const deployment = await fleet.deploy();
  const [vars] = await h.deployed();
  for (const [name, value] of Object.entries({ ...settings, ...secrets })) assert.equal(vars[name], value, name);
  const saved = JSON.parse(await h.stateText());
  for (const [name, value] of Object.entries(settings)) assert.equal(saved.vars[name], value, name);
  assertNoSecrets(await h.stateText(), "fleet.json");
  // Output from celld is redacted both in the log and in the saved deployment record.
  const log = await h.deployLog();
  for (const value of Object.values(secrets)) assert.ok(!log.includes(value), "deploy.log leaks a secret");
  assert.match(log, /"OIDC_CLIENT_SECRET": "\[REDACTED\]"/);
  assert.equal(deployment.echo, "[REDACTED]");
  assert.equal(saved.deployment.echo, "[REDACTED]");
});

test("secrets passed as deployment bindings are trimmed, deployed and not saved; the shell value wins", async t => {
  const h = await setup(t);
  setEnv({ ARCHIVE_S3_SECRET_ACCESS_KEY: secrets.ARCHIVE_S3_SECRET_ACCESS_KEY });
  const fleet = await h.open();
  await fleet.deploy({ OIDC_CLIENT_SECRET: `  ${secrets.OIDC_CLIENT_SECRET}  `, ARCHIVE_S3_SECRET_ACCESS_KEY: "binding-loses", ARCHIVE_S3_SESSION_TOKEN: secrets.ARCHIVE_S3_SESSION_TOKEN });
  const [vars] = await h.deployed();
  assert.equal(vars.OIDC_CLIENT_SECRET, secrets.OIDC_CLIENT_SECRET);
  assert.equal(vars.ARCHIVE_S3_SECRET_ACCESS_KEY, secrets.ARCHIVE_S3_SECRET_ACCESS_KEY);
  assert.equal(vars.ARCHIVE_S3_SESSION_TOKEN, secrets.ARCHIVE_S3_SESSION_TOKEN);
  assertNoSecrets(await h.stateText(), "fleet.json");
  assert.ok(!(await h.stateText()).includes("binding-loses"));
});

test("secrets must be resupplied on every deploy; saved settings are remembered across processes", async t => {
  const h = await setup(t);
  setEnv({ ...settings, ...secrets });
  let fleet = await h.open();
  await fleet.deploy();
  await fleet.deploy();
  // A later shell (new process) without any management variables.
  setEnv(Object.fromEntries(controlled.map(name => [name, undefined])));
  fleet = await h.open();
  await fleet.deploy();
  setEnv({ OIDC_CLIENT_SECRET: secrets.OIDC_CLIENT_SECRET, MANAGEMENT_AUDIT_DAYS: "7" });
  await fleet.deploy();
  const [first, second, third, fourth] = await h.deployed();
  for (const vars of [first, second]) for (const [name, value] of Object.entries(secrets)) assert.equal(vars[name], value, name);
  for (const name of Object.keys(secrets)) assert.equal(third[name], undefined, `${name} survived a deploy without it`);
  for (const [name, value] of Object.entries(settings)) assert.equal(third[name], value, `${name} was not remembered`);
  assert.equal(fourth.OIDC_CLIENT_SECRET, secrets.OIDC_CLIENT_SECRET);
  assert.equal(fourth.ARCHIVE_S3_SECRET_ACCESS_KEY, undefined);
  assert.equal(fourth.MANAGEMENT_AUDIT_DAYS, "7", "the shell overrides the saved selection");
  assert.equal(JSON.parse(await h.stateText()).vars.MANAGEMENT_AUDIT_DAYS, "7");
  assertNoSecrets(await h.stateText(), "fleet.json");
});

test("redact removes every occurrence of credentials and private values, and ignores empty ones", async t => {
  const fleet = new Fleet(work, {}, credentials);
  const text = `${credentials.accessKeyId}:${credentials.secretAccessKey} ${credentials.sessionToken} ${credentials.secretAccessKey}`;
  assert.equal(fleet.redact(text), "[REDACTED]:[REDACTED] [REDACTED] [REDACTED]");
  fleet.privateValues = new Set(Object.values(secrets));
  const repeated = Object.values(secrets).map(value => `${value} and ${value}`).join("\n");
  assert.equal(fleet.redact(repeated), "[REDACTED] and [REDACTED]\n".repeat(3).trimEnd());
  // No private values and blank optional credentials leave text untouched.
  for (const blank of [undefined, ""]) {
    const quiet = new Fleet(work, {}, { ...credentials, sessionToken: blank });
    assert.equal(quiet.redact("plain text"), "plain text");
    assert.equal(quiet.redact(""), "");
  }

  // Blank shell values are omitted rather than registered as private values.
  const h = await setup(t);
  setEnv({ OIDC_CLIENT_SECRET: "", ARCHIVE_S3_SECRET_ACCESS_KEY: "", ARCHIVE_S3_SESSION_TOKEN: "" });
  const deployed = await h.open();
  await deployed.deploy();
  assert.deepEqual([...(deployed.privateValues || [])], []);
  assert.equal(deployed.redact("plain text"), "plain text");
  const [vars] = await h.deployed();
  for (const name of Object.keys(secrets)) assert.equal(vars[name], undefined);
});

test("invalid secrets stop deployment without revealing the value", async t => {
  const h = await setup(t);
  const fleet = await h.open();
  setEnv({ ARCHIVE_S3_SESSION_TOKEN: "first-line\nsecond-line" });
  await assert.rejects(fleet.deploy(), error => {
    assert.match(error.message, /ARCHIVE_S3_SESSION_TOKEN must be a single nonblank line/);
    assert.ok(!error.message.includes("first-line"));
    return true;
  });
  // A whitespace-only value is rejected (not omitted like an empty one).
  setEnv({ ARCHIVE_S3_SESSION_TOKEN: undefined, OIDC_CLIENT_SECRET: "   " });
  await assert.rejects(fleet.deploy(), /OIDC_CLIENT_SECRET must be a single nonblank line/);
  assert.deepEqual(await h.deployed(), [], "celld deploy ran");
  // A failing celld deploy reports its output redacted.
  setEnv({ OIDC_CLIENT_SECRET: secrets.OIDC_CLIENT_SECRET, FAKE_CELLD_FAIL: secrets.OIDC_CLIENT_SECRET });
  await assert.rejects(fleet.deploy(), error => {
    assert.match(error.message, /failed with \[REDACTED\]/);
    assert.ok(!error.message.includes(secrets.OIDC_CLIENT_SECRET));
    return true;
  });
  assert.ok(!(await h.deployLog()).includes(secrets.OIDC_CLIENT_SECRET));
  assertNoSecrets(await h.stateText(), "fleet.json");
});

test("secrets saved by an older helper are dropped on open and never redeployed", async t => {
  const legacy = { createdAt: "2026-01-01T00:00:00.000Z", credentialsFile, bucket: `s3://${credentials.bucket}/mayfly-fleet-test/legacy`,
    endpoint: credentials.s3Endpoint, region: credentials.region, topology: "three processes on one Linux host",
    nodes: [{ name: "a", port: 1, internalPort: 2 }],
    vars: { ENCRYPTION_ENABLED: "0", OIDC_CLIENT_ID: "legacy-client", MERCURY_API_KEY: "legacyMercuryKey", ...secrets } };
  const h = await setup(t, legacy);
  // Opening (as `status` and `down` do) rewrites fleet.json without the private values.
  let fleet = await h.open();
  const reopened = await h.stateText();
  assertNoSecrets(reopened, "reopened fleet.json");
  assert.ok(!reopened.includes("legacyMercuryKey"));
  assert.equal(JSON.parse(reopened).vars.OIDC_CLIENT_ID, "legacy-client");
  fleet = await h.open();
  await fleet.deploy();
  const [vars] = await h.deployed();
  assert.equal(vars.OIDC_CLIENT_ID, "legacy-client");
  for (const name of [...Object.keys(secrets), "MERCURY_API_KEY"]) assert.equal(vars[name], undefined, `${name} was redeployed from old state`);
  assertNoSecrets(await h.stateText(), "fleet.json");
});

test("enabled management without its secrets deploys anyway; the secrets are optional to the helper", async t => {
  const h = await setup(t);
  // OIDC_CLIENT_SECRET is optional (public clients). Archive S3 credentials are
  // only checked by the Worker when an archive runs, which then answers 503.
  setEnv(settings);
  const fleet = await h.open();
  await fleet.deploy();
  const [vars] = await h.deployed();
  assert.equal(vars.MANAGEMENT_ENABLED, "1");
  assert.equal(vars.ARCHIVE_STORAGE, "s3");
  for (const name of Object.keys(secrets)) assert.equal(vars[name], undefined);
});
