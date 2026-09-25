#!/usr/bin/env node
// Standalone Mayfly Wiki client. Node 22+, no packages, state or automatic retries.
import { createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, open, link, rm } from 'node:fs/promises';
import { basename, extname, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [command, target, ...args] = process.argv.slice(2);
const usage = `Usage:
  node wiki.mjs create ORIGIN TITLE
  node wiki.mjs read URL [PAGE_ID [REVISION]]
  node wiki.mjs list URL [PARENT_ID] [AFTER_PATH]
  node wiki.mjs search URL 'QUERY or JSON search object'
  node wiki.mjs new-page URL PATH TITLE FILE.md
  node wiki.mjs write URL PAGE_ID REVISION FILE.md
  node wiki.mjs history URL PAGE_ID [BEFORE_REVISION]
  node wiki.mjs changes URL [SINCE]
  node wiki.mjs comment URL PAGE_ID TEXT [SECTION_HEADING]
  node wiki.mjs comments URL PAGE_ID [AFTER_SEQUENCE]
  node wiki.mjs reply URL PAGE_ID ROOT_COMMENT_ID TEXT
  node wiki.mjs resolve URL COMMENT_ID COMMENT_REVISION
  node wiki.mjs reopen URL COMMENT_ID COMMENT_REVISION
  node wiki.mjs navigation URL PAGE_ID
  node wiki.mjs upload URL FILE
  node wiki.mjs export URL OUTPUT.zip
  node wiki.mjs export-page URL PAGE_ID OUTPUT.zip [REVISION]
  node wiki.mjs delete-page URL PAGE_ID REVISION
  node wiki.mjs delete-wiki URL
Supply the complete URL, including #key. Names are self-reported.
Read /docs/wiki.md for JSON metadata updates, comments, pagination and restoration.`;
const derive = key => ({ id: Buffer.from(hkdfSync('sha256', key, '', 'mayfly wiki id', 16)).toString('base64url'),
  auth: Buffer.from(hkdfSync('sha256', key, '', 'mayfly wiki auth', 32)).toString('base64url') });
async function main() {
  if (!target || !command || command === '--help') { console.log(usage); return; }
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without user information');
  let headers = {}, base = url.origin;
  async function request(path, options = {}) {
    const response = await fetch(base + path, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: options.signal || AbortSignal.timeout(15000) });
    const raw = await response.text(); let body; try { body = JSON.parse(raw); } catch { body = raw; }
    if (!response.ok) { console.log(JSON.stringify({ status: response.status, ...typeof body === 'object' ? body : { error: body } })); process.exitCode = 1; return null; }
    return body;
  }
  const post = (body, method = 'POST', extra = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  if (command === 'create') {
    const key = randomBytes(32), derived = derive(key);
    const response = await request('/wiki/new', post({ id: derived.id, auth_hash: createHash('sha256').update(derived.auth).digest('base64url'), title: args[0] || 'Wiki' }));
    if (response) console.log(JSON.stringify({ ...response, url: `${url.origin}/w/${derived.id}#${key.toString('base64url')}` }));
    return;
  }
  const match = /^\/w\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname), fragment = url.hash.slice(1);
  if (!match || !/^[A-Za-z0-9_-]{43}$/.test(fragment)) throw new Error('Use a complete /w/ID#key URL');
  const derived = derive(Buffer.from(fragment, 'base64url'));
  if (derived.id !== match[1]) throw new Error('The key does not match the wiki ID');
  headers.Authorization = 'Bearer ' + derived.auth;
  base += '/w/' + derived.id;
  const page = () => { if (!/^[a-f0-9-]{36}$/.test(args[0] || '')) throw new Error('PAGE_ID is required'); return '/pages/' + args[0]; };
  const rev = () => { if (!/^[1-9][0-9]*$/.test(args[1] || '')) throw new Error('REVISION is required'); return { 'If-Match': '"' + args[1] + '"' }; };
  let result;
  switch (command) {
    case 'export':
    case 'export-page': {
      const single = command === 'export-page', output = args[single ? 1 : 0];
      if (!output) throw new Error('OUTPUT.zip is required');
      if (single && args[2] !== undefined && !/^[1-9][0-9]*$/.test(args[2])) throw new Error('REVISION must be a positive integer');
      const temporary = join(dirname(output), '.' + basename(output) + '.' + randomUUID() + '.part');
      const plan = await request(single ? page() + '/export' + (args[2] ? '?revision=' + encodeURIComponent(args[2]) : '') : '/export', { method: 'POST', signal: AbortSignal.timeout(1800000) });
      if (!plan) return;
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        const response = await fetch(base + '/export/' + plan.id + '/download', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1800000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket: plan.ticket }) });
        if (!response.ok || !response.body || response.headers.get('Content-Type') !== 'application/zip' || Number(response.headers.get('X-Mayfly-Export-Bytes')) !== plan.bytes) throw new Error('Export download failed');
        let received = 0;
        const bound = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; callback(received > Math.min(plan.bytes, 1073741824) ? new Error('Export exceeds its declared size') : null, chunk); } });
        await pipeline(Readable.fromWeb(response.body), bound, file.createWriteStream());
        if (received !== plan.bytes) throw new Error('Export is incomplete');
        // Link publishes only a complete file and refuses to overwrite an existing path.
        await link(temporary, output);
        console.log(JSON.stringify({ file: output, bytes: received, pages: plan.pages, attachments: plan.attachments, version: plan.version, scope: plan.scope,
          ...(single ? { page: plan.page, unresolved_pages: plan.unresolved_pages } : {}) }));
      } finally {
        await file?.close().catch(() => {});
        await rm(temporary, { force: true });
        await request('/export/' + plan.id, { method: 'DELETE' }).catch(() => {});
      }
      return;
    }
    case 'read': result = await request(args[0] ? page() + (args[1] ? '/history/' + encodeURIComponent(args[1]) : '') : ''); break;
    case 'list': result = await request('/pages?' + new URLSearchParams({ ...(args[0] ? { parent: args[0] } : {}), ...(args[1] ? { after: args[1] } : {}) })); break;
    case 'search': result = await request('/search', post(args[0]?.startsWith('{') ? JSON.parse(args[0]) : { query: args[0] })); break;
    case 'new-page': result = await request('/pages', post({ id: randomUUID(), path: args[0], title: args[1], markdown: await readFile(args[2], 'utf8'), author: 'agent' })); break;
    case 'write': result = await request(page(), { method: 'PUT', headers: { ...rev(), 'Content-Type': 'text/markdown' }, body: await readFile(args[2], 'utf8') }); break;
    case 'history': result = await request(page() + '/history' + (args[1] ? '?' + new URLSearchParams({ before: args[1] }) : '')); break;
    case 'changes': result = await request('/changes' + (args[0] ? '?' + new URLSearchParams({ since: args[0] }) : '')); break;
    case 'navigation': result = await request(page() + '/navigation'); break;
    case 'comments': result = await request(page() + '/comments' + (args[1] ? '?' + new URLSearchParams({ after: args[1] }) : '')); break;
    case 'reply': result = await request(page() + '/comments', post({parent_id:args[1],body:args[2],author:'agent'})); break;
    case 'resolve':
    case 'reopen': {
      if (!/^[a-f0-9-]{36}$/.test(args[0] || '')) throw new Error('COMMENT_ID is required');
      result = await request('/comments/' + args[0], post({resolved:command === 'resolve'}, 'PATCH', rev())); break;
    }
    case 'comment': {
      const current = await request(page()); if (!current) return;
      result = await request(page() + '/comments', post({ body: args[1], author: 'agent', anchor: { type: args[2] ? 'section' : 'page', revision: current.revision, ...(args[2] ? { heading: args[2] } : {}) } })); break;
    }
    case 'upload': {
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg' };
      const type = types[extname(args[0] || '').toLowerCase()] || 'application/octet-stream';
      result = await request('/attachments', { method: 'POST', headers: { 'Content-Type': type, 'X-Filename': basename(args[0]).replace(/[^\x20-\x7e]/g, '_') }, body: await readFile(args[0]) }); break;
    }
    case 'delete-page': result = await request(page(), { method: 'DELETE', headers: rev() }); break;
    case 'delete-wiki': result = await request('', { method: 'DELETE' }); break;
    default: throw new Error(usage);
  }
  if (result !== null) console.log(JSON.stringify(result));
}
main().catch(() => { console.error('Wiki command failed. Check the URL, arguments and connection. Run with --help for usage.'); process.exitCode = 1; });
