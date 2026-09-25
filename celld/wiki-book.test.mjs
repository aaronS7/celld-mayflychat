import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, page, post, wikiHarness } from './wiki-test-helper.mjs';

test('book layout flag is reversible and navigation follows the live page tree with bounded results', {timeout:60000}, async t=>{
  const h=await wikiHarness(t),wiki=await h.create();
  const add=async(title,path,parent_id=null)=>{const r=await wiki.request('/pages',post({...page(title),path,parent_id}));assert.equal(r.status,201);return r.body;};
  const a=await add('A','a'),b=await add('B','b'),child=await add('Child','z-child',a.id),first=await add('First child','a-first',a.id),grandchild=await add('Deep page','deep',child.id);
  let manifest=(await wiki.request('/pages?parent=')).body.pages;
  assert.equal(manifest.find(p=>p.id===a.id).has_children,true);
  assert.equal(manifest.find(p=>p.id===b.id).has_children,false);
  const nav=async p=>{const r=await wiki.request('/pages/'+p.id+'/navigation');assert.equal(r.status,200);return r.body;};
  const order=[a,first,child,grandchild,b];
  for(const [i,p] of order.entries()){
    const n=await nav(p);assert.equal(n.previous?.id,order[i-1]?.id);assert.equal(n.next?.id,order[i+1]?.id);
    assert.ok(!JSON.stringify(n).includes('markdown'));assert.equal(n.page_id,p.id);
  }
  assert.deepEqual((await nav(grandchild)).ancestors.map(p=>p.id),[a.id,child.id]);
  assert.equal((await h.http(wiki.path+'/pages/'+a.id+'/navigation')).status,401);
  const other=await h.create('Isolated');assert.equal((await other.request('/pages/'+a.id+'/navigation')).status,404);
  assert.equal((await wiki.request('/pages/'+a.id+'/navigation/1')).status,404);
  const move=await wiki.request('/pages/'+child.id,post({...page(child.title,child.markdown),path:child.path,parent_id:b.id},'PUT',1));assert.equal(move.status,200);
  assert.deepEqual((await nav(grandchild)).ancestors.map(p=>p.id),[b.id,child.id]);
  assert.equal((await nav(first)).next.id,b.id);
  await wiki.request('/pages/'+first.id,{method:'DELETE',headers:{'If-Match':'"1"'}});
  manifest=(await wiki.request('/pages?parent=')).body.pages;
  assert.equal(manifest.find(p=>p.id===a.id).has_children,false,'deleted and moved children do not leave empty expand controls');
  assert.equal(manifest.find(p=>p.id===b.id).has_children,true);
  assert.equal((await nav(a)).next.id,b.id);assert.equal((await wiki.request('/pages/'+first.id+'/navigation')).status,404);
  assert.equal((await h.http('/config')).body.wiki.layout,'classic');
  assert.match((await h.http(wiki.path,{headers:{Accept:'text/html'}})).text,/data-wiki-layout="classic"/);
  await h.start({WIKI_BOOK_LAYOUT_ENABLED:'1'});
  assert.equal((await h.http('/config')).body.wiki.layout,'book');
  assert.match((await h.http(wiki.path,{headers:{Accept:'text/html'}})).text,/data-wiki-layout="book"/);
  assert.equal((await wiki.request('/pages/'+grandchild.id)).body.markdown,grandchild.markdown);
  await h.start({WIKI_BOOK_LAYOUT_ENABLED:'0'});assert.equal((await h.http('/config')).body.wiki.layout,'classic');
  await h.start({WIKI_BOOK_LAYOUT_ENABLED:'invalid'});assert.equal((await h.http('/config')).status,503);
  await h.start({WIKI_ENABLED:'0',WIKI_BOOK_LAYOUT_ENABLED:'invalid'});assert.equal((await h.http('/config')).body.wiki.enabled,false);assert.equal((await wiki.request('/pages')).status,404);
  await h.start({ENCRYPTION_ENABLED:'1',WIKI_BOOK_LAYOUT_ENABLED:'1'});assert.equal((await h.http('/config')).body.wiki.layout,'classic');
});

test('downloaded agents can comment, list, reply, resolve and reopen with revision checks', {timeout:30000}, async t=>{
  const h=await wikiHarness(t,{WIKI_BOOK_LAYOUT_ENABLED:'1'}),wiki=await h.create();
  const p=(await wiki.request('/pages',post(page()))).body;
  const file=join(h.directory,'wiki.mjs');await writeFile(file,(await h.http('/static/wiki.mjs')).text);
  const agent=async(...args)=>{const r=await execute(process.execPath,[file,...args]);return JSON.parse(r.stdout);};
  const root=await agent('comment',wiki.url,p.id,'Agent page feedback');assert.equal(root.anchor.type,'page');
  const section=await agent('comment',wiki.url,p.id,'Agent recovery feedback','Recovery');assert.equal(section.anchor.heading,'Recovery');
  const reply=await agent('reply',wiki.url,p.id,section.id,'Confirmed by the second agent');assert.equal(reply.parent_id,section.id);assert.equal(reply.anchor.heading,'Recovery');
  const listed=await agent('comments',wiki.url,p.id);assert.equal(listed.comments.length,3);assert.ok(listed.comments.every(c=>c.author==='agent'));assert.equal(listed.next,null);
  const resolved=await agent('resolve',wiki.url,section.id,'1');assert.equal(resolved.resolved,true);assert.equal(resolved.revision,2);
  await assert.rejects(agent('reopen',wiki.url,section.id,'1'),error=>JSON.parse(error.stdout).status===412);
  const reopened=await agent('reopen',wiki.url,section.id,'2');assert.equal(reopened.resolved,false);assert.equal(reopened.revision,3);
  assert.equal((await agent('navigation',wiki.url,p.id)).next,null);
  await h.start({WIKI_BOOK_LAYOUT_ENABLED:'0'});assert.equal((await agent('comments',wiki.url,p.id)).comments.length,3,'layout changes preserve the discussion');
});
