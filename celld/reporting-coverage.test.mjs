// Real Mayfly source with real SQLite. Providers and chat creation are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

function load(path, stub = false) {
  let source = execFileSync(process.env.ESBUILD || 'esbuild', [path, '--bundle', '--format=esm', '--external:cloudflare:workers'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (stub) {
    let replaced = 0;
    source = source.replace(/^import\s*\{\s*DurableObject(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\s*from\s*["']cloudflare:workers["'];?/gm, (_, alias) => {
      replaced++;
      return `class ${alias || 'DurableObject'} { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`;
    });
    assert(replaced > 0);
    assert(!source.includes('from "cloudflare:workers"'));
  }
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const { MayflyReports } = await load('celld/native/reports.ts');
const { CreationGate } = await load('celld/native/worker.ts', true);
const HOUR = 3_600_000;
function fixture(t) {
  let now = 1, alarm = null;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External fetch forbidden in coverage tests'); });
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const storage = {
    sql: { exec(query, ...args) { const rows = db.prepare(query).all(...args); return { toArray: () => rows, one() { assert.equal(rows.length, 1); return rows[0]; } }; } },
    transactionSync(fn) { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    async sync() {}, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; }, async getAlarm() { return alarm; },
  };
  const creations = [];
  const env = { REPORTS_ENABLED: '1', REPORT_CONTENT: '0', OWNER_EMAIL: 'owner@example.invalid', CHATS: {
    idFromName: id => id, get: id => ({ async fetch(request) {
      if (typeof request === 'string' || new URL(request.url).pathname === '/_report') return Response.json({ encrypted: false, count: 1, messages: [] });
      creations.push({ id, at: now }); return new Response(null, { status: 204 });
    } }),
  } };
  return { storage, env, creations, at(value) { now = value; }, reports: () => new MayflyReports(storage, env), gate: () => new CreationGate({ storage }, env), rows: query => storage.sql.exec(query).toArray() };
}
const send = (gate, path, body) => gate.fetch(new Request('https://internal' + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
const create = (gate, id) => send(gate, '/new', { id, auth_hash: 'synthetic', ip: '192.0.2.1', encryption: '0' });
const countMail = f => f.rows("SELECT * FROM report_outbox WHERE id LIKE 'chat-count:%' ORDER BY created_ms,id");
const hourlyMail = f => f.rows("SELECT * FROM report_outbox WHERE id LIKE 'hourly-chats:%' ORDER BY created_ms,id");
const incomplete = mail => /incomplete coverage/i.test(mail.body);
function insert(r, id, at) { r.store.run('INSERT INTO report_chats(event_id,chat_id,encryption,created_ms,recorded) VALUES (?,?,?, ?,1)', id, id, '0', at); }

test('disabled creation plus restart reports incomplete coverage without discarding tracked creations', async t => {
  const f = fixture(t); let gate = f.gate(); await send(gate, '/reports/start');
  f.at(HOUR); assert.equal((await create(gate, 'before')).status, 303);
  f.at(2 * HOUR); f.env.REPORTS_ENABLED = '0'; assert.equal((await create(gate, 'untracked')).status, 303);
  f.at(3 * HOUR); f.env.REPORTS_ENABLED = '1'; gate = f.gate(); assert.equal((await create(gate, 'after')).status, 303);
  f.at(12 * HOUR); await send(gate, '/reports/cron', { at: 12 * HOUR });
  const mail = countMail(f); assert.equal(mail.length, 1); assert(incomplete(mail[0]));
  assert.match(mail[0].body, /Recorded chats created: 2\./); assert.doesNotMatch(mail[0].body, /Total chats created:/);
  assert.equal(f.rows('SELECT * FROM report_chats WHERE recorded=1').length, 2);
  await send(gate, '/reports/cron', { at: 12 * HOUR }); assert.equal(countMail(f).length, 1);
});

test('an empty hourly window with a tracking gap emits a count-only incomplete notice', async t => {
  const f = fixture(t); let r = f.reports(); r.ensure();
  f.at(1000); f.env.REPORTS_ENABLED = '0'; r.ensure();
  f.at(HOUR); f.env.REPORTS_ENABLED = '1'; r = f.reports(); await r.hourly();
  const mail = hourlyMail(f); assert.equal(mail.length, 1); assert(incomplete(mail[0]));
  assert.match(mail[0].body, /Recorded chats created: 0\./);
});

test('tracking gap boundaries remain half-open and do not contaminate later complete windows', t => {
  const f = fixture(t); const r = f.reports(); r.ensure();
  f.at(12 * HOUR); r.ensure(); f.env.REPORTS_ENABLED = '0'; r.ensure();
  f.at(24 * HOUR); f.env.REPORTS_ENABLED = '1'; r.cron(24 * HOUR);
  f.at(36 * HOUR); r.cron(36 * HOUR);
  const mail = countMail(f); assert.equal(mail.length, 3);
  assert.deepEqual(mail.map(incomplete), [false, true, false]);
  assert.match(mail[0].body, /Total chats created: 0\./); assert.match(mail[2].body, /Total chats created: 0\./);
});

test('restarts while continuously enabled preserve cursors and do not invent tracking gaps', t => {
  const f = fixture(t); let r = f.reports(); r.ensure(); insert(r, 'kept', HOUR);
  for (const hour of [2, 5, 8]) { f.at(hour * HOUR); r = f.reports(); r.ensure(); assert.equal(r.store.window('chat-count').start_ms, 1); }
  f.at(12 * HOUR); r.cron(12 * HOUR);
  assert.equal(countMail(f).length, 1); assert(!incomplete(countMail(f)[0])); assert.match(countMail(f)[0].body, /Total chats created: 1\./);
});

test('disabled observations and restarts preserve the earliest uncertain boundary', t => {
  const f = fixture(t); let r = f.reports(); r.ensure(); f.at(HOUR); r.ensure();
  f.at(2 * HOUR); f.env.REPORTS_ENABLED = '0'; r.ensure();
  f.at(4 * HOUR); r = f.reports(); r.ensure();
  f.at(6 * HOUR); f.env.REPORTS_ENABLED = '1'; r = f.reports(); r.ensure();
  const gaps = f.rows('SELECT start_ms,end_ms FROM report_tracking_gaps');
  assert.deepEqual(gaps.map(g => [g.start_ms, g.end_ms]), [[HOUR, 6 * HOUR]]);
});

test('gap cleanup waits for both reporting cursors', async t => {
  const f = fixture(t); const r = f.reports(); r.ensure();
  f.at(1000); f.env.REPORTS_ENABLED = '0'; r.ensure(); f.at(HOUR); f.env.REPORTS_ENABLED = '1'; r.ensure();
  f.at(12 * HOUR); r.cron(12 * HOUR); r.cleanup();
  assert.equal(f.rows('SELECT * FROM report_tracking_gaps').length, 1);
  await r.hourly(); assert(incomplete(hourlyMail(f)[0])); r.cleanup();
  assert.equal(f.rows('SELECT * FROM report_tracking_gaps').length, 0);
});

test('migration of legacy cursors marks unknown coverage and preserves tracked data', t => {
  const f = fixture(t); let r = f.reports();
  r.store.ensure('chat-count', 12 * HOUR, 1); r.store.ensure('hourly-chats', HOUR, 1); insert(r, 'legacy', 1000);
  f.at(12 * HOUR); r = f.reports(); r.cron(12 * HOUR);
  const mail = countMail(f); assert.equal(mail.length, 1); assert(incomplete(mail[0])); assert.match(mail[0].body, /Recorded chats created: 1\./);
});

test('starting disabled then enabling starts fresh windows without claiming historic coverage', t => {
  const f = fixture(t); f.env.REPORTS_ENABLED = '0'; let r = f.reports(); r.ensure();
  f.at(12 * HOUR); f.env.REPORTS_ENABLED = '1'; r = f.reports(); r.cron(12 * HOUR);
  assert.equal(countMail(f).length, 0); assert.equal(r.store.window('chat-count').start_ms, 12 * HOUR);
  f.at(24 * HOUR); r.cron(24 * HOUR); assert(!incomplete(countMail(f)[0]));
});

test('disabled alarm records a durable gap before removing its alarm', async t => {
  const f = fixture(t); let gate = f.gate(); await send(gate, '/reports/start');
  f.at(HOUR); f.env.REPORTS_ENABLED = '0'; gate = f.gate(); await gate.alarm(); assert.equal(await f.storage.getAlarm(), null);
  f.at(12 * HOUR); f.env.REPORTS_ENABLED = '1'; gate = f.gate(); await send(gate, '/reports/cron', { at: 12 * HOUR });
  assert(incomplete(countMail(f)[0]));
});

test('a disabled status observation records the gap even when no creation follows', async t => {
  const f = fixture(t); let gate = f.gate(); await send(gate, '/reports/start');
  f.at(HOUR); f.env.REPORTS_ENABLED = '0'; await send(gate, '/reports/status');
  f.at(12 * HOUR); f.env.REPORTS_ENABLED = '1'; gate = f.gate(); await send(gate, '/reports/cron', { at: 12 * HOUR });
  assert(incomplete(countMail(f)[0]));
});

test('one fully unobserved toggle cannot be inferred from enabled observations alone', t => {
  const f = fixture(t); const r = f.reports(); r.ensure();
  f.env.REPORTS_ENABLED = '0'; f.at(HOUR); // No request or alarm sees this configuration.
  f.env.REPORTS_ENABLED = '1'; f.at(12 * HOUR); r.cron(12 * HOUR);
  assert(!incomplete(countMail(f)[0])); // Deliberate observation limit, not proof of config continuity.
});

test('unconfirmed coverage metadata prevents dispatch of an untracked creation', async t => {
  const f = fixture(t); const gate = f.gate(); await send(gate, '/reports/start');
  f.at(HOUR); f.env.REPORTS_ENABLED = '0';
  f.storage.sync = async () => { throw new Error('Synthetic durability failure'); };
  const response = await create(gate, 'must-not-dispatch');
  assert.equal(response.status, 500); assert.deepEqual(f.creations, []);
});

test('empty same-instant disabled observations do not label unrelated coverage incomplete', t => {
  const f = fixture(t); const r = f.reports(); r.ensure();
  f.at(HOUR); r.ensure(); f.env.REPORTS_ENABLED = '0'; r.ensure(); f.env.REPORTS_ENABLED = '1'; r.ensure();
  f.at(12 * HOUR); r.cron(12 * HOUR); assert(!incomplete(countMail(f)[0]));
});

test('count-only and plaintext report metadata distinguish opt-out behavior', async t => {
  const f = fixture(t); const r = f.reports(); r.ensure(); insert(r, 'plaintext', 1000);
  f.at(HOUR); const window = r.store.due('hourly-chats');
  const counts = await r.prepare(window); assert.equal(counts.contentSensitive, false);
  f.env.REPORT_CONTENT = '1'; f.env.REPORT_SUMMARY_URL = 'https://synthetic.invalid/summary'; f.env.REPORT_SUMMARY_MODEL = 'synthetic';
  f.env.CHATS.get = () => ({ fetch: async () => Response.json({ encrypted: false, count: 1, messages: [{ from: 'Synthetic', text: 'Private content' }] }) });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'Synthetic plaintext summary' } }] }));
  const plaintext = await r.prepare(window); assert.equal(plaintext.contentSensitive, true);
  const prepared = [];
  t.mock.method(r.store, 'complete', (w, mail) => { prepared.push(mail); r.store.run('UPDATE report_windows SET start_ms=?,end_ms=? WHERE name=?', w.end_ms, w.end_ms + w.interval_ms, w.name); });
  f.at(12 * HOUR); r.cron(12 * HOUR); assert.equal(prepared.length, 1); assert.equal(prepared[0].contentSensitive, false);
});

test('coverage tracking preserves the zero epoch as a valid window and gap boundary', t => {
  const f = fixture(t); f.at(0); const r = f.reports(); r.ensure();
  f.at(1000); f.env.REPORTS_ENABLED = '0'; r.ensure();
  f.at(12 * HOUR); f.env.REPORTS_ENABLED = '1'; r.cron(12 * HOUR);
  const mail = countMail(f); assert.equal(mail.length, 1); assert(incomplete(mail[0]));
  assert.match(mail[0].body, /^1970-01-01T00:00:00\.000Z/);
  assert.equal(f.rows('SELECT start_ms FROM report_tracking_gaps')[0].start_ms, 0);
});

test('status observation does not start reporting windows before explicit start or activity', async t => {
  const f = fixture(t); const gate = f.gate(); await send(gate, '/reports/status');
  assert.deepEqual(f.rows('SELECT * FROM report_windows'), []);
  f.at(HOUR); await send(gate, '/reports/start');
  assert.equal(f.reports().store.window('chat-count').start_ms, HOUR);
});

for (const entry of ['status', 'alarm']) {
  test(`actual disabled ${entry} cancels queued plaintext before later re-enable`, async t => {
    const f = fixture(t); const r = f.reports(); r.ensure();
    r.store.enqueue('queued-private', { subject: 'Saved summary', body: 'SYNTHETIC_SAVED_PLAINTEXT' });
    f.at(1000); f.env.REPORTS_ENABLED = '0'; f.env.REPORT_CONTENT = '0';
    const disabled = f.gate();
    if (entry === 'status') assert.equal((await send(disabled, '/reports/status')).status, 200);
    else await disabled.alarm();
    const afterDisabled = f.rows("SELECT * FROM report_outbox WHERE id='queued-private'")[0];
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ success: true }); });
    f.at(2000); f.env.REPORTS_ENABLED = '1'; f.env.REPORT_CONTENT = '1';
    await f.gate().alarm();
    assert(!calls.some(mail => mail.body.includes('SYNTHETIC_SAVED_PLAINTEXT')), `Actual ${entry} path retained and sent opted-out plaintext: ${JSON.stringify(calls)}`);
    assert.equal(afterDisabled.body, ''); assert.equal(afterDisabled.cancelled_ms, 1000);
  });

  test(`disabled ${entry} cannot confirm opt-out when storage durability fails`, async t => {
    const f = fixture(t); const r = f.reports(); r.ensure(); r.store.enqueue('queued-private', { subject: 'Saved summary', body: 'SYNTHETIC_SAVED_PLAINTEXT' });
    f.at(1000); f.env.REPORTS_ENABLED = '0'; f.env.REPORT_CONTENT = '0';
    f.storage.sync = async () => { throw new Error('Synthetic cancellation durability failure'); };
    const disabled = f.gate();
    if (entry === 'status') assert.equal((await send(disabled, '/reports/status')).status, 500);
    else await assert.rejects(disabled.alarm(), /Synthetic cancellation durability failure/);
  });
}
