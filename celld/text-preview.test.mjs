import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source=await readFile(new URL('./browser/text-preview.js',import.meta.url),'utf8')+'\n'+await readFile(new URL('./browser/clipboard.js',import.meta.url),'utf8');
const {mayflyTextLanguage:language,mayflyCodeLanguage:codeLanguage,mayflyReadableText:readable,mayflyCodeTokens:tokens,mayflyCopyMarkdown:markdown,mayflyCopyHTML:html}=runInNewContext(source+';({mayflyTextLanguage,mayflyCodeLanguage,mayflyReadableText,mayflyCodeTokens,mayflyCopyMarkdown,mayflyCopyHTML})',{TextEncoder});

test('known text formats and code aliases are explicit; opaque binary files stay downloads',()=>{
  for(const [name,want] of Object.entries({'REPORT.JSON':'json','events.ndjson':'jsonl','deployment.yml':'yaml','table.csv':'csv','server.log':'text','README.md':'markdown','settings.toml':'toml','worker.ts':'typescript','notes.py':'python','view.html':'html','vector.svg':'xml'})) assert.equal(language(name,'application/octet-stream'),want,name);
  assert.equal(language('result','application/problem+json; charset=utf-8'),'json');
  assert.equal(language('notes','text/plain; charset=utf-8'),'text');
  for(const name of ['file.zip','file.pdf','file.exe','file','file.constructor','__proto__'])assert.equal(language(name),null,name);
  assert.equal(language('file','constructor'),null);
  for(const value of ['ts','typescript'])assert.equal(codeLanguage(value),'typescript');
  assert.equal(codeLanguage('json linenos'),'json');assert.equal(codeLanguage('unrecognized'),'text');
  assert.equal(codeLanguage('constructor'),'text');
});

test('JSON reading format preserves exact large numbers, escapes, order and string contents',()=>{
  const input=String.raw`{"id":90071992547409931234,"n":-1.200e+42,"path":"a\\b\"c","markup":"<script>bad()</script>","nested":[true,null,{},[]]}`;
  const result=readable(input,'json');
  assert.equal(result.formatted,true);assert.ok(result.text.includes('\n  "id": 90071992547409931234,'));
  assert.ok(result.text.includes('-1.200e+42'));assert.ok(result.text.includes(String.raw`"a\\b\"c"`));
  assert.deepEqual(JSON.parse(result.text),JSON.parse(input));
  assert.ok(result.text.indexOf('"id"')<result.text.indexOf('"n"'));
  for(const value of ['{broken json','{"n":NaN}',''])assert.equal(readable(value,'json').text,value);
  const ndjson='{"a":1}\n{"a":2}';assert.equal(readable(ndjson,'jsonl').text,ndjson);
  assert.equal(readable('one\r\ntwo\r\n','text').text,'one\ntwo');
  const deep='['.repeat(65)+'1'+']'.repeat(65);assert.equal(readable(deep,'json').text,deep);
  const huge=JSON.stringify('x'.repeat(600000));assert.equal(readable(huge,'json').text,huge);
  const unicode=JSON.stringify({value:'é'.repeat(270000)});assert.equal(readable(unicode,'json').formatted,false);
});

test('highlighting keeps JSON strings intact and respects language comment rules',()=>{
  const json='{"url":"https://host/#part", "active":true, "count":-2.5e3}';
  const found=tokens(json,'json');
  assert.deepEqual(Array.from(found,t=>t.kind),['property','string','property','keyword','property','number']);
  assert.equal(json.slice(found[1].start,found[1].end),'"https://host/#part"');
  assert.ok(tokens('const answer = true; // note','typescript').some(t=>t.kind==='comment'));
  assert.ok(tokens('# note\nvalue: "safe"','yaml').some(t=>t.kind==='comment'));
  assert.ok(tokens('SELECT * FROM records -- note','sql').some(t=>t.kind==='comment'));
  assert.equal(tokens('anything 123','text').length,0);
});

test('large inputs bound highlighting work without losing source data',()=>{
  const many='"key":123,'.repeat(50000), found=tokens(many,'json');
  assert.ok(found.length<=2000);assert.ok(found.every(t=>t.end<=128*1024));
  let rebuilt='',position=0;
  for(const token of found){rebuilt+=many.slice(position,token.start)+many.slice(token.start,token.end);position=token.end;}
  rebuilt+=many.slice(position);assert.equal(rebuilt,many);
});

test('Markdown copying contains full source, escapes filenames and contains embedded fences',()=>{
  const value='const text = "```";\n'+Array.from({length:70},(_,i)=>'// line '+i).join('\n');
  const result=markdown(value,'[link](https://bad) <script>\n**notes**.ts','typescript');
  assert.ok(result.startsWith('**\\[link\\]\\(https://bad\\) \\<script\\> \\*\\*notes\\*\\*\\.ts**\n\n````typescript\n'));
  assert.ok(result.endsWith('// line 69\n````'));
  assert.ok(result.includes(value));
  assert.equal(markdown('hello\n','Code','text'),'```\nhello\n```');
});

test('rich clipboard content contains safe escaped source and bounded syntax spans',()=>{
  const value='<img src=x onerror=alert(1)> & "quoted"\n<script>bad()</script>';
  const result=html(value,'html');
  assert.ok(result.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(result.includes('&lt;script&gt;'));
  assert.ok(!result.includes('<img'));assert.ok(!result.includes('<script'));
  assert.ok(html('const n = 123;','typescript').includes('<strong>const</strong>'));
  assert.ok(!result.includes('style='));
  assert.ok((html('"key":123,'.repeat(50000),'json').match(/<strong>/g)||[]).length<=2000);
});
