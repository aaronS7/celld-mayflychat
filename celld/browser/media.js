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
function mayflyImageViewer(source, card, trigger) {
  if(!card.isConnected || !source.complete)return;
  // Some browsers omit intrinsic pixel dimensions for viewBox-only SVGs.
  const naturalWidth=source.naturalWidth || source.clientWidth || 300;
  const naturalHeight=source.naturalHeight || source.clientHeight || 150;
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
  const dialog=el('dialog',null,'media-image-dialog'), toolbar=el('div',null,'media-image-toolbar');
  dialog.setAttribute('aria-label','Image viewer: '+(source.alt || 'Image attachment'));
  const title=el('strong',source.alt || 'Image attachment','media-image-title');
  const controls=el('div',null,'media-image-controls'), zoom=el('output',null,'media-image-zoom');
  zoom.setAttribute('aria-label','Image zoom');zoom.setAttribute('aria-live','polite');
  const button=(text,cls,label,action)=>{const node=el('button',text,cls);node.type='button';node.setAttribute('aria-label',label);node.addEventListener('click',action);return node;};
  const viewport=el('div',null,'media-image-viewport'), stage=el('div',null,'media-image-stage'), image=el('img',null,'media-image-full');
  viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label','Image view. Use arrow keys to pan.');
  image.alt=source.alt;image.referrerPolicy='no-referrer';image.draggable=false;
  // Reuse the authorized preview URL, including the opaque data URL for SVG.
  image.src=source.currentSrc || source.src;
  stage.append(image);viewport.append(stage);
  let scale=1, fitted=true, drag;
  const fitScale=()=>{
    const bounds=viewport.getBoundingClientRect(),style=getComputedStyle(viewport);
    // client dimensions round to pixels; floor the actual inner box so a
    // fractional flex size cannot leave an unnecessary overflow scrollbar.
    const width=Math.floor(Math.min(viewport.clientWidth,bounds.width-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth)));
    const height=Math.floor(Math.min(viewport.clientHeight,bounds.height-parseFloat(style.borderTopWidth)-parseFloat(style.borderBottomWidth)));
    return Math.min(1,width/naturalWidth,height/naturalHeight);
  };
  const minimum=()=>Math.min(.1,fitScale());
  const setScale=(value,anchor={x:viewport.clientWidth/2,y:viewport.clientHeight/2})=>{
    const previous=image.getBoundingClientRect(), bounds=viewport.getBoundingClientRect();
    const point={x:(bounds.left+viewport.clientLeft+anchor.x-previous.left)/scale,y:(bounds.top+viewport.clientTop+anchor.y-previous.top)/scale};
    scale=Math.max(minimum(),Math.min(8,value));
    const width=naturalWidth*scale,height=naturalHeight*scale;
    image.style.width=width+'px';image.style.height=height+'px';
    stage.style.width=width+'px';stage.style.height=height+'px';
    viewport.scrollLeft=(stage.clientWidth-width)/2+point.x*scale-anchor.x;
    viewport.scrollTop=(stage.clientHeight-height)/2+point.y*scale-anchor.y;
    zoom.textContent=Math.round(scale*100)+'%';
    // Keep the focused control in the dialog when zoom reaches its limit.
    out.setAttribute('aria-disabled',String(scale<=minimum()));inside.setAttribute('aria-disabled',String(scale>=8));
    fit.setAttribute('aria-pressed',String(fitted));actual.setAttribute('aria-pressed',String(scale===1));
  };
  const change=(value,anchor)=>{
    const next=Math.max(minimum(),Math.min(8,value));
    if(next===scale)return;
    fitted=false;setScale(next,anchor);
  };
  const fitImage=()=>{
    // Measure the full view without scrollbars left over from the previous
    // zoom level, so fitting has the same result on opening and after panning.
    fitted=true;viewport.style.overflow='hidden';setScale(fitScale());
    viewport.scrollTo(0,0);viewport.style.removeProperty('overflow');
  };
  const out=button('−','media-image-zoom-out','Zoom out',()=>change(scale/1.25));
  const inside=button('+','media-image-zoom-in','Zoom in',()=>change(scale*1.25));
  const fit=button('Fit','media-image-fit','Fit image to view',fitImage);
  const actual=button('100%','media-image-actual','View image at actual size',()=>change(1));
  const close=button('Close','media-image-close','Close image viewer',()=>dialog.close());
  controls.append(out,zoom,inside,fit,actual,close);toolbar.append(title,controls);
  dialog.append(toolbar,viewport,el('p','Scroll to zoom. Drag or swipe to pan. Escape closes.','media-image-help'));
  viewport.addEventListener('wheel',event=>{
    if(!event.deltaY)return;
    event.preventDefault();
    const bounds=viewport.getBoundingClientRect(),delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1);
    change(scale*Math.exp(-Math.max(-300,Math.min(300,delta))*.002),{x:event.clientX-bounds.left-viewport.clientLeft,y:event.clientY-bounds.top-viewport.clientTop});
  },{passive:false});
  // Touch scrolling remains native; pointer capture makes mouse dragging work
  // even when the pointer leaves the image or the viewport.
  viewport.addEventListener('pointerdown',event=>{
    if(event.pointerType==='touch' || event.button!==0)return;
    const bounds=viewport.getBoundingClientRect(),x=event.clientX-bounds.left-viewport.clientLeft,y=event.clientY-bounds.top-viewport.clientTop;
    if(x<0 || y<0 || x>=viewport.clientWidth || y>=viewport.clientHeight)return;
    // Overlay scrollbars sit inside the client box; leave their edge area to
    // the browser when the corresponding scrollbar can be present.
    if(viewport.scrollHeight>viewport.clientHeight && x>=viewport.clientWidth-16)return;
    if(viewport.scrollWidth>viewport.clientWidth && y>=viewport.clientHeight-16)return;
    if(viewport.scrollWidth<=viewport.clientWidth && viewport.scrollHeight<=viewport.clientHeight)return;
    event.preventDefault();viewport.focus({preventScroll:true});viewport.setPointerCapture(event.pointerId);
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
    viewport.classList.add('is-dragging');
  });
  viewport.addEventListener('pointermove',event=>{
    if(!drag || drag.id!==event.pointerId)return;
    viewport.scrollLeft=drag.left+drag.x-event.clientX;viewport.scrollTop=drag.top+drag.y-event.clientY;
  });
  const endDrag=()=>{drag=null;viewport.classList.remove('is-dragging');};
  viewport.addEventListener('pointerup',endDrag);viewport.addEventListener('pointercancel',endDrag);viewport.addEventListener('lostpointercapture',endDrag);
  dialog.addEventListener('keydown',event=>{
    if(event.altKey || event.ctrlKey || event.metaKey)return;
    if(event.key==='+' || event.key==='=')change(scale*1.25);
    else if(event.key==='-')change(scale/1.25);
    else if(event.key==='0')change(1);
    else if(event.key.toLowerCase()==='f')fitImage();
    else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))viewport.scrollBy({left:event.key==='ArrowLeft'?-80:event.key==='ArrowRight'?80:0,top:event.key==='ArrowUp'?-80:event.key==='ArrowDown'?80:0});
    else return;
    event.preventDefault();
  });
  let backdropPress=false;
  const outside=event=>{const bounds=dialog.getBoundingClientRect();return event.clientX<bounds.left || event.clientX>bounds.right || event.clientY<bounds.top || event.clientY>bounds.bottom;};
  dialog.addEventListener('pointerdown',event=>{backdropPress=event.target===dialog && outside(event);});
  dialog.addEventListener('click',event=>{if(backdropPress && event.target===dialog && outside(event))dialog.close();backdropPress=false;});
  let resizeFrame;
  // Refit outside observer delivery: changing overflow during delivery can
  // otherwise trigger a ResizeObserver loop when the viewport is resized.
  const resize=new ResizeObserver(()=>{
    if(fitted && !resizeFrame)resizeFrame=requestAnimationFrame(()=>{
      resizeFrame=null;if(dialog.open && fitted)fitImage();
    });
  });
  const removed=new MutationObserver(()=>{if(!card.isConnected || !dialog.isConnected)dialog.close();});
  dialog.addEventListener('close',()=>{
    resize.disconnect();cancelAnimationFrame(resizeFrame);removed.disconnect();dialog.remove();
    if(trigger.isConnected)trigger.focus({preventScroll:true});
  },{once:true});
  document.body.append(dialog);dialog.showModal();fitImage();close.focus({preventScroll:true});
  resize.observe(viewport);removed.observe(document.body,{childList:true,subtree:true});
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
        const textLanguage=language||mayflyTextLanguage(name,value.type)||'text';
        preview.replaceChildren(mayflyTextPreview(source,{name,language:textLanguage,format:true}));
        if(textLanguage==='html' && typeof wikiHtmlBlock==='function')preview.append(wikiHtmlBlock(source,{showSource:false,name}));
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
      if(load.disabled || load.hidden)return;
      load.disabled=true;status.textContent='Loading '+kind+'…';
      try {
        const value=await getFile();if(!card.isConnected)return;
        // Finish asynchronous SVG conversion before attaching the preview.
        const src=kind==='image' && svgFile(value) ? await mayflyImageDataURL(imageBlob(value)) : value.url;
        if(!card.isConnected)return;
        const media=document.createElement(kind==='image'?'img':'video');
        let enlarge, thumbnail;
        if(kind==='image'){
          media.alt=name || 'Image attachment';media.referrerPolicy='no-referrer';
          enlarge=el('button','Enlarge','media-enlarge');enlarge.type='button';enlarge.hidden=true;
          thumbnail=el('button',null,'media-image-trigger');thumbnail.type='button';thumbnail.disabled=true;
          for(const control of [enlarge,thumbnail]) {
            control.setAttribute('aria-label','Enlarge '+media.alt);control.setAttribute('aria-haspopup','dialog');
            control.addEventListener('click',()=>mayflyImageViewer(media,card,control));
          }
          thumbnail.append(media);actions.append(enlarge);
        }
        else {media.controls=true;media.playsInline=true;media.preload='metadata';media.setAttribute('aria-label',name || 'Video attachment');}
        media.addEventListener('error',()=>{if(enlarge){enlarge.hidden=true;thumbnail.disabled=true;}status.textContent='Preview unavailable in this browser. You can still download the file.';});
        media.addEventListener(kind==='image'?'load':'loadedmetadata',()=>{if(enlarge){enlarge.hidden=false;thumbnail.disabled=false;}status.textContent=external?'External file. If it opens, use your browser’s Save command.':'';},{once:true});
        preview.replaceChildren(thumbnail || media);
        // A data URL gives SVG previews an opaque origin even if opened from
        // the image menu. Never insert untrusted SVG markup into the page DOM.
        media.src=src;
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
