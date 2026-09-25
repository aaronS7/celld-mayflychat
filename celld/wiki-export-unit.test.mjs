import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { execute } from './wiki-test-helper.mjs';

test('portable ZIP streaming, exact limit, integrity, names and Markdown destinations', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mayfly-export-unit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'zip.mjs');await execute('esbuild',[new URL('./native/wiki-zip.ts',import.meta.url).pathname,'--bundle','--platform=neutral','--format=esm','--outfile='+file]);
  const zip=await import(pathToFileURL(file));
  const {zipSize,zipChunks,zipText,utf8,exportName,exportPageName,exportMarkdown,relativeFile,exportLimits}=zip;
  assert.equal(zip.crc32(utf8('123456789')),0xcbf43926);
  assert.equal(zip.crc32(utf8('456789'),zip.crc32(utf8('123'))),0xcbf43926);
  const entries=[{name:'README.md',size:6,data:()=>zipText('hello\n')},{name:'attachments/abc/résumé.mp4',size:256,data:async function*(){yield Uint8Array.from({length:128},(_,i)=>i);yield Uint8Array.from({length:128},(_,i)=>i+128);}},{name:'empty.md',size:0,data:()=>zipText('')}];
  let opened=0;const chunks=[];
  const iterator=zipChunks(entries,()=>{opened++;});assert.equal(opened,0,'generator is lazy');
  for await(const chunk of iterator)chunks.push(chunk);
  const archive=Buffer.concat(chunks);assert.equal(archive.length,zipSize(entries));
  const archiveFile=join(dir,'valid.zip');await writeFile(archiveFile,archive);
  await execute('python3',['-c',`import zipfile,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert z.read('README.md') == b'hello\\n'
 assert z.read('attachments/abc/résumé.mp4') == bytes(range(256))
 assert z.read('empty.md') == b''
 assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())`,archiveFile]);
  const overhead=zipSize([{name:'a',size:0}]);
  assert.equal(zipSize([{name:'a',size:exportLimits.bytes-overhead}]),exportLimits.bytes);
  assert.throws(()=>zipSize([{name:'a',size:exportLimits.bytes-overhead+1}]),/1 GiB/);
  assert.throws(()=>zipSize(Array.from({length:50001},(_,i)=>({name:String(i),size:0}))),/50,000/);
  for(const name of ['../escape','/absolute','a/../escape','a\\escape','a\0b'])assert.throws(()=>zipSize([{name,size:0}]));
  assert.throws(()=>zipSize([{name:'File',size:0},{name:'file',size:0}]));
  for(const size of [5,7])await assert.rejects(async()=>{for await(const _ of zipChunks([{name:'bad',size,data:()=>zipText('hello\n')}],()=>{})){};},/grew|incomplete/);
  await assert.rejects(async()=>{for await(const _ of zipChunks(entries,()=>{throw new Error('wiki changed');})){};},/wiki changed/);
  assert.equal(exportName('../../CON.txt'),'__.._CON.txt');
  assert.equal(exportName('CON.txt'),'_CON.txt');assert.equal(exportName('a:b?.json'),'a_b_.json');
  assert.equal(exportPageName('guide/con'),'pages/guide/_con.md');
  assert.equal(relativeFile('pages/guide/start.md','attachments/abc/a file.json'),'../../attachments/abc/a%20file.json');
  const page='11111111-1111-4111-8111-111111111111', attachment='22222222-2222-4222-8222-222222222222';
  const pages=new Map([[page,'pages/overview.md']]),files=new Map([[attachment,'attachments/file/data.json']]);
  const link='[Go](page:'+page+')', image='![Plot](attachment:'+attachment+')';
  const input=[link,image,'[ref]: <page:'+page+'> "Title"','`'+link+'`','```md',link,'```','    '+link,'\\'+link,'[External](https://example.invalid/file)','<!--',link,'-->'].join('\n');
  const output=exportMarkdown(input,'pages/guide/start.md',pages,files);
  assert.match(output,/\[Go\]\(\.\.\/overview.md\)/);assert.match(output,/\[Plot\]\(\.\.\/\.\.\/attachments\/file\/data.json\)/);
  assert.ok(output.includes('[ref]: <../overview.md> "Title"'));
  assert.ok(output.includes('`'+link+'`'));assert.ok(output.includes('```md\n'+link+'\n```'));
  assert.ok(output.includes('    '+link));assert.ok(output.includes('<!--\n'+link+'\n-->'));
  assert.ok(output.includes('\\'+link),'escaped link syntax stays literal');
  assert.ok(output.includes('[External](https://example.invalid/file)'));
  assert.equal(exportMarkdown('[missing](page:33333333-3333-4333-8333-333333333333)','pages/a.md',pages,files),'[missing](page:33333333-3333-4333-8333-333333333333)');
  const absent='33333333-3333-4333-8333-333333333333', example='[Example](attachment:'+absent+')';
  const fixture=[
    '# Repository handoff', image, '[File][asset]', '[asset]:\n    <attachment:'+attachment+'> "Download"',
    '[Multiline](\n    attachment:'+attachment+'\n)', '<attachment:'+attachment+'>',
    '- Nested list', '  - '+image, '    '+link, '',
    '- Fenced example', '  ```md', '  '+example, '  ```', '',
    '`'+example+'`', '    '+example, '\\'+example, '```md',example,'```',
    '~~~',example,'~~~', '<pre>',example,'</pre>', '<!--',example,'-->',
    '[External](https://example.invalid/file.json)', '<page:'+page+'>'
  ].join('\n');
  assert.deepEqual(zip.exportReferences(fixture),{pages:[page],attachments:[attachment]},'collect renderable references once and ignore examples');
  const rewritten=exportMarkdown(fixture,'README.md',new Map([[page,'README.md']]),files);
  assert.ok(rewritten.includes('[asset]:\n    <attachments/file/data.json> "Download"'));
  assert.ok(rewritten.includes('[Multiline](\n    attachments/file/data.json\n)'));
  assert.ok(rewritten.includes('[attachment:'+attachment+'](attachments/file/data.json)'));
  assert.ok(rewritten.includes('    [Go](README.md)'),'nested list continuation links remain portable');
  assert.deepEqual(zip.exportReferences(rewritten),{pages:[],attachments:[]});
  const html='<div>\n'+example+'\n</div>\n\n';
  assert.deepEqual(zip.exportReferences(html+image),{pages:[],attachments:[attachment]},'raw HTML blocks do not add attachments');
  assert.ok(exportMarkdown(html,'README.md',pages,files).includes(example));
  assert.deepEqual(zip.exportReferences('Unclosed ` tick\n\n'+image+'\n\nA later ` tick'),{pages:[],attachments:[attachment]},'an unmatched tick cannot hide later blocks');
});
