(async()=>{
  let pollDone; const realPoll=poll;
  poll=()=>pollDone=(async()=>{const r=await fetch(EVENTS+'?since=-1',{headers:hdr()});await render((await r.json()).events)})();
  nameInput.hidden=true; postingName.hidden=false; nameButton.hidden=false;
  await init(); await pollDone;
  const read=async()=> (await nativeFetch(config.host+EVENTS+'?since=-1',{headers:hdr()})).json();
  const ta=document.getElementById('text');
  nameButton.fire('click'); nameInput.value='Ada'; await nameInput.fire('keydown',{key:'Enter'});
  assert.equal(identity.name,'Ada'); assert.equal(identity.locked,false);
  if (config.first==='title') {
    // A title edit is a first post: it locks the name and needs no gate.
    titleEl.focus(); titleEl.textContent='First title'; await titleEl.blur();
    assert.equal(identity.locked,true); assert.equal(nameButton.hidden,true);
    const page=await read(); assert.equal(page.events.length,1);
    assert.deepEqual(await open(KS,page.events[0]),{from:'Ada',text:'/title First title'});
    await render(page.events); assert.equal(title,'First title'); assert.equal(titleEl.textContent,'First title');
    // Clearing works too, and the heading is empty rather than a placeholder string.
    titleEl.focus(); titleEl.textContent=''; await titleEl.blur();
    await render((await read()).events.slice(1)); assert.equal(title,''); assert.equal(titleEl.textContent,'');
  } else if (config.first==='reaction') {
    // Reactions target rows, so a peer message arrives first; the reaction is our first post.
    const peer=await seal(KS,0,{from:'Peer',text:'react to me'});
    assert((await nativeFetch(config.host+EVENTS+'?last=-1',{method:'POST',headers:hdr(),body:JSON.stringify(peer)})).ok);
    await render((await read()).events);
    // The name may still change until the reaction succeeds.
    nameButton.fire('click'); nameInput.value='Ada Lovelace'; await nameInput.fire('keydown',{key:'Enter'});
    await react(0,'👍',false);
    assert.equal(identity.locked,true);
    const page=await read(); assert.equal(page.events.length,2);
    assert.deepEqual(await open(KS,page.events[1]),{from:'Ada Lovelace',text:'/react 0 👍'});
    await render(page.events);
    assert(reacts[0].get('👍').has('Ada Lovelace'));
    // Locked chips still toggle for the locked name only.
    nameButton.fire('click'); assert.equal(nameInput.hidden,true);
  } else if (config.first==='failed-then-message') {
    // A failed first post keeps the rename chance and the draft; a rename in
    // flight is refused; the first success locks whatever name it carried.
    const liveFetch=globalThis.fetch; let release;
    globalThis.fetch=async(path,options)=>{ if(options?.method==='POST'){ await new Promise(r=>release=r); throw new Error('offline'); } return liveFetch(path,options); };
    ta.value='first attempt'; const sending=send({preventDefault(){}});
    while(!release) await new Promise(r=>setImmediate(r));
    assert.equal(nameButton.disabled,true); nameButton.fire('click'); assert.equal(nameInput.hidden,true); // pending: no rename
    release(); await sending;
    assert.equal(ta.value,'first attempt'); assert.match(status.textContent,/offline/);
    assert.equal(identity.locked,false); assert.equal(nameButton.disabled,false);
    globalThis.fetch=liveFetch;
    nameButton.fire('click'); assert.equal(nameInput.hidden,false); nameInput.value='Grace'; await nameInput.fire('keydown',{key:'Enter'});
    assert.equal(identity.name,'Grace');
    // A conflict on the way is absorbed by CAS and still ends in one locked name.
    const peer=await seal(KS,0,{from:'Peer',text:'sneaks in'});
    assert((await nativeFetch(config.host+EVENTS+'?last=-1',{method:'POST',headers:hdr(),body:JSON.stringify(peer)})).ok);
    await send({preventDefault(){}});
    assert.equal(identity.locked,true); assert.equal(ta.value,'');
    const page=await read(); assert.equal(page.events.length,2);
    assert.deepEqual(await open(KS,page.events[1]),{from:'Grace',text:'first attempt'});
    assert.equal(requests.filter(r=>r.options?.method==='POST').length,2); // 409 then success; the failure never reached the server
  } else if (config.first.startsWith('lost-')) {
    const [,kind,delivery]=config.first.split('-');
    if (kind==='reaction') {
      // Peer fixtures bypass append: it is exclusively the page's UI post path.
      const blob=await seal(KS,0,{from:'Ada',text:'same-name peer'});
      assert((await nativeFetch(config.host+EVENTS+'?last=-1',{method:'POST',headers:hdr(),body:JSON.stringify(blob)})).ok);
      await render((await read()).events); assert.equal(identity.locked,false);
    }
    const seq=session.last+1, liveFetch=globalThis.fetch;
    let posts=0;
    globalThis.fetch=async(path,options)=>{
      const response=await liveFetch(path,options);
      if (options?.method!=='POST' || ++posts!==1) return response;
      assert.equal(response.status,200); // the actual relay committed before the ack failed
      if (delivery==='inflight') {
        await render((await read()).events);
        assert.equal(identity.locked,true); // evidence was recorded before fetch, not after it threw
      }
      if (delivery==='500') return new Response('{"error":"lost ack"}',{status:500});
      throw new Error('lost ack');
    };
    ta.value='retained message draft';
    if (kind==='title') { titleEl.focus(); titleEl.textContent='Retained title'; await titleEl.blur(); }
    else if (kind==='reaction') await assert.rejects(react(0,'👍',false),/lost ack/);
    else await send({preventDefault(){}});
    assert.equal(ta.value,'retained message draft');
    if (kind==='title') { assert.equal(titleEl.textContent,'Retained title'); assert.equal(titleDraft,true); }
    assert.equal(nameButton.disabled,false);
    const accepted=(await read()).events.find(e=>e.seq===seq);
    assert.equal((await open(KS,accepted)).from,'Ada');
    if (delivery!=='inflight') {
      assert.equal(identity.locked,false);
      nameButton.fire('click'); nameInput.value='Grace'; await nameInput.fire('keydown',{key:'Enter'});
      assert.equal(identity.name,'Grace'); // an edit after unknown acknowledgement must be undone on proof
    }
    globalThis.fetch=liveFetch;
    if (delivery==='409' || delivery==='queue') {
      if (delivery==='queue') {
        let release; const blocked=new Promise(r=>release=r), decrypt=open;
        open=async(...args)=>{await blocked;return decrypt(...args)};
        const rendering=render([accepted]);
        // Delivery locks before decrypting; the submitted object was already captured as Grace.
        const sending=append({from:identity.name,text:'second post'});
        release(); await rendering; await sending; open=decrypt;
      } else {
        ta.value='second post'; await send({preventDefault(){}});
      }
      const page=await read();
      assert.equal(page.events.length,seq+2);
      assert.deepEqual(await open(KS,page.events.at(-1)),{from:'Ada',text:'second post'});
      if (delivery==='409') assert.equal(requests.filter(r=>r.options?.method==='POST').length,3); // accepted, conflict, retry
    } else if (delivery!=='inflight') {
      let polls=0;
      globalThis.fetch=async(path,options)=>++polls===1?liveFetch(path,options):new Response('',{status:401});
      await realPoll(); globalThis.fetch=liveFetch;
    }
    assert.equal(identity.locked,true); assert.equal(identity.name,'Ada'); assert.equal(postingName.textContent,'Ada');
    assert.equal(nameInput.value,'Ada'); assert.equal(nameInput.hidden,true); assert.equal(nameButton.hidden,true);
    assert.equal(identity.attempts.length,0);
    nameButton.fire('click'); assert.equal(nameInput.hidden,true);
    if (kind==='title') { assert.equal(title,'Retained title'); assert.equal(titleDraft,true); }
    if (kind==='reaction') assert(reacts[0].get('👍').has('Ada'));
  } else if (config.first.startsWith('uncommitted-')) {
    const failure=config.first.slice('uncommitted-'.length), liveFetch=globalThis.fetch;
    globalThis.fetch=async()=>{
      if(failure==='transport')throw new Error('offline');
      if(failure==='restarting')return new Response(JSON.stringify({error:'restarting',posted:false}),{status:503});
      return new Response('{}',{status:Number(failure)});
    };
    ta.value='not committed'; await send({preventDefault(){}});
    assert.equal(identity.locked,false); assert.equal(ta.value,'not committed');
    assert.equal(identity.attempts.length,failure==='400'||failure==='restarting'?0:1);
    globalThis.fetch=liveFetch;
    // Same seq, sender AND plaintext still do not establish ownership: only the sealed envelope does.
    const blob=await seal(KS,0,{from:'Ada',text:'not committed'});
    assert((await nativeFetch(config.host+EVENTS+'?last=-1',{method:'POST',headers:hdr(),body:JSON.stringify(blob)})).ok);
    await render((await read()).events);
    assert.equal(identity.locked,false); assert.equal(identity.attempts.length,0); assert.equal(nameButton.hidden,false);
    nameButton.fire('click'); assert.equal(nameInput.hidden,false);
  } else {
    // Deletion: cancel does nothing; confirming deletes; the page reports the
    // real outcome and stops; a poll finding 404 reaches the same state.
    const dialog=document.getElementById('deldialog');
    deleteButton.fire('click'); assert.equal(dialog.shown,1);
    await dialog.close('cancel');
    assert.equal(gone,false); assert.equal(document.activeElement,deleteButton);
    assert.equal(requests.filter(r=>r.options?.method==='DELETE').length,0);
    assert.equal(location.reloads,0);
    // A rejected deletion is visible and leaves the channel intact.
    const liveFetch=globalThis.fetch;
    globalThis.fetch=async(path,options)=>options?.method==='DELETE'?new Response(JSON.stringify({error:'nope'}),{status:500}):liveFetch(path,options);
    deleteButton.fire('click'); await dialog.close('delete'); await new Promise(r=>setTimeout(r,20));
    assert.equal(gone,false); assert.equal(deleteStatus.hidden,false); assert.match(deleteStatus.textContent,/Could not delete: nope/);
    assert.equal(deleteButton.disabled,false); assert.equal(location.reloads,0);
    assert((await nativeFetch(config.host+EVENTS+'?since=-1',{headers:hdr()})).ok);
    globalThis.fetch=liveFetch;
    deleteButton.fire('click'); assert.equal(dialog.shown,3); await dialog.close('delete');
    const deadline=Date.now()+5000; while(!gone && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
    assert.equal(gone,true); assert.equal(deleteStatus.hidden,true);
    assert.equal(deleteButton.disabled,true);
    assert.equal(titleEl.hasAttribute('contenteditable'),false);
    assert.notEqual(document.activeElement,titleEl);
    assert.equal(location.hash,'#'+config.key); // reload retains the channel URL
    assert.equal(location.reloads,1);
    channelGone(); assert.equal(location.reloads,1); // concurrent confirmations reload once
    const del=requests.filter(r=>r.options?.method==='DELETE'); assert.equal(del.length,1);
    assert.equal(del[0].url,config.host+'/c/'+config.id); assert.equal(del[0].options.headers.Authorization,'Bearer '+KS.auth);
    // The server really deleted it: reads and the HTML view are gone.
    assert.equal((await nativeFetch(config.host+EVENTS+'?since=-1',{headers:hdr()})).status,404);
    assert.equal((await nativeFetch(config.host+'/c/'+config.id,{headers:{Accept:'text/html'}})).status,404);
    // A second poll loop iteration seeing 404 stops quietly in the same state.
    gone=false; await realPoll(); assert.equal(gone,true);
    assert.equal(location.reloads,2);
    // DELETE 404 also confirms absence and reloads, without reporting failure.
    gone=false; await deleteChannel();
    assert.equal(gone,true); assert.equal(deleteStatus.hidden,true); assert.equal(location.reloads,3);
    // Posting after deletion fails visibly and keeps the draft.
    ta.value='too late'; await send({preventDefault(){}}); assert.equal(ta.value,'too late'); assert.match(status.textContent,/Could not send/);
  }
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
