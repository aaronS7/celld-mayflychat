const assert = require('node:assert/strict');
const document = new EventTarget(), window = new EventTarget();
document.hidden = false;
const status = {textContent:''}, EVENTS = '/c/fixture/events';
let gone = false, last = -1, titles = 0;
const hdr = () => ({Authorization:'Bearer fixture'});
function tabTitle(){ titles++; }
function channelGone(){ gone = true; wakePoll(); }
const timers = new Map(); let timerID = 0;
globalThis.setTimeout = (fn, ms) => { timers.set(++timerID, {fn, ms}); return timerID; };
globalThis.clearTimeout = id => timers.delete(id);
const tick = ms => {
  const found = [...timers].find(([,t]) => t.ms === ms);
  assert(found, 'expected timer '+ms); timers.delete(found[0]); found[1].fn();
};
const hasTimer = ms => [...timers.values()].some(t => t.ms === ms);
const drain = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
const event = (target, name, props={}) => target.dispatchEvent(Object.assign(new Event(name), props));
const deferred = () => {
  let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b});
  promise.catch(()=>{}); return {promise, resolve, reject};
};
let requests = [], active = 0, seen = [], holdRender = null;
globalThis.fetch = (path, {signal, headers}) => {
  assert.equal(active, 0, 'only one outstanding read'); active++;
  assert.equal(headers.Authorization, 'Bearer fixture');
  assert.equal(new URL(path,'http://fixture').searchParams.get('wait'), '30');
  const head=deferred(), body=deferred();
  const r = {path, signal, reading:false, ended:false,
    finish(){if(!this.ended){this.ended=true;active--}},
    headers(code=200){head.resolve({status:code, ok:code===200, json(){r.reading=true;return body.promise}})},
    body(events){this.finish();body.resolve({events})},
    respond(code, events=[]){this.headers(code);if(code===200)this.body(events)},
    fail(){this.finish();head.reject(Error('offline'))}
  };
  signal.addEventListener('abort', () => {r.finish();head.reject(signal.reason);body.reject(signal.reason)}, {once:true});
  requests.push(r); return head.promise;
};
async function render(events){
  if(holdRender) await holdRender.promise;
  let n=0;
  for(const seq of events) if(seq>last){last=seq;seen.push(seq);n++;}
  return n;
}
