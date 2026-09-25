function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
// A body is the only Markdown boundary. Commands and app UI never enter it.
// Each call owns its parser, sanitizer hooks, and unforgeable placeholder map.
function renderMessageMarkdown(text){
  const fallback = () => { const f = document.createDocumentFragment(); f.appendChild(document.createTextNode(text)); return f; };
  try {
    if (!globalThis.marked || !globalThis.DOMPurify) return fallback();
    const clean = DOMPurify(window);
    if (!clean.isSupported) return fallback();
    const safeURL = (s, anchors = true) => {
      if (anchors && /^#m[0-9]+$/.test(s)) return s;
      if (!/^https?:\/\//i.test(s) || /[\s\u0000-\u001f\u007f\\]/u.test(s)) return null;
      try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
    };
    // Decode character references as text, never as markup or a resource URL.
    const decoded = s => clean.sanitize(s.replace(/</g, '&lt;'), {
      ALLOWED_TAGS:[], ALLOWED_ATTR:[], RETURN_DOM_FRAGMENT:true
    }).textContent;
    const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
    const placeholders = new Map();
    const placeholder = (kind, text, url) => {
      const key = nonce + '-' + placeholders.size;
      placeholders.set(key, {kind, url});
      return `<span title="${key}">${esc(text)}</span>`;
    };
    const base = new marked.Renderer();
    let inLink = 0;
    const md = new marked.Marked({gfm:true, breaks:true, async:false, renderer:{
      html(token){ return placeholder('html', token.text); },
      image(token){ return placeholder('image', decoded(token.text), safeURL(decoded(token.href), false)); },
      checkbox(token){ return token.checked ? '[x] ' : '[ ] '; },
      code(token){
        if (typeof mayflyEnhanceCode !== 'function') return base.code.call(this, token);
        return '<pre><code title="'+esc(token.lang || '')+'">'+esc(token.text)+'</code></pre>';
      },
      link(token){
        inLink++;
        try { return base.link.call(this, token); } finally { inLink--; }
      },
      text(token){
        // Marked's raw-block text is deliberately unescaped for HTML users;
        // our literal-HTML policy must escape it and exclude references too.
        if (token.escaped && !token.tokens) return placeholder('html', token.text);
        const html = base.text.call(this, token);
        // Do not rewrite a composite token twice, HTML, code, labels, or URLs.
        if (inLink || token.tokens) return html;
        return html.replace(/(^|[^\w&])#(\d+)\b/g, (_, pre, n) => `${pre}<a href="#m${n}">#${n}</a>`);
      }
    }});
    const html = md.parse(text);
    // Hrefs here are browser-decoded attributes, not parser-escaped strings.
    clean.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName === 'href') {
        const url = node.nodeName === 'A' && safeURL(data.attrValue);
        if (url) data.attrValue = url; else data.keepAttr = false;
      }
    });
    const fragment = clean.sanitize(html, {
      ALLOWED_TAGS:['p','br','hr','strong','em','del','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','pre','code','table','thead','tbody','tr','th','td','a','span'],
      ALLOWED_ATTR:['href','title','start','align'], ALLOW_DATA_ATTR:false, ALLOW_ARIA_ATTR:false,
      RETURN_DOM_FRAGMENT:true
    });
    // Only safe app-owned DOM is added after the final content sanitization.
    for (const a of fragment.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      if (!href) { a.replaceWith(...a.childNodes); continue; }
      if (!href.startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; a.referrerPolicy = 'no-referrer'; }
    }
    const linkedSlots = new Map();
    for (const span of fragment.querySelectorAll('span[title]')) {
      const item = placeholders.get(span.getAttribute('title'));
      if (!item) continue;
      span.removeAttribute('title');
      if (item.kind === 'html') { span.className = 'literal-html'; continue; }
      if (!item.url) continue;
      if (typeof mayflyMedia === 'function') {
        const slot=mayflyMedia({name:span.textContent,kind:'image',url:item.url});
        const link=span.closest('a');
        if(link){(linkedSlots.get(link)||link).after(slot);linkedSlots.set(link,slot);}else span.replaceWith(slot);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'load-image'; button.textContent = 'Load image';
      button.title = 'Load image: ' + span.textContent;
      // Keep the control outside any enclosing Markdown link. The alt label
      // remains linked; loading one image must never also navigate.
      const slot = document.createElement('span'); slot.className = 'image-slot';
      const link = span.closest('a');
      if (link) { (linkedSlots.get(link) || link).after(slot); linkedSlots.set(link, slot); } else span.after(slot);
      slot.appendChild(button);
      button.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const img = document.createElement('img');
        img.alt = span.textContent; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => { slot.textContent = 'Image could not load'; }, {once:true});
        slot.replaceChildren(img);
        img.src = item.url; // The only resource assignment, after this image's consent.
      }, {once:true});
    }
    if (typeof mayflyEnhanceLinks === 'function') mayflyEnhanceLinks(fragment);
    if (typeof mayflyEnhanceCode === 'function') mayflyEnhanceCode(fragment);
    return fragment;
  } catch { return fallback(); }
}
