// Channel page, top to bottom: key and startup, session and polling, then the
// widgets (expiry, copy, delete, name, title), message rendering, reactions
// and replies, the picker, and the composer. The template supplies CID,
// RETENTION_MS, EXPIRES_AT, and VECTORS, includes the other browser modules
// before this one, and calls init() from a separate startup script; test
// fixtures call init with their own polling and navigation callbacks.
// Optional calls such as select?.() tolerate the minimal DOM stand-in that
// the Node tests supply in place of a browser.
const EVENTS = '/c/' + CID + '/events';
const titleEl = document.getElementById('title'), log = document.getElementById('log'), status = document.getElementById('status');
const textarea = document.getElementById('text');
let gone = false; // set once the channel is deleted or found missing

// --- key from the fragment ---------------------------------------------------
let KS = null, KEY = location.hash.slice(1); // KS: the keys derived from KEY
const hdr = () => ({'Authorization': 'Bearer ' + KS.auth});
let onChannelGone = () => location.reload();
async function init({startPolling = poll, onGone = onChannelGone} = {}){
  onChannelGone = onGone;
  if (!KEY){ document.getElementById('nokey').hidden = false; return; }
  try {
    await selfCheck();
    KS = await derive(unb64u(KEY));
  } catch(e){ document.getElementById('nokey').hidden = false; document.getElementById('nokey').textContent = 'Could not use this key: ' + e.message; return; }
  if (KS.id !== CID){ document.getElementById('nokey').hidden = false; document.getElementById('nokey').textContent = 'This key does not belong to this channel (pasted wrong?).'; return; }
  document.getElementById('main').hidden = false;
  document.getElementById('editbtn').hidden = false;
  document.getElementById('delbtn').hidden = false;
  titleEl.contentEditable = 'plaintext-only';
  titleEl.spellcheck = false;
  // The key never leaves the fragment: it is not in any path, query, or
  // request this page makes; only the displayed agent command carries it.
  document.getElementById('agenturl').value = 'curl -fsS ' + shellQuote(location.origin + '/c/' + CID + '#' + KEY);
  startPolling();
}
window.addEventListener('hashchange', () => location.reload()); // a new key means a new page

// --- session and polling -------------------------------------------------------
// The session owns the delivered cursor and this page's identity; the poller
// owns the one active read. Both call back into the rendering section below.
const session = createSession({
  open: event => openMessage(KS, event),
  seal: (seq, message) => sealMessage(KS, seq, message),
  post: (last, blob) => fetch(`${EVENTS}?last=${last}`, {method:'POST', headers:hdr(), body:JSON.stringify(blob)}),
  beginPresentation,
  onLock: showLockedName,
  onPending: count => { nameButton.disabled = nameInput.disabled = count > 0; },
  isStopped: () => gone
});
const identity = session.identity;
let unread = 0;
const poller = createPoller({
  read: signal => fetch(`${EVENTS}?since=${session.last}&wait=30`, {headers: hdr(), signal}),
  deliver: async events => {
    const n = await render(events);
    if (!gone && document.hidden && n) { unread += n; tabTitle(); }
  },
  isStopped: () => gone,
  onMissing: () => channelGone(),
  onUnauthorized: () => { status.textContent = 'The server rejected this key.'; },
  onStatus: text => { status.textContent = text; }
});
watchPollLifecycle(poller, () => { unread = 0; tabTitle(); });
// render, append, and poll are the entry points the tests drive directly.
function render(events){ return session.deliver(events); }
function append(obj){ return session.append(obj); }
function poll(){ return poller.start(); }
function wakePoll(){ poller.wake(); }

// --- expiry ----------------------------------------------------------------------
// The deadline is the newest delivered event's time plus the configured
// retention; reading never extends it. RETENTION_MS 0 means never.
const exp = document.getElementById('exp');
let expires = Date.parse(EXPIRES_AT);
function remaining(ms){
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const unit = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  if (d >= 1) return unit(d, 'day') + ', ' + unit(h % 24, 'hour');
  if (h >= 1) return unit(h, 'hour') + ', ' + unit(m % 60, 'minute');
  return m >= 1 ? unit(m, 'minute') : 'less than a minute';
}
function showExpiry(){
  if (!exp || !(expires > 0)) return; // some test fixtures omit the element
  exp.dateTime = new Date(expires).toISOString();
  exp.title = new Date(expires).toLocaleString();
  exp.textContent = remaining(Math.max(0, expires - Date.now()));
}
showExpiry();
if (expires > 0) setInterval(showExpiry, 60000);

