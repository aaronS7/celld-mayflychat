// HTML previews are opt-in. Source is sent only to a sandboxed document with
// its own strict CSP; the wiki page never inserts the source as markup.
function wikiHtmlBlock(source,{showSource=true,name='HTML'}={}) {
  const card=document.createElement('div'),actions=document.createElement('div');
  const toggle=document.createElement('button'),status=document.createElement('span');
  const viewport=document.createElement('div');
  card.className='wiki-html';card.setAttribute('role','group');card.setAttribute('aria-label',name+' preview');
  actions.className='wiki-html-actions';toggle.type='button';toggle.textContent='Preview HTML';
  status.className='meta';status.setAttribute('role','status');
  viewport.className='wiki-html-viewport';viewport.hidden=true;
  actions.append(toggle,status);card.append(actions,viewport);
  if(showSource){
    const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
    details.open=true;summary.textContent='HTML source';pre.textContent=source;
    details.append(summary,pre);card.append(details);
  }
  const size=new TextEncoder().encode(source).length;
  if(size>262144){toggle.disabled=true;status.textContent='HTML preview is limited to 256 KiB. The source remains available.';return card;}
  let frame=null,cleanup=null;
  toggle.addEventListener('click',()=>{
    if(frame){cleanup?.();frame.remove();frame=null;viewport.hidden=true;toggle.textContent='Preview HTML';status.textContent='';return;}
    const id=crypto.randomUUID();
    frame=document.createElement('iframe');frame.title=name+' rendered preview';
    frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';
    frame.className='wiki-html-frame';
    const current=frame;
    let timer;
    const finish=ok=>{
      cleanup?.();
      if(frame!==current)return;
      status.textContent=ok?'':'HTML preview could not be rendered.';
      if(!ok){current.remove();frame=null;viewport.hidden=true;toggle.textContent='Preview HTML';}
    };
    const receive=event=>{
      if(event.source!==current.contentWindow || event.data?.type!=='mayfly-html-preview-result' || event.data.id!==id)return;
      finish(event.data.ok===true);
    };
    cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);cleanup=null;};
    window.addEventListener('message',receive);
    timer=setTimeout(()=>finish(false),10000);
    current.addEventListener('load',()=>current.contentWindow?.postMessage({type:'mayfly-html-preview',id,source},'*'),{once:true});
    current.src='/static/html-preview-frame';
    viewport.replaceChildren(current);viewport.hidden=false;
    toggle.textContent='Hide preview';status.textContent='Rendering preview…';
    card.querySelector('details')?.removeAttribute('open');
  });
  return card;
}
