// Admin OIDC edge cases: CSRF/Origin enforcement, revoked administrators,
// logout, provider outages, sealed pending-login cookies and cookie attributes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { wikiHarness } from './wiki-test-helper.mjs';
import { identityProvider, cookieOf, login, managementVars, policy } from './management-test-helper.mjs';

const denied='OIDC sign-in failed or this identity is not an administrator', unavailable='Identity provider unavailable', mismatch='Sign-in expired or did not match this browser';
const token43=()=>randomBytes(32).toString('base64url');

test('admin auth: CSRF, logout, pending sign-ins, provider outages and revoked administrators',async t=>{
  const provider=await identityProvider(t);
  // Set before the first discovery so the provider's own query is what the server sees.
  provider.authorizationQuery='?p=b2c_1_signin';
  const vars=managementVars(provider);
  const h=await wikiHarness(t,vars);
  const port=Number(new URL(h.base).port);
  // A sign-in split into its two browser legs so tests can mix cookies and states.
  async function begin(){
    const response=await h.http('/admin/login');assert.equal(response.status,302,JSON.stringify(response.body));
    const auth=new URL(response.headers.get('location')),code=randomBytes(16).toString('hex');provider.codes.set(code,auth.searchParams);
    return {response,auth,state:auth.searchParams.get('state'),code,cookie:cookieOf(response)};
  }
  const finish=(flow,{cookie=flow.cookie,state=flow.state,code=flow.code,extra={}}={})=>{
    const query=new URLSearchParams();if(state!==null)query.append('state',state);if(code!==null)query.append('code',code);for(const [k,v] of Object.entries(extra))query.append(k,v);
    return h.http('/admin/callback?'+query,{headers:cookie?{Cookie:cookie}:{}});
  };
  const sessionOf=async cookie=>{const r=await h.http('/admin/api/session',{headers:{Cookie:cookie}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const signedOutPage=async(cookie,message)=>{
    const page=await h.http('/admin',{headers:cookie?{Cookie:cookie}:{}});
    assert.equal(page.status,200,message);assert.match(page.headers.get('content-type'),/^text\/html/,message);assert.equal(typeof page.body,'string',message);
    assert.ok(page.text.includes('<a href="/admin/login">Sign in with OIDC</a>'),message);assert.ok(!page.text.includes('id="logout"'),message);assert.ok(!page.text.includes('<script'),message);
  };

  let signed;
  await t.test('login keeps provider query parameters and sets hardened cookies',async()=>{
    const flow=await begin(),auth=flow.auth;
    assert.equal(auth.origin+auth.pathname,provider.origin+'/authorize');
    assert.equal(auth.searchParams.get('p'),'b2c_1_signin');
    const expected={response_type:'code',client_id:'mayfly-test',scope:'openid',redirect_uri:h.base+'/admin/callback',code_challenge_method:'S256'};
    for(const [k,v] of Object.entries(expected))assert.deepEqual(auth.searchParams.getAll(k),[v],k);
    for(const k of ['state','nonce','code_challenge'])assert.match(auth.searchParams.get(k)??'',/^[\w-]{43}$/,k);
    assert.equal(auth.searchParams.getAll('state').length,1);
    const other=await begin();
    assert.notEqual(other.state,flow.state);assert.notEqual(other.auth.searchParams.get('nonce'),auth.searchParams.get('nonce'));assert.notEqual(other.auth.searchParams.get('code_challenge'),auth.searchParams.get('code_challenge'));
    // The pending sign-in is a sealed, short-lived browser cookie.
    const [pending,...rest]=flow.response.headers.getSetCookie();assert.deepEqual(rest,[]);
    assert.match(pending,/^mayfly_admin_login=[\w-]{40,}; /);
    for(const attribute of ['Path=/','HttpOnly','SameSite=Lax','Max-Age=300'])assert.ok(pending.split('; ').includes(attribute),attribute);
    assert.ok(!/;\s*(Secure|Domain=)/i.test(pending),'loopback http cookies carry neither Secure nor Domain');
    const done=await finish(flow);
    assert.equal(done.status,303,JSON.stringify(done.body));assert.equal(done.headers.get('location'),'/admin');
    const cookies=done.headers.getSetCookie(),session=cookies.find(c=>c.startsWith('mayfly_admin=')),cleared=cookies.find(c=>c.startsWith('mayfly_admin_login='));
    assert.equal(cookies.length,2);
    assert.match(session,/^mayfly_admin=[\w-]{43}; /);
    for(const attribute of ['Path=/','HttpOnly','SameSite=Lax','Max-Age=3600'])assert.ok(session.split('; ').includes(attribute),attribute);
    assert.ok(!/;\s*(Secure|Domain=)/i.test(session));assert.ok(!session.startsWith('__Host-'));
    assert.match(cleared,/^mayfly_admin_login=; /);assert.ok(cleared.split('; ').includes('Max-Age=0'));
    signed={cookie:cookieOf(done)};signed.csrf=(await sessionOf(signed.cookie)).csrf;
    provider.authorizationQuery='';
  });

  const wiki=await h.create('CSRF target');
  const detail='/admin/api/resources/wiki/'+wiki.id;
  await t.test('state-changing admin API calls require the CSRF token, exact Origin and same-origin fetch metadata',async()=>{
    const other=await login(h,provider);assert.equal(other.response.status,303);const otherSession=await sessionOf(other.cookie);
    const good={Origin:h.base,'X-CSRF-Token':signed.csrf};
    const put=async headers=>{
      const current=await h.http(detail,{headers:{Cookie:signed.cookie}});assert.equal(current.status,200,JSON.stringify(current.body));
      return h.http(detail+'/policy',{method:'PUT',headers:{Cookie:signed.cookie,'Content-Type':'application/json',...headers},body:JSON.stringify({policy_version:current.body.policy_version,...policy()})});
    };
    const initial=(await h.http(detail,{headers:{Cookie:signed.cookie}})).body.policy_version;assert.equal(typeof initial,'number');
    const without=name=>Object.fromEntries(Object.entries(good).filter(([k])=>k!==name));
    const rejected=[
      ['missing token',without('X-CSRF-Token')],
      ['wrong token',{...good,'X-CSRF-Token':token43()}],
      ['empty token',{...good,'X-CSRF-Token':''}],
      ["another session's token",{...good,'X-CSRF-Token':otherSession.csrf}],
      ['missing Origin',without('Origin')],
      ['other host Origin',{...good,Origin:'https://evil.example'}],
      ['https scheme Origin',{...good,Origin:h.base.replace('http:','https:')}],
      ['other port Origin',{...good,Origin:'http://127.0.0.1:'+(port===65535?port-1:port+1)}],
      ['localhost alias Origin',{...good,Origin:h.base.replace('127.0.0.1','localhost')}],
      ['trailing slash Origin',{...good,Origin:h.base+'/'}],
      ['null Origin',{...good,Origin:'null'}],
      ['cross-site fetch',{...good,'Sec-Fetch-Site':'cross-site'}],
      ['same-site fetch',{...good,'Sec-Fetch-Site':'same-site'}],
      ['user-initiated fetch',{...good,'Sec-Fetch-Site':'none'}],
    ];
    for(const [name,headers] of rejected){const r=await put(headers);assert.equal(r.status,403,name);assert.deepEqual(r.body,{error:'Invalid CSRF protection'},name);}
    // A forged action never reaches the resource.
    for(const [name,headers] of rejected.filter(([name])=>['missing token','other host Origin','cross-site fetch'].includes(name))){
      const r=await h.http(detail+'/action',{method:'POST',headers:{Cookie:signed.cookie,'Content-Type':'application/json',...headers},body:JSON.stringify({action:'delete'})});
      assert.equal(r.status,403,name);assert.deepEqual(r.body,{error:'Invalid CSRF protection'},name);
    }
    const after=await h.http(detail,{headers:{Cookie:signed.cookie}});assert.equal(after.body.state,'active');assert.equal(after.body.policy_version,initial,'no forged policy write landed');
    assert.equal((await wiki.request()).status,200);
    // Correct token and Origin succeed with or without same-origin fetch metadata.
    assert.equal((await put(good)).status,202);
    const sameOrigin=await put({...good,'Sec-Fetch-Site':'same-origin'});assert.equal(sameOrigin.status,202,JSON.stringify(sameOrigin.body));
    assert.equal((await h.http(detail,{headers:{Cookie:signed.cookie}})).body.policy_version,initial+2);
    // Reads need only the session cookie: no token, no Origin (fetch metadata is not checked on GET).
    for(const path of ['/admin/api/session','/admin/api/resources',detail,detail+'/audit',detail+'/archives']){
      const r=await h.http(path,{headers:{Cookie:signed.cookie}});assert.equal(r.status,200,path+' '+JSON.stringify(r.body));
    }
    assert.equal((await h.http('/admin/api/resources',{headers:{Cookie:signed.cookie,'Sec-Fetch-Site':'cross-site'}})).status,200);
    // Unauthenticated writes are refused as unauthenticated before any CSRF check.
    assert.equal((await h.http(detail+'/policy',{method:'PUT',headers:{Origin:h.base,'Content-Type':'application/json'},body:'{}'})).status,401);
  });

  await t.test('logout clears cookies without a session but needs CSRF to end a live one',async()=>{
    const clears=r=>{const cookies=r.headers.getSetCookie();assert.equal(cookies.length,1);assert.match(cookies[0],/^mayfly_admin=; /);assert.ok(cookies[0].split('; ').includes('Max-Age=0'));assert.ok(cookies[0].split('; ').includes('Path=/'));};
    const out=(headers)=>h.http('/admin/logout',{method:'POST',headers});
    // No session: no token is needed, but the Origin check still applies.
    let r=await out({Origin:h.base});assert.equal(r.status,204);clears(r);
    r=await out({Origin:h.base,Cookie:'mayfly_admin=not-a-session'});assert.equal(r.status,204);clears(r);
    r=await out({Origin:h.base,Cookie:'mayfly_admin='+token43()});assert.equal(r.status,204,'unknown well-formed session');clears(r);
    r=await out({});assert.equal(r.status,403,'missing Origin is refused even without a session');assert.deepEqual(r.headers.getSetCookie(),[]);
    r=await out({Origin:'https://evil.example'});assert.equal(r.status,403);
    r=await out({Origin:h.base,'Sec-Fetch-Site':'cross-site'});assert.equal(r.status,403);
    // A live session survives forged logouts.
    const victim=await login(h,provider);assert.equal(victim.response.status,303);const {csrf}=await sessionOf(victim.cookie);
    for(const [name,headers] of [['missing token',{Origin:h.base}],['wrong token',{Origin:h.base,'X-CSRF-Token':token43()}],['missing Origin',{'X-CSRF-Token':csrf}],['other Origin',{Origin:'https://evil.example','X-CSRF-Token':csrf}],['cross-site',{Origin:h.base,'X-CSRF-Token':csrf,'Sec-Fetch-Site':'cross-site'}]]){
      r=await out({Cookie:victim.cookie,...headers});assert.equal(r.status,403,name);assert.deepEqual(r.body,{error:'Invalid CSRF protection'},name);assert.deepEqual(r.headers.getSetCookie(),[],name);
    }
    await sessionOf(victim.cookie);
    r=await out({Cookie:victim.cookie,Origin:h.base,'X-CSRF-Token':csrf});assert.equal(r.status,204);clears(r);
    r=await h.http('/admin/api/session',{headers:{Cookie:victim.cookie}});assert.equal(r.status,401);assert.deepEqual(r.body,{error:'Admin session expired'});
    await signedOutPage(victim.cookie,'logged-out cookie');
    r=await out({Cookie:victim.cookie,Origin:h.base});assert.equal(r.status,204,'logout of an ended session needs no token');clears(r);
    await sessionOf(signed.cookie);
  });

  await t.test('pending sign-in cookies are sealed to their own state',async()=>{
    const exchanges=provider.exchanges,a=await begin(),b=await begin();
    const reject=async(promise,status,error,message)=>{const r=await promise;assert.equal(r.status,status,message+' '+JSON.stringify(r.body));assert.deepEqual(r.body,{error},message);assert.ok(!r.headers.getSetCookie().some(c=>/^mayfly_admin=[\w-]/.test(c)),message);};
    await reject(finish(a,{cookie:null}),400,'Invalid sign-in response','no login cookie');
    await reject(finish(a,{code:null}),400,'Invalid sign-in response','no code');
    await reject(finish(a,{state:null}),400,'Invalid sign-in response','no state');
    await reject(finish(a,{extra:{state:b.state}}),400,'Invalid sign-in response','duplicate state');
    await reject(finish(a,{extra:{code:'other'}}),400,'Invalid sign-in response','duplicate code');
    const value=a.cookie.slice('mayfly_admin_login='.length),at=Math.floor(value.length/2);
    const flipped=value.slice(0,at)+(value[at]==='A'?'B':'A')+value.slice(at+1);
    await reject(finish(a,{cookie:'mayfly_admin_login='+flipped}),400,mismatch,'tampered ciphertext');
    await reject(finish(a,{cookie:'mayfly_admin_login='+value.slice(0,-4)}),400,mismatch,'truncated cookie');
    await reject(finish(a,{cookie:'mayfly_admin_login=%%%'}),400,mismatch,'malformed cookie');
    await reject(finish(a,{cookie:b.cookie}),400,mismatch,"flow B's cookie with flow A's state");
    await reject(finish(b,{cookie:a.cookie}),400,mismatch,"flow A's cookie with flow B's state");
    await reject(finish(a,{extra:{iss:'https://evil.example'}}),400,mismatch,'mismatched iss');
    assert.equal(provider.exchanges,exchanges,'rejected callbacks never reach the token endpoint');
    // Rejections consume nothing: both genuine flows still complete, each exactly once.
    const doneA=await finish(a,{extra:{iss:provider.origin}});assert.equal(doneA.status,303,JSON.stringify(doneA.body));
    const doneB=await finish(b);assert.equal(doneB.status,303,JSON.stringify(doneB.body));
    assert.equal(provider.exchanges,exchanges+2);
    await reject(finish(a),400,mismatch,'replayed callback');
  });

  await t.test('a flood of new sign-ins cannot evict an earlier pending one',async()=>{
    const first=await begin();let last;
    for(let i=0;i<30;i++)last=await begin();
    const r=await finish(first);assert.equal(r.status,303,JSON.stringify(r.body));await sessionOf(cookieOf(r));
    assert.equal((await finish(last)).status,303);
  });

  // Remove the administrator: the existing session is refused but not deleted.
  await h.start({...vars,OIDC_ADMIN_SUBJECTS:'["someone-else"]'});
  let carried;
  await t.test('a removed administrator loses API access and sees the sign-in page',async()=>{
    for(const path of ['/admin/api/session','/admin/api/resources',detail]){
      const r=await h.http(path,{headers:{Cookie:signed.cookie}});assert.equal(r.status,403,path);assert.deepEqual(r.body,{error:'Admin access denied'},path);
    }
    const write=await h.http(detail+'/policy',{method:'PUT',headers:{Cookie:signed.cookie,Origin:h.base,'X-CSRF-Token':signed.csrf,'Content-Type':'application/json'},body:JSON.stringify({policy_version:1,...policy(null,null,false,true)})});
    assert.equal(write.status,403);assert.deepEqual(write.body,{error:'Admin access denied'});
    await signedOutPage(signed.cookie,'removed administrator');await signedOutPage(undefined,'anonymous');
    const again=await login(h,provider);assert.equal(again.response.status,403);assert.deepEqual(again.response.body,{error:denied});
    assert.ok(!again.response.headers.getSetCookie().some(c=>/^mayfly_admin=[\w-]/.test(c)));
    carried=await begin(); // completed after the next restart
  });

  await h.start(vars);
  await t.test('provider outages are 503s; rejected codes are generic 403s',async()=>{
    provider.down=true;
    let r=await h.http('/admin/login');
    assert.equal(r.status,503);assert.deepEqual(r.body,{error:unavailable});assert.deepEqual(r.headers.getSetCookie(),[]);
    assert.ok(!r.text.includes(provider.origin)&&!/\bat\s|stack|secret/i.test(r.text),r.text);
    provider.down=false;
    const outage=async(setup,status,error,message)=>{
      const flow=await begin();setup();
      try {
        const r=await finish(flow);assert.equal(r.status,status,message+' '+JSON.stringify(r.body));assert.deepEqual(r.body,{error},message);
        const cookies=r.headers.getSetCookie();assert.equal(cookies.length,1,message);assert.match(cookies[0],/^mayfly_admin_login=; /,message);
        assert.ok(!r.text.includes(provider.origin)&&!r.text.includes('invalid_grant'),message);
      } finally { provider.down=false;provider.tokenStatus=null; }
      return flow;
    };
    const failed=await outage(()=>{provider.tokenStatus=502;},503,unavailable,'token endpoint 502');
    await outage(()=>{provider.tokenStatus=500;},503,unavailable,'token endpoint 500');
    await outage(()=>{provider.down=true;},503,unavailable,'provider down during callback');
    await outage(()=>{provider.tokenStatus=400;},403,denied,'token endpoint invalid_grant');
    await outage(()=>{provider.tokenStatus=401;},403,denied,'token endpoint 401');
    // The state was consumed by the failed attempt; the browser must start a new sign-in.
    r=await finish(failed);assert.equal(r.status,400);assert.deepEqual(r.body,{error:mismatch});
    const fresh=await login(h,provider);assert.equal(fresh.response.status,303);
  });

  await t.test('re-adding a removed administrator revives the earlier session',async()=>{
    const s=await sessionOf(signed.cookie);assert.equal(s.subject,'admin');assert.equal(s.csrf,signed.csrf);
    const page=await h.http('/admin',{headers:{Cookie:signed.cookie}});assert.ok(page.text.includes('id="logout"'));
    // The sealing key is durable, so a sign-in begun before a restart still completes.
    const r=await finish(carried);assert.equal(r.status,303,JSON.stringify(r.body));await sessionOf(cookieOf(r));
  });
});
