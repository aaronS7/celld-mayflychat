import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { hkdfSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const base = process.env.MAYFLY_BASE_URL || "http://127.0.0.1:9890";
function run(command, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; });
    child.stderr.on("data", b => { stderr += b; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
test("mode-aware Node, Python, and Go programs interoperate on native celld", { timeout: 180000 }, async t => {
  const config = await (await fetch(base + "/config")).json();
  const dir = await mkdtemp(join(tmpdir(), "mayfly-native-clients-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const programs = {};
  for (const lang of ["mjs", "py", "go"]) {
    for (const kind of ["create", "client"]) {
      const name = `${kind}.${lang}`;
      const response = await fetch(`${base}/static/${name}`);
      assert.equal(response.status, 200);
      const source = await response.text();
      assert.equal(source, await readFile(new URL(`./static/${name}`, import.meta.url), "utf8"));
      await writeFile(join(dir, name), source);
      if (lang === "go") {
        const compiled = await run(process.env.GO_BIN || "go", ["build", "-o", join(dir, kind), join(dir, name)]);
        assert.equal(compiled.code, 0, compiled.stderr);
        programs[`${lang}/${kind}`] = [join(dir, kind)];
      } else programs[`${lang}/${kind}`] = [lang === "mjs" ? process.execPath : process.env.PYTHON_BIN || "python3", join(dir, name)];
    }
  }
  const invoke = async (lang, kind, args, input = "", expectedCode = 0) => {
    const [command, ...prefix] = programs[`${lang}/${kind}`];
    const result = await run(command, [...prefix, ...args], input);
    assert.equal(result.code, expectedCode, `${lang} ${kind}: ${result.stderr}`);
    return result.stdout;
  };
  for (const creator of ["mjs", "py", "go"]) await t.test(`${creator} creator; all three senders/readers; conflict and corrupt ciphertext`, async () => {
    const url = new URL((await invoke(creator, "create", [base])).trim());
    const key = Buffer.from(url.hash.slice(1), "base64url");
    const auth = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "mayfly auth", 32)).toString("base64url");
    t.after(async () => { const r = await fetch(new URL(url.pathname, base), { method: "DELETE", headers: { Authorization: `Bearer ${auth}` } }); await r.text(); });
    let last = -1;
    for (const sender of ["mjs", "py", "go"]) {
      const text = `${sender}: hello 👋\nQuotes: " ' <>& and /title are opaque to the server`;
      const posted = JSON.parse(await invoke(sender, "client", [url.href, "post", "--from", sender, "--last", String(last)], text));
      assert.equal(posted.id, ++last);
      assert.equal(posted.posted, true);
      assert.deepEqual(posted.messages, []);
      for (const reader of ["mjs", "py", "go"]) {
        const got = JSON.parse(await invoke(reader, "client", [url.href, "read", "--last", String(last - 1)]));
        assert.equal(got.messages[0].text, text);
        assert.equal(got.messages[0].from, sender);
        assert.equal(got.last, last);
      }
    }
    for (const sender of ["mjs", "py", "go"]) {
      const conflict = JSON.parse(await invoke(sender, "client", [url.href, "post", "--from", sender, "--last", "0"], "must not append", 1));
      assert.equal(conflict.posted, false);
      assert.equal(conflict.messages.length, 2);
      assert.equal(conflict.last, 2);
    }
    if (process.env.MAYFLY_TEST_REJECTION_TEXT) for (const sender of ["mjs", "py", "go"]) {
      const [command, ...prefix] = programs[`${sender}/client`];
      const result = await run(command, [...prefix, url.href, "post", "--from", sender, "--last", "2"], process.env.MAYFLY_TEST_REJECTION_TEXT);
      assert.equal(result.code, 1, result.stderr);
      const rejection = JSON.parse(result.stderr);
      assert.equal(rejection.posted, false);
      assert.equal(rejection.code, "moderation_rejected");
      assert.ok(!rejection.hint, "Definite rejections must not be described as ambiguous successes");
    }
    if (!config.encryption) return;
    const corrupt = await fetch(`${base}${url.pathname}/events?last=2`, { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify({ nonce: Buffer.alloc(12).toString("base64url"), ct: Buffer.alloc(16).toString("base64url") }) });
    assert.equal(corrupt.status, 200);
    await corrupt.text();
    for (const reader of ["mjs", "py", "go"]) {
      const got = JSON.parse(await invoke(reader, "client", [url.href, "read", "--last", "-1"]));
      assert.equal(got.messages.length, 4);
      assert.equal(got.messages[3].id, 3);
      assert.equal(got.last, 3);
      assert.match(got.messages[3].text, /decrypt|invalid|corrupt/i, "corrupt envelopes retain their cursor position");
    }
  });
});
