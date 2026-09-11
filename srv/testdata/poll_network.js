(async()=>{
  const assert = (ok, text) => {if(!ok)throw Error(text)};
  const nativeFetch = window.fetch.bind(window), nativeTimeout = window.setTimeout.bind(window);
  const sleep = ms => new Promise(resolve=>nativeTimeout(resolve,ms));
  const until = async (fn, ms=4000) => {
    const end=performance.now()+ms;
    while(!await fn()){if(performance.now()>end)throw Error('condition timed out');await sleep(10)}
  };
  const state = async () => (await nativeFetch('/test-state')).json();
  let shortenDeadline=false;
  // Keep real Chrome fetch/abort/body behavior; the unit test checks the full 35-second clock.
  window.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms===35000 && shortenDeadline ? 150 : ms, ...args);
  await init({onGone:()=>{window.testReloads=(window.testReloads||0)+1}});assert(KS && !document.hidden,'visible initialized browser');
  await until(async()=> (await state()).reads===1);
  let seq=-1;
  const post = async () => {
    seq++;
    const blob=await seal(KS,seq,{from:'Fixture',text:'live delivery '+seq});
    const r=await nativeFetch(EVENTS+'?last='+(seq-1),{method:'POST',headers:hdr(),body:JSON.stringify(blob)});
    assert(r.ok,'accepted encrypted post');
    return performance.now();
  };
  const latencies=[];
  for(let i=0;i<4;i++){
    const ack=await post();await until(()=>!!msgs[seq],2000);
    latencies.push(performance.now()-ack);
    assert(session.last===seq && log.children.length===seq+1,'in-order consecutive delivery');
  }
  for(const [phase, recovery] of [['headers','online'],['body','online'],['body','pageshow'],['headers','deadline'],['body','deadline']]) {
    const before=await state();
    await nativeFetch('/test-stall?phase='+phase,{method:'POST'});
    shortenDeadline=recovery==='deadline';
    window.dispatchEvent(new Event('online'));
    await until(async()=> (await state()).stalled===before.stalled+1);
    shortenDeadline=false;
    const ack=await post();
    if(recovery!=='deadline'){
      await sleep(50);assert(!msgs[seq],'held response has not delivered its accepted post');
      if(recovery==='online')window.dispatchEvent(new Event('online'));
      else window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
    }
    await until(()=>!!msgs[seq]);
    await until(async()=> (await state()).canceled===before.canceled+1);
    assert(session.last===seq && log.children.length===seq+1,'recovery neither skips nor duplicates events: '+phase+'/'+recovery);
    assert(status.textContent==='','successful delivery clears reconnecting status');
    assert(performance.now()-ack<4000,'recovery does not wait for the server hold');
  }
  // A completed restart refusal uses the same recovery loop, retaining its cursor.
  await nativeFetch('/test-stall?phase=restart',{method:'POST'});
  window.dispatchEvent(new Event('online'));
  await until(()=>status.textContent==='Reconnecting…');
  await post();await until(()=>!!msgs[seq]);
  assert(session.last===seq && log.children.length===seq+1 && status.textContent==='', '503 restart recovery');
  // Local deletion also aborts an outstanding read rather than leaving a zombie poll.
  await deleteChannel();await until(()=>gone && !poller.running);
  assert(window.testReloads===1,'confirmed deletion requests one reload');
  const stopped=(await state()).reads;
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  document.dispatchEvent(new Event('visibilitychange'));
  await sleep(100);assert((await state()).reads===stopped,'terminal deletion stays stopped');
  assert(location.hash==='#'+KEY,'recovery does not change the key');
  await nativeFetch('/test-result',{method:'POST',body:JSON.stringify({ok:true,ackToDOMms:latencies})});
})().catch(e=>fetch('/test-result',{method:'POST',body:JSON.stringify({ok:false,error:String(e),stack:e.stack})}));
