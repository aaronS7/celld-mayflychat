import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { execute } from './wiki-test-helper.mjs';

test('summary boundaries preserve Unicode, favor recent chat context and bound escaped input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'summary-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'summaries.mjs');
  await execute('esbuild', [new URL('./native/summaries.ts', import.meta.url).pathname, '--bundle', '--platform=neutral', '--format=esm', '--outfile=' + file]);
  const { summaryClip, summaryInput, summarySettings, SummaryLimiter, summaryLimits, streamSummary, sseData } = await import(pathToFileURL(file));
  assert.deepEqual(summarySettings({}), { enabled: false });
  assert.throws(() => summarySettings({ AI_SUMMARY_ENABLED: 'true' }), error => error.status === 503);
  assert.deepEqual(summarySettings({ ENCRYPTION_ENABLED: '1', AI_SUMMARY_ENABLED: 'invalid' }), { enabled: false });
  for (let max = 0; max < 32; max++) {
    const clipped = summaryClip('Résumé 🐝 日本語'.repeat(4), max);
    assert.ok(clipped.isWellFormed() && Buffer.byteLength(clipped) <= max);
    assert.ok('Résumé 🐝 日本語'.repeat(4).startsWith(clipped));
  }
  const source = (seq, text) => ({ seq, title: 'Message ' + seq, text, originalBytes: Buffer.byteLength(text) });
  const snapshot = { scope: 'chat', title: 'Conversation', version: 2, total: 3,
    sources: [source(0, 'Old context'.repeat(20000)), source(1, 'New decision'.repeat(18000)), source(2, 'Newest next step.')] };
  const recent = summaryInput(snapshot);
  assert.deepEqual(recent.metadata.sources.map(s => s.seq), [1, 2]);
  assert.equal(recent.metadata.partial, true);
  assert.equal(recent.metadata.sources[0].excerpt, true);
  assert.equal(JSON.parse(recent.messages[1].content).sources.at(-1).text, 'Newest next step.');
  const escaped = summaryInput({ ...snapshot, sources: Array.from({ length: 200 }, (_, seq) => source(seq, '\u0001"\\🐝'.repeat(4000))), total: 200 });
  assert.ok(Buffer.byteLength(escaped.messages[1].content) <= summaryLimits.inputBytes);
  assert.ok(JSON.parse(escaped.messages[1].content).sources.every(s => s.text.isWellFormed()));
  assert.throws(() => summaryInput({ ...snapshot, sources: [source(0, '  \n ')] }), error => error.status === 422);

  // Releasing concurrency must not bypass the one-minute start limit.
  const limiter = new SummaryLimiter(), releases = [limiter.acquire(), limiter.acquire()];
  assert.throws(() => limiter.acquire(), error => error.status === 429);
  releases[0](); releases[0](); releases[1]();
  for (let n = 2; n < summaryLimits.perMinute; n++) limiter.acquire()();
  assert.throws(() => limiter.acquire(), error => error.status === 429);

  // Event records can contain multiline data and UTF-8 split at arbitrary bytes.
  const payload = Buffer.from(': heartbeat\r\ndata: Résumé 🐝\r\ndata: second line\r\n\r\ndata: [DONE]\n\n');
  const provider = new ReadableStream({ start(controller) { for (const byte of payload) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const frames = []; for await (const frame of sseData(provider.getReader())) frames.push(frame);
  assert.deepEqual(frames, ['Résumé 🐝\nsecond line', '[DONE]']);

  const previousFetch = globalThis.fetch, deadline = summaryLimits.timeoutMS;
  t.after(() => { globalThis.fetch = previousFetch; summaryLimits.timeoutMS = deadline; });
  let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); };
  const env = { AI_SUMMARY_ENABLED: '1', MERCURY_BASE_URL: 'https://provider.example/v1', MERCURY_API_KEY: 'fixture-key' };
  const generate = options => streamSummary(new Request('https://app.example/summary'), { ...env, ...options }, snapshot, new SummaryLimiter(), () => {});
  for (const base of ['http://provider.example/v1', 'https://key@provider.example/v1', 'https://provider.example/v1?key=secret', 'invalid']) {
    await assert.rejects(generate({ MERCURY_BASE_URL: base }), error => error.status === 503);
  }
  assert.equal(calls, 0, 'invalid configuration cannot contact a provider');
  summaryLimits.timeoutMS = 30;
  await assert.rejects(generate({}), error => error.status === 504);
  assert.equal(calls, 1, 'a stalled provider is aborted at the deadline');
});
