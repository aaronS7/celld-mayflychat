#!/usr/bin/env node
// Create a Mayfly Chat channel locally. Node 18+, nothing to install.
// Usage: node create.mjs HTTP(S)-ORIGIN
// Prints one full channel URL on success; no state or retries.
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const b64 = bytes => Buffer.from(bytes).toString('base64url');
const usage = 'usage: node create.mjs HTTP(S)-ORIGIN';

function origin(raw) {
  const authority = raw.slice(raw.indexOf('//') + 2).replace(/\/$/, '');
  if (!raw || /[\\\x00-\x1f\x7f]/.test(raw) || raw.includes('?') || raw.includes('#') || authority.endsWith(':') ||
      !/^https?:\/\/[^/?#\\\x00-\x1f]+\/?$/i.test(raw)) {
    throw new Error('expected an HTTP(S) origin with no path, query, or fragment');
  }
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid URL (scheme, host, or port)'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('expected an HTTP(S) origin with no path, query, or fragment');
  }
  return url;
}

function request(target, body) {
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request(target,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, agent: false }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({status: res.statusCode, raw: Buffer.concat(chunks)}));
        res.on('error', reject);
      });
    req.setTimeout(60000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body); // http.request never follows redirects.
  });
}

async function main(argv) {
  if (argv.length === 1 && ['-h', '--help'].includes(argv[0])) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (argv.length !== 1) throw new Error(usage);
  const url = origin(argv[0]);
  const configReply = await request(new URL('/config', url));
  let encryption = '1';
  if (configReply.status !== 404) {
    if (configReply.status !== 200) throw new Error(`Could not read server settings (HTTP ${configReply.status})`);
    const config = JSON.parse(configReply.raw.toString('utf8'));
    if (config.protocol !== 2 || typeof config.encryption !== 'boolean') throw new Error('Invalid server settings');
    encryption = config.encryption ? '1' : '0';
  }
  const key = randomBytes(32);
  const derive = (label, length) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), label, length));
  const id = b64(derive('mayfly id', 16));
  const auth = b64(derive('mayfly auth', 32));
  const body = JSON.stringify({ id, auth_hash: b64(createHash('sha256').update(auth).digest()), encryption });
  const { status } = await request(new URL('/new', url), body);
  if (status === 503) throw new Error('HTTP 503: Server temporarily unavailable; try again shortly.');
  if (status !== 303) throw new Error(`HTTP ${status}`);
  process.stdout.write(`${url.origin}/c/${id}#${b64(key)}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`create: ${error.message}\n`);
  process.exitCode = 1;
}
