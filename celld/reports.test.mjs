import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
const source = execFileSync('esbuild', ['celld/native/reports.ts', '--bundle', '--format=esm'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const { MayflyReports } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('replaying a creation receipt after expiry never resurrects the deleted chat', async t => {
  let now=1_000_000;t.mock.method(Date,'now',()=>now);
  const compiled=execFileSync('esbuild',['celld/native/worker.ts','--bundle','--format=esm','--external:cloudflare:workers'],{encoding:'utf8',maxBuffer:8*1024*1024});
  const source=compiled.replace(/import \{ DurableObject(?: as (\w+))? \} from "cloudflare:workers";/g,
    (_, name='DurableObject') => `class ${name} { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }`);
  assert.notEqual(source,compiled);
  const { Chat }=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const ctx={storage:{sql:{exec(q,...a){const rows=db.prepare(q).all(...a);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},async setAlarm(){},async deleteAlarm(){}}};
  const env={ENCRYPTION_ENABLED:'0',JEV_ENABLED:'0',JEV_TAGGING_ENABLED:'0',RETENTION_SECONDS:'1'};
  const chat=new Chat(ctx,env);
  const create=id=>chat.fetch(new Request('https://mayfly.internal/_create',{method:'POST',body:JSON.stringify({auth_hash:Buffer.alloc(32,1).toString('base64url'),encryption:'0',creation_id:id})}));
  assert.equal((await create('first')).status,204);assert.equal(db.prepare('SELECT COUNT(*) n FROM channel').get().n,1);
  now+=2000;assert.equal((await create('first')).status,204);assert.equal(db.prepare('SELECT COUNT(*) n FROM channel').get().n,0);
  assert.equal((await create('second')).status,204);assert.equal(db.prepare('SELECT COUNT(*) n FROM channel').get().n,1);
});
test('cron counts deleted creations, includes zero, and ignores duplicate ticks; encrypted content stays out of model input', async t => {
  let now = 1; t.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const storage = { sql: { exec(q,...a) { return { toArray: () => db.prepare(q).all(...a) }; } }, transactionSync(fn) { db.exec('BEGIN'); try { const value=fn(); db.exec('COMMIT'); return value; } catch(e) {db.exec('ROLLBACK');throw e;} }, async sync() {} };
  const env = { REPORTS_ENABLED:'1', REPORT_SUMMARY_URL:'https://summary.example/v1/chat/completions',REPORT_SUMMARY_MODEL:'test', CHATS: { idFromName: x=>x, get: id=>({ async fetch() { return Response.json(id==='encrypted' ? { encrypted:true,count:3,messages:[] } : { encrypted:false,count:1,messages:[{from:'Alice',text:'Test topic'}] }); } }) } };
  const reports = new MayflyReports(storage,env);reports.ensure();
  for (const id of ['plain','encrypted','deleted']) reports.store.run('INSERT INTO report_chats(event_id,chat_id,encryption,created_ms,recorded) VALUES (?,?,?,?,1)',id,id,id==='encrypted'?'1':'0',1000);
  let captured;
  t.mock.method(globalThis,'fetch',async (_url,init)=>{captured=JSON.parse(init.body);return Response.json({choices:[{message:{content:'A concise chat summary.'}}]});});
  now=3600000;await reports.hourly();
  assert.match(captured.messages[1].content,/Test topic/);
  assert.match(captured.messages[1].content,/"encrypted":true,"count":3,"messages":\[\]/);
  now=12*3600000;reports.cron(now);reports.cron(now);
  let rows=reports.store.rows("SELECT * FROM report_outbox WHERE id LIKE 'chat-count:%'");assert.equal(rows.length,1);assert.match(rows[0].body,/Total chats created: 3/);
  now=24*3600000;reports.cron(now);rows=reports.store.rows("SELECT * FROM report_outbox WHERE id LIKE 'chat-count:%' ORDER BY created_ms");assert.equal(rows.length,2);assert.match(rows[1].body,/Total chats created: 0/);
});
