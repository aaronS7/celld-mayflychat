import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MayflySpaces as spaces } from './static/spaces.mjs';
import { page,post } from './wiki-test-helper.mjs';
import { events,summaryHarness,waitFor } from './summary-test-helper.mjs';

const summarize=(wiki,path='/summary',options={})=>fetch(wiki.url.split('#')[0]+path,{method:'POST',...options,headers:{Authorization:'Bearer '+wiki.auth,...options.headers}});
const result=async response=>{assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/event-stream/);return events(await response.text());};
const seed=async(wiki,value)=>{const response=await wiki.request('/pages',post(value));assert.equal(response.status,201);return response.body;};

test('authenticated summaries stream before the provider finishes and preserve source revisions', {timeout:30000}, async t=>{
  const h=await summaryHarness(t),wiki=await h.create('Summary handbook'),other=await h.create('Other wiki');
  const first=await seed(wiki,page('Plan','# Plan\n\nShip the first release on Tuesday.')),second=await seed(wiki,page('Result','# Result\n\nRecord the outcome.'));
  await seed(other,page('Private other wiki','# Other resource sentinel'));
  assert.equal((await h.http(wiki.path+'/summary',{method:'POST'})).status,401);
  assert.equal((await summarize(wiki,'/summary',{headers:{Authorization:'Bearer '+other.auth}})).status,401);
  assert.equal((await summarize(wiki,'/pages/'+crypto.randomUUID()+'/summary')).status,404);
  assert.equal((await summarize(wiki,'/summary',{body:JSON.stringify({prompt:'Use custom instructions'})})).status,400);
  assert.equal((await summarize(wiki,'/summary?query=extra')).status,400);
  assert.equal((await summarize(wiki,'/pages/'+first.id+'/summary?revision=1&revision=2')).status,400);
  assert.equal(h.mercury.requests.length,0);
  h.mercury.hold=true;
  const pending=summarize(wiki,'/pages/'+first.id+'/summary');
  let response;
  try{response=await Promise.race([pending,delay(2000).then(()=>{throw new Error('Response headers were buffered until completion');})]);}
  catch(error){h.mercury.release();throw error;}
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  try{
    while(!text.includes('event: delta')){const chunk=await Promise.race([reader.read(),delay(2000).then(()=>{throw new Error('Stream did not deliver the first delta');})]);assert.equal(chunk.done,false);text+=decoder.decode(chunk.value,{stream:true});}
    assert.equal(h.mercury.requests[0].finished,false,'the client sees generated text before provider completion');
    assert.match(text,/Résumé 🐝/,'UTF-8 survives split network chunks');
  }finally{h.mercury.release();}
  for(;;){const chunk=await reader.read();if(chunk.done)break;text+=decoder.decode(chunk.value,{stream:true});}
  const stream=events(text);assert.equal(stream.at(-1).event,'done');assert.equal(stream[0].data.sources[0].revision,1);
  assert.equal(stream.filter(e=>e.event==='delta').map(e=>e.data.text).join(''),h.mercury.output);
  const provider=h.mercury.requests[0];assert.equal(provider.path,'/v1/chat/completions');assert.equal(provider.body.model,'mercury-2.5');assert.equal(provider.body.stream,true);assert.equal(provider.body.diffusing,false);assert.equal(provider.body.reasoning_effort,'instant');assert.equal(provider.authorization,'Bearer summary-fixture-secret');
  assert.ok(provider.body.messages[1].content.includes('Tuesday'));
  for(const secret of [wiki.key,wiki.auth,other.key,'Other resource sentinel'])assert.ok(!JSON.stringify(provider.body).includes(secret));
  h.mercury.hold=false;
  await wiki.request('/pages/'+first.id,post({...page('Plan','# Plan\n\nNow Wednesday.'),path:first.path},'PUT',1));
  const historical=await result(await summarize(wiki,'/pages/'+first.id+'/summary?revision=1'));
  assert.equal(historical[0].data.sources[0].revision,1);assert.ok(h.mercury.requests.at(-1).body.messages[1].content.includes('Tuesday'));assert.ok(!h.mercury.requests.at(-1).body.messages[1].content.includes('Wednesday'));
  const overview=await result(await summarize(wiki));assert.equal(overview[0].data.included,2);assert.equal(overview[0].data.partial,false);assert.deepEqual(new Set(overview[0].data.sources.map(s=>s.title)),new Set([first.title,second.title]));
  assert.equal((await wiki.request('/pages/'+first.id)).body.revision,2,'summaries never write the wiki');
});

