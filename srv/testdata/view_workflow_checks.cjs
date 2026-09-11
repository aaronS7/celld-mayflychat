(async()=>{
  let pollDone;
  poll=()=>pollDone=(async()=>{const r=await fetch(EVENTS+'?since=-1',{headers:hdr()});await render((await r.json()).events)})();
  const main=document.getElementById('main'), compose=document.getElementById('compose'), ta=document.getElementById('text');
  compose.hidden=false; nameInput.hidden=true; postingName.hidden=false; nameButton.hidden=false;
  await init(); await pollDone;
  // Reading needs nothing; the composer is ready with the default name.
  assert.equal(identity.name,'human'); assert.equal(identity.locked,false); assert.equal(session.last,-1);
  assert.equal(main.hidden,false); assert.equal(compose.hidden,false);
  assert.equal(titleEl.contentEditable,'plaintext-only'); // title editing has no name gate
  assert.equal(requests.length,1); assert.equal(requests[0].options.method,undefined);
  const full=config.host+'/c/'+config.id+'#'+config.key;
  const command='curl -fsS '+shellQuote(full);
  assert.equal(document.getElementById('agenturl').value,command);
  assert(!command.includes('wrong.example'));
  const quoted="https://example.test/c/x'$(echo unsafe)#key";
  const escaped=require('node:child_process').execFileSync('sh',['-c','printf %s '+shellQuote(quoted)],{encoding:'utf8'});
  assert.equal(escaped,quoted);
  const copyButton=document.getElementById('copybtn');copyButton.textContent='Copy';
  const copying=copyButton.fire('click');
  assert.equal(copied,command);assert.equal(copyButton.textContent,'Copy');assert(copyButton.disabled);
  finishCopy();await copying;assert.equal(copyButton.textContent,'Copied');assert(!copyButton.disabled);
  navigator.clipboard.writeText=async()=>{throw new Error('denied')};await copyButton.fire('click');
  assert.equal(copyButton.textContent,'Copy');assert.match(document.getElementById('copy-status').textContent,/Could not copy/);
  assert.equal(requests.length,1); // Copy is local and does not announce the reader.
  for(const n of [0,16,31,33,64]) await assert.rejects(derive(new Uint8Array(n)),/32-byte/);
  const read=async()=> (await nativeFetch(config.host+EVENTS+'?since=-1',{headers:hdr()})).json();
  const posts=()=>requests.filter(r=>r.options?.method==='POST').length;

  // Renaming: the pencil opens an inline editor; invalid drafts stay put with a reason.
  nameButton.fire('click');
  assert.equal(nameInput.hidden,false);assert.equal(nameInput.value,'human');assert.equal(document.activeElement,nameInput);
  for(const bad of ['two\nlines','bad\x7fname','bad\ud800']) {
    nameInput.value=bad; await nameInput.fire('keydown',{key:'Enter'});
    assert.equal(identity.name,'human'); assert.equal(nameInput.hidden,false); assert.match(nameStatus.textContent,/control characters/);
  }
  nameInput.value='   '; await nameInput.fire('keydown',{key:'Enter'}); // blank keeps the current name
  assert.equal(identity.name,'human'); assert.equal(nameInput.hidden,true); assert.equal(nameStatus.textContent,'');
  nameButton.fire('click'); nameInput.value='Escaped'; await nameInput.fire('keydown',{key:'Escape'});
  assert.equal(identity.name,'human'); assert.equal(nameInput.hidden,true);
  nameButton.fire('click'); nameInput.value='  Jo <b>& " 🐦  '; await nameInput.blur();
  assert.equal(identity.name,'Jo <b>& " 🐦'); assert.equal(postingName.textContent,identity.name); assert.equal(nameInput.hidden,true);
  nameButton.fire('click'); nameInput.value='Alice'; await nameInput.fire('keydown',{key:'Enter'});
  assert.equal(identity.name,'Alice'); assert.equal(document.activeElement,ta);
  assert.equal(posts(),0); // renaming before the first post sends nothing
  assert.equal(document.getElementById('editbtn').hidden,false);

  // A message typed while the name editor is still open commits the draft first.
  nameButton.fire('click'); nameInput.value='Alice2';
  ta.value='hello from the browser'; await send({preventDefault(){}});
  assert.equal(identity.name,'Alice2'); assert.equal(identity.locked,true); assert.equal(ta.value,'');
  assert.equal(nameInput.hidden,true); assert.equal(nameButton.hidden,true); // one chance, now gone
  let page=await read(); assert.equal(page.events.length,1);
  assert.deepEqual(await open(KS,page.events[0]),{from:'Alice2',text:'hello from the browser'});
  await render(page.events);
  assert.equal(rows[0].innerHTML.includes('<b title="Alice2">Alice2</b>'),true);
  // Locked: the control is inert and every later post uses the same name.
  nameButton.fire('click'); assert.equal(nameInput.hidden,true);
  nameInput.value='Sneaky'; await nameInput.fire('keydown',{key:'Enter'}); assert.equal(identity.name,'Alice2');
  ta.value='second'; await send({preventDefault(){}});
  page=await read(); assert.equal(page.events.length,2);
  assert.deepEqual(await open(KS,page.events[1]),{from:'Alice2',text:'second'});
  await render(page.events);
  assert(rows[1].className.includes('cont'));
  assert.equal(rows[1].innerHTML.includes('<b title="Alice2">Alice2</b>'),true); // grouped rows keep their sender

  // Failures keep the draft and the prior name; a pending post disables renaming.
  const liveFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('offline')};
  ta.value='kept draft'; await send({preventDefault(){}});
  assert.equal(ta.value,'kept draft'); assert.match(status.textContent,/offline/); assert.equal(document.getElementById('sendbtn').disabled,false);
  globalThis.fetch=liveFetch;
  ta.value='';
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
