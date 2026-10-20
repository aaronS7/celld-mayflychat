import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { b64, unb64, failure, HTTPError, readBody } from './protocol';
import { sha256, utf8 } from './management-storage';
export interface OIDCEnv {
  MANAGEMENT_ORIGIN?: string; OIDC_ISSUER?: string; OIDC_CLIENT_ID?: string; OIDC_CLIENT_SECRET?: string;
  OIDC_ADMIN_SUBJECTS?: string;
}
type Config = {origin: string; issuer: string; client: string; secret?: string; subjects: string[]; local: boolean; cookie: string};
type Session = {issuer: string; subject: string; client: string; csrf: string; expires: number};
// Pending sign-ins live only in the browser, sealed with this object's key; nothing is stored until a callback.
type Flow = {state: string; nonce: string; verifier: string; issuer: string; client: string; token: string; jwks: string; expires: number};
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const loopback = ['127.0.0.1','localhost'], denied = 'OIDC sign-in failed or this identity is not an administrator', unavailable = 'Identity provider unavailable';
const configs = new WeakMap<OIDCEnv, Config>();
export function oidcConfig(env: OIDCEnv): Config {
  const cached=configs.get(env); if (cached) return cached;
  try {
    const origin=new URL(env.MANAGEMENT_ORIGIN!), issuer=new URL(env.OIDC_ISSUER!);
    const local=origin.protocol === 'http:' && loopback.includes(origin.hostname);
    if ((!local && origin.protocol !== 'https:') || origin.origin !== env.MANAGEMENT_ORIGIN || issuer.href.replace(/\/$/,'') !== env.OIDC_ISSUER!.replace(/\/$/,'') || issuer.username || issuer.password || issuer.search || issuer.hash || (issuer.protocol !== 'https:' && !(local && issuer.protocol === 'http:' && loopback.includes(issuer.hostname)))) throw 0;
    const subjects=JSON.parse(env.OIDC_ADMIN_SUBJECTS ?? '[]');
    if (!env.OIDC_CLIENT_ID || !Array.isArray(subjects) || !subjects.length || subjects.some(s=>typeof s !== 'string' || !s || s.length>255)) throw 0;
    const c={origin:origin.origin,issuer:env.OIDC_ISSUER!,client:env.OIDC_CLIENT_ID,secret:env.OIDC_CLIENT_SECRET,subjects,local,cookie:local ? 'mayfly_admin' : '__Host-mayfly_admin'};
    configs.set(env,c); return c;
  } catch { throw new HTTPError(503,'Admin OIDC is not configured'); }
}
function cookie(request: Request, name: string) { return (request.headers.get('Cookie') ?? '').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1); }
function setCookie(c: Config,name: string,value: string,age: number) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${c.local ? '' : '; Secure'}`; }
function endpoint(value: unknown, c: Config) {
  let url: URL | undefined;
  try { url=new URL(value as string); } catch { /* rejected below */ }
  if (typeof value !== 'string' || !url || url.username || url.password || url.hash || url.protocol !== 'https:' && !(c.local && url.protocol === 'http:' && loopback.includes(url.hostname))) throw new HTTPError(503,'Unsafe identity provider endpoint');
  return url;
}
async function providerJSON(url: URL, init?: RequestInit) {
  let response: Response;
  try { response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)}); } catch { throw new HTTPError(503,unavailable); }
  // A token endpoint's 4xx rejects this code or client; it is a sign-in failure, not an outage.
  if (!response.ok) { await response.body?.cancel().catch(()=>{}); const rejected=init?.method === 'POST' && response.status>=400 && response.status<500; throw new HTTPError(rejected ? 403 : 503,rejected ? denied : unavailable); }
  try { return JSON.parse(await readBody(new Request('https://internal/',{method:'POST',body:response.body}),262144)); } catch { throw new HTTPError(503,unavailable); }
}
export class AdminAuth {
  private key?: Promise<CryptoKey>;
  constructor(private sql: SqlStorage,private env: OIDCEnv) {
    sql.exec('CREATE TABLE IF NOT EXISTS admin_sessions(id TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER NOT NULL)');
    sql.exec('DROP TABLE IF EXISTS admin_logins');
    sql.exec('CREATE TABLE IF NOT EXISTS admin_login_states(id TEXT PRIMARY KEY,expires INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS admin_secret(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
    sql.exec('INSERT OR IGNORE INTO admin_secret VALUES(1,?)',random());
  }
  cleanup() { for (const t of ['admin_sessions','admin_login_states']) this.sql.exec(`DELETE FROM ${t} WHERE expires<=?`,Date.now()); }
  nextExpiry() { return this.sql.exec<{at:number|null}>('SELECT MIN(expires) at FROM (SELECT expires FROM admin_sessions UNION ALL SELECT expires FROM admin_login_states)').one().at; }
  private config(request: Request) {
    const c=oidcConfig(this.env);
    if (new URL(request.url).origin !== c.origin) throw new HTTPError(403,'Use the configured management origin');
    return c;
  }
  private sealKey() { return this.key ??= crypto.subtle.importKey('raw',unb64(this.sql.exec<{value:string}>('SELECT value FROM admin_secret').one().value)!,'AES-GCM',false,['encrypt','decrypt']); }
  private async seal(state: string, flow: Flow) {
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(state)},await this.sealKey(),utf8.encode(JSON.stringify(flow))));
    const out=new Uint8Array(12+sealed.length); out.set(iv); out.set(sealed,12); return b64(out);
  }
  private async open(state: string, value: string): Promise<Flow | undefined> {
    const raw=/^[\w-]{40,3000}$/.test(value) ? unb64(value) : undefined;
    if (!raw || raw.length<29) return;
    try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:raw.subarray(0,12),additionalData:utf8.encode(state)},await this.sealKey(),raw.subarray(12)))); } catch { return; }
  }
  private async current(c: Config, request: Request) {
    const raw=cookie(request,c.cookie);
    if (!raw || !/^[\w-]{43}$/.test(raw)) return;
    const id=await sha256(utf8.encode(raw)), row=this.sql.exec<{value:string;expires:number}>('SELECT value,expires FROM admin_sessions WHERE id=?',id).toArray()[0];
    return {id,session:row && row.expires>Date.now() ? JSON.parse(row.value) as Session : undefined};
  }
  private csrf(c: Config, request: Request, session?: Session) {
    if (request.headers.get('Origin') !== c.origin || (request.headers.get('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin') || session && request.headers.get('X-CSRF-Token') !== session.csrf) throw new HTTPError(403,'Invalid CSRF protection');
  }
  async session(request: Request): Promise<Session> {
    const c=this.config(request), found=await this.current(c,request);
    if (!found) throw new HTTPError(401,'Admin sign-in required');
    const session=found.session;
    if (!session) throw new HTTPError(401,'Admin session expired');
    if (session.issuer !== c.issuer || session.client !== c.client || !c.subjects.includes(session.subject)) throw new HTTPError(403,'Admin access denied');
    if (!['GET','HEAD'].includes(request.method)) this.csrf(c,request,session);
    return session;
  }
  // Origin errors still throw; a missing, expired or revoked session just signs out.
  async signedIn(request: Request) {
    this.config(request);
    try { await this.session(request); return true; } catch(error) { if (error instanceof HTTPError && [401,403].includes(error.status)) return false; throw error; }
  }
  private async discover(c: Config) {
    const m=await providerJSON(endpoint(c.issuer.replace(/\/$/,'')+'/.well-known/openid-configuration',c));
    if (m?.issuer !== c.issuer || !Array.isArray(m.code_challenge_methods_supported) || !m.code_challenge_methods_supported.includes('S256')) throw new HTTPError(503,'Provider must support OIDC and PKCE S256');
    return {authorization:endpoint(m.authorization_endpoint,c),token:endpoint(m.token_endpoint,c).href,jwks:endpoint(m.jwks_uri,c).href};
  }
  async login(request: Request) {
    const c=this.config(request), provider=await this.discover(c);
    const state=random(), nonce=random(), verifier=random(), authorization=provider.authorization;
    const flow: Flow={state:await sha256(utf8.encode(state)),nonce,verifier,issuer:c.issuer,client:c.client,token:provider.token,jwks:provider.jwks,expires:Date.now()+300000};
    const params={client_id:c.client,response_type:'code',scope:'openid',redirect_uri:c.origin+'/admin/callback',state,nonce,code_challenge:b64(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(verifier)))),code_challenge_method:'S256'};
    for (const [k,v] of Object.entries(params)) authorization.searchParams.set(k,v);
    return new Response(null,{status:302,headers:{Location:authorization.href,'Set-Cookie':setCookie(c,c.cookie+'_login',await this.seal(state,flow),300)}});
  }
  async callback(request: Request) {
    const c=this.config(request), params=new URL(request.url).searchParams;
    const state=params.get('state'), code=params.get('code'), sealed=cookie(request,c.cookie+'_login');
    if (!state || !code || !sealed || params.getAll('state').length!==1 || params.getAll('code').length!==1) throw new HTTPError(400,'Invalid sign-in response');
    const hash=await sha256(utf8.encode(state)), flow=await this.open(state,sealed);
    // No await between the replay check and insert: each state completes at most once.
    if (!flow || flow.state !== hash || flow.expires<Date.now() || flow.issuer !== c.issuer || flow.client !== c.client || params.has('iss') && params.get('iss') !== c.issuer || this.sql.exec('SELECT 1 FROM admin_login_states WHERE id=?',hash).toArray().length) throw new HTTPError(400,'Sign-in expired or did not match this browser');
    this.sql.exec('INSERT INTO admin_login_states VALUES(?,?)',hash,flow.expires);
    // Bounded by eviction, never refusal; provider codes are single-use regardless.
    this.sql.exec('DELETE FROM admin_login_states WHERE id NOT IN (SELECT id FROM admin_login_states ORDER BY expires DESC LIMIT 1024)');
    const clear=setCookie(c,c.cookie+'_login','',0);
    try {
      const body=new URLSearchParams({grant_type:'authorization_code',code,client_id:c.client,redirect_uri:c.origin+'/admin/callback',code_verifier:flow.verifier});
      const headers: Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
      if (c.secret) headers.Authorization='Basic '+btoa(encodeURIComponent(c.client).replace(/%20/g,'+')+':'+encodeURIComponent(c.secret).replace(/%20/g,'+'));
      const token=await providerJSON(endpoint(flow.token,c),{method:'POST',headers,body});
      let keys: ReturnType<typeof createLocalJWKSet>;
      try { keys=createLocalJWKSet(await providerJSON(endpoint(flow.jwks,c)) as JSONWebKeySet); } catch(error) { throw error instanceof HTTPError ? error : new HTTPError(503,unavailable); }
      let subject: string;
      try {
        const {payload}=await jwtVerify(token?.id_token,keys,{issuer:c.issuer,audience:c.client,algorithms:['RS256','ES256'],requiredClaims:['sub','iss','aud','exp','iat','nonce'],maxTokenAge:'5m',clockTolerance:30});
        if (payload.nonce !== flow.nonce || typeof payload.sub !== 'string' || !c.subjects.includes(payload.sub) || payload.azp !== undefined && payload.azp !== c.client || Array.isArray(payload.aud) && payload.aud.length>1 && payload.azp !== c.client) throw 0;
        subject=payload.sub;
      } catch { throw new HTTPError(403,denied); }
      const raw=random(), expires=Date.now()+3600000;
      const session: Session={issuer:c.issuer,subject,client:c.client,csrf:random(),expires};
      this.sql.exec('INSERT INTO admin_sessions VALUES(?,?,?)',await sha256(utf8.encode(raw)),JSON.stringify(session),expires);
      const out=new Headers({Location:'/admin'});
      out.append('Set-Cookie',setCookie(c,c.cookie,raw,3600)); out.append('Set-Cookie',clear);
      return new Response(null,{status:303,headers:out});
    } catch(error) { const response=failure(error); response.headers.append('Set-Cookie',clear); return response; }
  }
  // Logout always clears the cookie; CSRF is required only to end a live session.
  async logout(request: Request) {
    const c=this.config(request), found=await this.current(c,request);
    this.csrf(c,request,found?.session);
    if (found) this.sql.exec('DELETE FROM admin_sessions WHERE id=?',found.id);
    return new Response(null,{status:204,headers:{'Set-Cookie':setCookie(c,c.cookie,'',0)}});
  }
}
