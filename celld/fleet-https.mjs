// Optional private HTTPS ingress using an existing Tailscale login and nginx.
// Uses only its dedicated Serve port and nginx configuration; never resets Serve.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Fleet } from "./fleet.mjs";

const exec = promisify(execFile);
const fleet = await Fleet.open();
const command = process.argv[2] || "up";
assert.ok(["up", "down"].includes(command), "Usage: node celld/fleet-https.mjs up|down [https-port]");
async function serve(...args) {
  return exec("sudo", ["-n", "tailscale", "serve", ...args], { timeout: 30000 });
}
const configuration = JSON.parse((await exec("tailscale", ["serve", "status", "--json"])).stdout);
const directory = join(fleet.directory, "ingress");
const configFile = join(directory, "nginx.conf");
if (command === "down") {
  const ingress = fleet.state.ingress;
  assert.ok(ingress, "No ingress was created for this fleet");
  const existing = configuration.Web?.[`${ingress.hostname}:${ingress.port}`]?.Handlers?.["/"]?.Proxy;
  assert.ok(!existing || existing === ingress.target, "Serve port now belongs to a different service");
  if (existing) await serve(`--https=${ingress.port}`, "off");
  try { await exec("nginx", ["-p", directory + "/", "-c", configFile, "-s", "quit"]); }
  catch (error) { if (!String(error.stderr).includes("No such process") && !String(error.stderr).includes("No such file")) throw error; }
  console.log("Private Mayfly HTTPS ingress stopped; fleet and bucket data retained.");
} else {
  for (const node of fleet.state.nodes) await fleet.ready(node);
  const hostname = JSON.parse((await exec("tailscale", ["status", "--json"])).stdout).Self.DNSName.replace(/\.$/, "");
  assert.match(hostname, /^[a-z0-9.-]+$/i);
  const port = Number(process.argv[3] || fleet.state.ingress?.port || 8443);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  let ingress = fleet.state.ingress;
  if (ingress) {
    assert.equal(ingress.hostname, hostname);
    assert.equal(ingress.port, port, "Stop the existing ingress before changing its port");
  } else {
    assert.ok(!configuration.TCP?.[port], `Tailscale Serve port ${port} is already in use`);
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
    const localPort = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    ingress = { hostname, port, localPort, target: `http://127.0.0.1:${localPort}`, url: `https://${hostname}:${port}` };
  }
  const existing = configuration.Web?.[`${hostname}:${port}`]?.Handlers?.["/"]?.Proxy;
  assert.ok(!configuration.TCP?.[port] || existing === ingress.target, "Serve port belongs to a different service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const authority = `${hostname}:${port}`;
  // Tailscale terminates TLS and supplies the observed client IP. nginx fixes
  // scheme and host here, so caller-supplied forwarding headers cannot set them.
  const config = `worker_processes 1;
pid "${directory}/nginx.pid";
error_log "${directory}/error.log" warn;
events { worker_connections 1024; }
http {
  access_log off;
  client_body_temp_path "${directory}/client-body";
  proxy_temp_path "${directory}/proxy-temp";
  upstream mayfly {
    least_conn;
${fleet.state.nodes.map(n => `    server 127.0.0.1:${n.port} max_fails=1 fail_timeout=5s;`).join("\n")}
    keepalive 16;
  }
  server {
    listen 127.0.0.1:${ingress.localPort};
    server_name ${hostname};
    client_max_body_size 1m;
    location / {
      proxy_pass http://mayfly;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host "${authority}";
      proxy_set_header X-Forwarded-Host "${authority}";
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $http_x_forwarded_for;
      proxy_connect_timeout 2s;
      proxy_read_timeout 86500s;
      proxy_send_timeout 86500s;
      proxy_buffering off;
      # No non_idempotent option: a sent POST is never automatically replayed.
      proxy_next_upstream error timeout http_502 http_503 http_504;
      proxy_next_upstream_tries 3;
    }
  }
}
`;
  await writeFile(configFile, config, { mode: 0o600 });
  await exec("nginx", ["-p", directory + "/", "-c", configFile, "-t"]);
  if (!fleet.state.trustProxy) {
    fleet.state.trustProxy = true;
    await fleet.save();
    await fleet.deploy();
    // Rolling restarts apply the runtime forwarding setting.
    for (const node of fleet.state.nodes) {
      await fleet.stop(node); await fleet.start(node); await fleet.ready(node);
    }
  }
  let running = false;
  try {
    const pid = Number((await readFile(join(directory, "nginx.pid"), "utf8")).trim());
    const args = await readFile(`/proc/${pid}/cmdline`, "utf8");
    running = args.includes(configFile) && args.includes("nginx");
  } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  await exec("nginx", ["-p", directory + "/", "-c", configFile, ...(running ? ["-s", "reload"] : [])]);
  // Persist enough information to stop just this ingress even if Serve fails.
  fleet.state.ingress = ingress; await fleet.save();
  console.log((await serve("--bg", `--https=${port}`, ingress.target)).stdout.trim());
  const response = await fetch(ingress.url + "/llms.txt", { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  console.log(`Mayfly private HTTPS: ${ingress.url}`);
}