// --- copy the agent command ------------------------------------------------------
const shellQuote = s => "'" + s.replace(/'/g, "'\\''") + "'";
document.getElementById('copybtn').addEventListener('click', async e => {
  const button = e.currentTarget, feedback = document.getElementById('copy-status');
  if (button.disabled) return;
  button.disabled = true;
  feedback.textContent = '';
  try {
    await navigator.clipboard.writeText(document.getElementById('agenturl').value);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy';
    feedback.textContent = 'Could not copy. Select and copy the command instead.';
  } finally { button.disabled = false; }
});

// --- deletion: any key holder may end the channel ----------------------------
const deleteButton = document.getElementById('delbtn');
const deleteDialog = document.getElementById('deldialog');
const deleteStatus = document.getElementById('delete-status');
function channelGone(){
  if (gone) return;
  gone = true;
  wakePoll();
  session.discardPostEvidence();
  closePicker();
  deleteButton.disabled = true;
  titleEl.removeAttribute('contenteditable');
  titleEl.blur(); // The gone guard prevents a dirty title from posting during navigation.
  onChannelGone();
}
async function deleteChannel(){
  deleteButton.disabled = true;
  deleteStatus.hidden = true; deleteStatus.textContent = '';
  try {
    const r = await fetch('/c/' + CID, {method:'DELETE', headers: hdr()});
    if (r.status !== 204 && r.status !== 404) throw new Error((await r.json().catch(()=>({}))).error || r.status);
    channelGone();
  } catch(err){
    deleteStatus.textContent = 'Could not delete: ' + err.message;
    deleteStatus.hidden = false;
    deleteButton.disabled = false;
    deleteButton.focus();
  }
}
deleteButton.addEventListener('click', () => {
  if (deleteButton.disabled) return;
  if (typeof deleteDialog.showModal !== 'function') { if (confirm('Delete this channel?')) deleteChannel(); return; }
  deleteDialog.returnValue = '';
  deleteDialog.showModal();
});
deleteDialog.addEventListener('close', () => { if (deleteDialog.returnValue === 'delete') deleteChannel(); else deleteButton.focus(); });

// --- tab-local name: editable until the first successful post -----------------
const nameInput = document.getElementById('name'), nameButton = document.getElementById('namebtn');
const postingName = document.getElementById('posting-name'), nameStatus = document.getElementById('name-status');
function editName(){
  if (identity.locked || identity.pending) return;
  nameInput.value = identity.name;
  nameInput.hidden = false; postingName.hidden = true; nameButton.hidden = true;
  nameInput.focus(); nameInput.select?.();
}
// commitName adopts a valid draft and closes the editor; an invalid draft
// stays visible with its reason and reports false.
function commitName(){
  if (identity.locked) { nameInput.hidden = true; return true; }
  const draft = trimSpace(nameInput.value);
  if (draft && draft !== identity.name){
    if (!validFrom(draft)) { nameStatus.textContent = NAME_RULE; return false; }
    if (!session.setName(draft)) return false;
    postingName.textContent = identity.name;
    for (const id of Object.keys(reacts)) renderReacts(id);
  }
  nameStatus.textContent = '';
  nameInput.hidden = true; postingName.hidden = false; nameButton.hidden = identity.locked;
  return true;
}
// me is the name every post is sent as, committing any open edit first.
function me(){
  if (!identity.locked && !nameInput.hidden && !commitName()) throw new Error(NAME_RULE);
  return identity.name;
}
function showLockedName(from){
  postingName.textContent = nameInput.value = from;
  nameInput.hidden = true; postingName.hidden = false; nameButton.hidden = true;
  nameStatus.textContent = '';
  for (const id of Object.keys(reacts)) renderReacts(id);
}
nameButton.addEventListener('click', editName);
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); if (commitName()) textarea.focus(); }
  if (e.key === 'Escape') { e.preventDefault(); nameInput.value = identity.name; commitName(); }
});
nameInput.addEventListener('blur', () => { if (!nameInput.hidden) commitName(); });

