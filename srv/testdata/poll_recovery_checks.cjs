(async()=>{
  const reset = () => {
    assert(!poller.running); assert.equal(timers.size,0); assert.equal(active,0);
    gone=false;last=-1;unread=0;requests=[];seen=[];document.hidden=false;status.textContent='';
  };
  const stop = async done => {
    requests.at(-1).respond(401); await done;
    assert(!poller.running);  assert.equal(timers.size,0); assert.equal(active,0);
    const n=requests.length;
    event(window,'online');event(window,'pageshow',{persisted:true});event(document,'visibilitychange');
    await drain();assert.equal(requests.length,n,'terminal status does not restart');
    assert.match(status.textContent,/rejected this key/);
  };
  for(const phase of ['headers','body']) for(const nudge of ['visible','pageshow','online']) {
    reset();const done=poll(), first=requests[0];
    await poll();assert.equal(requests.length,1,'duplicate start is ignored');
    if(phase==='body'){first.headers();await drain();assert(first.reading)}
    assert(hasTimer(35000),'deadline covers headers and body');
    document.hidden=true;unread=3;
    event(document,'visibilitychange');event(window,'pageshow',{persisted:false});await drain();
    assert(!first.signal.aborted,'backgrounding and initial pageshow leave read alone');
    if(nudge==='visible'){document.hidden=false;event(document,'visibilitychange');assert.equal(unread,0)}
    if(nudge==='pageshow')event(window,'pageshow',{persisted:true});
    if(nudge==='online')event(window,'online');
    // Several simultaneous lifecycle events still make just one replacement.
    event(window,'online');event(window,'pageshow',{persisted:true});
    assert(first.signal.aborted);await drain();assert.equal(requests.length,2);
    assert(!hasTimer(2000),'intentional abort skips backoff');assert.equal(last,-1);
    document.hidden=true;unread=0;requests[1].respond(200,[0,1]);await drain();
    assert.deepEqual(seen,[0,1]);assert.equal(unread,2);assert.equal(requests.length,3);
    assert.match(requests[2].path,/since=1&/);assert.equal(status.textContent,'');
    requests[2].respond(200,[1,2]);await drain();
    assert.deepEqual(seen,[0,1,2]);assert.equal(unread,3,'duplicate deliveries do not double count');
    await stop(done);
  }
  for(const phase of ['headers','body']) for(const early of [false,true]) {
    reset();const done=poll(), first=requests[0];
    if(phase==='body'){first.headers();await drain()}
    tick(35000);assert(first.signal.aborted);await drain();
    assert.equal(requests.length,1);assert.equal(last,-1);assert(hasTimer(2000));
    assert.equal(status.textContent,'Reconnecting…');
    if(early)event(window,'online');else tick(2000);
    await drain();assert.equal(requests.length,2);assert(!hasTimer(2000));
    requests[1].respond(200,[0]);await drain();assert.deepEqual(seen,[0]);
    await stop(done);
  }
  for(const failure of ['network','http']) {
    reset();const done=poll();
    if(failure==='network')requests[0].fail();else requests[0].headers(503);
    await drain();assert(hasTimer(2000));assert.equal(active,0,'failed bodies are released');
    event(window,'pageshow',{persisted:true});await drain();
    assert.equal(requests.length,2);assert(!hasTimer(2000));await stop(done);
  }
  // A restart racing a completed response must not advance the cursor from an aborted read.
  reset();let done=poll();requests[0].respond(200,[0]);event(window,'online');await drain();
  assert.equal(last,-1);assert.match(requests[1].path,/since=-1&/);
  requests[1].respond(200,[0]);await drain();assert.deepEqual(seen,[0]);await stop(done);
  // Rendering owns cursor advancement; lifecycle events cannot race another fold/read.
  reset();holdRender=deferred();done=poll();requests[0].respond(200,[0]);await drain();
  assert.equal(timers.size,0);
  event(window,'online');event(window,'pageshow',{persisted:true});await poll();await drain();
  assert.equal(requests.length,1);assert.equal(last,-1);
  holdRender.resolve();holdRender=null;await drain();
  assert.equal(last,0);assert.match(requests[1].path,/since=0&/);await stop(done);
  for(const phase of ['headers','body','retry']) {
    reset();done=poll();const first=requests[0];
    if(phase==='body'){first.headers();await drain()}
    if(phase==='retry'){first.fail();await drain();assert(hasTimer(2000))}
    channelGone();await done;assert(first.signal.aborted);assert.equal(timers.size,0);assert.equal(active,0);
    await poll();event(window,'online');event(document,'visibilitychange');await drain();
    assert.equal(requests.length,1,'deletion stops requests and retry timers');
  }
  reset();done=poll();requests[0].respond(404);await done;
  assert(gone);assert.equal(active,0);assert.equal(timers.size,0);
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
