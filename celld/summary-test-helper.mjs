import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { wikiHarness } from './wiki-test-helper.mjs';

export async function summaryHarness(t, vars={}) {
  const state={requests:[],hold:false,pending:new Set(),aborted:0,mode:'normal',status:200,firstChunks:0,
    output:'# Summary\n\nRésumé 🐝: keep the rollout small. [1]\n\n- Verify the result.\n- Record the next step.\n\n<img src="https://example.invalid/tracker" onerror="alert(1)"><script>alert(1)</script>'};
  state.release=()=>{for(const release of state.pending)release();state.pending.clear();};
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    if(req.url==='/fixture'){
      const value=raw?JSON.parse(raw):{};for(const key of ['hold','mode','status'])if(key in value)state[key]=value[key];if(value.release)state.release();
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({requests:state.requests.length,aborted:state.aborted,finished:state.requests.filter(r=>r.finished).length}));return;
    }
    const entry={path:req.url,body:JSON.parse(raw),authorization:req.headers.authorization,finished:false};state.requests.push(entry);
    const mode=state.mode,hold=state.hold;
    if(state.status!==200){res.writeHead(state.status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'provider-private-detail'}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
    let release;
    res.on('close',()=>{if(!entry.finished)state.aborted++;release?.();});
    const frame=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';
    const delta=text=>frame({choices:[{index:0,delta:{content:text},finish_reason:null}]});
    try{
      if(mode==='malformed'){res.end('data: not-json\n\n');return;}
      if(mode==='oversized'){res.end('data: '+('x'.repeat(140000)));return;}
      const first=Buffer.from(delta(state.output.slice(0,55))),split=first.indexOf(Buffer.from('🐝'))+2;
      res.write(first.subarray(0,split));await delay(10);res.write(first.subarray(split));state.firstChunks++;
      if(hold){await new Promise(resolve=>{release=resolve;state.pending.add(resolve);});state.pending.delete(release);}
      else await delay(60);
      if(res.destroyed)return;
      if(mode==='disconnect'){res.end();return;}
      res.write(': heartbeat\r\n\r\n');res.write(delta(state.output.slice(55)));
      res.write(frame({choices:[{index:0,delta:{},finish_reason:mode==='length'?'length':'stop'}]}));
      entry.finished=true;res.end('data: [DONE]\r\n\r\n');
    }catch{res.destroy();}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{state.release();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
  const env={AI_SUMMARY_ENABLED:'1',MERCURY_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,MERCURY_API_KEY:'summary-fixture-secret',WIKI_BOOK_LAYOUT_ENABLED:'1',...vars};
  const h=await wikiHarness(t,env);
  return {...h,mercury:state,summaryEnv:env,summaryControl:`http://127.0.0.1:${provider.address().port}/fixture`};
}
export function events(text) {
  return text.split('\n\n').filter(Boolean).map(frame=>({event:frame.split('\n').find(line=>line.startsWith('event: '))?.slice(7),data:JSON.parse(frame.split('\n').find(line=>line.startsWith('data: ')).slice(6))}));
}
export async function waitFor(fn,label){for(let n=0;n<300;n++){if(await fn())return;await delay(10);}throw new Error('Timeout: '+label);}
