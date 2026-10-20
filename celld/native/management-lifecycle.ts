import { b64, unb64, HTTPError, json } from './protocol';
import { bodyJSON } from './wiki-core';
import { auditDays, deadlines, defaults, policyInput, type ManagementSettings, type Receipt, type ResourceKind, type ResourceRecord } from './management-core';
import { archiveStore, encodeJSON, putVerified, readVerified, sha256, type ArchiveEnv, type ArchiveStore } from './management-storage';

export interface LifecycleEnv extends ManagementSettings, ArchiveEnv { MANAGEMENT?: DurableObjectNamespace; WIKI_FILES?: R2Bucket }
type ObjectEntry = {key: string; size: number; sha256: string; table?: string; rows?: number; file?: string; type?: string};
// backoff counts consecutive failed runs; record.attempts keeps the operation's total failures.
type Job = {action: 'archive' | 'archive-delete' | 'delete' | 'restore'; actor: string; id: string; at: number; stage: string; table: number; cursor: number; index: number; source: ResourceRecord; receipt?: Receipt; backoff?: number};
type Manifest = {format: 'mayfly-backup'; version: 1; schema_version: 1; archive_id: string; created_at: number; resource: ResourceRecord; tables: string[]; objects: ObjectEntry[]};
const tables = {chat:['channel','events','linked_spaces'], wiki:['wiki','pages','revisions','comments','changes','attachments','linked_spaces','chunks','wiki_search']};
const linkSchema = 'CREATE TABLE IF NOT EXISTS linked_spaces(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,nonce TEXT NOT NULL,ct TEXT NOT NULL,created_at TEXT NOT NULL)';
const pack = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k,v]) => [k,v instanceof ArrayBuffer ? {blob:b64(new Uint8Array(v))} : v]));
const unpack = (v: unknown): SqlStorageValue => v !== null && typeof v === 'object' && 'blob' in v && typeof v.blob === 'string' ? unb64(v.blob)!.buffer as ArrayBuffer : v as SqlStorageValue;

