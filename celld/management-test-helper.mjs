// Shared fixtures for the management suites: a fixture OIDC provider that
// also controls injected archive faults, admin sessions and lifecycle helpers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes,createHash,hkdfSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { post } from './wiki-test-helper.mjs';

export async function identityProvider(t){
  const keys=await generateKeyPair('RS256'), jwk=await exportJWK(keys.publicKey);jwk.kid='fixture';
  const state={subject:'admin',nonce:null,issuer:null,audience:null,badSignature:false,archiveFailure:false,corrupt:false,holdReads:false,held:[],corruptAfter:null,codes:new Map(),exchanges:0,down:false,tokenStatus:null,authorizationQuery:''};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,state.origin);
    try {
      if(url.pathname==='/archive-control'){if(state.holdReads&&url.searchParams.has('read')){state.held.push(()=>res.end(JSON.stringify({fail:false,corrupt:false})));return;}
        // corruptAfter: N object reads succeed, then every later object read is corrupt.
        const late=state.corruptAfter!==null&&url.searchParams.get('key')?.includes('/objects/')&&state.corruptAfter--<=0;
        return res.end(JSON.stringify({fail:state.archiveFailure,corrupt:state.corrupt||late}));}
      if(state.down&&url.pathname!=='/archive-control')return res.writeHead(503).end('{}');
      if(url.pathname==='/.well-known/openid-configuration')return res.end(JSON.stringify({issuer:state.origin,authorization_endpoint:state.origin+'/authorize'+state.authorizationQuery,token_endpoint:state.origin+'/token',jwks_uri:state.origin+'/jwks',code_challenge_methods_supported:['S256']}));
      if(url.pathname==='/jwks')return res.end(JSON.stringify({keys:[jwk]}));
      if(url.pathname==='/token'){
        if(state.tokenStatus)return res.writeHead(state.tokenStatus).end(JSON.stringify({error:'invalid_grant'}));
        let raw='';for await(const p of req)raw+=p;const params=new URLSearchParams(raw), flow=state.codes.get(params.get('code'));state.codes.delete(params.get('code'));
        assert.ok(flow);assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),flow.get('code_challenge'));assert.equal(params.get('redirect_uri'),flow.get('redirect_uri'));state.exchanges++;
        let token=await new SignJWT({nonce:state.nonce??flow.get('nonce')}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(state.issuer??state.origin).setAudience(state.audience??'mayfly-test').setSubject(state.subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
        if(state.badSignature)token=token.slice(0,-8)+'AAAAAAAA';
        return res.end(JSON.stringify({id_token:token,access_token:'unused-private-token',token_type:'Bearer'}));
      }
      res.writeHead(404).end();
    }catch{res.writeHead(400).end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));state.origin='http://127.0.0.1:'+server.address().port;
  t.after(()=>{server.closeAllConnections();server.close();});return state;
}
export const cookieOf=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
export async function login(h,provider){
  const start=await h.http('/admin/login');assert.equal(start.status,302,JSON.stringify(start.body));
  const auth=new URL(start.headers.get('location'));const code=randomBytes(16).toString('hex');provider.codes.set(code,auth.searchParams);
  const callback='/admin/callback?'+new URLSearchParams({state:auth.searchParams.get('state'),code});
  const response=await h.http(callback,{headers:{Cookie:cookieOf(start)}});
  return {response,callback,cookie:cookieOf(response),loginCookie:cookieOf(start)};
}
export function admin(h,cookie){
  let csrf;
  const api=async(path='',body,method=body?'POST':'GET',extra={})=>h.http('/admin/api/'+path,{method,headers:{Cookie:cookie,Origin:h.base,...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
  return {api,async init(){const r=await api('session');assert.equal(r.status,200,JSON.stringify(r.body));csrf=r.body.csrf;return this;}};
}
export const policy=(idle=null,age=null,archive=false,paused=false)=>({idle_seconds:idle,age_seconds:age,archive_on_ttl:archive,paused});
export async function setPolicy(a,resource,value){const path='resources/'+resource.kind+'/'+resource.id;const current=await a.api(path);const r=await a.api(path+'/policy',{policy_version:current.body.policy_version,...value},'PUT');assert.equal(r.status,202,JSON.stringify(r.body));return r.body;}
export async function action(a,resource,action,extra={}){const r=await a.api('resources/'+resource.kind+'/'+resource.id+'/action',{action,...extra});assert.equal(r.status,202,JSON.stringify(r.body));return r.body;}
export async function settled(a,resource,state='active',requireArchive=false){const until=Date.now()+30000;for(;;){const r=await a.api('resources/'+resource.kind+'/'+resource.id);assert.equal(r.status,200,JSON.stringify(r.body));if(r.body.state===state&&(!requireArchive||r.body.latest_archive))return r.body;assert.ok(Date.now()<until,JSON.stringify(r.body));await delay(100);}}
export async function chat(h){const key=randomBytes(32),derive=(info,n)=>Buffer.from(hkdfSync('sha256',key,'',info,n)).toString('base64url');const auth=derive('mayfly auth',32),id=derive('mayfly id',16),config=(await h.http('/config')).body;const r=await h.http('/new',post({id,auth_hash:createHash('sha256').update(auth).digest('base64url'),encryption:config.encryption?'1':'0'}));assert.equal(r.status,303,JSON.stringify(r.body));return {kind:'chat',id,key,request:(path,options={})=>h.http('/c/'+id+path,{...options,headers:{Authorization:'Bearer '+auth,...options.headers}})};}
export const managementVars=provider=>({MANAGEMENT_ENABLED:'1',MANAGEMENT_ORIGIN:'auto',OIDC_ISSUER:provider.origin,OIDC_CLIENT_ID:'mayfly-test',OIDC_ADMIN_SUBJECTS:'["admin"]',ARCHIVE_STORAGE:'r2'});
// Patches the copied source so provider.archiveFailure, provider.corrupt,
// provider.corruptAfter and provider.holdReads control archive writes and reads. Pass as configureSource.
export function archiveFaults(provider){
  return async directory=>{
    const path=join(directory,'celld/native/management-storage.ts');let source=await readFile(path,'utf8');
    source=source.replace('const object = await bucket.get(key); return object ? new Uint8Array(await object.arrayBuffer()) : null;',`const object = await bucket.get(key); const bytes=object ? new Uint8Array(await object.arrayBuffer()) : null; const fault=await (await fetch('${provider.origin}/archive-control?read=1&key='+encodeURIComponent(key))).json(); if(bytes && fault.corrupt && key.includes('/objects/'))bytes[0]^=1; return bytes;`);
    source=source.replace('await bucket.put(key, data,',`if((await (await fetch('${provider.origin}/archive-control')).json()).fail)throw new Error('Injected archive failure'); await bucket.put(key, data,`);
    await writeFile(path,source);
  };
}