test('bounded wiki and chat summaries honor flags, saved text and encryption', {timeout:45000}, async t=>{
  const h=await summaryHarness(t),wiki=await h.create('Large wiki');
  const saved=[await seed(wiki,{...page('Root overview','# Overview\n\nStart here.'),path:'z-root'})];
  for(let n=1;n<65;n++)saved.push(await seed(wiki,{...page('Page '+n,'# Heading\n\nBrief saved page.'),path:'page-'+String(n).padStart(2,'0'),parent_id:saved[0].id}));
  const bounded=await result(await summarize(wiki));
  assert.equal(bounded[0].data.included,60,'the page count is bounded even when every page is short');
  assert.equal(bounded[0].data.sources[0].title,'Root overview','root pages precede descendants regardless of path sort');
  assert.equal(bounded[0].data.partial,true);assert.equal(bounded[0].data.total,65);
  for(const savedPage of saved){const updated=await wiki.request('/pages/'+savedPage.id,post({...page(savedPage.title,'# Heading\n\n'+('x'.repeat(4500))),path:savedPage.path,parent_id:savedPage.parent_id},'PUT',1));assert.equal(updated.status,200);}
  const overview=await result(await summarize(wiki));const info=overview[0].data;
  assert.equal(info.total,65);assert.ok(info.included<=60);assert.equal(info.partial,true);assert.ok(info.sources.every(s=>s.excerpt));
  const input=JSON.parse(h.mercury.requests.at(-1).body.messages[1].content);assert.ok(input.sources.reduce((n,s)=>n+Buffer.byteLength(s.text),0)<=160000);assert.equal(input.partial,true);
  const chatPlan=await spaces.complete(await spaces.plan(h.base,{chat:true})),chat=await spaces.capability(chatPlan.chat_url);
  const chatCall=(path,options={})=>h.http(chat.path+path,{...options,headers:{Authorization:'Bearer '+chat.auth,...options.headers}});
  assert.equal((await chatCall('/summary',{method:'POST'})).status,422);
  for(const [n,text] of ['Decide to ship on Friday.','Review the deployment result.'].entries())assert.equal((await chatCall('/events?last='+(n-1),post({nonce:randomBytes(12).toString('base64url'),from:'human',text}))).status,200);
  const before=(await chatCall('/events')).body;
  const summary=await result(await summarize(chat));assert.equal(summary[0].data.scope,'chat');assert.equal(summary[0].data.total,2);assert.equal(summary[0].data.included,2);
  assert.deepEqual((await chatCall('/events')).body,before);
  const calls=h.mercury.requests.length;
  await h.start({...h.summaryEnv,AI_SUMMARY_ENABLED:'0'});
  assert.equal((await summarize(wiki)).status,404);assert.equal((await summarize(chat)).status,404);assert.deepEqual((await h.http('/config')).body.summary,{enabled:false});
  await h.start({...h.summaryEnv,ENCRYPTION_ENABLED:'1'});
  assert.equal((await summarize(chat)).status,404);assert.deepEqual((await h.http('/config')).body.summary,{enabled:false});
  const encrypted=await spaces.complete(await spaces.plan(h.base,{chat:true})),secretChat=await spaces.capability(encrypted.chat_url);
  await h.start(h.summaryEnv);assert.equal((await summarize(secretChat)).status,412);
  assert.equal(h.mercury.requests.length,calls,'disabled/encrypted cases never call a provider');
  await h.start({...h.summaryEnv,MERCURY_API_KEY:''});
  assert.equal((await summarize(chat)).status,503);assert.equal((await h.http('/config')).status,200,'bad provider configuration does not disable ordinary reading');
});

test('stream failures, cancellation and concurrency limits do not leave active requests stuck', {timeout:30000}, async t=>{
  const h=await summaryHarness(t),wiki=await h.create();await seed(wiki,page());
  h.mercury.status=503;
  const unavailable=await summarize(wiki);assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes('provider-private-detail'));
  h.mercury.status=200;
  for(const mode of ['disconnect','malformed','oversized']){
    h.mercury.mode=mode;const stream=await result(await summarize(wiki));assert.equal(stream.at(-1).event,'error',mode);assert.ok(!stream.some(e=>e.event==='done'));
  }
  h.mercury.mode='length';assert.equal((await result(await summarize(wiki))).at(-1).data.truncated,true);
  h.mercury.mode='normal';h.mercury.hold=true;
  const abortA=new AbortController(),abortB=new AbortController();
  const [a,b]=await Promise.all([summarize(wiki,'/summary',{signal:abortA.signal}),summarize(wiki,'/summary',{signal:abortB.signal})]);
  assert.equal((await summarize(wiki)).status,429);
  const aborted=h.mercury.aborted;abortA.abort();await a.body.cancel().catch(()=>{});
  await waitFor(()=>h.mercury.aborted>aborted,'provider observes cancellation');
  h.mercury.hold=false;
  const retry=await result(await summarize(wiki));assert.equal(retry.at(-1).event,'done');
  abortB.abort();await b.body.cancel().catch(()=>{});h.mercury.release();
  const extra=await h.create('Delete while generating');await seed(extra,page());h.mercury.hold=true;
  const pending=await summarize(extra);await extra.request('',{method:'DELETE'});h.mercury.release();
  assert.equal((await result(pending)).at(-1).event,'error');
});
