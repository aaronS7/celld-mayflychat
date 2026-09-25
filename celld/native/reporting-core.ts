/** Durable report windows and an at-least-once email outbox. Kept identical in the three apps. */
export const HOUR = 3_600_000;
type Value = string | number | null;
export interface ReportStorage {
  sql: { exec(query: string, ...args: Value[]): { toArray(): unknown[] } };
  transactionSync<T>(fn: () => T): T;
  sync(): Promise<void>;
}
export interface ReportEnv {
  REPORTS_ENABLED?: string;
  REPORT_CONTENT?: string;
  OWNER_EMAIL?: string;
  TEST_MODE?: string;
  TEST_SERVICE_URL?: string;
}
export type Window = { name: string; start_ms: number; end_ms: number; interval_ms: number; retry_ms: number; error: string | null };
// Treat unclassified mail conservatively; count-only reports opt out explicitly.
export type Mail = { subject: string; body: string; contentSensitive?: boolean };
type QueuedMail = Mail & { id: string; attempts: number; recipient: string | null; content_sensitive: number };
export const periodLabel = (w: Window) => `${new Date(w.start_ms).toISOString()} — ${new Date(w.end_ms).toISOString()} (UTC, end exclusive)`;

export function integrationURL(env: ReportEnv, testPath: string, production: string): string {
  if (env.TEST_MODE !== '1' || !env.TEST_SERVICE_URL) return production;
  const url = new URL(env.TEST_SERVICE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Test integration must use loopback');
  return url.origin + testPath;
}
async function reportRecipient(env: ReportEnv): Promise<string> {
  let recipient = env.OWNER_EMAIL;
  if (!recipient) {
    const response = await fetch(integrationURL(env, '/email', 'https://reflection.int.exe.xyz/email'), { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    if (!response.ok) throw new Error(`Owner lookup HTTP ${response.status}`);
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    recipient = typeof value === 'string' ? value : value.email ?? value.owner_email;
  }
  if (!recipient || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)) throw new Error('Owner email unavailable');
  return recipient;
}
export async function sendReport(env: ReportEnv, mail: Mail): Promise<void> {
  const recipient = await reportRecipient(env);
  const response = await fetch(integrationURL(env, '/send', 'http://169.254.169.254/gateway/email/send'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ to: recipient, subject: mail.subject.replace(/[\r\n]/g, ' ').slice(0, 200), body: mail.body }),
  });
  if (!response.ok) throw new Error(`Email HTTP ${response.status}`);
  if ((await response.json() as { success?: boolean }).success !== true) throw new Error('Email acceptance unconfirmed');
}

