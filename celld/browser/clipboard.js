// Clipboard writes start inside the click gesture, including deferred image work.
function mayflyCopyMarkdown(source, name, language) {
  const escape = value => value.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  let width=3;
  for(const match of source.matchAll(/`+/g))width=Math.max(width,match[0].length+1);
  const fence='`'.repeat(width), lang=mayflyCodeLanguage(language);
  return (name && name!=='Code' ? '**'+escape(name)+'**\n\n' : '')+fence+(lang==='text'?'':lang)+'\n'+source+(source.endsWith('\n')?'':'\n')+fence;
}
function mayflyCopyHTML(source, language) {
  const escape=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Semantic formatting survives clipboard sanitization without inline styles.
  // Browser clipboard parsing applies the page's strict content security policy.
  let html='',position=0;
  for(const token of mayflyCodeTokens(source,language)) {
    const tag=token.kind==='comment'?'em':['keyword','property'].includes(token.kind)?'strong':null;
    html+=escape(source.slice(position,token.start))+(tag?'<'+tag+'>':'')+escape(source.slice(token.start,token.end))+(tag?'</'+tag+'>':'');
    position=token.end;
  }
  return '<pre><code>'+html+escape(source.slice(position))+'</code></pre>';
}
function mayflyWriteClipboard(data) {
  // A browser may reject the write before it consumes deferred attachment data.
  for(const value of Object.values(data))if(value instanceof Promise)void value.catch(()=>{});
  if(navigator.clipboard?.write && typeof ClipboardItem==='function') {
    return navigator.clipboard.write([new ClipboardItem(data)]).then(()=>false);
  }
  // Text is already in memory, so this fallback also retains the click gesture.
  if(typeof data['text/plain']==='string' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(data['text/plain']).then(()=>Object.hasOwn(data,'text/html'));
  }
  return Promise.reject(new Error('Clipboard unavailable'));
}
function mayflyCopyOptions(options, status) {
  const details=document.createElement('details'), summary=document.createElement('summary'), choices=document.createElement('span');
  details.className='media-copy';summary.textContent='Copy';summary.setAttribute('aria-label','Copy options');choices.className='media-copy-options';
  details.append(summary,choices);
  let busy=false;
  for(const option of options) {
    const button=document.createElement('button');button.type='button';button.textContent=option.label;button.className=option.className;
    button.addEventListener('click',async()=>{
      if(busy)return;
      busy=true;button.disabled=true;status.textContent='Copying…';
      try {
        const plain=await mayflyWriteClipboard(option.data());
        status.textContent=plain?'Contents copied as plain text.':option.success;
      } catch {status.textContent=option.failure||'Copy unavailable. Select the text or use Download.';}
      finally {busy=false;button.disabled=false;details.open=false;if(details.isConnected)summary.focus({preventScroll:true});}
    });
    choices.append(button);
  }
  details.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();details.open=false;summary.focus({preventScroll:true});}});
  details.addEventListener('focusout',event=>{if(event.relatedTarget && !details.contains(event.relatedTarget))details.open=false;});
  return details;
}
function mayflyImageDataURL(blob) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function mayflyClipboardPNG(blob) {
  if(blob.type==='image/png')return blob;
  if(blob.type==='image/svg+xml') {
    const image=new Image();image.src=await mayflyImageDataURL(blob);await image.decode();
    if(!image.naturalWidth || !image.naturalHeight || image.naturalWidth*image.naturalHeight>16*1024*1024)throw new Error('Image too large to copy');
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    canvas.getContext('2d').drawImage(image,0,0);
    return await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Image conversion failed')),'image/png'));
  }
  const bitmap=await createImageBitmap(blob);
  try {
    // Avoid allocating an unbounded canvas for unusually large uploaded images.
    if(bitmap.width*bitmap.height>16*1024*1024)throw new Error('Image too large to copy');
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    canvas.getContext('2d').drawImage(bitmap,0,0);
    return await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Image conversion failed')),'image/png'));
  } finally {bitmap.close();}
}
