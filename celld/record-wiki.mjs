// Record the actual application in desktop and touch-enabled mobile Chrome.
// Disposable local storage, synthetic pages, no production keys or provider calls.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execute,post,wikiHarness} from './wiki-test-helper.mjs';
assert.ok(process.env.CHROME_BIN,'Set CHROME_BIN to record the wiki');
const cleanup=[];
try {
  const h=await wikiHarness({after:fn=>cleanup.push(fn)},{WIKI_BOOK_LAYOUT_ENABLED:'1'});
  const wiki=await h.create('Mayfly handbook'),pages={};
  async function add(key,title,path,markdown,parent=null){
    const r=await wiki.request('/pages',post({title,path,markdown,parent_id:parent?pages[parent]:null,author:'handbook-agent'}));
    assert.equal(r.status,201);pages[key]=r.body.id;
  }
  await add('welcome','Welcome','00-welcome','# Welcome\n\nA shared home for your team’s knowledge. Write once, explore together, and give agents the context they need.\n\n## Find your way\n\nBrowse the chapters in the sidebar, jump to a section on this page, or use the search bar above. Your place stays highlighted as you move.\n\n## Work together\n\n- Keep lasting decisions in the wiki.\n- Use a linked chat to explore an idea.\n- Review a page together in its discussion.\n\n## Built for people and agents\n\nEvery page has a stable identity and a version history. People read and edit in the browser; agents use the same pages through the API.');
  await add('guides','Team workflows','guides','# Team workflows\n\nPractical guides for keeping a shared knowledge base useful.\n\n## Start a chapter\n\nExpand this section to explore writing, review and collaboration.');
  await add('writing','Writing a page','guides/01-writing','# Writing a page\n\nStart with a clear title and a short introduction.\n\n## Make it useful\n\nDescribe the task, show an example and link related pages.','guides');
  await add('agents','Working with agents','guides/02-agents','# Working with agents\n\nBring humans and agents into the same conversation, with a shared source of knowledge.\n\n## Share the wiki\n\nGive your agent the complete wiki link. It can browse pages, search passages and read the latest Markdown.\n\n```sh\nnode wiki.mjs list "$WIKI_URL"\nnode wiki.mjs comments "$WIKI_URL" PAGE_ID\n```\n\n## Review together\n\nLeave feedback on a page or a named section. Reply in the same thread, then resolve it when the change is ready.\n\n## Keep decisions\n\nCapture the agreed result in the page. A linked chat holds the working conversation; the wiki holds the lasting knowledge.','guides');
  for(const [key,title] of [['review','Reviewing changes'],['history','Page history'],['links','Linking a chat'],['images','Images and code']])await add(key,title,'guides/03-'+key,'# '+title+'\n\nA practical reference for your shared wiki.\n\n## Getting started\n\nMake a small change, review it together, and keep a clear record.','guides');
  await add('operations','Operations','operations','# Operations\n\nRunbooks for safe releases and resilient services.\n\n## Before a change\n\nCheck ownership, prepare a rollback and agree how to verify the result.');
  await add('deploy','Deploy checklist','operations/deploy','# Deploy checklist\n\nMake changes in small, verifiable steps.\n\n## Validate\n\nRun functional and browser tests.\n\n## Release\n\nDeploy the tested build, then verify the live service.','operations');
  await add('recovery','Recovery runbook','operations/recovery','# Recovery runbook\n\nRestore service while preserving acknowledged writes.\n\n## Before you begin\n\n- Identify the current owner.\n- Check the most recent replicated position.\n- Record the incident in the linked chat.\n\n## Fencing\n\nConfirm that the old owner has stopped accepting writes before promoting its replacement.\n\n```typescript\nconst ready = await replica.caughtUp();\nif (ready) await owner.promote();\n```\n\n## Verification\n\nRead the last acknowledged write, check the service response, and document the outcome.','operations');
  await add('reference','API reference','reference','# API reference\n\nUse stable page IDs and revision checks to keep agent updates predictable.\n\n## Read and discuss\n\nThe wiki client supports page reads, search, comments and replies.');
  await wiki.request('/pages/'+pages.recovery+'/comments',post({body:'Checked the ownership and fencing steps. Ready for a second review.',author:'review-agent',anchor:{type:'section',heading:'Fencing',revision:1}}));
  const output=fileURLToPath(new URL('../website/public/media/',import.meta.url));
  const config={chrome:process.env.CHROME_BIN,profile:join(h.directory,'chrome'),url:wiki.url,pages,output,frames:join(h.directory,'recording-frames'),fps:12};
  await mkdir(config.frames);
  const harness=await readFile(new URL('../srv/testdata/chrome.cjs',import.meta.url),'utf8');
  const exercise=await readFile(new URL('./testdata/wiki-recording.cjs',import.meta.url),'utf8');
  const script=join(h.directory,'record.cjs');await writeFile(script,'const config='+JSON.stringify(config)+';\n'+harness+'\n'+exercise,{mode:0o600});
  const {stdout}=await execute(process.execPath,[script],{timeout:180000,maxBuffer:1024*1024});console.log(stdout.trim());
  for(const name of ['desktop','mobile']){
    await execute('ffmpeg',['-y','-loglevel','error','-framerate',String(config.fps),'-i',join(config.frames,name,'frame-%05d.png'),'-vf','fps=24','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-crf','21','-movflags','+faststart',join(output,'wiki-'+name+'-demo.mp4')],{timeout:60000});
    const {stdout:probe}=await execute('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height','-of','json',join(output,'wiki-'+name+'-demo.mp4')]);
    const info=JSON.parse(probe);assert.ok(Number(info.format.duration)>10);console.log(name+': '+info.streams[0].width+'×'+info.streams[0].height+', '+Number(info.format.duration).toFixed(1)+' seconds.');
  }
  assert.equal(h.provider.requests.length,0,'Recordings must not call Jev');
} finally {for(const finish of cleanup.reverse())await finish();}
