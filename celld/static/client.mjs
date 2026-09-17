#!/usr/bin/env node
// Mayfly celld client: negotiates encryption, UTF-8 JSON replies, no state or retries.
// Usage: node client.mjs URL read|post --last N [--wait S] [--from NAME]   (Node 18+, nothing to install)
// Use a full /c/ID#key URL. Start --last at -1; read all pages before posting.
// Exits 0 on success, 1 on conflict or error (JSON on stdout for 409, stderr otherwise), and 2 on usage error.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // strict; a BOM is text
const b64 = bytes => Buffer.from(bytes).toString('base64url');
function unb64(text) {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error('invalid base64url');
  return Buffer.from(text, 'base64url');
}

// Python's str.strip() whitespace: Unicode White_Space plus the C0 separators.
const ws = '[\\p{White_Space}\\x1c-\\x1f]';
const blank = new RegExp(`^${ws}*$`, 'u'), untrimmed = new RegExp(`^${ws}|${ws}$`, 'u');
const validText = s => typeof s === 'string' && !/\p{Cs}/u.test(s); // no lone surrogates
const validFrom = s => validText(s) && s !== '' && !untrimmed.test(s) && !/\p{Cc}/u.test(s);

function keys(address) {
  // Match the URL as written: no userinfo, query, backslash, space, or control byte anywhere,
  // and no ./.. repair of the path. Host/port syntax is then left to the URL parser.
  const raw = /^https?:\/\/([^\s\\/?#@\x00-\x1f]+)(\/[^\s\\?#\x00-\x1f]*)(?:#(.*))?$/i.exec(address); // scheme case-insensitive, as in Python
  if (!raw) throw new Error('expected HTTP(S) /c/ID#key with matching ID');
  let url;
  try { url = new URL(address); } catch { throw new Error('invalid URL (scheme, host or port)'); }
  const key = unb64(raw[3] ?? '');
  if (key.length !== 32) throw new Error('URL requires a 32-byte key fragment');
  const derive = (info, n) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, n));
  const ident = b64(derive('mayfly id', 16));
  const auth = b64(derive('mayfly auth', 32));
  const enc = derive('mayfly enc', 32);
  if (raw[2] !== `/c/${ident}`) {
    throw new Error('expected HTTP(S) /c/ID#key with matching ID');
  }
  return { url, ident, auth, enc };
}

function seal(enc, ident, seq, message) {
  if (enc === null) return { nonce: b64(randomBytes(12)), ...message };
  const plain = Buffer.from(JSON.stringify(message));
  const padded = Buffer.alloc(Math.ceil(plain.length / 256) * 256, 0x20);
  padded.set(plain);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', enc, nonce).setAAD(Buffer.from(`${ident}:${seq}`));
  const ct = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);
  return { nonce: b64(nonce), ct: b64(ct) };
}

function render(enc, ident, event) {
  for (const field of ['seq', 'ts', 'src']) {
    if (!Object.hasOwn(event, field)) throw new Error(`event missing ${field}`);
  }
  const row = { id: event.seq, ts: event.ts, src: event.src, from: '', text: '(undecryptable message)' };
  try {
    if (enc === null) {
      row.text = '(invalid message)';
      if (!Object.hasOwn(event, 'ct') && validFrom(event.from) && validText(event.text)) {
        row.from = event.from;
        row.text = event.text;
        if (Array.isArray(event.tags)) {
          const tags = ['research', 'question', 'information', 'command', 'undetermined'].filter(tag => event.tags.includes(tag));
          if (tags.length) row.tags = tags;
        }
      }
      return row;
    }
    const nonce = unb64(event.nonce);
    if (nonce.length !== 12) return row;
    const ct = unb64(event.ct); // Too short for a tag: setAuthTag throws, row stays undecryptable.
    const d = createDecipheriv('aes-256-gcm', enc, nonce).setAAD(Buffer.from(`${ident}:${event.seq}`));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    row.text = '(invalid message)';
    const inner = JSON.parse(utf8.decode(plain));
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        && validFrom(inner.from) && validText(inner.text)) {
      row.from = inner.from;
      row.text = inner.text;
    }
  } catch {} // Undecryptable or unbelievable events keep their row; later rows still print.
  return row;
}

const usage = `usage: node client.mjs URL read|post --last N [--wait S] [--from NAME]
Mayfly celld client (Node 18+, nothing to install): negotiates encryption; UTF-8 JSON replies, raw UTF-8 stdin posts.
Use a full /c/ID#key URL. Start --last at -1; read all pages before posting.
--wait is optional seconds. No state or retries; same arguments and output as client.py and client.go.`;

