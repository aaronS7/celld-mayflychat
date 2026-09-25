// All author content is sanitized before adding app-owned links, images or tokens.
// No rendered Markdown HTML, inline SVG, automatic external media requests or scripts.
function wikiMarkdown(source, context) {
  const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clean = DOMPurify(window), images = new Map(), links = new Map();
  const nonce = crypto.randomUUID();let nextSlot=0;
  const slot = (map, value, label) => { const key=nonce+'-'+nextSlot++; map.set(key,value); return `<span title="${key}">${escape(label)}</span>`; };
  const decoded = s => clean.sanitize(s.replace(/</g,'&lt;'), {ALLOWED_TAGS:[],ALLOWED_ATTR:[],RETURN_DOM_FRAGMENT:true}).textContent;
  const safeHTTP = s => {
    if (!/^https?:\/\//i.test(s) || /[\s\u0000-\u001f\u007f\\]/u.test(s)) return null;
    try { const u=new URL(s); return ['http:','https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
  };
  const parser = new marked.Marked({gfm:true,async:false,renderer:{
    html(token){return escape(token.text);},
    heading(token){return '<h'+token.depth+(token.wikiSection?' title="'+nonce+'-'+token.wikiSection+'"':'')+'>'+this.parser.parseInline(token.tokens)+'</h'+token.depth+'>';},
    image(token){return slot(images,decoded(token.href),decoded(token.text));},
    link(token){return slot(links,decoded(token.href),decoded(token.text));},
    code(token){return '<pre><code title="'+escape(token.lang || '')+'">'+escape(token.text)+'</code></pre>';},
    checkbox(token){return token.checked?'[x] ':'[ ] ';}
  }});
  const tokens=parser.lexer(source);let line=1;
  for(const token of tokens){
    // Match the API's source-line anchors. Other Markdown headings (for
    // example an underlined title) must not shift later section citations.
    if(token.type==='heading' && /^ {0,3}#{1,6}\s/.test(token.raw))token.wikiSection='s'+line;
    line+=(token.raw.match(/\n/g)||[]).length;
  }
  const fragment=clean.sanitize(parser.parser(tokens),{ALLOWED_TAGS:['p','br','hr','strong','em','del','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','pre','code','table','thead','tbody','tr','th','td','span'],ALLOWED_ATTR:['title','start','align'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,RETURN_DOM_FRAGMENT:true});
  for(const heading of fragment.querySelectorAll('h1[title],h2[title],h3[title],h4[title],h5[title],h6[title]')){
    if(heading.title.startsWith(nonce+'-'))heading.id=heading.title.slice(nonce.length+1);
    heading.removeAttribute('title');
  }
  const attachment=(span,id)=>{
    const label=span.textContent, retry=document.createElement('button');retry.type='button';retry.textContent='Retry attachment';
    const load=async()=>{
      span.textContent=label+' · Loading attachment…';
      try {
        const info=await context.attachmentInfo(id);
        span.replaceWith(mayflyMedia({name:info.name,kind:mayflyMediaKind(info.type,info.name),language:mayflyTextLanguage(info.name,info.type),resolve:()=>context.attachment(id),autoImage:true,autoText:true}));
      } catch {span.textContent=label+' · Attachment unavailable. ';span.append(retry);}
    };
    retry.addEventListener('click',load);void load();
  };
  for(const span of fragment.querySelectorAll('span[title]')) {
    const key=span.title; span.removeAttribute('title');
    if(links.has(key)) {
      const href=links.get(key), page=/^page:([a-f0-9-]{36})$/.exec(href), file=/^attachment:([a-f0-9-]{36})$/.exec(href), external=safeHTTP(href);
      if(file){attachment(span,file[1]);continue;}
      const kind=external && mayflyLinkedFile(external);
      if(kind){span.replaceWith(mayflyMedia({name:span.textContent,kind,url:external}));continue;}
      if(page || external) {
        const a=document.createElement('a');a.textContent=span.textContent;
        a.href=page?context.pageURL(page[1]):external;
        if(!page){a.target='_blank';a.rel='noopener noreferrer';a.referrerPolicy='no-referrer';}
        span.replaceWith(a);
      }
    } else if(images.has(key)) {
      const href=images.get(key), file=/^attachment:([a-f0-9-]{36})$/.exec(href), external=safeHTTP(href);
      if(file)attachment(span,file[1]);
      else if(external)span.replaceWith(mayflyMedia({name:span.textContent,kind:'image',url:external}));
    }
  }
  mayflyEnhanceCode(fragment);
  return fragment;
}
