(() => {
  const article = document.getElementById('document');
  const source = document.getElementById('document-source').textContent;
  // The escaped source remains readable if scripting or either vendor fails.
  try {
    if (!globalThis.marked || !globalThis.DOMPurify) return;
    const clean = DOMPurify(window);
    if (!clean.isSupported) return;
    const escape = text => String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const base = new marked.Renderer();
    const md = new marked.Marked({gfm:true, async:false, renderer:{
      html(token){ return escape(token.text); },
      image(token){ return escape(token.text); },
      checkbox(token){ return token.checked ? '[x] ' : '[ ] '; },
      text(token){
        if (token.escaped && !token.tokens) return escape(token.text);
        return base.text.call(this, token);
      }
    }});
    // Documents need ordinary relative and section links, unlike channel messages.
    clean.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName !== 'href') return;
      try {
        const url = new URL(data.attrValue, document.baseURI);
        if (node.nodeName !== 'A' || !['http:', 'https:'].includes(url.protocol)) data.keepAttr = false;
      } catch { data.keepAttr = false; }
    });
    const fragment = clean.sanitize(md.parse(source), {
      ALLOWED_TAGS:['p','br','hr','strong','em','del','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','pre','code','table','thead','tbody','tr','th','td','a'],
      ALLOWED_ATTR:['href','title','start','align'], ALLOW_DATA_ATTR:false, ALLOW_ARIA_ATTR:false,
      RETURN_DOM_FRAGMENT:true
    });
    // App-owned heading IDs make the document's section links navigable.
    const ids = new Set();
    for (const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const stem = heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
      let id = stem;
      for (let n = 1; ids.has(id); n++) id = stem + '-' + n;
      ids.add(id);
      heading.id = id;
    }
    article.replaceChildren(fragment);
  } catch { /* Keep the original text rather than partially rendered output. */ }
})();
