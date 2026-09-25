// Text previews only create text nodes and app-owned spans, never rendered HTML.
function mayflyTextLanguage(name, type = '') {
  const extensions = {
    json:'json', jsonc:'jsonc', jsonl:'jsonl', ndjson:'jsonl', yaml:'yaml', yml:'yaml',
    toml:'toml', ini:'ini', conf:'ini', cfg:'ini', csv:'csv', tsv:'csv', txt:'text', log:'text',
    md:'markdown', markdown:'markdown', js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript',
    ts:'typescript', tsx:'typescript', py:'python', go:'go', rs:'rust', java:'java', c:'c', h:'c', cpp:'cpp', hpp:'cpp',
    sh:'bash', bash:'bash', zsh:'bash', sql:'sql', css:'css', html:'html', htm:'html', xml:'xml', svg:'xml', diff:'diff', patch:'diff'
  };
  const extension = String(name || '').toLowerCase().split('.').pop();
  if (Object.hasOwn(extensions, extension)) return extensions[extension];
  type = String(type).split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type)) return 'json';
  const types = {'application/x-ndjson':'jsonl','text/plain':'text','text/csv':'csv','text/tab-separated-values':'csv',
    'text/markdown':'markdown','application/yaml':'yaml','text/yaml':'yaml','application/xml':'xml','text/xml':'xml'};
  return Object.hasOwn(types,type) ? types[type] : null;
}
function mayflyCodeLanguage(language) {
  const value = String(language || '').trim().split(/\s/)[0].toLowerCase();
  const aliases = {js:'javascript',javascript:'javascript',ts:'typescript',typescript:'typescript',py:'python',python:'python',rust:'rust',sh:'bash',shell:'bash',yml:'yaml',ndjson:'jsonl',md:'markdown',plaintext:'text',text:'text'};
  return (Object.hasOwn(aliases,value) ? aliases[value] : mayflyTextLanguage('code.' + value)) || 'text';
}
function mayflyReadableText(source, language) {
  const text = source.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  // Bound formatting work and preserve number/string lexemes (JSON.stringify
  // would silently round large integer IDs). Downloads retain the source bytes.
  if (language !== 'json' || text.length > 512 * 1024 || new TextEncoder().encode(text).length > 512 * 1024) return {text, formatted:false};
  try { JSON.parse(text); } catch { return {text, formatted:false}; }
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g) || [];
  const pieces = []; let depth = 0, size = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]; let part = token;
    if (token === '{' || token === '[') {
      if (++depth > 64) return {text, formatted:false};
      if (tokens[i+1] !== (token === '{' ? '}' : ']')) part += '\n' + '  '.repeat(depth);
    } else if (token === '}' || token === ']') {
      depth--;
      if (tokens[i-1] !== (token === '}' ? '{' : '[')) part = '\n' + '  '.repeat(depth) + token;
    } else if (token === ',') part += '\n' + '  '.repeat(depth);
    else if (token === ':') part += ' ';
    if ((size += part.length) > 5 * 1024 * 1024) return {text, formatted:false};
    pieces.push(part);
  }
  const formatted = pieces.join('');
  return {text:formatted, formatted:formatted !== text};
}
function mayflyCodeTokens(value, language) {
  if (language === 'text') return [];
  // Limit both scanned characters and DOM nodes. The rest remains selectable
  // plain text when users expand a multi-megabyte file.
  const source = value.slice(0, 128 * 1024), tokens = [];
  if (language === 'xml' || language === 'html') {
    for(const match of source.matchAll(/<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/gi)) {
      tokens.push({start:match.index,end:match.index+match[0].length,kind:match[0].startsWith('<!--')?'comment':'property'});
      if(tokens.length>=2000)break;
    }
    return tokens;
  }
  const json = language === 'json' || language === 'jsonl';
  const hash = ['python','bash','yaml','toml','ini'].includes(language);
  const slash = ['javascript','typescript','go','rust','java','c','cpp','jsonc','css'].includes(language);
  const comments = [hash ? '#[^\\n]*' : '', slash ? '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)' : '', language === 'sql' ? '--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)' : '', ['xml','html'].includes(language) ? '<!--[\\s\\S]*?(?:-->|$)' : ''].filter(Boolean).join('|');
  const pattern = new RegExp((comments ? '('+comments+')|' : '((?!))|') +
    '("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|`(?:\\\\[\\s\\S]|[^`\\\\])*`)|' +
    '(-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|\\b([A-Za-z_$][\\w$]*)\\b', 'g');
  const keywords = new Set((json ? 'true false null' : 'const let var function async await return if else for while class new import from export throw try catch finally def in is and or not True False None func package type struct interface nil true false null undefined public private static void int string bool boolean select from where insert into update set create table join on as case when then end yes no').split(' '));
  for (const match of source.matchAll(pattern)) {
    if (!match[0]) continue;
    const property = /^(?:[^\S\n]*:)/.test(source.slice(match.index+match[0].length, match.index+match[0].length+100));
    const kind = match[1] ? 'comment' : match[2] ? (property ? 'property' : 'string') : match[3] ? 'number' : property && ['yaml','toml','ini','javascript','typescript'].includes(language) ? 'property' : keywords.has(match[4]) || (language === 'sql' && keywords.has(match[4].toLowerCase())) ? 'keyword' : null;
    if (kind) tokens.push({start:match.index,end:match.index+match[0].length,kind});
    if (tokens.length >= 2000) break;
  }
  return tokens;
}
function mayflyHighlight(code, value, language) {
  const fragment = document.createDocumentFragment(); let position = 0;
  for (const token of mayflyCodeTokens(value, language)) {
    fragment.append(value.slice(position,token.start));
    const span = document.createElement('span'); span.className = 'wiki-code-' + token.kind;
    span.textContent = value.slice(token.start,token.end); fragment.append(span); position = token.end;
  }
  fragment.append(value.slice(position)); code.replaceChildren(fragment);
}
function mayflyTextPreview(source, {language = 'text', name = 'Code', format = false} = {}) {
  const readable = format ? mayflyReadableText(source, language) : {text:source.replace(/\r\n?/g,'\n').replace(/\n$/,''),formatted:false};
  const value = readable.text;
  let lines = value ? 1 : 0, cutoff = value.length;
  for (let i=0; i<value.length; i++) if (value[i] === '\n') { if (lines === 50) cutoff=i; lines++; }
  // A minified record can be one extremely long line. Keep the initial view
  // small even then, and make the full original text available with Expand.
  cutoff = Math.min(cutoff, 16 * 1024);
  const shortened = cutoff < value.length;
  const el = (tag, cls, text) => {const node=document.createElement(tag);node.className=cls;if(text)node.textContent=text;return node;};
  const root=el('span','mayfly-text'), actions=el('span','media-actions text-actions'), info=el('span','text-coverage');
  const status=el('span','media-status text-copy-status');status.setAttribute('role','status');
  root.setAttribute('role','group');root.setAttribute('aria-label',name+' text preview');
  const pre=el('pre','text-source'), code=document.createElement('code'); pre.append(code); pre.tabIndex=0;
  pre.id='text-preview-'+crypto.randomUUID();pre.setAttribute('aria-label',name+' preview');
  const expand=el('button','text-expand'), minimize=el('button','text-minimize');
  for(const button of [expand,minimize]){button.type='button';button.setAttribute('aria-controls',pre.id);}
  let expanded=false, minimized=false;
  const render=()=>{
    const shown=expanded?value:value.slice(0,cutoff);
    pre.hidden=minimized; expand.hidden=minimized||!shortened;
    expand.textContent=expanded?'Show first 50 lines':'Expand';expand.setAttribute('aria-expanded',String(expanded));
    minimize.textContent=minimized?'Show preview':'Minimize';minimize.setAttribute('aria-expanded',String(!minimized));
    const total=lines+(lines===1?' line':' lines');
    info.textContent=language.toUpperCase()+(readable.formatted?' · formatted':'')+' · '+(minimized?'Preview minimized':value?'Showing '+(expanded||!shortened?total:(shown.match(/\n/g)||[]).length+1+' of '+total+(cutoff===16*1024?' (long line shortened)':'')):'Empty file');
    if(!minimized)mayflyHighlight(code,shown,language);
    else code.replaceChildren();
    pre.scrollTop=0;pre.scrollLeft=0;
  };
  expand.addEventListener('click',()=>{expanded=!expanded;render();});
  minimize.addEventListener('click',()=>{minimized=!minimized;if(minimized)expanded=false;render();});
  const copy=mayflyCopyOptions([
    {label:'Copy contents',className:'text-copy-contents',data:()=>({'text/plain':source}),success:'Full contents copied.'},
    {label:'Copy as Markdown',className:'text-copy-markdown',data:()=>({'text/plain':mayflyCopyMarkdown(value,name,language)}),success:'Full contents copied as Markdown.'},
    {label:'Copy formatted text',className:'text-copy-formatted',data:()=>({'text/html':mayflyCopyHTML(value,language),'text/plain':value}),success:'Full formatted text copied.'}
  ],status);
  actions.append(info,copy,expand,minimize);root.append(actions,status,pre);render();return root;
}
function mayflyEnhanceCode(fragment) {
  for(const code of fragment.querySelectorAll('pre > code')) {
    if(code.closest('.mayfly-text'))continue;
    const language=mayflyCodeLanguage(code.getAttribute('title'));
    code.parentElement.replaceWith(mayflyTextPreview(code.textContent,{language}));
  }
}
