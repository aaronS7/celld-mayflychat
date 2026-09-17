(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const stoppedPage = () => {
    assert(gone && !poller.running, 'deletion stops polling');
    assert(!titleEl.hasAttribute('contenteditable') && document.activeElement !== titleEl, 'deletion ends title editing');
  };
  await init({startPolling:()=>{}, onGone:()=>{window.testReloads=(window.testReloads||0)+1}});
  assert(KS && KS.id === CID && !document.getElementById('main').hidden, 'existing crypto initialization');
  // Shared shell: one theme following the system scheme, brand home link,
  // footer, no channel id or instructions on the human page.
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  assert(dark === EXPECT_DARK, 'scheme under test: dark=' + dark);
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  assert(dark ? bodyBg === 'rgb(25, 14, 25)' : bodyBg === 'rgb(246, 234, 217)', 'desert theme background: ' + bodyBg);
  // Check every speaker hue against its actual tinted row in both schemes.
  const probe = document.createElement('div'); probe.className = 'msg'; probe.hidden = true;
  probe.innerHTML = '<div class="hdr"><b>Sender</b></div>'; document.body.appendChild(probe);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const luminance = css => {
    ctx.fillStyle = bodyBg; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
    const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(x => {
      const v = x / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    });
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const hue of hues) {
    probe.style.setProperty('--c', `hsl(${hue} 70% var(--speaker-lightness))`);
    const fg = luminance(getComputedStyle(probe.querySelector('b')).color), bg = luminance(getComputedStyle(probe).backgroundColor);
    assert((Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) >= 4.5, 'readable speaker hue ' + hue);
  }
  probe.remove();
  const brand = document.querySelector('header a.brand');
  assert(brand && brand.getAttribute('href') === '/' && brand.textContent.trim() === 'Mayfly Chat' && brand.querySelector('svg'), 'brand mark links home');
  assert(document.querySelector('footer.site nav a[href="/llms.txt"]')?.textContent === 'llms.txt', 'footer index link labelled llms.txt');
  assert(document.querySelector('footer.site a[href="https://github.com/josharian/mayfly"] svg'), 'GitHub icon on the run-your-own link');
  assert(document.querySelector('footer.site a[href="/docs/about.md"]')?.textContent === 'What is this?', 'explanatory-page link');
  assert(document.querySelectorAll('footer.site a').length === 4 && document.querySelectorAll('footer.site a[href="https://github.com/josharian/mayfly"]').length === 1, 'no redundant source link');
  assert(!document.querySelector('main').textContent.includes(CID) && !document.getElementById('instr'), 'no channel id or agent instructions in the human view');
  assert(document.getElementById('delbtn') && !document.getElementById('delbtn').hidden && !document.getElementById('deldialog').open, 'delete control present and confirmation closed');
  // The page has the key, so the agent command it displays is complete and
  // pasteable, while the URL bar and every request keep the key in the
  // fragment alone.
  const full = location.origin + '/c/' + CID + '#' + KEY;
  const copiedCommand = document.getElementById('agenturl').value;
  assert(copiedCommand === 'curl -fsS ' + shellQuote(full), 'copyable curl command: ' + copiedCommand);
  assert(identity.name === 'human' && !identity.locked && getComputedStyle(document.getElementById('compose')).display !== 'none', 'composer ready with the default name');
  assert(document.getElementById('posting-name').textContent === 'human' && !document.getElementById('namebtn').hidden && document.getElementById('name').hidden, 'posting as human with an edit control');
  assert(titleEl.isContentEditable && !document.getElementById('editbtn').hidden, 'title editable immediately, with a pencil');
  assert(titleEl.textContent === '' && getComputedStyle(titleEl, '::before').content === '"untitled"', 'empty title reads untitled through CSS');
  const empty = await (await fetch(EVENTS+'?since=-1', {headers:hdr()})).json();
  assert(empty.events.length === 0, 'opening a channel does not introduce its reader');
  let finishCopy, copied;
  Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText(text){copied=text;return new Promise(r=>finishCopy=r)}}});
  const copyButton = document.getElementById('copybtn'); copyButton.click();
  assert(copied === copiedCommand && copyButton.textContent === 'Copy' && copyButton.disabled, 'clipboard success is not premature');
  finishCopy(); await new Promise(r=>setTimeout(r,0));
  assert(copyButton.textContent === 'Copied' && !copyButton.disabled, 'clipboard completion');
  navigator.clipboard.writeText = async () => {throw Error('clipboard denied')};
  copyButton.click(); await new Promise(r=>setTimeout(r,0));
  assert(copyButton.textContent === 'Copy' && document.getElementById('copy-status').textContent.includes('Could not copy'), 'clipboard failure visible');
  assert(location.search === '' && !location.pathname.includes(KEY), 'the key is only ever in the fragment');
  // Exercise the actual Chrome argument stack, including ArrayBuffer and views.
  for (const n of [0, 1, 32767, 32768, 32769, 394512, 512*1024]) {
    const bytes = Uint8Array.from({length:n}, (_, i) => i % 256);
    for (const input of [bytes, bytes.buffer, bytes.subarray(1)]) {
      const want = new Uint8Array(input), got = unb64u(b64u(input));
      assert(got.length === want.length && got.every((b, i) => b === want[i]), 'base64 exact bytes '+n);
    }
  }
  const expected = new Map();
  // Every delivery is a real encrypted append over the one transport there is.
  const deliverMarkdown = async (messages, fold = true) => {
    for (const m of messages) {
      const blob = await seal(KS, m.id, {from:m.from, text:m.text});
      const response = await fetch(EVENTS+'?last='+(m.id-1), {method:'POST', headers:hdr(), body:JSON.stringify(blob)});
      assert(response.ok, 'real append: '+response.status);
      expected.set(m.id, {from:m.from, text:m.text});
    }
    const page = await (await fetch(EVENTS+'?since='+session.last, {headers:hdr()})).json();
    assert(Object.keys(page).sort().join(',') === 'events,last,more', 'read response fields');
    return fold ? render(page.events) : page;
  };
  // Resting/editing bounds retain full text, including anonymous hover.
  const longTitle = 'Full "title" <&> ' + 'long title '.repeat(200);
  setTitle(longTitle);
  const titleStyle = getComputedStyle(titleEl), line = parseFloat(titleStyle.lineHeight);
  assert(titleEl.textContent === longTitle && titleStyle.webkitLineClamp === '3', 'full title and three resting lines');
  assert(titleEl.getBoundingClientRect().height <= 3*line+2 && titleEl.scrollHeight > titleEl.clientHeight, 'resting title bounded');
  assert(titleEl.title === longTitle && !titleEl.children.length, 'full plain title tooltip');
  if (READER_ONLY) {
    // A reader who never posts: the page is complete without a name or a post.
    assert(document.documentElement.scrollWidth <= innerWidth, 'reader mobile no overflow');
    const empty2 = await (await fetch(EVENTS+'?since=-1', {headers:hdr()})).json();
    assert(empty2.events.length === 0 && identity.name === 'human' && !identity.locked, 'reading writes nothing and locks nothing');
    return {ok:true, anonymous:true, dark, width:innerWidth};
  }
  // The pencil focuses the title for editing; the heading grows to six lines and scrolls.
  document.getElementById('editbtn').click();
  assert(document.activeElement === titleEl, 'pencil focuses the title');
  assert(titleEl.textContent === longTitle && Math.abs(titleEl.clientHeight-6*line) < 2 && titleEl.scrollHeight > titleEl.clientHeight, 'six editing lines with full scrollable title');
  assert(titleEl.getBoundingClientRect().right <= document.documentElement.clientWidth, 'editing title stays inside the page');
  titleEl.blur(); setTitle('');
  // Rename before the first post through the real DOM control.
  document.getElementById('namebtn').click();
  assert(document.activeElement === nameInput && nameInput.value === 'human', 'pencil opens the name editor');
  nameInput.value = 'Browser';
  nameInput.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  assert(identity.name === 'Browser' && document.getElementById('posting-name').textContent === 'Browser' && nameInput.hidden, 'name committed locally without a post');
  assert((await (await fetch(EVENTS+'?since=-1', {headers:hdr()})).json()).events.length === 0, 'renaming posts nothing');
  const body = text => { const d = document.createElement('div'); d.className = 'txt'; d.appendChild(renderMessageMarkdown(text)); return d; };
  const has = (d, selector, text) => assert(d.querySelector(selector)?.textContent === text, selector + ': ' + d.innerHTML);
  const network = async () => (await fetch('/test-network')).json();
  const fixture = document.createElement('div'); fixture.className = 'msg'; log.appendChild(fixture);
  const format = body('# Heading\n\n**bold** *italic* ~~gone~~\nline two\n\n> quote\n\n- item\n- [x] done\n- [ ] todo\n\n3. third\n\n| A | B |\n| - | - |\n| x | y |\n\n`<i> #1`\n\n```html\n<img src=x> #2\n  whitespace\n```');
  fixture.appendChild(format);
  for (const [tag, text] of [['h1','Heading'],['strong','bold'],['em','italic'],['del','gone'],['th','A']]) has(format, tag, text);
  assert(format.querySelector('br') && format.querySelectorAll('li').length === 4, 'breaks and lists');
  assert(format.textContent.includes('[x] done') && format.textContent.includes('[ ] todo'), 'textual tasks');
  assert(!format.querySelector('input,[class^="language-"]'), 'no task controls or highlighting');
  assert(format.querySelector('ol').getAttribute('start') === '3', 'ordered list start');
  assert(format.querySelector('pre code').textContent === '<img src=x> #2\n  whitespace\n', 'plain fenced code whitespace');
  assert(!format.querySelector('code a'), 'no references in code');
  const refs = body('hi #0 (#12), x#3 &#35;4 `#5` [#6](https://example.test/#7) https://example.test/#8\n\n<span title="#9">literal</span>\n\n![#10](data:x)');
  assert([...refs.querySelectorAll('a[href^="#m"]')].map(a => a.textContent).join(',') === '#0,#12', 'eligible reference boundaries: ' + refs.innerHTML);
  assert(refs.querySelector('a[href="https://example.test/#8"]'), 'bare URL fragment');
  const paired = body(`[![one](http://${location.host}/probe/pair1) ![two](http://${location.host}/probe/pair2)](https://example.test/)`);
  assert([...paired.querySelectorAll('button')].map(b => b.title).join(',') === 'Load image: one,Load image: two', 'linked controls retain image order');
  const html = '<div style="color:red"><img src="/probe/raw"><script>window.pwned=1</script> #1</div>';
  const literal = body(html); has(literal, '.literal-html', html);
  assert(!literal.querySelector('div,img,script,a'), 'literal block HTML');
  const rawInline = body('before <script> &amp; #7 </script> after');
  assert(rawInline.textContent.trimEnd() === 'before <script> &amp; #7 </script> after' && !rawInline.querySelector('a,script'), 'raw inline HTML remains literal: ' + rawInline.innerHTML);
  const attacks = [
    '<img src="/probe/raw" onerror="window.pwned=1">',
    '<svg><a xlink:href="javascript:window.pwned=1">x</a></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=/probe/mxss onerror=window.pwned=1>">',
    '<iframe src="/probe/frame"></iframe><object data="/probe/object"></object><embed src="/probe/embed">',
    '<video poster="/probe/poster"><source src="/probe/source"></video><audio src="/probe/audio">',
    '<style>@import "/probe/css";</style><link rel=preload as=image href="/probe/preload">',
    '<form action="/probe/form"><input autofocus onfocus="window.pwned=1"></form>',
    '<!-- <img src=/probe/comment> -->',
    '<span title="image-0" data-image="0"><button class=load-image>Load image</button></span>',
    '&lt;img src=/probe/entity onerror=window.pwned=1&gt;',
    '<a id=title name=DOMPurify href="javascript:window.pwned=1">clobber</a>',
    '<template><img src=/probe/template></template>',
    '</script><script>window.pwned=1</script>',
    '[x](javascript:alert%281%29)', '[x](jav&#x61;script:alert%281%29)',
    '[x](java&#10;script:alert%281%29)', '[x](data:text/html,x)', '[x](blob:https://example.test/id)',
    '[x](file:///etc/passwd)', '[x](/probe/relative)', '[x](//example.test/x)', '[x](#other)',
    '[x](https://example&#10;.test/x)', '[x](https://example&#x5c;.test/x)',
    '[x](#m1x)', '[x](mailto:a@example.test)', '[x](https:example.test)', '[x](https://)',
    '![x](data:image/svg+xml,x)', '![x](/probe/relative-image)', '![x](//example.test/x)',
    '![x](javascript:alert%281%29)', '![x](https://)',
    '[![x](data:x)](javascript:alert%281%29)'
  ];
  for (const attack of attacks) {
    const d = body(attack); fixture.appendChild(d);
    assert(!d.querySelector('img,svg,math,script,style,iframe,object,embed,link,video,audio,source,form,input,button,template'), 'active tag: ' + attack);
    assert(!d.querySelector('[href],[src],[style],[id],[name],[data-image]'), 'active attribute: ' + attack + ' => ' + d.innerHTML);
  }
  assert(!window.pwned, 'script executed');
  const links = body('[one](https://example.test/?a=1&amp;b=2) [two](HTTP://example.test/x) [local](#m007) [blocked](javascript:x)');
  assert(links.querySelector('a').getAttribute('href') === 'https://example.test/?a=1&b=2', 'decoded href');
  for (const a of links.querySelectorAll('a[href^="http"]')) assert(a.target === '_blank' && a.rel === 'noopener noreferrer' && a.referrerPolicy === 'no-referrer', 'safe external link');
  assert(!links.querySelector('a[href^="#"]').hasAttribute('target'), 'local navigation');
  assert(links.textContent.includes('blocked'), 'blocked link retains label');
  const images = body(`[![first](http://${location.host}/probe/one?a=1&amp;b=2)](https://example.test/navigation) ![second](http://${location.host}/probe/two) ![bad](/probe/bad)`);
  fixture.appendChild(images);
  const buttons = images.querySelectorAll('button');
  assert(buttons.length === 2 && !images.querySelector('img'), 'per-image inert controls');
  assert(!buttons[0].closest('a') && images.querySelector('a').textContent === 'first', 'linked image control outside link');
  await new Promise(r => setTimeout(r, 100));
  assert((await network()).length === 0, 'no resource request before activation');
  const before = location.href;
  const loaded = new Promise((resolve, reject) => {
    images.addEventListener('load', resolve, {capture:true, once:true});
    images.addEventListener('error', () => reject(new Error('probe image failed')), {capture:true, once:true});
  });
  buttons[0].click(); await loaded;
  const requests = await network();
  assert(requests.length === 1 && requests[0].path === '/probe/one?a=1&b=2' && requests[0].referer === '', 'exactly one image, no referrer: ' + JSON.stringify(requests));
  assert(location.href === before && images.querySelectorAll('img').length === 1 && images.querySelectorAll('button').length === 1, 'load does not navigate or load others');
  const repeat = body('![first](http://'+location.host+'/probe/one?a=1&amp;b=2)'); fixture.appendChild(repeat);
  assert(repeat.querySelector('button') && !repeat.querySelector('img'), 'consent does not carry to another instance of the same image');
  assert(localStorage.length === 0 && sessionStorage.length === 0, 'no persisted preferences');
  // Plain labels and single command parse; the reply target is outside the body.
  let calls = 0; const parseCommand = command; command = text => { calls++; return parseCommand(text); };
  const messages = ['**original** ![delivered](http://'+location.host+'/probe/delivered)', '/title **plain title**', '/re 0 **reply**\n/title nested', '/react 2 **yes**', '/re 999 **unavailable**', 're #0: **ordinary prose**'];
  await deliverMarkdown(messages.map((text, id) => ({id, text, from:'<b>name</b>', src:'<i>src</i>', ts:new Date().toISOString()})));
  assert(rows[0].querySelector('.load-image') && !rows[0].querySelector('img'), 'transport-delivered image requires its own consent');
  assert(calls === messages.length && titleEl.textContent === '**plain title**', 'commands once and title plain');
  assert(rows[2].querySelector('.reply-target a').getAttribute('href') === '#m0' && !rows[2].querySelector('.txt .reply-target'), 'app-owned reply link');
  has(rows[2], '.txt strong', 'reply');
  assert(rows[2].querySelector('.txt').textContent.includes('/title nested'), 'nonrecursive reply');
  assert(rows[2].querySelector('.chip-label').textContent === '**yes**', 'reaction plain');
  assert(rows[2].querySelector('.hdr b').textContent === '<b>name</b>' && !rows[2].querySelector('.hdr b b'), 'name plain');
  assert(!rows[4].querySelector('.reply-target') && rows[4].querySelector('strong'), 'unavailable reply ordinary Markdown');
  assert(rows[5].querySelector('.txt a').getAttribute('href') === '#m0' && !rows[5].querySelector('.reply-target'), 'old reply ordinary prose');
  const beforeNav = location.href;
  rows[2].querySelector('.reply-target a').click();
  assert(location.href === beforeNav && rows[0].classList.contains('highlight'), 'reply navigation preserves key');
  rows[5].querySelector('.txt a').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, ctrlKey:true}));
  assert(location.href === beforeNav, 'modified local navigation preserves key');
  for (const a of log.querySelectorAll('.txt a,.reply-target a')) assert(!a.getAttribute('href')?.includes(KEY), 'no key in content anchors');
  // Unsupported sanitizer and exceptions must fall back without losing later rows.
  const purifier = globalThis.DOMPurify;
  for (const replacement of [undefined, () => ({isSupported:false}), () => { throw Error('test'); }]) {
    globalThis.DOMPurify = replacement;
    const d = body('<img src=/probe/fallback> **literal**');
    assert(d.textContent === '<img src=/probe/fallback> **literal**' && !d.querySelector('*'), 'sanitizer fallback');
  }
  globalThis.DOMPurify = purifier;
  const parser = globalThis.marked;
  globalThis.marked = {...parser, Marked: class { parse(){throw Error('test')} }};
  await deliverMarkdown([{id:6, text:'**literal**', from:'x'}, {id:7, text:'next delivery', from:'x'}]);
  assert(rows[6].querySelector('.txt').textContent === '**literal**' && msgs[7], 'parser error delivery continues');
  // Exercise the final sanitizer and its decoded-href hook independently of
  // Marked's escaping; these are boundary tests, not a malicious-parser model.
  globalThis.marked = {...parser, Marked: class { parse(){return '<p id="bad" class="bad" style="color:red" data-x="bad" aria-label="bad" onclick="window.pwned=1"><a href="jav&#x61;script:alert(1)">blocked</a><a href="&#47;probe/relative">relative</a><a href="https://example.test/?a=1&amp;b=2">safe</a><span title="image-0">not a capability</span></p><svg><circle></circle></svg><form><input></form>'; } }};
  const boundary = body('ignored'); fixture.appendChild(boundary);
  assert(!boundary.querySelector('[id],[class],[style],[data-x],[aria-label],[onclick],svg,form,input,button'), 'final allowlist');
  assert(boundary.querySelectorAll('a').length === 1 && boundary.querySelector('a').getAttribute('href') === 'https://example.test/?a=1&b=2', 'final decoded URL hook');
  globalThis.marked = parser;
  const extra = [
    '/re 2 /react 0 not-a-chip', '/react 8 yes', '/re 10 self', '/re 12 future',
    'future target', '/re 1 hidden title', '/re 3 hidden reaction', '/re 0 \n', '/re 8 **reply again**'
  ];
  const count = await deliverMarkdown(extra.map((text, i) => ({id:i+8, text, from:'ReplyAgent'})));
  assert(count === 8 && !msgs[9], 'only reaction hidden; replies ordinary unread rows');
  assert(rows[8].querySelector('.reply-target a').getAttribute('href') === '#m2', 'reply to reply');
  assert(rows[8].querySelector('.txt').textContent.trim() === '/react 0 not-a-chip' && !reacts[0], 'nonrecursive reaction body');
  assert(rows[8].querySelector('.chip-label').textContent === 'yes', 'reply reaction target');
  assert(rows[16].querySelector('.reply-target a').getAttribute('href') === '#m8', 'reply remains targetable');
  for (const id of [10,11,13,14,15]) assert(!rows[id].querySelector('.reply-target') && msgs[id].text === extra[id-8], 'literal unavailable/malformed target '+id);
  assert(rows[10].classList.contains('cont') && rows[16].classList.contains('cont'), 'chronological grouping ignores hidden commands');
  for (const id of [10, 16]) {
    const b = rows[id].querySelector('.hdr b'), cs = getComputedStyle(b);
    assert(b.textContent === 'ReplyAgent' && cs.visibility === 'visible' && cs.display !== 'none' && b.getBoundingClientRect().width > 0, 'grouped rows keep a visible sender');
  }
  const replay = await (await fetch(EVENTS+'?since=7', {headers:hdr()})).json();
  assert(await render(replay.events) === 0, 'duplicate reply page ignored');
  const ta = document.getElementById('text');
  for (const [draft, body] of [['', ''], [' \n body  ', ' \n body  '], ['/re 0 ', ''], ['/re 0  \n body ', ' \n body '], ['/re 01 x', '/re 01 x'], ['re #0: hi', 're #0: hi']]) {
    ta.value = draft; ta.setSelectionRange(1, Math.max(1,draft.length-1));
    rows[8].querySelector('.reply').click();
    assert(ta.value === '/re 8 '+body && document.activeElement === ta && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length, 'whole-draft reply composer');
    insertReply(2); assert(ta.value === '/re 2 '+body, 'retarget once');
  }
  const unreadPage = await deliverMarkdown([{id:17, from:'ReplyAgent', text:'/re 16 unread reply'}, {id:18, from:'ReplyAgent', text:'/react 17 yes'}], false);
  await openPicker(8, rows[8].querySelector('.addreact'));
  assert(!picker.hidden && pickFor === 8, 'reaction picker open before remote deletion');
  titleEl.focus(); titleEl.textContent = 'Unsent title at remote deletion';
  const realFetch = globalThis.fetch; let polls = 0, deletionPosts = 0;
  globalThis.fetch = async (path, options) => {
    if (options?.method === 'POST') { deletionPosts++; throw Error('post after deletion'); }
    return ++polls === 1 ? {ok:true, json:async () => unreadPage} : {status:404};
  };
  Object.defineProperty(document, 'hidden', {configurable:true, value:true}); unread = 0;
  await poll();
  assert(document.title === '(1) **plain title** · Mayfly Chat', 'poll background includes title');
  assert(unread === 1 && msgs[17] && !msgs[18], 'poll counts reply once, reaction never');
  assert(!document.getElementById('clear'), 'no key exposure banner exists');
  // The simulated 404 ended the loop in the deleted state; undo that page
  // state (not server state) so the live channel's checks can continue.
  assert(gone, 'a 404 poll stops the page before navigation');
  stoppedPage();
  assert(window.testReloads === 1, 'remote deletion requests a reload');
  await new Promise(r=>setTimeout(r,0));
  assert(deletionPosts === 0, 'remote deletion must not post the dirty title on blur');
  gone = false;
  titleEl.textContent = title;
  document.getElementById('delbtn').disabled = false;
  titleEl.contentEditable = 'plaintext-only';
  delete document.hidden; unread = 0; globalThis.fetch = realFetch;
  assert(picker.hidden && pickFor === null && pickAnchor === null, 'poll 404 closes the active reaction picker');
  // Compact headers preserve the complete identity, including attribute escapes.
  const longName = 'Long synthetic "sender" <&> ' + 'N'.repeat(480);
  await deliverMarkdown([{id:19, from:longName, text:'compact header'}]);
  const header = rows[19].querySelector('.hdr'), author = header.querySelector('b');
  const metadata = header.querySelector('span'), style = getComputedStyle(author);
  assert(author.textContent === longName && author.title === longName && !author.children.length, 'full plain name in DOM and tooltip');
  assert(style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis' && style.overflow === 'hidden' && author.scrollWidth > author.clientWidth, 'long sender ellipsized');
  const nameRange = document.createRange(); nameRange.selectNodeContents(author);
  assert(nameRange.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 1, 'sender text occupies one line');
  const authorBox = author.getBoundingClientRect(), metaBox = metadata.getBoundingClientRect();
  assert(metaBox.right <= header.getBoundingClientRect().right + 1 && (authorBox.right <= metaBox.left + 1 || authorBox.bottom <= metaBox.top + 1), 'metadata fits beside or below the name without overlap');
  const source = metadata.querySelector('.src');
  // The source is the address the server observed, shown raw, with a tooltip
  // that says exactly that and claims nothing about who posted.
  assert(/^[0-9a-fA-F.:]+$/.test(source.textContent), 'raw source address: ' + source.textContent);
  assert(/server saw/.test(source.title) && /not proof of who wrote/.test(source.title) && !/fingerprint/i.test(source.title), 'truthful source tooltip: ' + source.title);
  assert(metadata.querySelector('time[datetime]') && metadata.querySelector('.reply') && metadata.querySelector('.addreact'), 'time and accessible actions retained');
  // The longest address the server can observe must not push the header off
  // the page, at any width, and must remain readable in full.
  const wideAddress = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
  row({seq:9001, ts:new Date().toISOString(), src:wideAddress}, 'address row', longName);
  const wideRow = rows[9001], wideSource = wideRow.querySelector('.hdr .src');
  assert(wideSource.textContent === wideAddress && wideSource.title.includes(wideAddress), 'full address in the DOM and its tooltip');
  assert(getComputedStyle(wideSource).textOverflow !== 'ellipsis', 'raw address is not truncated');
  for (const rect of wideSource.getClientRects()) assert(rect.right <= wideRow.getBoundingClientRect().right + 1, 'address wraps inside its row');
  assert(wideRow.getBoundingClientRect().right <= log.getBoundingClientRect().right + 1, 'header fits its column');
  assert(document.documentElement.scrollWidth <= window.innerWidth, 'wide address causes no page overflow');
  delete rows[9001]; wideRow.remove();
  const all = await (await fetch(EVENTS+'?since=-1', {headers:hdr()})).json();
  assert(all.events.length === expected.size, 'all events stored');
  for (const ev of all.events) {
    const raw = await open(KS, ev), want = expected.get(ev.seq);
    assert(raw.from === want.from && raw.text === want.text, 'encrypted raw roundtrip '+ev.seq);
  }
  // Unsupported routes cannot expose decrypted messages.
  const unsupported = await fetch('/c/'+CID+'/messages', {headers:{Authorization:'Bearer '+KEY}});
  assert(unsupported.status === 404, 'no clear endpoint: '+unsupported.status);
  const unsupportedText = await unsupported.text();
  assert(!unsupportedText.includes(expected.get(0).text), 'no plaintext from an unsupported endpoint');
  const wide = body('```\n' + 'x'.repeat(300) + '\n```\n\n| a | b |\n| - | - |\n| ' + 'y'.repeat(300) + ' | z |'); fixture.appendChild(wide);
  assert(getComputedStyle(wide.querySelector('pre')).whiteSpace === 'pre', 'code whitespace CSS');
  assert(wide.querySelector('pre').clientWidth <= fixture.clientWidth && wide.querySelector('table').clientWidth <= fixture.clientWidth, 'bounded code/table');
  assert(document.documentElement.scrollWidth <= window.innerWidth, 'no page overflow: ' + window.innerWidth + '/' + document.documentElement.scrollWidth);
  assert((await network()).length === 1 && !window.pwned, 'no delayed resources or script');
  const fullToken = 'token"<&>' + 'R'.repeat(180);
  reacts[0] = new Map([[fullToken, new Set(['Alice', 'Bob'])]]); renderReacts(0);
  const chip = rows[0].querySelector('.chip');
  assert(chip.title === fullToken+' · Alice, Bob' && chip.getAttribute('aria-label') === fullToken+' (2)', 'chip full token, people, and accessible name');
  emoji = [['👍', 'thumbs up']];
  await openPicker(0, rows[0]);
  const suggestion = [...sugg.querySelectorAll('button')].find(b => b.dataset.r === fullToken);
  assert(suggestion?.title === fullToken && suggestion.getAttribute('aria-label') === 'React with '+fullToken, 'picker full token hover and accessible name');
  pickin.value = fullToken; pickin.dispatchEvent(new Event('input'));
  const literalOption = found.querySelector('button');
  assert(literalOption.title === 'React with exactly this: '+fullToken && literalOption.getAttribute('aria-label') === 'React with '+fullToken, 'literal token hover and accessible name');
  pickin.value = 'thumbs'; pickin.dispatchEvent(new Event('input'));
  const emojiOption = [...found.querySelectorAll('button')].find(b => b.dataset.r === '👍');
  assert(emojiOption?.title === '👍 · thumbs up' && emojiOption.getAttribute('aria-label') === 'React with 👍', 'emoji result token tooltip and accessible name');
  closePicker();
  Object.defineProperty(document, 'hidden', {configurable:true, value:true}); unread = 2;
  setTitle('Away title');
  assert(document.title === '(2) Away title · Mayfly Chat', 'background title with unread');
  setTitle('Renamed away');
  assert(document.title === '(2) Renamed away · Mayfly Chat', 'title-only update preserves unread');
  delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
  assert(document.title === 'Renamed away · Mayfly Chat' && unread === 0, 'foreground clears unread but retains title');
  assert(document.documentElement.scrollWidth <= innerWidth, 'shared-view mobile no overflow');
  // First-success cases use the real UI and relay, with only the response lost.
  // Reset tab-local naming between cases; peer fixtures above never use append().
  for (const kind of ['message', 'title', 'reaction']) for (const delivery of ['poll', '409']) {
    identity.locked = false; nameButton.hidden = false;
    nameButton.click(); nameInput.value = 'Accepted '+kind; nameInput.blur();
    const acceptedName = identity.name, seq = session.last+1;
    let localPosts = 0;
    globalThis.fetch = async (path, options) => {
      const response = await realFetch(path, options);
      if (options?.method !== 'POST' || ++localPosts !== 1) return response;
      assert(response.ok, 'first post really committed');
      if (kind === 'title') return new Response('{"error":"lost acknowledgement"}', {status:500});
      throw Error('lost acknowledgement');
    };
    ta.value = 'Retained message draft';
    if (kind === 'title') { titleEl.focus(); titleEl.textContent = 'Retained title '+delivery; titleEl.blur(); }
    else if (kind === 'reaction') { rows[0].querySelector('.addreact').click(); await pick('ack'); }
    else await send({preventDefault(){}});
    const deadline = performance.now()+5000;
    while (identity.pending && performance.now() < deadline) await new Promise(r=>setTimeout(r,10));
    assert(!identity.pending && !identity.locked && !nameButton.disabled, 'lost ack leaves name unlocked until evidence arrives');
    assert(ta.value === 'Retained message draft', 'lost ack retains composer draft');
    if (kind === 'title') assert(titleDraft && titleEl.textContent === 'Retained title '+delivery, 'lost title ack retains heading draft');
    nameButton.click(); nameInput.value = 'Edited after unknown ack'; nameInput.blur();
    assert(identity.name === 'Edited after unknown ack', 'name-edit window exercised');
    globalThis.fetch = realFetch;
    if (delivery === 'poll') {
      let reads = 0;
      globalThis.fetch = (path, options) => ++reads === 1 ? realFetch(path, options) : Promise.resolve(new Response('', {status:401}));
      await poll(); globalThis.fetch = realFetch;
    } else {
      await append({from:me(), text:'CAS retry after name edit'});
      const page = await (await realFetch(EVENTS+'?since='+(seq-1), {headers:hdr()})).json();
      assert(page.events.length === 2, 'accepted first post and one retried second post');
      assert((await open(KS, page.events[1])).from === acceptedName, 'CAS retry uses restored name, not its captured edited name');
      await render(page.events);
    }
    assert(identity.locked && identity.name === acceptedName && postingName.textContent === acceptedName && nameInput.value === acceptedName && nameInput.hidden && nameButton.hidden, 'matching delivery restores and locks the accepted name: '+kind+'/'+delivery);
    assert(identity.attempts.length === 0, 'lock retires ambiguous attempts');
    if (kind === 'reaction') assert(reacts[0].get('ack').has(acceptedName), 'hidden reaction reconciles before its early return');
    if (kind === 'title') { assert(titleDraft && title === 'Retained title '+delivery, 'hidden title reconciles without consuming its failed draft'); titleDraft = false; showTitle(); }
  }
  identity.locked = false; nameButton.hidden = false;
  // An acknowledged post through the DOM composer: the name locks, the pencil goes.
  document.getElementById('namebtn').click(); nameInput.value = 'Browser <b> " (human)'; nameInput.blur();
  assert(identity.name === 'Browser <b> " (human)' && !identity.locked, 'blur commits the draft');
  const beforePost = session.last, ta2 = document.getElementById('text');
  ta2.value = 'hello from the DOM';
  ta2.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', ctrlKey:true, bubbles:true}));
  const postDeadline = performance.now() + 5000;
  while (!identity.locked && performance.now() < postDeadline) await new Promise(r=>setTimeout(r,10));
  assert(identity.locked && document.getElementById('namebtn').hidden && nameInput.hidden, 'first success locks the name and removes the pencil');
  const posted = await (await fetch(EVENTS+'?since='+beforePost, {headers:hdr()})).json();
  assert(posted.events.length === 1, 'exactly one post');
  const inner = await open(KS, posted.events[0]);
  assert(inner.from === identity.name && inner.text === 'hello from the DOM', 'post carries the locked self-asserted name');
  await render(posted.events);
  while (ta2.value !== '' && performance.now() < postDeadline) await new Promise(r=>setTimeout(r,10));
  assert(ta2.value === '' && !document.getElementById('sendbtn').disabled && document.activeElement === ta2, 'post-send: cleared, enabled, focused');
  const placeholderStyle = getComputedStyle(ta2, '::placeholder');
  assert(placeholderStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(ta2).backgroundColor === getComputedStyle(document.body).backgroundColor, 'empty composer shows no overlay after sending');
  assert(document.getElementById('posting-name').textContent === identity.name && !document.getElementById('posting-name').children.length, 'posting name is plain text');
  assert(!rows[session.last].querySelector('.hdr b b'), 'name cannot become markup');
  // An explicit introduction by the sender renders as prose; a forged one stays literal.
  await deliverMarkdown([{id:session.last+1, from:'Alice', text:'/join Alice'}, {id:session.last+2, from:'Agent', text:'/join Alice'}]);
  assert(rows[session.last-1].querySelector('.txt').textContent === 'Alice joined the channel' && rows[session.last-1].querySelector('.txt.join'), 'nice join');
  assert(rows[session.last].querySelector('.txt').textContent.trim() === '/join Alice' && !rows[session.last].querySelector('.txt.join'), 'mismatched join stays literal');
  assert(localStorage.length === 0 && sessionStorage.length === 0, 'names are tab-local, never persisted');
  // The countdown is text with the absolute deadline in its tooltip, or absent entirely.
  const expEl = document.getElementById('exp');
  assert(/^\d+ (hours?|days?|minutes?)(, \d+ (hours?|minutes?))?$|^less than a minute$/.test(expEl.textContent) && expEl.title, 'expiry countdown: ' + expEl.textContent);
  // Do not render these transport probes: compare actual decrypted content.
  // Names and text have no separate byte budget; content survives intact
  // whenever it fits the relay's decoded-ciphertext cap.
  // Each transport-size probe gets an empty disposable channel: their combined
  // ciphertext intentionally exceeds the 1 MiB per-channel budget.
  async function envelopeChannel(){
    const url = await newChannel();
    const keys = await derive(unb64u(url.split('#')[1]));
    return {keys, events:'/c/'+keys.id+'/events', headers:{Authorization:'Bearer '+keys.auth, 'Content-Type':'application/json'}};
  }
  const CAP = 512*1024;
  const envelopeName = '\\"'.repeat(400); // 800-byte name
  const mixedEnvelope = '\x00\x01\b\t\n\f\r"\\<>&é你好🐦\u2028\u2029';
  let mixedText = mixedEnvelope.repeat(Math.floor(65536/te.encode(mixedEnvelope).length));
  mixedText += 'x'.repeat(65536-te.encode(mixedText).length);
  assert(validFrom(envelopeName), 'a long name is still a valid name');
  for (const text of ['\\'.repeat(50*1024), '\x00'.repeat(65536), mixedText, 'plain '.repeat(30000)]) {
    const {keys, events, headers} = await envelopeChannel();
    const obj = {from:envelopeName, text};
    const blob = await seal(keys, 0, obj);
    const size = unb64u(blob.ct).length;
    assert(size < CAP, 'cipher fits: ' + size);
    const response = await fetch(events+'?last=-1', {method:'POST', headers, body:JSON.stringify(blob)});
    assert(response.ok, 'large browser post '+response.status);
    const page = await (await fetch(events+'?since=-1', {headers})).json();
    assert(page.events.length === 1, 'one large event');
    const got = await open(keys, page.events[0]);
    assert(got && got.from === obj.from && got.text === obj.text, 'large browser roundtrip');
    assert((await fetch(events.slice(0,-7), {method:'DELETE', headers})).ok, 'remove transport fixture');
  }
  // The cap itself: the largest sealed event the relay accepts, and the next
  // block up, which it refuses with its own error instead of storing.
  const {keys:capKeys, events:capEvents, headers:capHeaders} = await envelopeChannel();
  const capOverhead = te.encode(JSON.stringify({from:'P', text:''})).length;
  const atCap = await seal(capKeys, 0, {from:'P', text:'x'.repeat(CAP-16-256-capOverhead)});
  assert(unb64u(atCap.ct).length === CAP-256+16, 'largest event sits one block below the cap');
  let capResponse = await fetch(capEvents+'?last=-1', {method:'POST', headers:capHeaders, body:JSON.stringify(atCap)});
  assert(capResponse.ok, 'largest accepted event: '+capResponse.status);
  const overCap = await seal(capKeys, 1, {from:'P', text:'x'.repeat(CAP-16-capOverhead)});
  assert(unb64u(overCap.ct).length > CAP, 'over the cap');
  capResponse = await fetch(capEvents+'?last=0', {method:'POST', headers:capHeaders, body:JSON.stringify(overCap)});
  assert(capResponse.status === 413, 'oversized event rejected: '+capResponse.status);
  assert((await capResponse.json()).error.includes('too large'), 'the relay explains its one size policy');
  const afterCap = await (await fetch(capEvents+'?since=0', {headers:capHeaders})).json();
  assert(afterCap.events.length === 0, 'the oversized event was not stored');
  assert((await fetch(capEvents.slice(0,-7), {method:'DELETE', headers:capHeaders})).ok, 'remove cap fixture');
  // Deletion through the real dialog: cancel keeps the channel; Delete ends it.
  const dialog = document.getElementById('deldialog');
  document.getElementById('delbtn').click();
  assert(dialog.open, 'confirmation opens');
  dialog.querySelector('button[value="cancel"]').click();
  await new Promise(r=>setTimeout(r,20));
  assert(!dialog.open && !gone && (await fetch(EVENTS+'?since=-1', {headers:hdr()})).ok, 'cancel deletes nothing');
  assert(window.testReloads === 1, 'cancel does not request another reload');
  rows[0].querySelector('.addreact').click();
  assert(!picker.hidden && pickFor === 0, 'reaction picker open before local deletion');
  // click() activates deletion without the outside mousedown that closes the picker.
  document.getElementById('delbtn').click();
  assert(dialog.open && !picker.hidden, 'keyboard-equivalent deletion opens confirmation with picker still open');
  deletionPosts = 0;
  globalThis.fetch = async (path, options) => {
    if (options?.method === 'POST') deletionPosts++;
    const response = await realFetch(path, options);
    if (options?.method === 'DELETE') {
      titleEl.focus(); titleEl.textContent = 'Unsent title at local deletion';
    }
    return response;
  };
  dialog.querySelector('button[value="delete"]').click();
  const deleteDeadline = performance.now() + 5000;
  while (!gone && performance.now() < deleteDeadline) await new Promise(r=>setTimeout(r,10));
  assert(gone && document.getElementById('delbtn').disabled, 'deletion confirmed: ' + deleteStatus.textContent);
  assert(picker.hidden && pickFor === null && pickAnchor === null, 'local deletion closes the active reaction picker');
  stoppedPage();
  assert(deletionPosts === 0, 'local deletion must not post the dirty title on blur');
  globalThis.fetch = realFetch;
  assert(window.testReloads === 2, 'local deletion also requests a reload');
  assert(location.hash === '#'+KEY && location.pathname === '/c/'+CID, 'reload keeps the channel URL');
  assert((await fetch(EVENTS+'?since=-1', {headers:hdr()})).status === 404, 'channel really gone');
  assert(document.documentElement.scrollWidth <= window.innerWidth, 'deleted page no overflow');
  return {ok:true, dark, width:window.innerWidth, attacks:attacks.length, nameWidth:author.clientWidth, headerHeight:header.clientHeight};
})().then(result => fetch('/test-result', {method:'POST', body:JSON.stringify(result)}), err => fetch('/test-result', {method:'POST', body:JSON.stringify({error:err.stack})}));
