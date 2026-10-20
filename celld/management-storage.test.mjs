import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { build } from 'esbuild';
const compiled=(await build({entryPoints:['celld/native/management-storage.ts'],bundle:true,write:false,format:'esm',platform:'neutral'})).outputFiles[0].text;
const {archiveStore,putVerified}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const hash=v=>createHash('sha256').update(v).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();

test('dedicated S3 archives sign requests, conditionally create and verify stored bytes',async t=>{
  const original=globalThis.fetch,objects=new Map(),requests=[];let corrupt=false;
  t.after(()=>globalThis.fetch=original);
  globalThis.fetch=async(request,init)=>{
    const r=request instanceof Request?request:new Request(request,init),url=new URL(r.url),body=Buffer.from(await r.arrayBuffer());requests.push(r);
    assert.equal(url.origin,'https://storage.example');
    const auth=r.headers.get('Authorization');assert.ok(auth);
    const [,scope,names,signature]=/Credential=fixture\/([^,]+), SignedHeaders=([^,]+), Signature=(\w+)/.exec(auth);
    const [day,region,service,terminal]=scope.split('/');assert.equal(region,'us-east-1');assert.equal(service,'s3');assert.equal(terminal,'aws4_request');
    const headers=names.split(';').map(n=>n+':'+(n==='host'?url.host:r.headers.get(n)).trim()+'\n').join('');
    const canonical=[r.method,url.pathname,'',headers,names,r.headers.get('x-amz-content-sha256')??hash(body)].join('\n');
    const key=hmac(hmac(hmac(hmac('AWS4fixture-secret',day),region),'s3'),'aws4_request');
    assert.equal(hmac(key,['AWS4-HMAC-SHA256',r.headers.get('x-amz-date'),scope,hash(canonical)].join('\n')).toString('hex'),signature);
    if(r.method==='PUT'){
      assert.equal(r.headers.get('if-none-match'),'*');assert.equal(r.headers.get('x-amz-content-sha256'),hash(body));
      if(objects.has(url.pathname))return new Response(null,{status:412});
      objects.set(url.pathname,body);return new Response(null,{status:200});
    }
    const stored=objects.get(url.pathname);return stored?new Response(corrupt?Buffer.from('damaged'):stored):new Response(null,{status:404});
  };
  const store=archiveStore({ARCHIVE_STORAGE:'s3',ARCHIVE_S3_ENDPOINT:'https://storage.example',ARCHIVE_S3_BUCKET:'private-archives',ARCHIVE_S3_REGION:'us-east-1',ARCHIVE_S3_ACCESS_KEY_ID:'fixture',ARCHIVE_S3_SECRET_ACCESS_KEY:'fixture-secret'});
  const key='mayfly/v1/chat/resource/archive/objects/0',bytes=new TextEncoder().encode('immutable backup');
  const receipt=await putVerified(store,key,bytes);assert.equal(receipt.sha256,hash(bytes));assert.equal(objects.size,1);
  await putVerified(store,key,bytes);assert.equal(objects.size,1,'retry never overwrites an existing archive object');
  await assert.rejects(putVerified(store,key,new TextEncoder().encode('different snapshot')),/integrity/);
  corrupt=true;await assert.rejects(putVerified(store,key,bytes),/integrity/);
  assert.equal(requests[0].url,'https://storage.example/private-archives/'+key);
});
