import type { Wiki } from './wiki';
import type { Chat } from './worker';
import { DurableObject } from 'cloudflare:workers';
import { canonicalID, failure, HTTPError, json, readBody } from './protocol';
import { deadlines, type ResourceRecord } from './management-core';
import { AdminAuth, oidcConfig, type OIDCEnv } from './management-auth';
import { archiveStore, readVerified } from './management-storage';
import { type LifecycleEnv } from './management-lifecycle';
import { managementPage } from './management-ui';
import { backupTar, type BackupEntry } from './management-download';
const states: ResourceRecord['state'][]=['active','archiving','expiring','deleting','deleted','restoring'];
export interface ManagementEnv extends LifecycleEnv, OIDCEnv { CHATS: DurableObjectNamespace<Chat>; WIKIS: DurableObjectNamespace<Wiki> }

export class Management extends DurableObject<ManagementEnv> {
  private sql: SqlStorage;
  private auth: AdminAuth;
  constructor(ctx: DurableObjectState,env: ManagementEnv) {
    super(ctx,env); this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS resources(key TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL)');
    this.sql.exec('DROP INDEX IF EXISTS resource_filter');
    this.sql.exec('CREATE INDEX IF NOT EXISTS resource_state ON resources(state,key)');
    this.auth=new AdminAuth(this.sql,env);
  }
  // The alarm only sweeps expired admin sessions and consumed sign-in states.
  async alarm() { this.auth.cleanup(); const next=this.auth.nextExpiry(); if (next !== null) await this.ctx.storage.setAlarm(Math.max(next,Date.now()+60000)); }
  private async arm() {
    const next=this.auth.nextExpiry(); if (next === null) return;
    const at=Math.max(next,Date.now()+60000), current=await this.ctx.storage.getAlarm();
    if (current === null || current>at) await this.ctx.storage.setAlarm(at);
  }
  private target(kind: string,id: string) { const ns=kind === 'chat' ? this.env.CHATS : this.env.WIKIS; return ns.get(ns.idFromName(id)); }
  private resource(kind: string,id: string,path: string, method='GET',body?: string,actor?: string) {
    return this.target(kind,id).fetch(new Request('https://management.internal/_management'+path,{method,body,headers:actor ? {'X-Management-Actor':actor} : {}}));
  }
  async fetch(request: Request): Promise<Response> {
    try { return await this.handle(request); } catch(error) { return failure(error); }
  }
  private async handle(request: Request): Promise<Response> {
    const url=new URL(request.url),path=url.pathname;
    if (path === '/register' && request.method === 'PUT') {
      const r=await request.json<ResourceRecord>();
      if (!canonicalID(r.id) || !['chat','wiki'].includes(r.kind)) throw new Error('Invalid internal registration');
      this.sql.exec('INSERT INTO resources VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,version=excluded.version,value=excluded.value WHERE excluded.version>resources.version',r.kind+':'+r.id,r.kind,r.state,r.version,JSON.stringify(r));
      return new Response(null,{status:204});
    }
    if (this.env.MANAGEMENT_ENABLED !== '1') throw new HTTPError(404,'Management is disabled');
    if (path === '/admin/login' && request.method === 'GET') return this.auth.login(request);
    if (path === '/admin/callback' && request.method === 'GET') { try { return await this.auth.callback(request); } finally { await this.arm(); } }
    if (path === '/admin/logout' && request.method === 'POST') return this.auth.logout(request);
    if ((path === '/admin' || path === '/admin/') && request.method === 'GET') {
      oidcConfig(this.env);
      return managementPage(await this.auth.signedIn(request));
    }
    const session=await this.auth.session(request), actor=JSON.stringify({issuer:session.issuer,subject:session.subject});
    if (path === '/admin/api/session' && request.method === 'GET') return json({issuer:session.issuer,subject:session.subject,csrf:session.csrf,expires:session.expires});
    if (path === '/admin/api/resources' && request.method === 'GET') {
      const kind=url.searchParams.get('kind') ?? '', state=url.searchParams.get('state') ?? '', after=url.searchParams.get('after') ?? '';
      if (kind && !['chat','wiki'].includes(kind)) throw new HTTPError(400,'Unknown resource kind');
      if (state && !states.includes(state as ResourceRecord['state'])) throw new HTTPError(400,'Unknown resource state');
      // Keys are kind:id, so a kind filter is a primary-key range; state uses resource_state(state,key).
      const where=['key>?'], args: string[]=[after];
      if (kind) { where.push('key>=? AND key<?'); args.push(kind+':',kind+';'); }
      if (state) { where.push('state=?'); args.push(state); }
      const rows=this.sql.exec<{key:string;value:string}>(`SELECT key,value FROM resources WHERE ${where.join(' AND ')} ORDER BY key LIMIT 51`,...args).toArray();
      return json({resources:rows.slice(0,50).map(row=>{const r=JSON.parse(row.value);return {...r,...deadlines(r)};}),next:rows.length>50 ? rows[49].key : null});
    }
    const match=/^\/admin\/api\/resources\/(chat|wiki)\/([\w-]{22})(?:\/(policy|action|archives|audit|download))?$/.exec(path);
    if (!match || !canonicalID(match[2])) throw new HTTPError(404,'No such management route');
    const [,kind,id,action]=match;
    if (!this.sql.exec('SELECT 1 FROM resources WHERE key=?',kind+':'+id).toArray().length) throw new HTTPError(404,'Resource is not managed');
    if (action === 'download' && request.method === 'GET') {
      const archiveID=url.searchParams.get('archive_id');
      if (!archiveID) throw new HTTPError(404,'Archive not found');
      const response=await this.resource(kind,id,'/archives?id='+encodeURIComponent(archiveID));
      if (!response.ok) return response;
      const {archives}=await response.json<{archives:NonNullable<ResourceRecord['latest_archive']>[]} >();
      const receipt=archives.find(a=>a.id === archiveID);
      if (!receipt) throw new HTTPError(404,'Archive not found');
      const store=archiveStore(this.env), raw=await readVerified(store,receipt);
      const manifest=JSON.parse(new TextDecoder().decode(raw));
      const prefix=`mayfly/v1/${kind}/${id}/${receipt.id}/`;
      if (manifest.version !== 1 || manifest.resource.id !== id || manifest.resource.kind !== kind || manifest.objects.length !== receipt.objects) throw new HTTPError(409,'Invalid archive manifest');
      const entries: BackupEntry[]=[{name:'manifest.json',size:raw.length,read:async()=>raw}];
      for (const [i,o] of manifest.objects.entries()) {
        if (o.key !== prefix+'objects/'+i) throw new HTTPError(409,'Invalid archive object');
        entries.push({name:'objects/'+i,size:o.size,read:async()=>{await this.auth.session(request);return readVerified(store,o);}});
      }
      const chunks=backupTar(entries,()=>{if(Date.now()>=session.expires || request.signal.aborted) throw new Error('Download session ended');});
      const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await chunks.next();if(next.done)controller.close();else controller.enqueue(next.value);}catch(e){controller.error(e);}},async cancel(){await chunks.return(undefined);}});
      return new Response(stream,{headers:{'Content-Type':'application/x-tar','Content-Disposition':`attachment; filename="mayfly-${kind}-${receipt.id}.tar"`}});
    }
    const method=action === 'policy' ? 'PUT' : action === 'action' ? 'POST' : 'GET';
    if (request.method !== method) throw new HTTPError(405,'Method not allowed');
    // Session and CSRF were enforced above; the body is small and bounded.
    const body=method==='GET' ? undefined : await readBody(request,8192);
    const response=await this.resource(kind,id,action ? '/'+action : '',method,body,actor);
    if (!action && response.ok) {
      const r=await response.json<ResourceRecord & {links:Array<{id:string;kind:string;title:string}>}>();
      return json({...r,links:r.links.map(link=>{const companion=this.sql.exec<{state:string}>('SELECT state FROM resources WHERE key=?',link.kind+':'+link.id).toArray()[0]; return {...link,state:companion?.state ?? 'unmanaged or unavailable'};})});
    }
    return response;
  }
}
export async function managementRoute(request: Request,env: ManagementEnv): Promise<Response | undefined> {
  const path=new URL(request.url).pathname;
  if (path !== '/admin' && !path.startsWith('/admin/')) return;
  if (env.MANAGEMENT_ENABLED !== '1' || !env.MANAGEMENT) throw new HTTPError(404,'Management is disabled');
  // Internal registration and actor headers are never forwarded from a public URL.
  const headers=new Headers();
  for (const name of ['Cookie','Origin','Sec-Fetch-Site','X-CSRF-Token','Content-Type']) {const v=request.headers.get(name);if(v!==null)headers.set(name,v);}
  // The Worker's secure() wrapper adds no-store and no-referrer to every admin response.
  return env.MANAGEMENT.get(env.MANAGEMENT.idFromName('management')).fetch(new Request(request,{headers}));
}
