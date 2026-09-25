// App-owned media controls are added only after Markdown sanitization.
function mayflyMediaKind(type, name) {
  if (['image/png','image/jpeg','image/gif','image/webp','image/svg+xml'].includes(type) || (type==='application/octet-stream' && /\.svg$/i.test(name))) return 'image';
  if (['video/mp4','video/webm','video/ogg'].includes(type)) return 'video';
  if (mayflyTextLanguage(name, type)) return 'text';
  return 'file';
}
function mayflyLinkedFile(url) {
  try {
    const path = new URL(url).pathname;
    if (/\.(mp4|webm|ogv)$/i.test(path)) return 'video';
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return 'image';
    if (mayflyTextLanguage(path) || /\.(pdf|zip|gz|tar|7z|docx?|xlsx?|pptx?|mp3|wav|ogg)$/i.test(path)) return 'file';
  } catch {}
  return null;
}
function mayflyMedia({name, kind, url, resolve, language, autoImage = false, autoText = false}) {
  const el = (tag, text, cls) => { const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node; };
  const card=el('span',null,'mayfly-media'), title=el('strong',name || 'Attachment','media-name');
  const actions=el('span',null,'media-actions'), preview=el('span',null,'media-preview'), status=el('span',null,'media-status');
  status.setAttribute('role','status');
  card.append(title,actions,preview,status);
  let file, pending, sharedFile;
  const share=el('button','Share video','media-share');share.type='button';share.hidden=true;
  share.addEventListener('click',async()=>{
    if(!sharedFile)return;
    share.disabled=true;
    try {await navigator.share({files:[sharedFile]});status.textContent='Video handed to your device’s share sheet.';}
    catch(error){status.textContent=error.name==='AbortError'?'Sharing canceled.':'Sharing unavailable. You can still download the video.';}
    finally {share.disabled=false;}
  });
  const getFile=async()=>{
    if(file)return file;
    pending??=Promise.resolve().then(resolve || (()=>({url,name}))).catch(error=>{pending=null;throw error;});
    file=await pending;
    if(kind==='video' && file.blob && navigator.canShare && navigator.share && !sharedFile) {
      try {
        const candidate=new File([file.blob],file.name||name||'video.mp4',{type:file.blob.type});
        if(navigator.canShare({files:[candidate]})){sharedFile=candidate;share.hidden=false;}
      } catch { /* Download stays available when the device cannot share files. */ }
    }
    return file;
  };
  const svgFile=value=>!!value.blob && (value.type==='image/svg+xml' || /\.svg$/i.test(value.name||name||''));
  const imageBlob=value=>svgFile(value) ? new Blob([value.blob],{type:'image/svg+xml'}) : value.blob;
  const external=url && new URL(url,location.href).origin!==location.origin;
  const download=el(url?'a':'button',external?'Download / open':'Download','media-download');
  if(url){download.href=url;download.download='';download.target='_blank';download.rel='noopener noreferrer';download.referrerPolicy='no-referrer';}
  else {
    download.type='button';
    download.addEventListener('click',async()=>{
      download.disabled=true;status.textContent='Preparing download…';
      try {
        const value=await getFile();if(!card.isConnected)return;
        const a=document.createElement('a');a.href=value.url;a.download=value.name || name || 'attachment';
        document.body.append(a);a.click();a.remove();status.textContent='Download started.';
      } catch {status.textContent='Download unavailable. Try again.';}
      finally {download.disabled=false;}
    });
  }
  actions.append(download);
  if(kind==='video' && resolve)actions.append(share);
  if(kind==='image' && resolve) {
    actions.append(mayflyCopyOptions([{label:'Copy image',className:'media-copy-image',
      data:()=>({'image/png':getFile().then(value=>mayflyClipboardPNG(imageBlob(value)))}),success:'Image copied as PNG.',failure:'Image copy unavailable. You can still download the image.'}],status));
  }
  if(external)status.textContent='External file. If it opens, use your browser’s Save command.';
  if(kind==='text' && resolve) {
    const load=el('button','Preview text','media-load');load.type='button';actions.prepend(load);
    const show=async()=>{
      if(load.disabled||load.hidden)return;
      load.disabled=true;status.textContent='Loading text preview…';
      try {
        const value=await getFile();
        const source=new TextDecoder('utf-8',{fatal:true}).decode(await value.blob.arrayBuffer());
        if(!card.isConnected)return;
        if(source.includes('\0'))throw new Error('Not text');
        preview.replaceChildren(mayflyTextPreview(source,{name,language:language||mayflyTextLanguage(name,value.type)||'text',format:true}));
        load.hidden=true;status.textContent='';
      } catch {status.textContent='Text preview unavailable. The file may be binary or use another encoding. You can still download it.';}
      finally {load.disabled=false;}
    };
    load.addEventListener('click',show);
    // Owned wiki files may load automatically; external links stay opt-in.
    if(autoText)void show();
  }
  if(kind==='image' || kind==='video') {
    const load=el('button',kind==='image'?'Load image':'Load video','media-load');load.type='button';actions.prepend(load);
    const show=async()=>{
      load.disabled=true;status.textContent='Loading '+kind+'…';
      try {
        const value=await getFile();if(!card.isConnected)return;
        const media=document.createElement(kind==='image'?'img':'video');
        if(kind==='image'){media.alt=name;media.referrerPolicy='no-referrer';}
        else {media.controls=true;media.playsInline=true;media.preload='metadata';media.setAttribute('aria-label',name || 'Video attachment');}
        media.addEventListener('error',()=>{status.textContent='Preview unavailable in this browser. You can still download the file.';});
        media.addEventListener(kind==='image'?'load':'loadedmetadata',()=>{status.textContent=external?'External file. If it opens, use your browser’s Save command.':'';},{once:true});
        preview.replaceChildren(media);
        // A data URL gives SVG previews an opaque origin even if opened from
        // the image menu. Never insert untrusted SVG markup into the page DOM.
        media.src=kind==='image' && svgFile(value) ? await mayflyImageDataURL(imageBlob(value)) : value.url;
        load.hidden=true;
        if(kind==='video' && (media.requestFullscreen || media.webkitEnterFullscreen)) {
          const full=el('button','Fullscreen','media-fullscreen');full.type='button';full.setAttribute('aria-label','View video fullscreen');
          full.addEventListener('click',async()=>{
            try {
              if(media.requestFullscreen && document.fullscreenEnabled)await media.requestFullscreen();
              else if(media.webkitEnterFullscreen)media.webkitEnterFullscreen();
              else throw new Error('Fullscreen unavailable');
            } catch {status.textContent='Fullscreen is unavailable here. Try the player’s fullscreen control or download the video.';}
          });
          actions.append(full);
        }
      } catch {load.disabled=false;status.textContent='Attachment unavailable. Try again.';}
    };
    load.addEventListener('click',show);
    // The renderer inserts the fragment before the async resolver completes.
    if(autoImage && kind==='image')void show();
  }
  return card;
}
function mayflyEnhanceLinks(fragment) {
  for(const a of fragment.querySelectorAll('a[href]')) {
    if(a.closest('.mayfly-media'))continue;
    const kind=mayflyLinkedFile(a.href);
    if(kind)a.replaceWith(mayflyMedia({name:a.textContent,kind,url:a.href}));
  }
}