// --- title -----------------------------------------------------------------
// An empty heading shows "untitled" through CSS, so editing starts from
// nothing rather than a placeholder that has to be deleted first.
let title = '';
let titleStart = '', titleDraft = false, titleEdit = 0;
function showTitle(){
  if (document.activeElement !== titleEl && !titleDraft) titleEl.textContent = title;
}
function tabTitle(){ document.title = (unread ? `(${unread}) ` : '') + (title || 'untitled') + ' · Mayfly Chat'; }
function setTitle(t){
  title = t;
  showTitle();
  tabTitle();
  titleEl.title = t; // the heading is clamped to a few lines; hover shows it whole
}
document.getElementById('editbtn').addEventListener('click', () => {
  titleEl.focus();
  const range = document.createRange?.(); if (!range) return;
  range.selectNodeContents(titleEl); range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
});
titleEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  if (e.key === 'Escape') { titleDraft = false; titleStart = title; titleEl.textContent = title; titleEl.blur(); }
});
titleEl.addEventListener('focus', () => {
  titleEdit++;
  titleStart = trimSpace(titleEl.textContent);
});
titleEl.addEventListener('blur', async () => {
  if (gone) return; // deletion can move focus off a dirty title
  const t = trimSpace(titleEl.textContent), edit = titleEdit;
  if (!t) titleEl.replaceChildren?.(); // a stray <br> would hide the placeholder
  if (t === titleStart || t === title) { titleDraft = false; showTitle(); return; }
  titleDraft = true;
  try {
    if (t && !validTitle(t)) throw new Error('Title must be a single control-free line.');
    await append({from:me(), text:commandText.title(t)});
    if (edit === titleEdit) { titleDraft = false; showTitle(); }
  } catch(err){ if (edit === titleEdit) status.textContent = 'Could not rename: ' + err.message; }
});

// --- rendering delivered events ----------------------------------------------
// conversation.js turns plaintext into row, title, and reaction changes;
// this section turns those changes into DOM.
const conversation = createConversation();
const {messages: msgs, reacts, used} = conversation;
const rows = Object.create(null); // seq -> row element
let prevFrom = null; // sender of the previous row, for grouping
// One hue per name, assigned in order of first appearance.
const hues = [210, 30, 280, 160, 350, 60, 120, 320, 190, 90];
const colors = Object.create(null);
function color(name){
  if (!(name in colors)) colors[name] = `hsl(${hues[Object.keys(colors).length % hues.length]} 70% var(--speaker-lightness))`;
  return colors[name];
}
function beginPresentation(){
  const atBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 200;
  const dirty = new Set();
  return {
    apply(event, message){
      if (RETENTION_MS > 0) {
        const deadline = Date.parse(event.ts) + RETENTION_MS;
        if (deadline > expires) { expires = deadline; showExpiry(); }
      }
      const change = conversation.apply(event, message);
      if (change.kind === 'title') { setTitle(change.text); return 0; }
      if (change.kind === 'reaction') { dirty.add(change.to); return 0; }
      row(change.event, change.text, change.from, change.reply, change.join);
      return 1;
    },
    finish(visible){
      for (const id of dirty) renderReacts(id);
      if (visible && atBottom) window.scrollTo(0, document.body.scrollHeight);
    }
  };
}
function row(ev, text, from, reply, join){
  const d = document.createElement('div');
  d.className = 'msg' + (from === prevFrom ? ' cont' : '');
  d.style.setProperty('--c', color(from));
  d.id = 'm' + ev.seq;
  const t = new Date(ev.ts);
  const sourceHint = `Posted from ${ev.src} — the source address the server saw. ` +
    'Servers, proxies and shared networks can change it; it is not proof of who wrote the message';
  const replyTarget = reply
    ? `<small class="reply-target"><a href="#m${reply.to}">↩ #${reply.to}</a></small>`
    : '';
  d.innerHTML = `<div class="hdr"><b title="${esc(from)}">${esc(from)}</b><span>` +
    '<button class="act addreact" title="Add reaction">🙂<small>+</small></button>' +
    `<button class="act reply" title="Reply to #${ev.seq}" data-id="${ev.seq}">↩</button> ` +
    `<a href="#${esc(KEY)}" data-target="m${ev.seq}">#${ev.seq}</a> · ` +
    `<code class="src" title="${esc(sourceHint)}">${esc(ev.src)}</code> · ` +
    `<time datetime="${esc(ev.ts)}" title="${t.toLocaleString()}">` +
    `${t.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</time></span></div>` +
    replyTarget + '<div class="txt"></div><div class="reacts" hidden></div>';
  const body = d.querySelector('.txt');
  if (join) {
    body.className = 'txt join';
    body.appendChild(document.createTextNode(join + ' joined the channel'));
  } else {
    body.appendChild(renderMessageMarkdown(reply ? reply.text : text));
  }
  log.appendChild(d);
  rows[ev.seq] = d;
  prevFrom = from;
}
function renderReacts(id){
  const el = rows[id]?.querySelector('.reacts'); if (!el) return;
  const m = reacts[id] || new Map();
  let h = '';
  for (const [r, who] of m){
    const mine = who.has(identity.name);
    h += `<button class="chip${mine?' mine':''}" data-r="${esc(r)}" ` +
      `title="${esc(r)} · ${esc([...who].join(', '))}" aria-label="${esc(r)} (${who.size})">` +
      `<span class="chip-label">${esc(r)}</span> ${who.size}</button>`;
  }
  el.innerHTML = h;
  el.hidden = !h;
}

