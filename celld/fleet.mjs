// Real S3-backed celld 0.5 fleet. Each node has its own process and local disk.
// The local runner tests process failure; it does not simulate losing this VM.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
export const defaultState = process.env.MAYFLY_FLEET_STATE || join(homedir(), ".local/state/mayfly-celld-fleet");
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export class Fleet {
  static async open(directory = defaultState, credentialsFile) {
    directory = resolve(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let state;
    try { state = JSON.parse(await readFile(join(directory, "fleet.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const credentialPath = resolve(credentialsFile || state?.credentialsFile || join(root, "s3.celld.env"));
    const credentials = JSON.parse(await readFile(credentialPath, "utf8"));
    for (const key of ["accessKeyId", "secretAccessKey", "bucket", "s3Endpoint", "region"]) {
      assert.ok(typeof credentials[key] === "string" && credentials[key] && !credentials[key].startsWith("<"), `Missing ${key}`);
    }
    assert.equal(credentials.forcePathStyle, true, "This runner uses path-style S3");
    assert.equal(credentials.signatureVersion, "s3v4");
    await chmod(credentialPath, 0o600);
    if (!state) {
      const stamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
      const prefix = `mayfly-fleet-test/${stamp}-${randomBytes(3).toString("hex")}`;
      state = { createdAt: new Date().toISOString(), credentialsFile: credentialPath,
        bucket: `s3://${credentials.bucket}/${prefix}`, endpoint: credentials.s3Endpoint,
        region: credentials.region, topology: "three processes on one Linux host", nodes: [] };
      for (const name of ["a", "b", "c"]) state.nodes.push({ name, port: await freePort(), internalPort: await freePort() });
    }
    assert.equal(new URL(state.bucket).hostname, credentials.bucket, "Credentials bucket changed");
    assert.equal(state.endpoint, credentials.s3Endpoint, "Credentials endpoint changed");
    const fleet = new Fleet(directory, state, credentials);
    await fleet.save();
    return fleet;
  }
  constructor(directory, state, credentials) {
    this.directory = directory;
    this.state = state;
    this.credentials = credentials;
    this.project = join(directory, "project");
  }
  redact(text) {
    for (const key of ["accessKeyId", "secretAccessKey", "sessionToken"]) {
      if (this.credentials[key]) text = text.replaceAll(this.credentials[key], "[REDACTED]");
    }
    for (const value of this.privateValues || []) text = text.replaceAll(value, "[REDACTED]");
    return text;
  }
  environment(extra = {}) {
    const env = { ...process.env, CELLD_BUCKET: this.state.bucket, S3_ENDPOINT: this.state.endpoint,
      AWS_REGION: this.state.region, AWS_ACCESS_KEY_ID: this.credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: this.credentials.secretAccessKey, ...extra };
    // Do not accidentally combine static credentials with an unrelated token.
    delete env.AWS_SESSION_TOKEN;
    if (this.credentials.sessionToken) env.AWS_SESSION_TOKEN = this.credentials.sessionToken;
    return env;
  }
  async save() {
    await writeFile(join(this.directory, "fleet.json"), JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
  }
  async command(args, label, timeout = 60000) {
    const child = spawn("celld", args, { cwd: root, env: this.environment(), stdio: ["ignore", "pipe", "pipe"], timeout });
    let output = "", stdout = "";
    child.stdout.on("data", chunk => { output += chunk; stdout += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    output = this.redact(output);
    await writeFile(join(this.directory, label + ".log"), output, { mode: 0o600 });
    assert.equal(code, 0, `${label}: ${output}`);
    return this.redact(stdout);
  }
  async deploy(vars = {}) {
    await mkdir(this.project, { recursive: true });
    await cp(join(root, "celld/native"), join(this.project, "celld/native"), { recursive: true });
    // This repository's config uses JSON plus standalone line comments.
    const source = await readFile(join(root, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
    if (this.state.trustProxy) config.vars.TRUST_PROXY = "1";
    for (const name of ["ENCRYPTION_ENABLED", "JEV_ENABLED", "JEV_TAGGING_ENABLED", "TYPESAFE_MODEL"]) {
      const value = process.env[name] ?? this.state.vars?.[name];
      if (value !== undefined) config.vars[name] = value;
    }
    Object.assign(config.vars, vars);
    assert.ok(["0", "1"].includes(config.vars.ENCRYPTION_ENABLED), "ENCRYPTION_ENABLED must be 0 or 1");
    if (config.vars.ENCRYPTION_ENABLED === "0") {
      for (const name of ["JEV_ENABLED", "JEV_TAGGING_ENABLED"]) assert.ok(["0", "1"].includes(config.vars[name]), `${name} must be 0 or 1`);
    }
    if (config.vars.ENCRYPTION_ENABLED === "1") {
      delete config.vars.TYPESAFE_API_KEY;
    } else if (config.vars.JEV_ENABLED === "1" || config.vars.JEV_TAGGING_ENABLED === "1") {
      let key = process.env.TYPESAFE_API_KEY;
      if (!key) {
        const file = join(root, "typesafe.celld.env");
        let contents;
        try { contents = await readFile(file, "utf8"); await chmod(file, 0o600); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (contents) {
          key = /^TYPESAFE_API_KEY=(.*)$/m.exec(contents)?.[1].trim();
          if (key && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) key = key.slice(1, -1);
        }
      }
      assert.ok(key?.trim() && !/[\r\n]/.test(key), "Jev requires TYPESAFE_API_KEY in the environment or typesafe.celld.env");
      config.vars.TYPESAFE_API_KEY = key.trim();
      this.privateValues = new Set([...(this.privateValues || []), key.trim()]);
    } else delete config.vars.TYPESAFE_API_KEY;
    const deploymentFile = join(this.project, "wrangler.jsonc");
    await writeFile(deploymentFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    await chmod(deploymentFile, 0o600);
    const output = await this.command(["deploy", this.project, "--json"], "deploy");
    this.state.deployment = JSON.parse(output.trim());
    this.state.vars = Object.fromEntries(Object.entries(config.vars).filter(([name]) => name !== "TYPESAFE_API_KEY"));
    await this.save();
    for (const node of this.state.nodes) {
      if (await this.running(node)) {
        const r = await this.request(node, "/reload", { method: "POST" }, true);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
    }
    return this.state.deployment;
  }
  async running(node) {
    if (!node.pid || !node.session) return false;
    try {
      const stat = await readFile(`/proc/${node.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (["Z", "X"].includes(fields[0])) return false;
      // The kernel start time prevents a recycled PID from targeting a different
      // process and remains readable while a killed process is being reaped.
      if (node.startTicks) return fields[19] === node.startTicks;
      const env = (await readFile(`/proc/${node.pid}/environ`, "utf8")).split("\0");
      return env.includes(`CELLD_NODE=${node.session}`) && env.includes(`CELLD_WATCH=${join(this.directory, "node-" + node.name)}`);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) return false;
      if (error.code === "EACCES") {
        try {
          const stat = await readFile(`/proc/${node.pid}/stat`, "utf8");
          if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0])) return false;
        } catch (next) { if (next.code === "ENOENT") return false; }
      }
      throw error;
    }
  }
  async start(node, { fresh = false } = {}) {
    assert.ok(!await this.running(node), `Node ${node.name} is already running`);
    if (fresh) {
      // Keep the old disk intact for recovery evidence; use a new node slot.
      node.name += "-cold";
    }
    const watch = join(this.directory, "node-" + node.name);
    await mkdir(watch, { recursive: true, mode: 0o700 });
    node.session = `mayfly-${node.name}-${randomBytes(6).toString("hex")}`;
    const log = await open(join(this.directory, `${node.session}.log`), "a", 0o600);
    try {
      const child = spawn("celld", ["--listen", `127.0.0.1:${node.port}`,
        "--internal-listen", `127.0.0.1:${node.internalPort}`, "--advertise", `127.0.0.1:${node.internalPort}`], {
        cwd: root, detached: true, stdio: ["ignore", log.fd, log.fd],
        env: this.environment({ CELLD_NODE: node.session, CELLD_WATCH: watch,
          CELLD_DURABILITY: "fleet", CELLD_FETCH_TIMEOUT_S: "86500", CELLD_HANDLER_BUDGET_S: "86500",
          CELLD_TRUST_FORWARDED_HEADERS: this.state.trustProxy ? "1" : "0",
          CELLD_TOKIO_THREADS: "2", CELLD_PLACEMENT_WEIGHT: "1", CELLD_MAX_RSS_MB: "256", CELLD_V8_HEAP_LIMIT_MB: "64" }),
      });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      node.pid = child.pid;
      const stat = await readFile(`/proc/${node.pid}/stat`, "utf8");
      node.startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      child.unref();
    } finally { await log.close(); }
    await this.save();
  }
  async stop(node, signal = "SIGTERM") {
    if (!await this.running(node)) return;
    process.kill(node.pid, signal);
    const end = Date.now() + 45000;
    while (await this.running(node)) {
      assert.ok(Date.now() < end, `Node ${node.name} did not stop after ${signal}`);
      await delay(100);
    }
    delete node.pid;
    await this.save();
  }
  async signal(node, signal) {
    assert.ok(await this.running(node), `Node ${node.name} is not running`);
    process.kill(node.pid, signal);
  }
  base(node) { return `http://127.0.0.1:${node.port}`; }
  async request(node, path, init = {}, internal = false) {
    const base = internal ? `http://127.0.0.1:${node.internalPort}` : this.base(node);
    const response = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(45000), ...init });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: Object.fromEntries(response.headers) };
  }
  async ready(node) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      if (!await this.running(node)) {
        const output = await readFile(join(this.directory, `${node.session}.log`), "utf8");
        throw new Error(`Node ${node.name} stopped: ${this.redact(output)}`);
      }
      try {
        if ((await this.request(node, "/.well-known/celld/health", { signal: AbortSignal.timeout(1000) })).status === 200) return;
      } catch { /* The listener can still be starting. */ }
      await delay(250);
    }
    throw new Error(`Node ${node.name} did not become healthy`);
  }
  async snapshot(label) {
    const states = [];
    for (const node of this.state.nodes) {
      if (await this.running(node)) states.push({ name: node.name, ...(await this.request(node, "/state", {}, true)).body });
    }
    await writeFile(join(this.directory, label + ".json"), JSON.stringify(states, null, 2) + "\n", { mode: 0o600 });
    return states;
  }
  async up() {
    await this.command(["diagnose", "--json"], "diagnose-before");
    await this.deploy();
    for (const node of this.state.nodes) if (!await this.running(node)) await this.start(node);
    for (const node of this.state.nodes) await this.ready(node);
    await this.command(["diagnose", "--json", ...this.state.nodes.flatMap(n => ["--peer", n.session])], "diagnose-live");
    await this.snapshot("state-start");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fleet;
  try {
    const command = process.argv[2] || "status";
    assert.ok(["up", "deploy", "down", "status", "diagnose"].includes(command), "Usage: node celld/fleet.mjs up|deploy|down|status|diagnose [state-directory] [credentials-file]");
    fleet = await Fleet.open(process.argv[3], process.argv[4]);
    if (command === "up") await fleet.up();
    if (command === "deploy") await fleet.deploy();
    if (command === "down") for (const node of fleet.state.nodes) await fleet.stop(node);
    if (command === "diagnose") console.log(await fleet.command(["diagnose", "--json"], "diagnose-live"));
    console.log(JSON.stringify({ state: fleet.directory, bucket: fleet.state.bucket,
      https: fleet.state.ingress?.url, deployment: fleet.state.deployment?.version,
      topology: fleet.state.topology, nodes: await Promise.all(fleet.state.nodes.map(async node => ({
        name: node.name, url: fleet.base(node), pid: node.pid, running: await fleet.running(node),
      }))) }, null, 2));
  } catch (error) {
    console.error(fleet ? fleet.redact(error.stack) : error.message);
    process.exitCode = 1;
  }
}