export class ReportStore {
  constructor(readonly storage: ReportStorage, private readonly env: ReportEnv = {}) {
    this.run(`CREATE TABLE IF NOT EXISTS report_windows (name TEXT PRIMARY KEY, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, interval_ms INTEGER NOT NULL, retry_ms INTEGER NOT NULL DEFAULT 0, error TEXT)`);
    this.run(`CREATE TABLE IF NOT EXISTS report_outbox (id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL, next_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_ms INTEGER, error TEXT)`);
    const columns = new Set(this.rows<{ name: string }>('PRAGMA table_info(report_outbox)').map(row => row.name));
    this.storage.transactionSync(() => {
      if (!columns.has('recipient')) this.run('ALTER TABLE report_outbox ADD COLUMN recipient TEXT');
      if (!columns.has('content_sensitive')) this.run('ALTER TABLE report_outbox ADD COLUMN content_sensitive INTEGER NOT NULL DEFAULT 1');
      if (!columns.has('cancelled_ms')) this.run('ALTER TABLE report_outbox ADD COLUMN cancelled_ms INTEGER');
      // Existing queues did not capture a recipient. Never assign their private
      // bodies to whichever owner happens to be configured during an upgrade.
      if (!columns.has('recipient')) this.cancel('Legacy report cancelled: original recipient unavailable.', '1=1');
    });
    this.run('CREATE INDEX IF NOT EXISTS report_mail_due ON report_outbox(sent_ms,next_ms)');
    // Object construction observes settings even when disabled handlers return
    // before delivering. Re-enabling later must not restore cancelled content.
    this.applyPolicy(this.env);
  }
  rows<T = Record<string, Value>>(query: string, ...args: Value[]): T[] { return this.storage.sql.exec(query, ...args).toArray() as T[]; }
  run(query: string, ...args: Value[]) { this.rows(query, ...args); }
  ensure(name: string, interval: number, now = Date.now()) {
    this.run('INSERT OR IGNORE INTO report_windows(name,start_ms,end_ms,interval_ms) VALUES (?,?,?,?)', name, now, (Math.floor(now / interval) + 1) * interval, interval);
  }
  window(name: string) { return this.rows<Window>('SELECT * FROM report_windows WHERE name=?', name)[0]; }
  due(name: string, until = Date.now()): Window | undefined {
    const w = this.window(name);
    return w && w.end_ms <= until && w.retry_ms <= Date.now() ? w : undefined;
  }
  enqueue(id: string, mail: Mail, now = Date.now()) {
    this.run('INSERT OR IGNORE INTO report_outbox(id,subject,body,created_ms,next_ms,recipient,content_sensitive) VALUES (?,?,?,?,?,?,?)', id, mail.subject, mail.body, now, now, this.env.OWNER_EMAIL || null, mail.contentSensitive === false ? 0 : 1);
  }
  complete(w: Window, mail?: Mail) {
    this.storage.transactionSync(() => {
      if (this.window(w.name)?.start_ms !== w.start_ms) return;
      if (mail) this.enqueue(`${w.name}:${w.end_ms}`, mail);
      this.run('UPDATE report_windows SET start_ms=?,end_ms=?,retry_ms=0,error=NULL WHERE name=?', w.end_ms, w.end_ms + w.interval_ms, w.name);
    });
  }
  failed(w: Window, now = Date.now()) {
    this.run('UPDATE report_windows SET retry_ms=?,error=? WHERE name=?', now + 300_000, 'Report preparation failed; retry scheduled.', w.name);
  }
  next(names: string[]): number | null {
    const times = names.map(name => this.window(name)).filter(Boolean).map(w => Math.max(w.end_ms, w.retry_ms));
    const mail = this.rows<{ at: number | null }>('SELECT MIN(next_ms) at FROM report_outbox WHERE sent_ms IS NULL AND cancelled_ms IS NULL')[0].at;
    if (mail !== null) times.push(mail);
    return times.length ? Math.min(...times) : null;
  }
  private cancel(reason: string, where: string, ...args: Value[]) {
    this.run(`UPDATE report_outbox SET cancelled_ms=?,subject='',body='',error=? WHERE sent_ms IS NULL AND cancelled_ms IS NULL AND ${where}`, Date.now(), reason, ...args);
  }
  private applyPolicy(env: ReportEnv) {
    if (env.REPORT_CONTENT === '0') this.cancel('Report cancelled: content reporting disabled.', 'content_sensitive<>0');
    if (env.OWNER_EMAIL) this.cancel('Report cancelled: recipient configuration changed.', 'recipient IS NOT NULL AND recipient<>?', env.OWNER_EMAIL);
  }
  async reconcilePolicy(env: ReportEnv = this.env) {
    this.applyPolicy(env);
    await this.storage.sync();
  }
  async deliver(env: ReportEnv, limit = 5) {
    // Apply opt-outs to the whole pending queue, including future backoff times.
    // Cancellation is durable and never reversed by a subsequent opt-in.
    await this.reconcilePolicy(env);
    if (env.REPORTS_ENABLED === '0') return;
    for (let i = 0; i < limit; i++) {
      const row = this.rows<QueuedMail>('SELECT * FROM report_outbox WHERE sent_ms IS NULL AND cancelled_ms IS NULL AND next_ms<=? ORDER BY created_ms,id LIMIT 1', Date.now())[0];
      if (!row) break;
      this.run('UPDATE report_outbox SET attempts=attempts+1,next_ms=? WHERE id=?', Date.now() + 120_000, row.id);
      await this.storage.sync();
      try {
        if (!row.recipient) {
          row.recipient = await reportRecipient(env);
          this.run('UPDATE report_outbox SET recipient=? WHERE id=? AND recipient IS NULL', row.recipient, row.id);
          // A successful lookup must survive a restart before any email is sent.
          await this.storage.sync();
        }
        // Lookup/storage may yield. Recheck settings at the last local decision
        // point; a provider request already sent cannot be revoked.
        this.applyPolicy(env);
        if (this.rows<{ cancelled_ms: number | null }>('SELECT cancelled_ms FROM report_outbox WHERE id=?', row.id)[0].cancelled_ms !== null) {
          await this.storage.sync();
          continue;
        }
        if (env.REPORTS_ENABLED === '0') break;
        await sendReport({ ...env, OWNER_EMAIL: row.recipient }, row);
        this.run('UPDATE report_outbox SET sent_ms=?,error=NULL WHERE id=?', Date.now(), row.id);
      } catch {
        this.run('UPDATE report_outbox SET next_ms=?,error=? WHERE id=?', Date.now() + Math.min(4 * HOUR, 300_000 * 2 ** Math.min(row.attempts, 6)), 'Email not confirmed; retry scheduled.', row.id);
      }
      await this.storage.sync();
    }
    // Keep idempotency receipts; erase old email content rather than retaining it indefinitely.
    this.run("UPDATE report_outbox SET body='' WHERE sent_ms IS NOT NULL AND sent_ms<? AND body<>''", Date.now() - 7 * 24 * HOUR);
  }
  status() {
    return { windows: this.rows<Window>('SELECT * FROM report_windows ORDER BY name'),
      mail: this.rows('SELECT id,created_ms,next_ms,attempts,sent_ms,cancelled_ms,error FROM report_outbox ORDER BY created_ms DESC LIMIT 20') };
  }
}