// --- reactions, replies, and message links ---------------------------------------
const react = (id, r, remove) => {
  if (!validReaction(r)) return Promise.reject(new Error('Reaction must be one nonempty token without whitespace or controls.'));
  let from; try { from = me(); } catch(err){ return Promise.reject(err); }
  return append({from, text:remove ? commandText.unreact(id, r) : commandText.react(id, r)});
};
let highlighted = null;
log.addEventListener('click', async e => {
  const local = e.target.closest('a[href^="#m"]');
  const ref = local || e.target.closest('a[data-target]');
  if (local || (ref && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey)) {
    e.preventDefault();
    const target = document.getElementById(local ? local.getAttribute('href').slice(1) : ref.dataset.target);
    if (target) {
      highlighted?.classList.remove('highlight');
      highlighted = target;
      target.classList.add('highlight');
      target.scrollIntoView({block:'center'});
    }
    return;
  }
  const chip = e.target.closest('.chip'), rep = e.target.closest('.reply'), add = e.target.closest('.addreact');
  if (gone) return;
  if (rep){ insertReply(rep.dataset.id); return; }
  if (add){ openPicker(+add.closest('.msg').id.slice(1), add); return; }
  if (!chip) return;
  const id = +chip.closest('.msg').id.slice(1), r = chip.dataset.r;
  try { await react(id, r, reacts[id]?.get(r)?.has(identity.name)); } catch(err){ status.textContent = 'Reaction failed: ' + err.message; }
});
// Local message links cannot navigate: the fragment belongs exclusively to K.
log.addEventListener('auxclick', e => { if (e.target.closest('a[href^="#m"]')) e.preventDefault(); });
// insertReply retargets an existing /re prefix rather than stacking a second one.
function insertReply(id){
  const prefix = /^\/re (0|[1-9][0-9]*) /.exec(textarea.value);
  const body = prefix && Number.isSafeInteger(Number(prefix[1])) ? textarea.value.slice(prefix[0].length) : textarea.value;
  textarea.value = commandText.reply(id, body);
  textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// --- reaction picker: suggestions (most specific first) plus name search --------
const picker = document.getElementById('picker');
const pickin = document.getElementById('pickin');
const sugg = picker.querySelector('.sugg');
const found = picker.querySelector('.found');
const pickerr = document.getElementById('pickerr');
const DEFAULTS = ['👍','👎','❤️','😂','🎉','👀','✅','🤔'];
let pickFor = null, pickAnchor = null, emoji = null; // emoji: [[char, name]], fetched on first open
function suggestions(id){
  const out = [];
  const add = r => { if (r && !out.includes(r)) out.push(r); };
  for (const r of (reacts[id] || new Map()).keys()) add(r);            // already on this message
  for (const m of (msgs[id]?.text || '').matchAll(/\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]|\u200D\p{Extended_Pictographic})*/gu)) add(m[0]); // in the text
  for (const r of Object.keys(used).sort((a,b)=>used[b]-used[a])) add(r); // used elsewhere in the channel
  for (const r of DEFAULTS) add(r);
  return out.slice(0, 8);
}
function placePicker(){
  if (!pickAnchor) return;
  const rc = pickAnchor.getBoundingClientRect();
  picker.style.left = Math.max(8, Math.min(rc.left, window.innerWidth - picker.offsetWidth - 8)) + window.scrollX + 'px';
  picker.style.top = Math.max(8, Math.min(rc.bottom + 4, window.innerHeight - picker.offsetHeight - 8)) + window.scrollY + 'px';
}
async function openPicker(id, anchor){
  pickFor = id; pickAnchor = anchor;
  sugg.innerHTML = suggestions(id).map(r=>`<button data-r="${esc(r)}" title="${esc(r)}" aria-label="React with ${esc(r)}"><span class="pick-label">${esc(r)}</span></button>`).join('');
  found.innerHTML = ''; pickin.value = ''; pickerr.textContent = '';
  picker.hidden = false;
  placePicker();
  pickin.focus();
  if (!emoji) emoji = (await (await fetch('/emoji.txt')).text()).trim().split('\n').map(l=>l.split('\t'));
}
function closePicker(){ picker.hidden = true; pickFor = null; pickAnchor = null; }
window.addEventListener('resize', () => { if (!picker.hidden) placePicker(); });
async function pick(r){
  const id = pickFor; closePicker();
  try { await react(id, r, false); } catch(err){ status.textContent = 'Reaction failed: ' + err.message; }
}
pickin.addEventListener('input', () => {
  const raw = trimSpace(pickin.value), q = raw.toLowerCase();
  pickerr.textContent = '';
  if (!q){ found.innerHTML = ''; placePicker(); return; }
  // What you typed is always the first option (so Enter reacts with "LOL",
  // not the lollipop), followed by emoji whose names match.
  let h = validReaction(raw) ? `<button data-r="${esc(raw)}" class="lit" title="React with exactly this: ${esc(raw)}" aria-label="React with ${esc(raw)}"><span class="pick-label">${esc(raw)}</span></button>` : '';
  const hits = (emoji||[]).filter(([,n]) => n.includes(q)).sort((a,b)=>a[1].startsWith(q)?-1:b[1].startsWith(q)?1:0).slice(0, 24);
  found.innerHTML = h + hits.map(([c,n])=>`<button data-r="${esc(c)}" title="${esc(c)} · ${esc(n)}" aria-label="React with ${esc(c)}"><span class="pick-label">${esc(c)}</span></button>`).join('');
  placePicker();
});
pickin.addEventListener('keydown', e => {
  if (e.key === 'Escape'){ closePicker(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = found.querySelector('button');
  if (first) pick(first.dataset.r);
  else if (trimSpace(pickin.value)) pickerr.textContent = 'Reactions are nonempty tokens without whitespace or controls.';
});
picker.addEventListener('click', e => { const b = e.target.closest('button'); if (b) pick(b.dataset.r); });
document.addEventListener('mousedown', e => { if (!picker.hidden && !picker.contains(e.target) && !e.target.closest('.addreact')) closePicker(); });

// --- composer ------------------------------------------------------------------
async function send(ev){
  ev.preventDefault();
  const btn = document.getElementById('sendbtn');
  const text = textarea.value; if (btn.disabled || !trimSpace(text)) return false;
  btn.disabled = true;
  try{
    await append({from:me(), text});
    if (textarea.value === text) textarea.value = '';
  } catch(err){ status.textContent = 'Could not send: ' + err.message;
  } finally { btn.disabled = false; textarea.focus(); }
  return false;
}
textarea.addEventListener('keydown', e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter') send(e); });
document.getElementById('compose').addEventListener('submit', send);
