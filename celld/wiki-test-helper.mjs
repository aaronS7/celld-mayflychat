import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const execute = promisify(execFile);
export const post = (value, method='POST', rev) => ({method,headers:{'Content-Type':'application/json',...(rev?{'If-Match':`"${rev}"`}:{})},body:JSON.stringify(value)});
export const page = (title='Failover', markdown='# Failover\n\n## Recovery\nPreserve acknowledged writes during failover.\n') => ({title,path:title.toLowerCase().replace(/[^a-z0-9]+/g,'-'),markdown,aliases:['node failure'],tags:['operations'],author:'test-agent'});
export function capability() {
  const key=randomBytes(32), bits=(info,n)=>Buffer.from(hkdfSync('sha256',key,'',info,n)).toString('base64url');
  const auth=bits('mayfly wiki auth',32), id=bits('mayfly wiki id',16);
  return {id,auth,key:key.toString('base64url'),auth_hash:createHash('sha256').update(auth).digest('base64url')};
}
export async function wikiHarness(t, initial={}) {
  const directory=await mkdtemp(join(tmpdir(),'mayfly-wiki-test-'));
  await cp(new URL('./native/',import.meta.url),join(directory,'celld/native'),{recursive:true});
  const config=JSON.parse((await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8')).replace(/^\s*\/\/.*$/gm,''));
  await writeFile(join(directory,'wrangler.json'),JSON.stringify(config));
  const providerState={status:200,delay:0,malformed:false,requests:[],scores:null};
  const provider=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;
    const body=JSON.parse(text);providerState.requests.push({body,authorization:req.headers.authorization});
    if(providerState.delay)await delay(providerState.delay);
    res.writeHead(providerState.status,{'Content-Type':'application/json'});
    const answers=Object.fromEntries(Object.keys(body.questions).map((key,i)=>[key,{type:'score',score:providerState.scores?.[i]??Math.max(0,3-i),confidence:0.8}]));
    res.end(JSON.stringify(providerState.malformed?{answers:{}}:{model:'test-jev',answers}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const source=join(directory,'celld/native/wiki-search.ts');
  await writeFile(source,(await readFile(source,'utf8')).replace('https://api.typesafe.ai/v1/systemone',`http://127.0.0.1:${provider.address().port}/v1/systemone`));
  const picker=tcpServer();await new Promise(resolve=>picker.listen(0,'127.0.0.1',resolve));
  const port=picker.address().port;await new Promise(resolve=>picker.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  let child,done,output='';
  async function stop(){if(!child)return;child.kill('SIGINT');const timer=setTimeout(()=>child.kill('SIGKILL'),8000);try{await done;}finally{clearTimeout(timer);child=null;}}
  t.after(async()=>{await stop();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(directory,{recursive:true,force:true});});
  async function start(vars=initial){
    await stop();output='';
    const resolved={ENCRYPTION_ENABLED:'0',WIKI_ENABLED:'1',JEV_WIKI_SEARCH_ENABLED:'0',JEV_ENABLED:'0',JEV_TAGGING_ENABLED:'0',...vars};
    await writeFile(join(directory,'.dev.vars'),Object.entries(resolved).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
    child=spawn('celld',['dev',directory,'--port',String(port),'--no-watch','--logs'],{stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
    done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});done.catch(()=>{});
    const deadline=Date.now()+20000;
    for(;;){
      if(child.exitCode!==null)throw new Error(output);
      try{const r=await fetch(base+'/llms.txt',{signal:AbortSignal.timeout(500)});await r.text();if(r.ok)break;}catch{}
      assert.ok(Date.now()<deadline,output);await delay(100);
    }
  }
  async function http(path,options={}) {
    const response=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(20000),...options});
    const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}
    return {status:response.status,body,text,headers:response.headers};
  }
  async function create(title='Test knowledge',cap=capability()) {
    const result=await http('/wiki/new',post({...cap,title}));assert.equal(result.status,201,JSON.stringify(result));
    const path='/w/'+cap.id;
    return {...cap,path,url:base+path+'#'+cap.key,request:(suffix='',options={})=>http(path+suffix,{...options,headers:{Authorization:'Bearer '+cap.auth,...options.headers}})};
  }
  await start();
  return {directory,base,start,stop,http,create,provider:providerState,logs:()=>output};
}
