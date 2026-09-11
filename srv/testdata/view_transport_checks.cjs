(async () => {
  await selfCheck();
  session.setName(config.name); nameInput.hidden = true; // Transport coverage; naming is tested separately.
  KS = await derive(unb64u(config.key));
  const read = async since => (await nativeFetch(config.url+'/events?since='+since, {headers:hdr()})).json();
  const first = await read(-1);
  assert.deepEqual(Object.keys(first).sort(), ['events', 'last', 'more']);
  assert.deepEqual(Object.keys(hdr()), ['Authorization']);
  assert.notEqual(hdr().Authorization, 'Bearer ' + config.key); // the bearer is derived, never K
  // Expiry is the server's configured retention applied to real activity,
  // shown as a countdown with the absolute deadline in the tooltip.
  assert.equal(RETENTION_MS, Number(config.retentionMS));
  assert.equal(expires, Date.parse(config.expires));
  assert(expires-Date.now() < 2*3600e3 && expires > Date.now());
  assert.match(exp.textContent, /^(1 hour, \d+ minutes?|59 minutes)$/, exp.textContent);
  assert.equal(exp.title, new Date(expires).toLocaleString());
  assert.equal(remaining(0), 'less than a minute');
  assert.equal(remaining(60e3), '1 minute');
  assert.equal(remaining(23*3600e3+22*60e3+59e3), '23 hours, 22 minutes');
  assert.equal(remaining(49*3600e3), '2 days, 1 hour');
  await render(first.events);
  const deliverRow = async (text, from) => {
    const seq = session.last+1;
    await render([{seq, ts:'2026-01-01T00:00:00Z', src:'198.51.100.7', ...await seal(KS, seq, {from, text})}]);
    return seq;
  };
  // Names are a grammar, not a byte budget: the relay only sees ciphertext.
  for (const name of ['two\nlines', ' leading', 'trailing ', '', 'bad\x7fname']) assert.equal(validFrom(name), false, name);
  for (const name of ['x'.repeat(513), 'é'.repeat(512), 'é', '🐋 x']) assert(validFrom(name), name);
  assert(validString('🐦') && validString('�') && !validString('\ud800') && !validString('\udc00'));
  assert(!validFrom('bad\ud800') && validFrom('bird 🐦'));
  const badUTF8 = new Uint8Array(256).fill(0x20), raw = te.encode('{"from":"x","text":"x"}');
  raw[raw.length-3] = 255; badUTF8.set(raw);
  const badNonce = crypto.getRandomValues(new Uint8Array(12));
  const badCT = await crypto.subtle.encrypt({name:'AES-GCM',iv:badNonce,additionalData:te.encode(KS.id+':99')},KS.enc,badUTF8);
  assert.deepEqual(await open(KS,{seq:99,nonce:b64u(badNonce),ct:b64u(badCT)}),{});
  await assert.rejects(append({from:identity.name,text:'\ud800'}),/UTF-8/);
  assert.equal(expires, Date.parse(config.expires));
  assert.equal(session.last, 0);
  assert.equal(msgs[0].text, 'fixture');
  // The source shown is the address the server observed, labelled as what it
  // is: server-supplied evidence, not proof of who wrote the message.
  assert.equal(first.events[0].src, config.src);
  const srcHTML = rows[0].innerHTML;
  assert(srcHTML.includes('>'+config.src+'</code>'), srcHTML);
  const srcTitle = /class="src" title="([^"]*)"/.exec(srcHTML)[1];
  assert.match(srcTitle, /source address the server saw/);
  assert(srcTitle.includes(config.src), srcTitle);
  assert.match(srcTitle, /not proof of who wrote/);
  assert.doesNotMatch(srcTitle, /fingerprint/i);

  // A second participant with the same key, sealing outside this page.
  const foreignPost = async (seq, obj) => {
    const blob = await seal(KS, seq, obj);
    const resp = await nativeFetch(config.url+'/events?last='+(seq-1), {method:'POST', headers:hdr(), body:JSON.stringify(blob)});
    assert.equal(resp.status, 200, await resp.text());
  };
  let conflictKind = null, extraReply = false;
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt = async (...args) => {
    if (conflictKind){
      const kind = conflictKind; conflictKind = null;
      const prev = session.last;
      await foreignPost(prev+1, {from:'Peer', text:{message:'peer message',title:'/title peer title',react:'/react 0 B',unreact:'/unreact 0 B'}[kind]});
      const page = await read(prev);
      const m = await open(KS, page.events[0]);
      assert.equal(command(m.text)?.kind || 'message', kind); assert.equal(m.from, 'Peer');
      await render(page.events); // the cursor moves while encryption is pending
      assert.equal(session.last, prev+1);
    }
    return encrypt(...args);
  };
  const attempts = [];
  globalThis.fetch = async (path, opts) => {
    const requestURL = new URL(path, config.host);
    // The key lives in the fragment only: never in a path, query, or body.
    assert(!requestURL.href.includes(config.key), requestURL.href);
    assert(!(opts?.body || '').includes(config.key));
    assert(!requestURL.searchParams.has('from'));
    const resp = await nativeFetch(requestURL, opts);
    if (opts?.method === 'POST' && path.startsWith(EVENTS)) {
      attempts.push({last:Number(requestURL.searchParams.get('last')), blob:JSON.parse(opts.body), status:resp.status});
      if (resp.ok && extraReply){
        extraReply = false;
        const j = await resp.json();
        await foreignPost(j.id+1, {from:'Peer', text:'peer reply'});
        // A successful post can return later events, but not the posted event.
        return new Response(JSON.stringify({...j, ...await read(j.id)}), {status:200});
      }
    }
    return resp;
  };
  for (const kind of ['message', 'react', 'unreact', 'title']) {
    const obj = {from:identity.name, text:{message:'browser message héllo 👋',react:'/react 0 B',unreact:'/unreact 0 B',title:'/title browser title héllo 👋'}[kind]};
    const prev = session.last, start = attempts.length;
    conflictKind = kind;
    extraReply = kind === 'message';
    await append(obj);
    const [a,b] = attempts.slice(start);
    assert.equal(attempts.length-start, 2);
    assert.deepEqual([a.last, a.status, b.last, b.status], [prev,409,prev+1,200]);
    assert.notEqual(a.blob.nonce, b.blob.nonce);
    assert.notEqual(a.blob.ct, b.blob.ct);
    for (const attempt of [a,b]) {
      assert.deepEqual(await open(KS, {...attempt.blob, seq:attempt.last+1}), obj);
      assert.equal(await open(KS, {...attempt.blob, seq:attempt.last+2}), null);
    }
    assert.equal(session.last, prev+1); // successful response must not skip our own event
    await render((await read(session.last)).events);
    if (kind === 'message') assert.equal(msgs[prev+2].text, obj.text);
    if (kind === 'title') assert.equal(title, obj.text.slice(7));
  }

  // The shipped Python client and this page are the same protocol: each
  // reads what the other wrote, including the view's command messages.
  {
    const run = (stdin, ...args) => require('node:child_process').execFileSync('python3',
      [config.client, config.url+'#'+config.key, ...args], {encoding:'utf8', input:stdin});
    const python = JSON.parse(run('', 'read', '--last', '-1'));
    assert.equal(python.last, session.last);
    assert(python.messages.every(m => m.text !== '(undecryptable message)' && m.text !== '(invalid message)'));
    assert(python.messages.every(m => 'id' in m && 'ts' in m && 'src' in m && 'from' in m && 'text' in m));
    for (const kind of ['message', 'react', 'unreact', 'title'])
      assert(python.messages.some(m => m.from === identity.name && (command(m.text)?.kind || 'message') === kind), kind);
    // Long names survive the encrypted round trip.
    const longName = 'é'.repeat(512);
    run('Python to browser 👋', 'post', '--from', longName, '--last', String(session.last));
    const page = await read(session.last);
    const inner = await open(KS, page.events[0]);
    assert.equal(inner.text, 'Python to browser 👋');
    assert.equal(inner.from, longName);
    assert(validFrom(inner.from));
    await render(page.events);
    assert.equal(rows[session.last].innerHTML.includes('<b title="'+longName+'">'+longName+'</b>'), true);
  }
  // Channel creation is a native anchor, never a background action here.
  assert.equal(nodes.get('newbtn')?.listeners.click, undefined);
  assert.equal(newURL, undefined);

  // Reject ordinary invalid input before sealing or attempting a write.
  const attemptCount = attempts.length;
  for (const from of ['', ' leading', 'trailing ', 'two\nlines', 'bad\x7fname']) {
    assert.equal(validFrom(from), false, from);
    await assert.rejects(append({from, text:'not posted'}), /Name/);
  }
  for (const from of ['x'.repeat(512), 'é'.repeat(512), 'x'.repeat(513)]) assert(validFrom(from), from);
  for (const text of [' ', '', '\n\t']) await assert.rejects(append({from:identity.name, text}), /Message/);
  for (const reaction of ['', 'a b', 'a\x7f', 'a\u0085']) {
    assert.equal(validReaction(reaction), false, reaction);
    await assert.rejects(react(0, reaction, false), /Reaction/);
  }
  for (const r of ['B','LOL','approved','👨‍👩‍👧‍👦','🇺🇸','👍🏽','x'.repeat(10000),'\u200d','\ufffd']) assert(validReaction(r),r);
  assert.equal(attempts.length, attemptCount);
  // Plaintext size is bounded by the relay's ciphertext budget.
  const big = 'long '.repeat(20000);
  await append({from:identity.name, text:big});
  await render((await read(session.last)).events);
  assert.equal(msgs[session.last].text, big);

  // Consecutive rows by one sender group visually but still name the sender.
  {
    const a = await deliverRow('first of two', 'Pair'), b = await deliverRow('second of two', 'Pair');
    assert(!rows[a].className.includes('cont') && rows[b].className.includes('cont'));
    for (const id of [a, b]) assert(rows[id].innerHTML.includes('<b title="Pair">Pair</b>'), rows[id].innerHTML);
  }
  // An exact introduction by its own sender reads as prose; anything else stays literal.
  {
    const nice = await deliverRow('/join Alice', 'Alice');
    assert.equal(rows[nice].querySelector('.txt').className, 'txt join');
    assert.equal(rows[nice].querySelector('.txt').textContent, 'Alice joined the channel');
    assert.equal(msgs[nice].text, '/join Alice'); // the raw message is what agents and pickers see
    for (const [text, from] of [['/join Alice', 'Agent'], ['/join  Alice', 'Alice'], ['/join', 'Alice'], ['/join Alice now', 'Alice'], ['say /join Alice', 'Alice'], ['/Join Alice', 'Alice']]) {
      const seq = await deliverRow(text, from);
      assert.notEqual(rows[seq].querySelector('.txt').className, 'txt join', text);
      assert.equal(rows[seq].querySelector('.txt').textContent, text);
    }
    assert.equal(joinOf(' /join Alice ', 'Alice'), 'Alice');
    assert.equal(joinOf('/join Alice', 'alice'), null);
  }

  // Overlapping poll/conflict deliveries must finish folding in arrival order.
  const realOpen = open;
  for (const kind of ['message','title']){
    const prev = session.last;
    const evs = [];
    for (let i=1;i<=2;i++) evs.push({seq:prev+i, ts:'2026-01-01T00:00:00Z', src:'198.51.100.7',
      ...await seal(KS, prev+i, {from:identity.name, text:(kind === 'title' ? '/title ' : '') + (i === 1 ? 'older' : 'newer')})});
    let release, entered;
    const gate = new Promise(r => release=r), started = new Promise(r => entered=r), calls=[];
    open = async (ks, ev) => {calls.push(ev.seq); if (ev.seq === prev+1){entered(); await gate} return realOpen(ks,ev)};
    const older = render([evs[0]]);
    await started;
    const newer = render([evs[1]]);
    await new Promise(r=>setImmediate(r));
    assert.deepEqual(calls, [prev+1]);
    assert.equal(session.last, prev);
    release();
    await Promise.all([older,newer]);
    assert.equal(session.last, prev+2);
    if (kind === 'title') assert.equal(title, 'newer');
    else assert.deepEqual(log.children.slice(-2).map(e=>e.id), ['m'+(prev+1),'m'+(prev+2)]);
    const count = log.children.length;
    await render(evs);
    assert.equal(log.children.length, count); // duplicate conflict/poll page
    open = realOpen;
  }
  const remoteTitle = async text => render([{seq:session.last+1, ts:'2026-01-01T00:00:00Z', src:'198.51.100.7',
    ...await seal(KS, session.last+1, {from:'Remote', text:text ? '/title '+text : '/title'})}]);
  const liveAppend = append, submitted = [];
  let releaseTitle;
  append = async obj => {submitted.push(obj); await new Promise(r => releaseTitle=r)};
  const startTitle = title;
  titleEl.focus();
  await remoteTitle('while focused');
  assert.equal(titleEl.textContent, startTitle);
  await titleEl.blur();
  assert.equal(titleEl.textContent, 'while focused');
  assert.equal(submitted.length, 0);
  titleEl.focus(); titleEl.textContent = 'cancel this';
  await remoteTitle('before escape');
  await titleEl.fire('keydown', {key:'Escape'});
  assert.equal(titleEl.textContent, 'before escape');
  assert.equal(submitted.length, 0);
  titleEl.focus(); titleEl.textContent = 'real draft';
  await remoteTitle('while drafting');
  assert.equal(titleEl.textContent, 'real draft');
  const pendingTitle = titleEl.blur();
  assert.equal(submitted[0].text, '/title real draft');
  await remoteTitle('real draft');
  await remoteTitle('newer than our save');
  releaseTitle(); await pendingTitle;
  assert.equal(titleEl.textContent, 'newer than our save');
  assert.equal(title, 'newer than our save');
  titleEl.focus(); titleEl.textContent = 'first edit';
  const firstEdit = titleEl.blur();
  titleEl.focus(); titleEl.textContent = 'second draft';
  await remoteTitle('first edit');
  releaseTitle(); await firstEdit;
  assert.equal(titleEl.textContent, 'second draft');
  await titleEl.fire('keydown', {key:'Escape'});
  assert.equal(titleEl.textContent, 'first edit');
  append = liveAppend;
  titleEl.focus(); titleEl.textContent = 'two\nlines';
  await titleEl.blur();
  assert.equal(titleEl.textContent, 'two\nlines');
  assert.match(status.textContent, /Could not rename: Title/);
  await remoteTitle('remote after invalid');
  assert.equal(titleEl.textContent, 'two\nlines');
  titleEl.focus(); await titleEl.fire('keydown', {key:'Escape'});
  assert.equal(titleEl.textContent, 'remote after invalid');

  // Refocusing an in-flight save without editing does not post it twice.
  let finishTitle; const pendingSaves=[];
  append=async obj=>{pendingSaves.push(obj);await new Promise(r=>finishTitle=r)};
  titleEl.focus();titleEl.textContent='pending';const save=titleEl.blur();
  titleEl.focus();await titleEl.blur();assert.equal(pendingSaves.length,1);
  finishTitle();await save;append=liveAppend;
  // A failed title draft survives incoming titles, but unchanged blur cancels it.
  append=async()=>{throw new Error('rename offline')};titleEl.focus();titleEl.textContent='failed draft';await titleEl.blur();
  await remoteTitle('received after failure');assert.equal(titleEl.textContent,'failed draft');
  titleEl.focus();await titleEl.blur();assert.equal(titleEl.textContent,'received after failure');append=liveAppend;
  // A title-only page must not erase a hidden tab's existing unread badge.
  document.hidden=true;unread=2;await remoteTitle('badge preserved');assert.equal(document.title,'(2) badge preserved · Mayfly Chat');
  document.hidden=false;unread=0;

  // Neither old history, duplicate delivery nor an empty poll grants more time.
  const deadline = expires, datetime = exp.dateTime;
  await render([]);
  await render([{seq:session.last, ts:new Date(deadline+86400e3).toISOString()}]);
  await remoteTitle('old timestamp');
  assert.equal(expires, deadline); assert.equal(exp.dateTime, datetime);
  const activity = deadline + 3600e3;
  await render([{seq:session.last+1, ts:new Date(activity).toISOString(), src:'198.51.100.7',
    ...await seal(KS, session.last+1, {from:identity.name, text:'link #1 https://example.test/#1'})}]);
  assert.equal(expires, activity+RETENTION_MS);
  assert.equal(Date.parse(exp.dateTime), expires);
  assert.equal(log.children.at(-1).querySelector('.txt').textContent, 'link #1 https://example.test/#1');
  const target = document.getElementById('m1');
  let prevented = false;
  await log.fire('click', {target:{closest:sel => sel === 'a[data-target]' ? {dataset:{target:'m1'}} : null}, preventDefault(){prevented=true}});
  assert(prevented); assert(target.scrolled); assert.equal(location.hash, '#'+config.key);

  for (const [text, to, body] of [
    ['/re 0 hi', 0, 'hi'], ['/re 9007199254740991 hi', Number.MAX_SAFE_INTEGER, 'hi'],
    [' \n/re 12 hello\nworld \n', 12, 'hello\nworld'], ['/re 0  hi', 0, ' hi'],
    ['/re 0 \n  hi\nthere', 0, '\n  hi\nthere']
  ]) assert.deepEqual(command(text), {kind:'reply', to, text:body});
  for (const text of ['/re 0', '/re 0 ', '/re 0 \n\t', '/re 00 hi', '/re -1 hi', '/re 1.5 hi',
    '/re 9007199254740992 hi', '/Re 0 hi', '/re\t0 hi', '/re  0 hi', '/re 0\nhi',
    'say /re 0 hi', 're #0: hi', String.fromCharCode(96).repeat(3)+'\n/re 0 hi\n'+String.fromCharCode(96).repeat(3)]) {
    assert.equal(command(text), null, JSON.stringify(text));
  }

  // Whole-message grammar: malformed commands never disappear or match prefixes.
  const literal = ['prose /title No', String.fromCharCode(96).repeat(3)+'\n/title No\n'+String.fromCharCode(96).repeat(3), '/Title No', '/title  No', '/title\tNo',
    '/title a\nb', '/title a\u2028b', '/title a\x7fb', '/react 00 B', '/react +1 B', '/react -1 B',
    '/react 9007199254740992 B', '/react 0 B extra', '/react  0 B', '/react 0  B', '/react 0 B\nrest',
    '/react 0 B\u0085x', '/react 0 B\u0000x', '/unreact 0', '/what 0 B'];
  for (const raw of literal) assert.equal(command(raw), null, raw);
  assert.deepEqual(command(' \n/title Topic\t '), {kind:'title',text:'Topic'});
  assert.deepEqual(command(' \n/title\t '), {kind:'title',text:''});
  assert.equal(command('/title '+ 'x'.repeat(10000)).text.length,10000);
  const deliver = async (text, from='Remote') => {
    const seq=session.last+1; await render([{seq,ts:'2026-01-01T00:00:00Z',src:'198.51.100.7',...await seal(KS,seq,{from,text})}]); return seq;
  };
  for (const raw of literal) { const seq=await deliver(raw); assert.equal(msgs[seq].text,raw); }
  const hiddenTitle=await deliver('/title Title'); assert.equal(msgs[hiddenTitle],undefined);
  const missing=await deliver('/react '+(session.last+100)+' B'); assert(msgs[missing]);
  const titleTarget=await deliver('/react '+hiddenTitle+' B'); assert(msgs[titleTarget]);
  const targetID=await deliver('Target');
  const tokens=['approved','👨‍👩‍👧‍👦','🇺🇸','👍🏽','x'.repeat(3000)+'a','x'.repeat(3000)+'b','__proto__'];
  for (const token of tokens) {
    await deliver('/react '+targetID+' '+token);
    await deliver('/react '+targetID+' '+token);
    assert.equal(reacts[targetID].get(token).size,1);
    await deliver('/react '+targetID+' '+token,'Other');
    assert.equal(reacts[targetID].get(token).size,2);
    await deliver('/unreact '+targetID+' '+token);
    assert.deepEqual([...reacts[targetID].get(token)],['Other']);
  }
  assert.equal(reacts[targetID].size,tokens.length);
  const reactEl=element(); rows[targetID].querySelector=()=>reactEl; renderReacts(targetID);
  assert(reactEl.innerHTML.includes('data-r="'+tokens[4]+'"')); assert(reactEl.innerHTML.includes('chip-label'));
  assert(reactEl.innerHTML.includes('aria-label="'+tokens[5]+' (1)"'));
  assert(reactEl.innerHTML.includes('title="'+tokens[5]+' · Other"'));
  await deliver('/title'); assert.equal(title,''); assert.equal(document.title,'untitled · Mayfly Chat'); assert.equal(titleEl.textContent,'');
  // Empty titles can be submitted by the human title control too.
  append=async obj=>submitted.push(obj); await remoteTitle('to clear'); titleEl.focus(); titleEl.textContent=''; await titleEl.blur();
  assert.equal(submitted.at(-1).text,'/title'); append=liveAppend;
  // Presentation clamps do not shorten a long title or its edit value.
  const longTitle='T'.repeat(64*1024-7);
  await remoteTitle(longTitle);
  assert.equal(title,longTitle);assert.equal(titleEl.textContent,longTitle);
  assert.equal(document.title,longTitle+' · Mayfly Chat');
  titleEl.focus();assert.equal(titleEl.textContent,longTitle);await titleEl.blur();
  assert.equal(titleEl.textContent,longTitle);
  // Bad inner envelopes cannot throw after moving the cursor and lose the rest of a page.
  const malformed=[7,[],{},{from:7,text:'bad'},{from:'x',text:[]},{from:'bad\nname',text:'bad'},{from:'bad\ud800',text:'bad'},{from:'x',text:'bad\udc00'}];
  const badEvents=[]; let seq=session.last;
  for (const obj of malformed) {seq++;badEvents.push({seq,ts:'2026-01-01T00:00:00Z',src:'198.51.100.7',...await seal(KS,seq,obj)});}
  const nullSeq=++seq; badEvents.push({seq,ts:'2026-01-01T00:00:00Z',src:'198.51.100.7',...await seal(KS,seq,null)});
  // One event nobody holding this key can open, at its own position.
  seq++;
  const strangerKeys = await derive(crypto.getRandomValues(new Uint8Array(32)));
  const stranger = await seal({...strangerKeys, id:KS.id}, seq, {from:'Stranger',text:'sealed elsewhere'});
  const strangerSeq = seq;
  badEvents.push({seq,ts:'2026-01-01T00:00:00Z',src:'198.51.100.7',...stranger});
  seq++;badEvents.push({seq,ts:'2026-01-01T00:00:00Z',src:'198.51.100.7',...await seal(KS,seq,{from:'Remote',text:'after malformed'})});
  const oldRows=log.children.length; await render(badEvents);
  assert.equal(session.last,seq); assert.equal(log.children.length-oldRows,badEvents.length); assert.equal(msgs[seq].text,'after malformed');
  for (let i=0;i<malformed.length;i++) assert.equal(msgs[strangerSeq-malformed.length-1+i].text,'(invalid message)',JSON.stringify(malformed[i]));
  assert.equal(msgs[nullSeq].text,'(invalid message)');
  assert.equal(msgs[strangerSeq].text,'(undecryptable message)');
  // Long names/tokens retain their full values; only their presentation is bounded.
  const longName='N'.repeat(1024), namedID=await deliver('long-name row',longName);
  assert(rows[namedID].innerHTML.includes('<b title="'+longName+'">'+longName+'</b>'));
  window.innerWidth=375; window.innerHeight=667; window.scrollX=20; window.scrollY=100;
  picker.offsetWidth=310; picker.offsetHeight=120;
  const anchor={getBoundingClientRect(){return {left:365,bottom:660}}};
  await openPicker(targetID,anchor);
  const bounded=()=>{
    const x=parseFloat(picker.style.left)-window.scrollX,y=parseFloat(picker.style.top)-window.scrollY;
    assert(x>=8 && x+picker.offsetWidth<=window.innerWidth-8);
    assert(y>=8 && y+picker.offsetHeight<=window.innerHeight-8);
  };
  bounded();
  assert.equal(DEFAULTS.length, 8); assert(!DEFAULTS.includes('❌'));
  assert.equal(suggestions(targetID).length, 8);
  assert.equal(suggestions(namedID).length, 8); // defaults fill to eight, never nine
  assert(sugg.innerHTML.includes('data-r="'+tokens[4]+'"'));
  assert(sugg.innerHTML.includes('aria-label="React with '+tokens[4]+'"'));
  assert(sugg.innerHTML.includes('title="'+tokens[4]+'"'));
  assert(sugg.innerHTML.includes('<span class="pick-label">'+tokens[4]+'</span>'));
  pickin.value=tokens[5];picker.offsetHeight=300;await pickin.fire('input');bounded();
  assert(found.innerHTML.includes('data-r="'+tokens[5]+'"'));
  assert(found.innerHTML.includes('aria-label="React with '+tokens[5]+'"'));
  assert(found.innerHTML.includes('title="React with exactly this: '+tokens[5]+'"'));
  assert(found.innerHTML.includes('<span class="pick-label">'+tokens[5]+'</span>'));
  window.innerHeight=450;window.listeners.resize();bounded();
  anchor.getBoundingClientRect=()=>({left:-50,bottom:-20});placePicker();bounded();
  assert.equal(parseFloat(picker.style.left)-window.scrollX,8);
  assert.equal(parseFloat(picker.style.top)-window.scrollY,8);
  append=async obj=>submitted.push(obj);await pick(tokens[5]);
  assert.equal(submitted.at(-1).text,'/react '+targetID+' '+tokens[5]);
  append=liveAppend;
  // Generic send catches failures and preserves drafts; repeated Ctrl-Enter cannot double-send.
  const ta=document.getElementById('text'), btn=document.getElementById('sendbtn');
  // Reply clicks prefix the whole draft, not the selection; retarget only a valid leading prefix.
  for (const [draft, body] of [
    ['', ''], ['hello', 'hello'], [' \n  first\nsecond  \n', ' \n  first\nsecond  \n'],
    ['/re 0 draft', 'draft'], ['/re 0 ', ''], ['/re 0  \n draft  ', ' \n draft  '],
    ['/re 9007199254740991 hi', 'hi'], ['/re 01 hi', '/re 01 hi'],
    ['/re 9007199254740992 hi', '/re 9007199254740992 hi'], ['/re 0', '/re 0'],
    ['/re\t0 hi', '/re\t0 hi'], [' /re 0 hi', ' /re 0 hi'], ['re #0: hi', 're #0: hi']
  ]) {
    ta.value = draft; ta.setSelectionRange(1, Math.max(1, draft.length-1));
    await log.fire('click', {target:{closest:sel => sel === '.reply' ? {dataset:{id:'3'}} : null}});
    assert.equal(ta.value, '/re 3 '+body);
    assert.equal(document.activeElement, ta);
    assert.equal(ta.selectionStart, ta.value.length); assert.equal(ta.selectionEnd, ta.value.length);
    insertReply(0); insertReply(0);
    assert.equal(ta.value, '/re 0 '+body);
    assert.equal(ta.selectionStart, ta.value.length); assert.equal(ta.selectionEnd, ta.value.length);
  }
  let unblock,sendCalls=0; append=async()=>{sendCalls++;await new Promise(r=>unblock=r);throw new Error('network down')};
  ta.value='draft';const pending=send({preventDefault(){}});await send({preventDefault(){}});
  assert.equal(sendCalls,1);unblock();await pending;assert.equal(ta.value,'draft');assert.equal(btn.disabled,false);assert.match(status.textContent,/network down/);
  append=liveAppend;
})().then(() => process.exit(0), err => {console.error(err); process.exit(1)});