// The resource owns policy and lifecycle state. The catalog is only a replica.
// All content mutations check availability again after their last async boundary.
export class ResourceLifecycle {
  private sql: SqlStorage;
  private exists: boolean;
  private running?: Promise<void>;
  private pushing?: Promise<void>;
  private verifiedManifest?: {hash: string; value: Manifest};
  constructor(private ctx: DurableObjectState, private env: LifecycleEnv, private kind: ResourceKind, private hooks: {busy: () => boolean; changed: () => void}) {
    this.sql = ctx.storage.sql;
    this.exists = this.has('management_state');
  }
  private has(table: string) { return !!this.sql.exec("SELECT 1 FROM sqlite_master WHERE name=?", table).toArray().length; }
  record(): ResourceRecord | undefined { return this.exists ? JSON.parse(this.sql.exec<{value:string}>('SELECT value FROM management_state WHERE singleton=1').one().value) : undefined; }
  private job(): Job | undefined { const v = this.exists && this.sql.exec<{job:string | null}>('SELECT job FROM management_state WHERE singleton=1').one().job; return v ? JSON.parse(v) : undefined; }
  // dirty: 0 synced, 1 activity only (the alarm pushes it), 2 state or policy (pushed promptly).
  private save(record: ResourceRecord, dirty = 2) {
    record.version++; record.updated_at = Date.now();
    this.sql.exec('UPDATE management_state SET value=?,dirty=max(dirty,?) WHERE singleton=1', JSON.stringify(record), dirty);
  }
  private dirty() { return this.sql.exec<{dirty:number}>('SELECT dirty FROM management_state WHERE singleton=1').one().dirty; }
  private saveJob(job: Job | null) { this.sql.exec('UPDATE management_state SET job=? WHERE singleton=1', job ? JSON.stringify(job) : null); }
  // Input gates stay open across archive/R2 awaits, so a cancel can replace the stored
  // job mid-step. Durable writes after an await go through here and abandon a stale job.
  private live(job: Job) { if (this.job()?.id !== job.id) throw new Error('Operation canceled'); }
  create(id: string) {
    if (this.exists || this.env.MANAGEMENT_ENABLED !== '1') return;
    if (!this.env.MANAGEMENT) throw new HTTPError(503, 'Management catalog is not configured');
    const policy = defaults(this.env, this.kind);
    auditDays(this.env);
    if (policy.archive_on_ttl) archiveStore(this.env);
    this.sql.exec('CREATE TABLE management_state(singleton INTEGER PRIMARY KEY,value TEXT NOT NULL,job TEXT,dirty INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE management_archives(id TEXT PRIMARY KEY,receipt TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE management_objects(archive TEXT NOT NULL,idx INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(archive,idx))');
    this.sql.exec('CREATE TABLE management_audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL)');
    const at = Date.now();
    const record: ResourceRecord = {id,kind:this.kind,created_at:at,last_activity_at:at,policy,policy_version:1,version:1,state:'active',updated_at:at,latest_archive:null,reason:null,error:null,attempts:0,retry_at:null,deleted_at:null};
    this.sql.exec('INSERT INTO management_state VALUES(1,?,NULL,2)',JSON.stringify(record));
    this.exists = true;
    this.audit('system','created',{policy});
  }
  private audit(actor: string, action: string, detail: unknown = {}) {
    this.sql.exec('INSERT INTO management_audit(at,actor,action,detail) VALUES(?,?,?,?)',Date.now(),actor,action,JSON.stringify(detail));
    this.sql.exec('DELETE FROM management_audit WHERE at<?',Date.now()-auditDays(this.env)*86400000);
  }
  private overdue(r: ResourceRecord) { const deadline = deadlines(r).expires_at; return r.state === 'active' && deadline !== null && Date.now() >= deadline; }
  assertAvailable() {
    const r = this.record(); if (!r) return;
    // An overdue resource is expiring even before tick() records it; only archive/restore are temporary.
    if (r.state !== 'active' || this.overdue(r)) throw new HTTPError(r.state === 'archiving' || r.state === 'restoring' ? 423 : 410, 'Resource is unavailable during retention or management work');
  }
  activity() {
    if (!this.exists) return;
    this.assertAvailable(); const r = this.record()!; r.last_activity_at = Date.now(); this.save(r, 1);
  }
  next(): number | null {
    const r = this.record(); if (!r) return null;
    if (this.job()) return r.retry_at ?? Date.now()+50;
    const expiry = r.state === 'active' ? deadlines(r).expires_at : null;
    const oldest = this.sql.exec<{at:number|null}>('SELECT min(at) at FROM management_audit').one().at;
    const cleanup = oldest === null ? null : oldest + auditDays(this.env)*86400000 + 1;
    const deadline = expiry === null ? cleanup : cleanup === null ? expiry : Math.min(expiry,cleanup);
    return this.dirty() ? Math.min(deadline ?? Infinity, Date.now()+30000) : deadline;
  }
  async schedule() {
    const at = this.next(); if (at === null) return;
    const alarm = await this.ctx.storage.getAlarm();
    const target = Math.max(Date.now()+50,Math.min(alarm ?? Infinity, at));
    if (target !== alarm) await this.ctx.storage.setAlarm(target);
  }
  // Request paths never wait for the catalog: state changes push in the
  // background, activity waits for the alarm. The alarm (wait) retries both.
  async flush(wait = false) {
    if (!this.exists) return;
    // Persist a retry alarm before crossing objects, including initial registration.
    await this.schedule();
    const dirty = this.dirty();
    if (wait ? dirty : dirty > 1) { const pushed = this.push(); if (wait) await pushed; else this.ctx.waitUntil(pushed); }
  }
  private push() {
    if (!this.pushing) this.pushing = this.send().finally(() => { this.pushing = undefined; });
    return this.pushing;
  }
  private async send() {
    try {
      for (let n = 0; n < 3 && this.dirty(); n++) {
        // A clearable timer: celld keeps an event (including the alarm) open until its timers settle.
        const r = this.record()!, abort = new AbortController();
        let timer = 0;
        const timeout = new Promise<never>((_,reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('Catalog timeout')); }, 5000); });
        const response = await Promise.race([this.env.MANAGEMENT!.get(this.env.MANAGEMENT!.idFromName('management')).fetch(new Request('https://management.internal/register',{method:'PUT',body:JSON.stringify(r),signal:abort.signal})), timeout]).finally(() => clearTimeout(timer));
        await response.body?.cancel();
        if (!response.ok) return;
        if (this.record()!.version === r.version) this.sql.exec('UPDATE management_state SET dirty=0 WHERE singleton=1');
      }
    } catch { /* The durable outbox and alarm retry; content stays authoritative. */ }
  }
  // Starts due expiry. Callers persist the alarm through flush() before responding.
  tick() {
    const r = this.record();
    if (r && this.overdue(r)) this.begin(r.policy.archive_on_ttl ? 'archive-delete' : 'delete','ttl','ttl');
  }
  private begin(action: Job['action'], actor: string, reason: string, receipt?: Receipt) {
    const r = this.record()!;
    if (this.job()) throw new HTTPError(409,'A management operation is already running');
    if (action === 'restore' ? r.state !== 'deleted' : r.state !== 'active') throw new HTTPError(409,'Resource state does not allow this action');
    const job: Job = {action,actor,id:crypto.randomUUID(),at:Date.now(),stage:action === 'restore' ? 'restore-verify' : action === 'delete' ? 'erase' : 'snapshot',table:0,cursor:-1,index:0,source:structuredClone(r),receipt};
    r.state = action === 'restore' ? 'restoring' : reason === 'ttl' ? 'expiring' : action === 'delete' ? 'deleting' : 'archiving';
    r.reason=reason; r.error=null; r.retry_at=null; r.attempts=0;
    this.ctx.storage.transactionSync(() => { this.saveJob(job); this.save(r); this.audit(actor,action+'-started',{job:job.id,reason,policy_version:r.policy_version,archive:receipt?.id}); });
    this.hooks.changed();
  }
  // Live content is intact until erase or restore-write, so cancel restores the prior state;
  // a partial restore instead becomes an erase, which needs no archive storage.
  private cancel(r: ResourceRecord, actor: string) {
    const job=this.job();
    if (!job) throw new HTTPError(409,'No pending operation');
    if (job.stage === 'erase') throw new HTTPError(409,'Deletion has started and cannot be canceled; retry to finish it');
    const detail: Record<string,unknown>={job:job.id,stage:job.stage,attempts:r.attempts};
    let next: Job | null=null;
    r.error=null; r.retry_at=null; r.attempts=0;
    if (job.action !== 'restore') {
      r.state='active';
      // Otherwise tick() restarts the expiry at once.
      if (r.reason === 'ttl') { r.policy={...r.policy,paused:true}; r.policy_version++; detail.paused=true; }
      r.reason=null;
      // Uploaded objects stay put: archive storage may be what is failing. A verified manifest is a valid backup.
      if (this.sql.exec('SELECT 1 FROM management_archives WHERE id=?',job.id).toArray().length) detail.archive=job.id;
      else detail.partial_prefix=this.prefix(job);
    } else if (job.stage === 'restore-verify') { r.state='deleted'; r.reason='restore-canceled'; }
    else {
      // A new id makes the abandoned step's late writes fail live().
      next={action:'delete',actor,id:crypto.randomUUID(),at:Date.now(),stage:'erase',table:0,cursor:-1,index:0,source:structuredClone(r)};
      r.state='deleting'; r.reason='restore-canceled'; detail.rollback=next.id;
    }
    this.ctx.storage.transactionSync(() => {
      this.saveJob(next); this.save(r);
      this.sql.exec('DELETE FROM management_objects WHERE archive=?',job.id);
      this.audit(actor,job.action+'-canceled',detail);
    });
    this.verifiedManifest=undefined;
    this.hooks.changed();
  }
  async removeByCapability() {
    this.assertAvailable(); this.begin('delete','capability','capability-delete'); await this.flush();
  }
  private objects(id: string) { return this.sql.exec<{value:string}>('SELECT value FROM management_objects WHERE archive=? ORDER BY idx',id).toArray().map(r=>JSON.parse(r.value) as ObjectEntry); }
  private async object(job: Job, store: ArchiveStore, bytes: Uint8Array, detail: Partial<ObjectEntry>) {
    const key = `mayfly/v1/${this.kind}/${job.source.id}/${job.id}/objects/${job.index}`;
    const entry = {...await putVerified(store,key,bytes),...detail};
    this.live(job);
    this.sql.exec('INSERT OR REPLACE INTO management_objects VALUES(?,?,?)',job.id,job.index,JSON.stringify(entry));
    job.index++;
  }
  private prefix(job: Job) { return `mayfly/v1/${this.kind}/${job.source.id}/${job.id}/`; }
  private activeTables() { return tables[this.kind].filter(t => this.has(t)); }
  private snapshotRows(table: string, after: number) {
    const where = table === 'attachments' ? " AND status='ready'" : '';
    // Read sizes first for large text tables. Keep chunks below 2 MiB while
    // packing short revisions efficiently, without materializing an entire wiki.
    let count=128;
    if (['pages','revisions'].includes(table)) {
      const sizes=this.sql.exec<{size:number}>(`SELECT length(CAST(${table === 'pages' ? 'markdown' : 'snapshot'} AS BLOB))+4096 size FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 128`,after).toArray();
      let bytes=0;count=0;for(const row of sizes){if(count && bytes+row.size>2*1024*1024)break;bytes+=row.size;count++;}
    }
    const rows = this.sql.exec<Record<string, SqlStorageValue>>(`SELECT rowid AS __rowid,* FROM ${table} WHERE rowid>?${where} ORDER BY rowid LIMIT ?`,after,count).toArray();
    // Exclude unfinished uploads from both the snapshot and its byte accounting.
    if (table === 'wiki' && rows.length) rows[0].attachment_bytes = this.sql.exec<{n:number}>("SELECT coalesce(sum(size),0) n FROM attachments WHERE status='ready'").one().n;
    return rows;
  }
  private async manifest(job: Job, store: ArchiveStore): Promise<Manifest> {
    const receipt = job.receipt!;
    if (this.verifiedManifest?.hash === receipt.sha256) return this.verifiedManifest.value;
    const manifest: Manifest = JSON.parse(new TextDecoder().decode(await readVerified(store,receipt)));
    if (manifest.format !== 'mayfly-backup' || manifest.version !== 1 || manifest.schema_version !== 1 || manifest.resource.id !== job.source.id || manifest.resource.kind !== this.kind || manifest.archive_id !== receipt.id || !Array.isArray(manifest.objects) || manifest.objects.length !== receipt.objects || !Array.isArray(manifest.tables) || manifest.tables.some(t=>!tables[this.kind].includes(t))) throw new Error('Unsupported backup manifest');
    const prefix = `mayfly/v1/${this.kind}/${job.source.id}/${receipt.id}/objects/`;
    for (const [i,o] of manifest.objects.entries()) {
      if (o.key !== prefix+i || !Number.isSafeInteger(o.size) || o.size < 0 || !/^[a-f0-9]{64}$/.test(o.sha256) || (!!o.table === !!o.file) || o.table && !manifest.tables.includes(o.table) || o.file && (!o.file.startsWith(job.source.id+'/') || !/^[a-f0-9-]{36}$/.test(o.file.slice(job.source.id.length+1)))) throw new Error('Invalid backup object');
    }
    this.verifiedManifest={hash:receipt.sha256,value:manifest};
    return manifest;
  }
  private clearContent() {
    for (const table of this.activeTables()) this.sql.exec(`DELETE FROM ${table}`);
    this.hooks.changed();
  }
  private finish(job: Job, state: ResourceRecord['state'], clear = false) {
    this.live(job);
    const r = this.record()!;
    r.state=state; r.error=null; r.retry_at=null;
    // A canceled restore's rollback keeps the original deletion time.
    if (state === 'deleted') r.deleted_at=job.source.deleted_at ?? Date.now();
    if (job.action === 'restore') {
      r.created_at=job.source.created_at; r.last_activity_at=job.source.last_activity_at;
      r.policy={...job.source.policy,paused:true}; r.policy_version++; r.deleted_at=null;
    }
    this.ctx.storage.transactionSync(() => {
      if (clear) this.clearContent();
      this.save(r); this.saveJob(null); this.audit(job.actor,job.action+'-completed',{job:job.id,archive:job.receipt?.id});
      this.sql.exec('DELETE FROM management_objects WHERE archive=?',job.id);
    });
    this.verifiedManifest=undefined;
    this.hooks.changed();
  }
  async alarm() {
    if (this.running) return this.running;
    this.running = this.run(); try { await this.running; } finally { this.running=undefined; }
  }
  private async run() {
    if (!this.exists) return;
    this.sql.exec('DELETE FROM management_audit WHERE at<?',Date.now()-auditDays(this.env)*86400000);
    this.tick();
    let job = this.job();
    if (!job || (this.record()!.retry_at ?? 0) > Date.now()) { await this.flush(true); return; }
    // A safety alarm covers process loss at any await. Cursors make retries safe.
    await this.ctx.storage.setAlarm(Date.now()+60000);
    // A cancel may have landed during that await.
    job=this.job();
    let progressed=false;
    try {
      if (this.hooks.busy()) { await this.flush(true); await this.ctx.storage.setAlarm(Date.now()+1000); return; }
      const store = !job || job.action === 'delete' ? undefined : archiveStore(this.env);
      const until=Date.now()+1000;
      for (let n=0;n<20 && Date.now()<until && job;n++) {
        await this.step(job,store);
        progressed=true; job=this.job();
      }
      if (job?.backoff) { job.backoff=0; this.saveJob(job); }
      const r=this.record()!; if (r.retry_at !== null || r.error !== null) { r.retry_at=null; r.error=null; this.save(r); }
    } catch {
      // A canceled job's abandoned step is not a failure of the resource or its rollback.
      const current=this.job();
      if (job && current?.id === job.id) {
        // Progress before a failure restarts the backoff; attempts still counts every failure.
        current.backoff=(progressed ? 0 : current.backoff ?? 0)+1; this.saveJob(current);
        const r=this.record()!; r.attempts++; r.error='Management operation failed. Check archive storage, attachment availability, and backup integrity, then retry.';
        r.retry_at=Date.now()+Math.min(3600000,1000*2**Math.min(current.backoff,12)); this.save(r);
        this.audit(job.actor,'operation-failed',{job:job.id,stage:job.stage,attempt:r.attempts});
      }
    }
    // Replace the safety alarm with the next job/deadline; wiki cleanup merges its own alarm later.
    await this.ctx.storage.deleteAlarm();
    await this.flush(true);
  }
  private async step(job: Job, store?: ArchiveStore) {
    if (job.stage === 'snapshot') {
      const all=this.activeTables(), table=all[job.table];
      if (!table) { job.stage='files'; job.cursor=-1; }
      else {
        const rows=this.snapshotRows(table,job.cursor);
        if (!rows.length) { job.table++; job.cursor=-1; }
        else { await this.object(job,store!,encodeJSON(rows.map(pack)),{table,rows:rows.length}); job.cursor=Number(rows.at(-1)!.__rowid); }
      }
    } else if (job.stage === 'files') {
      const file=this.kind === 'wiki' ? this.sql.exec<{rid:number;key:string;type:string;size:number}>("SELECT rowid rid,key,type,size FROM attachments WHERE rowid>? AND status='ready' ORDER BY rowid LIMIT 1",job.cursor).toArray()[0] : undefined;
      if (!file) job.stage='manifest';
      else {
        const live=await this.env.WIKI_FILES?.get(file.key);
        if (!live) throw new Error('Committed attachment missing');
        const bytes=new Uint8Array(await live.arrayBuffer());
        if (bytes.length !== file.size) throw new Error('Attachment size mismatch');
        await this.object(job,store!,bytes,{file:file.key,type:file.type});
        const head=await this.env.WIKI_FILES!.head(file.key);
        if (!head || head.etag !== live.etag) throw new Error('Attachment changed during snapshot');
        job.cursor=file.rid;
      }
    } else if (job.stage === 'manifest') {
      const objects=this.objects(job.id);
      const manifest: Manifest={format:'mayfly-backup',version:1,schema_version:1,archive_id:job.id,created_at:job.at,resource:job.source,tables:this.activeTables(),objects};
      const saved=await putVerified(store!,this.prefix(job)+'manifest.json',encodeJSON(manifest));
      this.live(job);
      const receipt: Receipt={id:job.id,key:saved.key,sha256:saved.sha256,created_at:job.at,objects:objects.length,bytes:objects.reduce((n,o)=>n+o.size,saved.size)};
      this.ctx.storage.transactionSync(()=>{
        this.sql.exec('INSERT OR REPLACE INTO management_archives VALUES(?,?)',receipt.id,JSON.stringify(receipt));
        const r=this.record()!; r.latest_archive=receipt; this.save(r); job.receipt=receipt;
        this.audit(job.actor,'archive-verified',{receipt});
      });
      if (job.action === 'archive') { this.finish(job,'active'); return; }
      job.stage='erase';
    } else if (job.stage === 'erase') {
      // Erase external objects before their durable keys. Each DELETE is retryable.
      const files=this.kind === 'wiki' ? this.sql.exec<{id:string;key:string}>('SELECT id,key FROM attachments LIMIT 20').toArray() : [];
      if (files.length) {
        if (!this.env.WIKI_FILES) throw new Error('Attachment storage unavailable');
        for (const file of files) { await this.env.WIKI_FILES.delete(file.key); this.live(job); this.sql.exec('DELETE FROM attachments WHERE id=?',file.id); }
      } else {
        this.finish(job,'deleted',true); return;
      }
    } else if (job.stage.startsWith('restore-')) {
      const manifest=await this.manifest(job,store!);
      this.live(job);
      if (job.stage === 'restore-verify') {
        const object=manifest.objects[job.index];
        if (object) { await readVerified(store!,object); job.index++; }
        else {
          this.ctx.storage.transactionSync(()=>this.clearContent());
          if (manifest.tables.includes('linked_spaces')) this.sql.exec(linkSchema);
          job.stage='restore-write'; job.index=0;
        }
      } else if (job.stage === 'restore-write') {
        const object=manifest.objects[job.index];
        if (!object) { job.stage='restore-check'; job.index=0; }
        else {
          const bytes=await readVerified(store!,object);
          this.live(job);
          if (object.table) {
            const table=object.table;
            const columns=new Set(this.sql.exec<{name:string}>(`PRAGMA table_info(${table})`).toArray().map(r=>r.name));
            const rows=JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>[];
            if (rows.length !== object.rows) throw new Error('Backup row count mismatch');
            this.ctx.storage.transactionSync(()=>{
              for (const row of rows) {
                const names=Object.keys(row);
                if (!names.includes('__rowid') || names.some(k=>k !== '__rowid' && !columns.has(k))) throw new Error('Invalid backup columns');
                this.sql.exec(`INSERT OR REPLACE INTO ${table} (${names.map(k=>k === '__rowid' ? 'rowid' : '"'+k+'"').join(',')}) VALUES(${names.map(()=>'?').join(',')})`,...names.map(k=>unpack(row[k])));
              }
            });
          } else {
            if (!this.env.WIKI_FILES) throw new Error('Attachment storage unavailable');
            await this.env.WIKI_FILES.put(object.file!,bytes,{httpMetadata:{contentType:object.type}});
          }
          job.index++;
        }
      } else {
        const object=manifest.objects[job.index];
        if (!object) { job.source=manifest.resource; this.finish(job,'active'); return; }
        if (object.table) {
          const original=JSON.parse(new TextDecoder().decode(await readVerified(store!,object))) as Record<string,unknown>[];
          // Chunks are disjoint ascending rowid ranges, so missing or extra rows change the hash.
          const rows=original.length ? this.sql.exec<Record<string,SqlStorageValue>>(`SELECT rowid AS __rowid,* FROM ${object.table} WHERE rowid BETWEEN ? AND ? ORDER BY rowid`,Number(original[0].__rowid),Number(original.at(-1)!.__rowid)).toArray() : [];
          if (rows.length !== original.length || rows.some((row,i)=>Number(row.__rowid) !== Number(original[i].__rowid)) || await sha256(encodeJSON(rows.map(pack))) !== object.sha256) throw new Error('Restored rows failed verification');
        } else {
          const file=await this.env.WIKI_FILES?.get(object.file!);
          if (!file || await sha256(await file.arrayBuffer()) !== object.sha256) throw new Error('Restored attachment failed verification');
        }
        job.index++;
      }
    } else throw new Error('Invalid lifecycle stage');
    this.live(job); this.saveJob(job);
  }
  async handle(request: Request): Promise<Response> {
    if (!this.exists) throw new HTTPError(404,'Resource predates management or does not exist');
    // Start due expiry first: an overdue resource is neither shown as active nor rescued by a policy edit.
    this.tick();
    const r=this.record()!, url=new URL(request.url), path=url.pathname;
    if (request.method === 'GET') {
      if (path === '/_management/audit') return json({events:this.sql.exec('SELECT * FROM management_audit WHERE at>=? ORDER BY id DESC LIMIT 200',Date.now()-auditDays(this.env)*86400000).toArray()});
      if (path === '/_management/archives') {
        const id=url.searchParams.get('id');
        const rows=id === null ? this.sql.exec<{receipt:string}>('SELECT receipt FROM management_archives ORDER BY rowid DESC') : this.sql.exec<{receipt:string}>('SELECT receipt FROM management_archives WHERE id=?',id);
        return json({archives:rows.toArray().map(row=>JSON.parse(row.receipt))});
      }
      const job=this.job();
      return json({...r,...deadlines(r),job:job ? {action:job.action,stage:job.stage,cancellable:job.stage !== 'erase'} : null,
        links:this.has('linked_spaces') ? this.sql.exec('SELECT id,kind,title FROM linked_spaces ORDER BY id').toArray() : []});
    }
    const input=await bodyJSON(request,8192), actor=request.headers.get('X-Management-Actor') ?? 'unknown';
    // Refresh after reading the body: another request or the deadline may have changed policy/state.
    this.tick(); const current=this.record()!;
    if (path === '/_management/policy' && request.method === 'PUT') {
      if (current.state !== 'active' || this.job()) throw new HTTPError(409,'Policy cannot change while an operation is running');
      if (input.policy_version !== current.policy_version) throw new HTTPError(409,'Policy changed; reload before editing');
      const {policy_version,...value}=input, policy=policyInput(value);
      if (policy.archive_on_ttl) archiveStore(this.env);
      current.policy=policy; current.policy_version++;
      this.ctx.storage.transactionSync(()=>{this.save(current);this.audit(actor,'policy-updated',{policy,policy_version:current.policy_version});});
      this.tick();
    } else if (path === '/_management/action' && request.method === 'POST') {
      const action=input.action;
      if (action === 'retry') {
        if (!this.job()) throw new HTTPError(409,'No pending operation');
        current.retry_at=null; this.save(current); this.audit(actor,'retry');
      } else if (action === 'cancel') this.cancel(current,actor);
      else if (['archive','archive-delete','delete','restore'].includes(String(action))) {
        if (action !== 'delete') archiveStore(this.env);
        let receipt: Receipt | undefined;
        if (action === 'restore') {
          const row=this.sql.exec<{receipt:string}>('SELECT receipt FROM management_archives WHERE id=?',String(input.archive_id)).toArray()[0];
          if (!row) throw new HTTPError(404,'Archive receipt not found'); receipt=JSON.parse(row.receipt);
          if (input.confirm_original_links !== true) throw new HTTPError(400,'Restoration reactivates original links; confirm_original_links must be true');
        }
        this.begin(action as Job['action'],actor,'admin',receipt);
      } else throw new HTTPError(400,'Unknown action');
    } else throw new HTTPError(404,'Unknown management route');
    await this.flush();
    return json({...this.record(),...deadlines(this.record()!)},202);
  }
}
