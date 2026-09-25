function mayflyRecovery(container, pending) {
  container.replaceChildren();
  if (!pending) return;
  const note = document.createElement('p');
  note.textContent = 'Creation or linking is incomplete. Retry to finish the same resources. Keep these recovery links if you leave this page.';
  container.append(note);
  for (const kind of ['chat','wiki']) if (pending[kind+'_url']) {
    try {
      const safe = new URL(pending[kind+'_url']);
      if (safe.origin !== location.origin || !/^\/(c|w)\/[\w-]{22}$/.test(safe.pathname) || !/^#[\w-]{43}$/.test(safe.hash)) continue;
    } catch { continue; }
    const a = document.createElement('a'); a.href = pending[kind+'_url']; a.textContent = kind === 'chat' ? 'Chat link' : 'Wiki link';
    container.append(a,' ');
  }
}
async function mayflyCompanions(url, container) {
  if (!container || container.parentElement.hidden) return;
  let source;
  try { source = await MayflySpaces.capability(url); } catch { return; }
  const other = source.kind === 'chat' ? 'wiki' : 'chat';
  const el = (tag,text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const title = el('strong',other === 'wiki' ? 'Linked wikis' : 'Linked chats'), list = el('ul'), message = el('p'), recovery = el('div');
  list.className = 'space-list'; message.className = 'meta'; message.setAttribute('role','status'); recovery.className = 'space-recovery';
  const refreshButton = el('button','Refresh links'); refreshButton.type = 'button';
  const heading = el('div'); heading.className = 'space-actions'; heading.append(title,refreshButton);
  const create = el('form'), input = el('input'), createButton = el('button',other === 'wiki' ? 'Create wiki' : 'Start chat');
  create.className = 'space-actions'; createButton.type = 'submit';
  if (other === 'wiki') { input.placeholder = 'Wiki title'; input.setAttribute('aria-label','Title of linked wiki'); input.required = true; input.maxLength = 160; create.append(input); }
  create.append(createButton);
  const existing = el('details'), summary = el('summary','Link an existing '+other), form = el('form'), fullURL = el('input'), linkButton = el('button','Link '+other);
  fullURL.type = 'url'; fullURL.required = true; fullURL.autocomplete = 'off'; fullURL.placeholder = 'Complete '+other+' URL, including #key'; fullURL.setAttribute('aria-label',fullURL.placeholder);
  form.className = 'space-actions'; linkButton.type = 'submit'; form.append(fullURL,linkButton); existing.append(summary,form);
  const note = el('p','Linking shares access with everyone holding either complete URL, including other people and agents in the wiki. Chat expiry leaves the wiki intact. Removing a shortcut does not revoke access.'); note.className = 'meta';
  container.replaceChildren(heading,list,create,existing,note,message,recovery); container.hidden = false;
  let pending = null, busy = false;
  const run = fn => async event => {
    event?.preventDefault(); if (busy) return; busy = true;
    createButton.disabled = linkButton.disabled = refreshButton.disabled = true;
    message.textContent = 'Working…';
    try { await fn(); }
    catch (error) { message.textContent = error.message; mayflyRecovery(recovery,error.recovery || pending); }
    finally { busy = false; createButton.disabled = linkButton.disabled = refreshButton.disabled = false; }
  };
  async function refresh() {
    const links = await MayflySpaces.links(source.url); list.replaceChildren();
    for (const item of links) {
      const row = el('li'), a = el(item.url ? 'a' : 'span',(item.kind === 'wiki' ? 'Open wiki: ' : 'Open ')+item.title);
      if (item.url) a.href = item.url;
      else a.textContent += ' · '+item.error;
      const remove = el('button','Remove shortcut'); remove.type = 'button'; remove.setAttribute('aria-label','Remove shortcut to '+item.title);
      remove.addEventListener('click',run(async()=>{await MayflySpaces.remove(source.url,item.id);await refresh();message.textContent = 'Shortcut removed here. Previously shared access still works.';}));
      row.append(a,remove); list.append(row);
    }
    message.textContent = links.length ? '' : 'No linked '+(other === 'wiki' ? 'wikis' : 'chats')+' yet.';
  }
  create.addEventListener('submit',run(async()=>{
    if (!pending) pending = await MayflySpaces.plan(source.origin,{[source.kind]:source.url,[other]:true,title:other === 'wiki' ? input.value : undefined});
    input.disabled = true;
    await MayflySpaces.complete(pending); pending = null; input.disabled = false; input.value = ''; recovery.replaceChildren();
    createButton.textContent = other === 'wiki' ? 'Create wiki' : 'Start chat';
    await refresh(); message.textContent = 'Linked '+other+' ready. Open it above.';
  }));
  // A pending creation must be finished before switching to an unrelated link.
  form.addEventListener('submit',run(async()=>{
    if (pending) throw new Error('Retry creation first, or keep the recovery links and reload.');
    const chat = source.kind === 'chat' ? source.url : fullURL.value, wiki = source.kind === 'wiki' ? source.url : fullURL.value;
    try { await MayflySpaces.link(chat,wiki); }
    catch (error) { error.recovery = {chat_url:chat,wiki_url:wiki}; throw error; }
    fullURL.value = ''; existing.open = false; recovery.replaceChildren(); await refresh(); message.textContent = 'Linked. Open it above.';
  }));
  refreshButton.addEventListener('click',run(refresh));
  await run(refresh)();
}
