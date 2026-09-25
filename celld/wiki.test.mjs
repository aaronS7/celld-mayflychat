import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { capability, page, post, wikiHarness } from './wiki-test-helper.mjs';

test('wiki lifecycle, isolation, revisions, search, discussion, files and feature flags in celld', {timeout:180000}, async t=>{
  const h=await wikiHarness(t), a=await h.create(), b=await h.create('Isolated wiki');
  let p, child, thread;
  await t.test('capabilities, creation replay and private shells',async()=>{
    assert.match((await h.http('/docs/wiki.md')).body,/WIKI_ENABLED/);
    assert.match((await h.http('/llms.txt')).body,/\/docs\/wiki\.md/);
    assert.equal((await h.http(a.path+'/pages')).status,401);
    assert.equal((await h.http(a.path+'/pages',{headers:{Authorization:'Bearer '+b.auth}})).status,401);
    assert.equal((await h.http(a.path+'/_create',post({auth_hash:b.auth_hash}))).status,401);
    const instructions=await h.http(a.path);assert.match(instructions.body,/wiki\.mjs/);assert.doesNotMatch(instructions.body,/Test knowledge/);
    const shell=await h.http(a.path,{headers:{Accept:'text/html'}});assert.equal(shell.status,200);assert.doesNotMatch(shell.body,/Test knowledge/);
    assert.equal((await h.http('/wiki/new',post({...a,title:'Replay'}))).status,200);
    assert.equal((await h.http('/wiki/new',{...post({...capability(),title:'Cross origin'}),headers:{Origin:'https://elsewhere.invalid'}})).status,403);
    assert.equal((await h.http('/config')).body.wiki.enabled,true);
  });
  await t.test('page identity, idempotent creation, metadata, pagination and hierarchy',async()=>{
    const value={...page(),id:randomUUID()};p=(await a.request('/pages',post(value))).body;assert.equal(p.revision,1);assert.ok(p.sections.some(s=>s.heading==='Recovery'));
    const replay=await a.request('/pages',post(value));assert.equal(replay.status,200);assert.equal(replay.body.revision,1);
    assert.equal((await a.request('/pages',post({...value,title:'Other'}))).status,409);
    child=(await a.request('/pages',post({...page('Subpage'),parent_id:p.id}))).body;
    await a.request('/pages',post(page('Other')));
    const list=await a.request('/pages?limit=1');assert.equal(list.body.pages.length,1);assert.ok(list.body.next);
    const next=await a.request('/pages?limit=1&after='+list.body.next);assert.notEqual(next.body.pages[0].id,list.body.pages[0].id);
    assert.equal((await a.request('/pages?parent=')).body.pages.length,2);
    assert.equal((await a.request('/pages?parent='+p.id)).body.pages[0].id,child.id);
    assert.equal((await a.request('/pages/'+p.id,post({...page(),parent_id:child.id},'PUT',1))).status,400);
    assert.equal((await a.request('/pages/'+p.id,{method:'DELETE',headers:{'If-Match':'"1"'}})).status,409);
    assert.equal((await a.request('/pages',post({...page('Bad path'),path:'../escape'}))).status,400);
    assert.equal((await a.request('/pages',post({...page('Oversized'),markdown:'x'.repeat(262145)}))).status,400);
    assert.equal((await a.request('/pages',post({...page('Surrogate'),markdown:'\ud800'}))).status,400);
    assert.equal((await a.request('/pages',post({...page('Null'),markdown:'\0'}))).status,400);
  });
  await t.test('revision preconditions preserve concurrent writes and raw Markdown',async()=>{
    assert.equal((await a.request('/pages/'+p.id,post(page(),'PUT'))).status,428);
    const writes=await Promise.all(['Winner one','Winner two'].map(title=>a.request('/pages/'+p.id,post({...page(),title},'PUT',1))));
    assert.deepEqual(writes.map(r=>r.status).sort(),[200,412]);
    p=(await a.request('/pages/'+p.id)).body;assert.equal(p.revision,2);
    assert.equal((await a.request('/pages/'+p.id,post(page(),'PUT',1))).body.current_revision,2);
    const md='# Durable recovery\n\n## Recovery\nUniqueTerm acknowledged data survives.\n';
    const update=await a.request('/pages/'+p.id,{method:'PUT',headers:{'Content-Type':'text/markdown','If-Match':'"2"'},body:md});
    assert.equal(update.status,200);assert.equal(update.body.revision,3);assert.equal(update.body.title,p.title);p=update.body;
    const raw=await a.request('/pages/'+p.id,{headers:{Accept:'text/markdown'}});assert.equal(raw.body,md);assert.equal(raw.headers.get('ETag'),'"3"');
    assert.equal((await a.request('/pages/'+p.id+'/history/1')).body.title,'Failover');
    const history=(await a.request('/pages/'+p.id+'/history?limit=1')).body;assert.equal(history.next,3);assert.equal(history.revisions[0].revision,3);
    assert.equal((await a.request('/pages/'+p.id+'/history?before=3')).body.revisions[0].revision,2);
  });
  await t.test('local search indexes aliases and sections atomically without crossing wikis',async()=>{
    for(const query of ['UniqueTerm','node failure','Recovery']){
      const result=await a.request('/search',post({query}));assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.results.some(r=>r.page_id===p.id));
      const hit=result.body.results.find(r=>r.page_id===p.id);assert.equal(hit.revision,3);assert.match(hit.url,/revision=3/);assert.ok(hit.start_line>=1);
    }
    assert.equal((await b.request('/search?query=UniqueTerm')).body.results.length,0);
    assert.equal((await a.request('/search',post({query:'unknown',related_terms:['UniqueTerm']}))).body.results[0].page_id,p.id);
    assert.equal((await a.request('/search',post({query:'UniqueTerm',tag:'absent'}))).body.results.length,0);
    assert.equal((await a.request('/search',post({query:'UniqueTerm',path:'unrelated/'}))).body.results.length,0);
    assert.equal((await a.request('/search',post({query:'" OR * NOT (',mode:'keyword'}))).status,200);
    assert.equal((await a.request('/search',post({query:'UniqueTerm',mode:'relevance'}))).body.fallback,'disabled');
    assert.equal(h.provider.requests.length,0);
    const results=await Promise.all(Array.from({length:50},()=>a.request('/search?query=UniqueTerm')));assert.ok(results.every(r=>r.status===200));
  });
  await t.test('section discussion, replies, optimistic resolution and detachment',async()=>{
    thread=(await a.request('/pages/'+p.id+'/comments',post({body:'What about partitions?',author:'Reviewer',anchor:{type:'section',heading:'Recovery',revision:3}}))).body;
    assert.equal(thread.anchor.heading,'Recovery');assert.equal(thread.detached,false);
    const reply=await a.request('/pages/'+p.id+'/comments',post({body:'Covered below.',parent_id:thread.id}));assert.equal(reply.status,201);
    assert.equal((await a.request('/pages/'+p.id+'/comments',post({body:'Stale',anchor:{type:'page',revision:1}}))).status,412);
    assert.equal((await a.request('/pages/'+p.id+'/comments',post({body:'Missing',anchor:{type:'section',heading:'Absent',revision:3}}))).status,400);
    const resolved=await a.request('/comments/'+thread.id,post({resolved:true},'PATCH',1));assert.equal(resolved.body.resolved,true);
    assert.equal((await a.request('/comments/'+thread.id,post({resolved:false},'PATCH',1))).status,412);
    p=(await a.request('/pages/'+p.id,post({...p,markdown:'# Recovery changed\n\nDifferent material.'},'PUT',3))).body;
    const comments=(await a.request('/pages/'+p.id+'/comments')).body.comments;assert.equal(comments[0].detached,true);
    assert.equal((await a.request('/search?query=UniqueTerm')).body.results.length,0);
    assert.equal((await a.request('/pages/'+p.id+'/comments?limit=1')).body.next,thread.seq);
  });
  let image;
  await t.test('owned images require the same wiki capability and enforce type/size',async()=>{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=','base64');
    const uploaded=await a.request('/attachments',{method:'POST',headers:{'Content-Type':'image/png','X-Filename':'diagram.png'},body:png});
    assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));image=uploaded.body;assert.match(image.markdown,/attachment:/);
    const response=await fetch(h.base+a.path+'/attachments/'+image.id,{headers:{Authorization:'Bearer '+a.auth}});
    assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
    const metadata=await a.request('/attachments/'+image.id,{method:'HEAD'});
    assert.equal(metadata.status,200);assert.equal(metadata.text,'');assert.equal(metadata.headers.get('Content-Length'),String(png.length));
    assert.match(metadata.headers.get('Content-Disposition'),/attachment; filename\*=UTF-8''diagram.png/);
    assert.equal((await h.http(a.path+'/attachments/'+image.id)).status,401);
    assert.equal((await h.http(a.path+'/attachments/'+image.id,{method:'HEAD'})).status,401);
    assert.equal((await b.request('/attachments/'+image.id)).status,404);
    assert.equal((await a.request('/attachments',{method:'POST',headers:{'Content-Type':'image/png'},body:'not an image'})).status,400);
    assert.equal((await a.request('/attachments',{method:'POST',headers:{'Content-Type':'image/png'},body:Buffer.alloc(5242881)})).status,413);
  });
  await t.test('video and generic attachments retain bytes, names and authorization without active document previews',async()=>{
    for(const [type,name,body,storedType] of [
      ['video/mp4','clip.mp4',Buffer.from('000000186674797069736f6d00000200','hex'),'video/mp4'],
      ['application/pdf','Quarterly report.pdf','%PDF-1.7\nfixture','application/octet-stream'],
      ['image/svg+xml','diagram.svg','<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>','image/svg+xml'],
      ['text/html','notes "draft".html','<script>window.unsafe=true</script>','application/octet-stream'],
    ]) {
      const uploaded=await a.request('/attachments',{method:'POST',headers:{'Content-Type':type,'X-Filename':name},body});
      assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));assert.equal(uploaded.body.type,storedType);assert.equal(uploaded.body.name,name);assert.match(uploaded.body.markdown,storedType.startsWith('image/')?/^!\[/:/^\[/);
      const response=await fetch(h.base+a.path+'/attachments/'+uploaded.body.id,{headers:{Authorization:'Bearer '+a.auth}});
      assert.equal(response.headers.get('Content-Type'),storedType);assert.match(response.headers.get('Content-Disposition'),/^attachment; filename\*=UTF-8''/);
      assert.equal(decodeURIComponent(response.headers.get('Content-Disposition').split("UTF-8''")[1]),name);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(body));
      assert.equal((await b.request('/attachments/'+uploaded.body.id,{method:'HEAD'})).status,404);
    }
    assert.equal((await a.request('/attachments',{method:'POST',headers:{'Content-Type':'video/mp4'},body:'not a movie'})).status,400);
    assert.equal((await a.request('/attachments',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(5242881)})).status,413);
    assert.equal((await a.request('/attachments',{method:'POST',body:''})).status,400);
  });
  await t.test('changes, restart persistence, flag-off preservation and encryption override',async()=>{
    const changes=(await a.request('/changes?since=0&limit=2')).body;assert.equal(changes.changes.length,2);assert.ok(changes.next);
    assert.ok((await a.request('/changes?since='+changes.next)).body.changes[0].seq>changes.next);
    await h.start({WIKI_ENABLED:'0',JEV_WIKI_SEARCH_ENABLED:'1'});
    assert.equal((await a.request('/pages')).status,404);assert.equal((await h.http('/wiki')).status,404);assert.equal((await h.http('/config')).body.wiki.enabled,false);
    assert.match((await h.http('/')).body,/<p hidden><a id="newwikibtn"/);
    await h.start({WIKI_ENABLED:'1',ENCRYPTION_ENABLED:'1',JEV_WIKI_SEARCH_ENABLED:'bad'});
    assert.equal((await a.request('/pages')).status,404);assert.equal((await h.http('/config')).body.wiki.relevance,false);
    await h.start();assert.equal((await a.request('/pages/'+p.id)).body.revision,4);
    assert.equal((await a.request('/attachments/'+image.id)).status,200);
    assert.equal((await a.request('/pages/'+p.id+'/history/1')).body.title,'Failover');
    assert.equal(h.provider.requests.length,0);
  });
  await t.test('Jev scores real candidates, caches and invalidates, with bounded failures',async()=>{
    await h.start({JEV_WIKI_SEARCH_ENABLED:'1',TYPESAFE_API_KEY:'fixture-key'});
    const input={query:'Recovery',context:'Restore service',mode:'relevance'};
    const before=h.provider.requests.length;
    assert.equal((await h.http(a.path+'/search',{...post(input),headers:{Authorization:'Bearer '+b.auth}})).status,401);
    assert.equal(h.provider.requests.length,before,'Unauthorized search does not contact Jev');
    const ranked=await a.request('/search',post(input));assert.equal(ranked.body.mode,'relevance');assert.equal(ranked.body.results[0].relevance,3);
    assert.equal(h.provider.requests.length,before+1);
    const sent=h.provider.requests.at(-1);assert.equal(sent.authorization,'Bearer fixture-key');assert.equal(sent.body.state.context,'Restore service');
    assert.ok(sent.body.state.candidates.length<=20);assert.doesNotMatch(JSON.stringify(sent.body),new RegExp(a.auth+'|'+a.id+'|'+a.key));
    await a.request('/search',post(input));assert.equal(h.provider.requests.length,before+1);
    p=(await a.request('/pages/'+p.id,post({...p,markdown:p.markdown+'\nMore recovery instructions.'},'PUT',4))).body;
    await a.request('/search',post(input));assert.equal(h.provider.requests.length,before+2);
    h.provider.status=503;
    const failed=await a.request('/search',post({...input,context:'Provider failure'}));assert.equal(failed.body.mode,'keyword');assert.equal(failed.body.fallback,'unavailable');assert.ok(failed.body.results.length);
    h.provider.status=200;h.provider.malformed=true;
    assert.equal((await a.request('/search',post({...input,context:'Malformed response'}))).body.fallback,'unavailable');h.provider.malformed=false;
    h.provider.delay=1300;
    const slow=await a.request('/search',post({...input,context:'Deadline'}));assert.equal(slow.body.fallback,'unavailable');h.provider.delay=0;
    h.provider.delay=250;
    const count=h.provider.requests.length;
    const same=await Promise.all(Array.from({length:8},()=>a.request('/search',post({...input,context:'Coalesce'}))));assert.ok(same.every(r=>r.body.mode==='relevance'));assert.equal(h.provider.requests.length,count+1);
    const distinct=await Promise.all(Array.from({length:8},(_,i)=>a.request('/search',post({...input,context:'Concurrent '+i}))));
    assert.ok(distinct.some(r=>r.body.fallback==='busy'));assert.ok(distinct.every(r=>r.status===200));h.provider.delay=0;
  });
  await t.test('edits and deletion while Jev waits never return stale wiki content',async()=>{
    h.provider.delay=250;
    const pending=a.request('/search',post({query:'Recovery',mode:'relevance',context:'Race with edit'}));
    await delay(75);
    p=(await a.request('/pages/'+p.id,post({...p,markdown:'# Updated\nNew recovery guide.'},'PUT',p.revision))).body;
    const result=await pending;assert.equal(result.body.fallback,'changed');assert.ok(result.body.results.filter(r=>r.page_id===p.id).every(r=>r.revision===p.revision));
    h.provider.delay=0;
  });
  await t.test('page deletion and restore retain identity and history; wiki deletion is permanent',async()=>{
    const removed=await a.request('/pages/'+child.id,{method:'DELETE',headers:{'If-Match':'"1"'}});assert.equal(removed.status,200);assert.equal(removed.body.deleted,true);
    assert.equal((await a.request('/pages/'+child.id)).status,404);
    const old=(await a.request('/pages/'+child.id+'/history/1')).body;
    const restored=await a.request('/pages/'+child.id,post(old,'PUT',2));assert.equal(restored.status,200);assert.equal(restored.body.id,child.id);assert.equal(restored.body.revision,3);
    h.provider.delay=250;
    const searching=a.request('/search',post({query:'Recovery',mode:'relevance',context:'Race with wiki deletion'}));await delay(75);
    assert.equal((await a.request('',{method:'DELETE'})).status,204);assert.equal((await searching).status,404);
    assert.equal((await a.request('/pages')).status,404);assert.equal((await a.request('/attachments/'+image.id)).status,404);
    assert.equal((await h.http('/wiki/new',post({...a,title:'Resurrection'}))).status,410);
    await h.start();assert.equal((await a.request('/pages')).status,404);assert.equal((await b.request('/pages')).status,200);
  });
  assert.doesNotMatch(h.logs(),/fixture-key/);
});
