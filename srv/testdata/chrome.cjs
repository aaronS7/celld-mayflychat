const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const chrome = spawn(config.chrome, ['--headless','--no-sandbox','--disable-gpu','--disable-background-networking',
  '--no-first-run','--no-default-browser-check','--remote-debugging-pipe','--user-data-dir='+config.profile,
  '--window-size=1280,900','about:blank'], {stdio:['ignore','ignore','ignore','pipe','pipe']});
chrome.on('error', err => {console.error(err); process.exit(1)});
const exited = new Promise(resolve => chrome.on('exit', resolve));
let nextID=0, buffer='';
const pending = new Map();
chrome.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  for (let end; (end=buffer.indexOf('\0')) >= 0;) {
    const raw=buffer.slice(0,end); buffer=buffer.slice(end+1); if(!raw)continue;
    const msg=JSON.parse(raw), p=pending.get(msg.id); if(!p)continue;
    pending.delete(msg.id);
    if(msg.error)p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
  }
});
function cdp(method,params={},sessionId){return new Promise((resolve,reject) => {
  const id=++nextID; pending.set(id,{resolve,reject});
  chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
})}
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){
  for(let n=0;n<600;n++){
    try { const result=await fn();if(result)return result; }
    catch(err){
      // A document can disappear between navigation and a readiness probe.
      if(!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/.test(String(err)))throw err;
    }
    await sleep(10);
  }
  throw new Error('timeout: '+label);
}
async function evaluate(tab,expression){
  const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},tab.sessionId);
  if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function attach(targetId){
  const {sessionId}=await cdp('Target.attachToTarget',{targetId,flatten:true});
  await cdp('Page.enable',{},sessionId); return {targetId,sessionId};
}
