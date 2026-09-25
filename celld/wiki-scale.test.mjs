// Opt-in capacity exercise. Measures local warm requests, not fleet durability or Jev.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { execute, post, wikiHarness } from './wiki-test-helper.mjs';

test('thousands of pages with fifty concurrent wiki clients', {timeout:600000}, async t=>{
  const count=Number(process.env.WIKI_SCALE_PAGES||5000);
  assert.ok(Number.isInteger(count)&&count>=100&&count<=10000);
  const h=await wikiHarness(t), wiki=await h.create('Synthetic capacity fixture');
  const topics=['failover','networking','storage','deployment','authentication','replication','recovery','observability'];
  const content=i=>{
    const topic=topics[i%topics.length];
    const paragraph=`The ${topic} procedure for service ${i} documents prerequisites, operator checks, validation steps and a recovery decision. Preserve acknowledged writes, verify the current owner, and record the observed result before making another change. `;
    return {title:`Runbook ${String(i).padStart(5,'0')}`,path:`runbooks/${String(i).padStart(5,'0')}`,author:'synthetic-agent',aliases:[`service ${i}`],tags:[topic],
      markdown:`# Runbook ${i}\n\n${paragraph.repeat(2)}\n\n## ${topic}\n${paragraph.repeat(2)}\n\n## Validation\nCheck marker${i} and confirm the documented outcome.\n`};
  };
  let next=0;const ids=[];const began=performance.now();
  await Promise.all(Array.from({length:12},async()=>{for(;;){const i=next++;if(i>=count)return;const result=await wiki.request('/pages',post(content(i)));assert.equal(result.status,201,JSON.stringify(result.body));ids[i]=result.body.id;}}));
  const seeded=performance.now()-began;t.diagnostic(`Seeded ${count} pages in ${Math.round(seeded)} ms.`);
  const timings={steady:[],burst:[],writes:[]};
  const search=async(i,group)=>{const start=performance.now();const result=await wiki.request('/search',post({query:i%2?topics[i%topics.length]:`marker${i%count}`,limit:10}));assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.results.length);timings[group].push(performance.now()-start);};
  for(let i=0;i<40;i++)await search(i,'steady');
  for(let wave=0;wave<3;wave++)await Promise.all(Array.from({length:50},(_,i)=>search(i+wave*50,'burst')));
  await Promise.all([
    ...Array.from({length:40},(_,i)=>search(i+200,'burst')),
    ...Array.from({length:10},async(_,i)=>{const start=performance.now();const result=await wiki.request('/pages/'+ids[i],post({...content(i),markdown:content(i).markdown+'\nScaleUpdateMarker'+i},'PUT',1));assert.equal(result.status,200);timings.writes.push(performance.now()-start);}),
  ]);
  const fresh=await wiki.request('/search?query=ScaleUpdateMarker0');assert.equal(fresh.body.results[0].revision,2);
  const summary=Object.fromEntries(Object.entries(timings).map(([name,values])=>{values.sort((a,b)=>a-b);const at=p=>Math.round(values[Math.ceil(values.length*p)-1]);return [name,{requests:values.length,p50_ms:at(.5),p95_ms:at(.95),max_ms:at(1)}];}));
  t.diagnostic(JSON.stringify({pages:count,concurrency:50,local_only:true,...summary}));
  assert.equal(h.provider.requests.length,0);
  const exportBegan=performance.now(),prepared=await wiki.request('/export',{method:'POST'});
  assert.equal(prepared.status,201,JSON.stringify(prepared.body));const plan=prepared.body;
  const preparedMS=Math.round(performance.now()-exportBegan);
  const response=await fetch(h.base+wiki.path+'/export/'+plan.id+'/download',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket:plan.ticket})});
  assert.equal(response.status,200);
  const destination=join(h.directory,'scale.zip');
  await Promise.all([pipeline(Readable.fromWeb(response.body),createWriteStream(destination)),...Array.from({length:50},(_,i)=>search(i,'burst'))]);
  await execute('python3',['-c',`import zipfile,sys,os
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert sum(n.startswith('pages/') for n in z.namelist()) == int(sys.argv[2])
 assert os.stat(sys.argv[1]).st_size == int(sys.argv[3])`,destination,String(count),String(plan.bytes)]);
  t.diagnostic(JSON.stringify({export_pages:count,archive_bytes:plan.bytes,prepare_ms:preparedMS,export_total_ms:Math.round(performance.now()-exportBegan),concurrent_readers:50,local_only:true}));
});