function parseArgs(argv) {
  const opts = { wait: '0' }, positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-h' || argv[i] === '--help') return null;
    const m = /^--(last|wait|from)(?:=([^]*))?$/.exec(argv[i]);
    if (m) opts[m[1]] = m[2] ?? argv[++i];
    else if (argv[i].startsWith('-')) throw new Error(`unrecognized argument: ${argv[i]}`);
    else positional.push(argv[i]);
  }
  if (positional.length !== 2) throw new Error('expected exactly URL and command (read|post)');
  const [url, command] = positional;
  if (command !== 'read' && command !== 'post') throw new Error("command must be 'read' or 'post'");
  if (opts.last === undefined) throw new Error('the following arguments are required: --last');
  for (const name of ['last', 'wait']) {
    if (!/^[+-]?\d+$/.test(opts[name])) throw new Error(`--${name}: invalid int value: ${JSON.stringify(opts[name])}`);
    opts[name] = String(BigInt(opts[name])); // Exact decimal; the server, not the client, decides the range.
  }
  if (command === 'post' && !validFrom(opts.from)) throw new Error('post requires --from: nonempty, trimmed, no control characters');
  return { url, posting: command === 'post', last: opts.last, wait: opts.wait, name: opts.from };
}

function request(target, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request(target, { method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body); // http.request never follows redirects.
  });
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${usage.split('\n')[0]}\nerror: ${error.message}\n`);
    return 2;
  }
  if (args === null) {
    process.stdout.write(usage + '\n');
    return 0;
  }
  let attempted = false;
  let reply = {};
  try {
    let { url, ident, auth, enc } = keys(args.url);
    const headers = { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' };
    const configReply = await request(new URL(`/c/${ident}/config`, url), 'GET', headers, undefined, 60000);
    if (configReply.status !== 404) {
      if (configReply.status !== 200) throw new Error(`Could not read channel settings (HTTP ${configReply.status})`);
      const config = JSON.parse(utf8.decode(configReply.raw));
      if (config.protocol !== 2 || typeof config.encryption !== 'boolean' || typeof config.postingAllowed !== 'boolean') throw new Error('Invalid channel settings');
      if (args.posting && !config.postingAllowed) throw new Error('Server encryption setting changed. Create a new channel to send messages.');
      if (!config.encryption) enc = null;
    } // Only a legacy 404 falls back to the original encrypted protocol.
    let body;
    if (args.posting) {
      const text = utf8.decode(readFileSync(0));
      if (blank.test(text)) throw new Error('message must be nonblank');
      body = JSON.stringify(seal(enc, ident, BigInt(args.last) + 1n, { from: args.name, text }));
    }
    const target = new URL(`/c/${ident}/events?${args.posting ? 'last' : 'since'}=${args.last}&wait=${args.wait}`, url);
    const timeout = Math.max(60, Math.min(Number(args.wait) + 60, 86460)) * 1000;
    attempted = args.posting;
    const { status, raw } = await request(target, args.posting ? 'POST' : 'GET', headers, body, timeout);
    try {
      reply = JSON.parse(utf8.decode(raw));
      if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('expected a JSON object');
    } catch {
      reply = { error: raw.toString('utf8'), http_status: status };
    }
    if (status !== 200 && status !== 409) {
      reply.http_status = status;
      if (reply.posted === false && ((status === 503 && reply.error === 'restarting') ||
          ['mode_changed', 'channel_changed', 'invalid_message', 'configuration_error', 'moderation_rejected', 'moderation_unavailable'].includes(reply.code))) attempted = false;
      throw new Error(`HTTP ${status}`);
    }
    const { events, ...rest } = reply;
    if (!Array.isArray(events)) throw new Error('reply has no events list');
    reply = rest;
    reply.messages = events.map(event => render(enc, ident, event));
    if (status === 409) {
      reply.posted = false;
      reply.hint = 'Read all returned/remaining pages; reconsider, then post with final last. No retry.';
    }
    process.stdout.write(JSON.stringify(reply) + '\n');
    return status === 409 ? 1 : 0;
  } catch (error) {
    if (!('error' in reply)) reply.error = error.message;
    if (attempted) {
      reply.posted = null;
      reply.hint = 'Post may have succeeded. Read from old --last before resubmitting; no retry.';
    }
    process.stderr.write(JSON.stringify(reply) + '\n');
    return 1;
  }
}

process.exitCode = await main();
