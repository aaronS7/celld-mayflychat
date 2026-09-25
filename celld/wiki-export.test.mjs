import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { execute, page, post, wikiHarness } from './wiki-test-helper.mjs';

export async function unpack(file) {
  const {stdout}=await execute('python3',['-c',`import zipfile,sys,json,base64
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert len(z.namelist()) == len(set(z.namelist()))
 print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))`,file],{maxBuffer:16*1024*1024});
  return Object.fromEntries(Object.entries(JSON.parse(stdout)).map(([n,b])=>[n,Buffer.from(b,'base64')]));
}

test('wiki export API and served agent client preserve all current content and enforce isolation', {timeout:180000}, async t=>{
  const h=await wikiHarness(t),wiki=await h.create('Portable wiki'), other=await h.create('Other');
  const upload=async(name,body)=>(await wiki.request('/attachments',{method:'POST',headers:{'X-Filename':name,'Content-Type':'application/octet-stream'},body})).body;
  const bytes=Buffer.from(Array.from({length:2048},(_,i)=>i%256)),file=await upload('../notes.json',bytes),orphan=await upload('unreferenced.mp4',Buffer.from('video-original-bytes'));
  const parent=(await wiki.request('/pages',post({...page('Start'),path:'guide/start'}))).body;
  const markdown='# Child 🌱\n\n[Parent](page:'+parent.id+')\n\n[File](attachment:'+file.id+')\n\n[Remote](https://example.invalid/external.zip)\n';
  const child=(await wiki.request('/pages',post({...page('Child',markdown),path:'guide/child',parent_id:parent.id}))).body;
  const gone=(await wiki.request('/pages',post(page('Deleted','OLD-DELETED-CONTENT')))).body;
  await wiki.request('/pages/'+gone.id,{method:'DELETE',headers:{'If-Match':'"1"'}});
  const thread=(await wiki.request('/pages/'+child.id+'/comments',post({body:'Migration discussion',author:'agent'}))).body;
  await wiki.request('/pages/'+child.id+'/comments',post({parent_id:thread.id,body:'Reply retained',author:'human'}));
  await wiki.request('/comments/'+thread.id,post({resolved:true},'PATCH',1));
  const client=join(h.directory,'wiki.mjs');await writeFile(client,(await h.http('/static/wiki.mjs')).body);
  await t.test('preflight, exact ZIP bytes, page/file links and metadata',async()=>{
    assert.equal((await h.http(wiki.path+'/export',{method:'POST'})).status,401);
    assert.equal((await h.http(wiki.path+'/export',{method:'POST',headers:{Authorization:'Bearer '+other.auth}})).status,401);
    assert.equal((await wiki.request('/export',post({invalid:true}))).status,400);
    const prepared=await wiki.request('/export',{method:'POST'});assert.equal(prepared.status,201,JSON.stringify(prepared.body));
    const plan=prepared.body;assert.equal(plan.pages,2);assert.equal(plan.attachments,2);assert.equal(plan.state,'ready');assert.ok(plan.bytes<1073741824);
    assert.equal((await wiki.request('/export',{method:'POST'})).status,429);
    assert.equal((await other.request('/export/'+plan.id)).status,404);
    const endpoint=h.base+wiki.path+'/export/'+plan.id+'/download';
    const form=ticket=>({method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket})});
    assert.equal((await fetch(endpoint,form(other.auth))).status,401);
    assert.equal((await fetch(h.base+other.path+'/export/'+plan.id+'/download',form(plan.ticket))).status,404);
    const response=await fetch(endpoint,form(plan.ticket));assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'application/zip');
    const buffer=Buffer.from(await response.arrayBuffer());assert.equal(buffer.length,plan.bytes);assert.equal(response.headers.get('X-Mayfly-Export-Bytes'),String(plan.bytes));
    assert.equal(response.headers.get('Cache-Control'),'no-store, no-transform');
    const output=join(h.directory,'api.zip');await writeFile(output,buffer);const archive=await unpack(output);
    assert.equal(archive['pages/guide/child.md'].toString(),markdown.replace('page:'+parent.id,'start.md').replace('attachment:'+file.id,'../../attachments/'+file.id+'/__notes.json'));
    assert.deepEqual(archive['attachments/'+file.id+'/__notes.json'],bytes);
    assert.equal(archive['attachments/'+orphan.id+'/unreferenced.mp4'].toString(),'video-original-bytes');
    const metadata=JSON.parse(archive['metadata/'+child.id+'.json']);assert.equal(metadata.parent_id,parent.id);assert.equal(metadata.title,'Child');assert.deepEqual(metadata.tags,['operations']);
    const comments=archive['discussion/'+child.id+'.jsonl'].toString().trim().split('\n').map(JSON.parse);assert.equal(comments.length,2);assert.equal(comments[0].resolved,true);assert.equal(comments[1].parent_id,thread.id);
    const manifest=JSON.parse(archive['manifest.json']);assert.equal(manifest.wiki.version,plan.version);assert.deepEqual(Object.keys(manifest.wiki).sort(),['id','title','version']);
    const all=Object.values(archive).map(b=>b.toString()).join('\n');
    for(const privateValue of [wiki.auth,wiki.key,wiki.auth_hash,other.auth,'OLD-DELETED-CONTENT'])assert.ok(!all.includes(privateValue));
    assert.ok(!Object.keys(archive).some(n=>n.includes(gone.id)));assert.match(all,/https:\/\/example.invalid\/external.zip/);
    assert.equal((await wiki.request('/export/'+plan.id)).body.state,'complete');
    assert.equal((await fetch(endpoint,form(plan.ticket))).status,401,'ticket is single use');
  });
  await t.test('changes, cancellation and agent streaming to an exclusive file',async()=>{
    let plan=(await wiki.request('/export',{method:'POST'})).body;
    await wiki.request('/pages/'+parent.id,{method:'PUT',headers:{'Content-Type':'text/markdown','If-Match':'"1"'},body:'# Latest saved page\n'});
    let status=(await wiki.request('/export/'+plan.id)).body;assert.equal(status.state,'failed');assert.equal(status.code,'export_changed');
    plan=(await wiki.request('/export',{method:'POST'})).body;
    assert.equal((await wiki.request('/export/'+plan.id,{method:'DELETE'})).body.state,'canceled');
    const output=join(h.directory,'agent.zip'),run=await execute(process.execPath,[client,'export',wiki.url,output]);const result=JSON.parse(run.stdout);
    assert.equal(result.pages,2);assert.equal(result.attachments,2);assert.equal((await readFile(output)).length,result.bytes);
    const archive=await unpack(output);assert.equal(archive['pages/guide/start.md'].toString(),'# Latest saved page\n');
    await assert.rejects(execute(process.execPath,[client,'export',wiki.url,output]));
    assert.equal((await readFile(output)).length,result.bytes,'existing destination retained');
    assert.ok(!(await readdir(h.directory)).some(n=>n.endsWith('.part')),'temporary downloads removed');
  });
  await t.test('single-page API and client export referenced bytes, revisions and current discussion for a PR',async()=>{
    const path='/pages/'+child.id+'/export';
    assert.equal((await h.http(wiki.path+path,{method:'POST'})).status,401);
    assert.equal((await h.http(wiki.path+path,{method:'POST',headers:{Authorization:'Bearer '+other.auth}})).status,401);
    assert.equal((await other.request(path,{method:'POST'})).status,404);
    for(const query of ['?revision=0','?revision=1&revision=2','?revision=x','?extra=1'])assert.equal((await wiki.request(path+query,{method:'POST'})).status,400);
    assert.equal((await wiki.request(path+'?revision=999',{method:'POST'})).status,404);
    const current='# Current child\n\n[Self](page:'+child.id+')\n\n[Video](attachment:'+orphan.id+')\n';
    assert.equal((await wiki.request('/pages/'+child.id,{method:'PUT',headers:{'Content-Type':'text/markdown','If-Match':'"1"'},body:current})).status,200);
    const plan=(await wiki.request(path+'?revision=1',{method:'POST'})).body;
    assert.equal(plan.scope,'page');assert.equal(plan.pages,1);assert.equal(plan.attachments,1);assert.equal(plan.page.revision,1);
    assert.equal(plan.page.id,child.id);assert.equal(plan.page.file,'README.md');assert.deepEqual(plan.unresolved_pages,[parent.id]);
    assert.equal((await wiki.request('/export',{method:'POST'})).status,429,'page and wiki share one export slot');
    assert.equal((await wiki.request(path,{method:'POST'})).status,429);
    const response=await fetch(h.base+wiki.path+'/export/'+plan.id+'/download',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket:plan.ticket})});
    assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,plan.bytes);
    const output=join(h.directory,'page-api.zip');await writeFile(output,bytes);const archive=await unpack(output);
    assert.equal(archive['README.md'].toString(),markdown.replace('attachment:'+file.id,'attachments/'+file.id+'/__notes.json'));
    assert.deepEqual(archive['attachments/'+file.id+'/__notes.json'],Buffer.from(Array.from({length:2048},(_,i)=>i%256)));
    assert.equal(Object.keys(archive).filter(n=>n.startsWith('attachments/')).length,1);
    assert.ok(!Object.keys(archive).some(n=>n.includes(orphan.id)||n.startsWith('pages/')));
    const manifest=JSON.parse(archive['_mayfly/manifest.json']);assert.equal(manifest.format,'mayfly-page');assert.equal(manifest.page.revision,1);
    assert.equal(JSON.parse(archive['_mayfly/page.json']).parent_id,parent.id);
    assert.deepEqual(JSON.parse(archive['_mayfly/references.json']),{unresolved_pages:[parent.id]});
    assert.equal(archive['_mayfly/discussion.jsonl'].toString().trim().split('\n').length,2);
    assert.match(archive['_mayfly/README.md'].toString(),/does not create or publish a pull request/);
    const all=Object.values(archive).map(b=>b.toString()).join('\n');for(const privateValue of [wiki.key,wiki.auth,wiki.auth_hash])assert.ok(!all.includes(privateValue));
    const latestPath=join(h.directory,'page-agent.zip');
    const result=JSON.parse((await execute(process.execPath,[client,'export-page',wiki.url,child.id,latestPath])).stdout);
    assert.equal(result.scope,'page');assert.equal(result.page.revision,2);assert.equal(result.attachments,1);assert.deepEqual(result.unresolved_pages,[]);
    const latest=await unpack(latestPath);assert.equal(latest['README.md'].toString(),current.replace('page:'+child.id,'README.md').replace('attachment:'+orphan.id,'attachments/'+orphan.id+'/unreferenced.mp4'));
    assert.equal(latest['attachments/'+orphan.id+'/unreferenced.mp4'].toString(),'video-original-bytes');
    const historicalPath=join(h.directory,'page-agent-r1.zip');
    const historical=JSON.parse((await execute(process.execPath,[client,'export-page',wiki.url,child.id,historicalPath,'1'])).stdout);assert.equal(historical.page.revision,1);
    assert.deepEqual((await unpack(historicalPath))['README.md'],archive['README.md']);
    await assert.rejects(execute(process.execPath,[client,'export-page',wiki.url,child.id,latestPath]));
    assert.deepEqual((await unpack(latestPath))['README.md'],latest['README.md'],'existing output is never overwritten');
    assert.ok(!(await readdir(h.directory)).some(n=>n.endsWith('.part')));
  });
  await t.test('page export handles unavailable references, code examples and deleted history explicitly',async()=>{
    const foreign=(await other.request('/attachments',{method:'POST',headers:{'X-Filename':'private.json','Content-Type':'application/json'},body:'PRIVATE OTHER WIKI'})).body;
    const missing='[Missing](attachment:'+foreign.id+')';
    const p=(await wiki.request('/pages',post(page('Missing file',missing)))).body;
    const failed=await wiki.request('/pages/'+p.id+'/export',{method:'POST'});assert.equal(failed.status,409);assert.equal(failed.body.code,'export_attachment_missing');
    assert.equal((await wiki.request('/pages/'+p.id,{method:'PUT',headers:{'Content-Type':'text/markdown','If-Match':'"1"'},body:'```md\n'+missing+'\n```\n'})).status,200);
    const code=await wiki.request('/pages/'+p.id+'/export',{method:'POST'});assert.equal(code.status,201);assert.equal(code.body.attachments,0);
    await wiki.request('/export/'+code.body.id,{method:'DELETE'});
    assert.equal((await wiki.request('/pages/'+gone.id+'/export',{method:'POST'})).status,404);
    const history=await wiki.request('/pages/'+gone.id+'/export?revision=1',{method:'POST'});assert.equal(history.status,201);assert.equal(history.body.page.revision,1);
    await wiki.request('/export/'+history.body.id,{method:'DELETE'});
  });
  await t.test('empty export and feature flag enforcement',async()=>{
    const empty=await h.create('Empty');const result=JSON.parse((await execute(process.execPath,[client,'export',empty.url,join(h.directory,'empty.zip')])).stdout);assert.equal(result.pages,0);assert.equal(result.attachments,0);
    await h.start({WIKI_ENABLED:'0'});assert.equal((await wiki.request('/export',{method:'POST'})).status,404);assert.equal((await wiki.request('/pages/'+child.id+'/export',{method:'POST'})).status,404);
    await h.start();assert.equal((await wiki.request('/export',{method:'POST'})).status,201);
  });
  await t.test('size preflight and edits during an attachment stream fail closed',async()=>{
    const zipSource=join(h.directory,'celld/native/wiki-zip.ts'),exportSource=join(h.directory,'celld/native/wiki-export.ts');
    const zip=await readFile(zipSource,'utf8'),exporter=await readFile(exportSource,'utf8');
    await writeFile(zipSource,zip.replace('bytes: 1_073_741_824','bytes: 2048'));
    await h.start();const limited=await wiki.request('/export',{method:'POST'});assert.equal(limited.status,413);assert.equal(limited.body.code,'export_limit');
    const pageLimited=await wiki.request('/pages/'+child.id+'/export',{method:'POST'});assert.equal(pageLimited.status,413);assert.equal(pageLimited.body.code,'export_limit');
    await writeFile(zipSource,zip);
    await writeFile(exportSource,exporter.replace('await bucket!.get(file.key);','await bucket!.get(file.key); await new Promise(resolve => setTimeout(resolve, 300));'));
    await h.start();const plan=(await wiki.request('/export',{method:'POST'})).body;
    const response=await fetch(h.base+wiki.path+'/export/'+plan.id+'/download',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket:plan.ticket})});
    const consumed=response.arrayBuffer();consumed.catch(()=>{});
    await wiki.request('/pages/'+parent.id,{method:'PUT',headers:{'Content-Type':'text/markdown','If-Match':'"2"'},body:'# Changed during download\n'});
    await assert.rejects(consumed,'an interrupted ZIP cannot become a successful response');
    assert.equal((await wiki.request('/export/'+plan.id)).body.code,'export_changed');
  });
});
