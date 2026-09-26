let wikiMermaidFrame, wikiMermaidQueue = Promise.resolve();

function wikiMermaidSandbox() {
  wikiMermaidFrame ??= new Promise((resolve,reject)=>{
    const frame=document.createElement('iframe');
    frame.className='wiki-mermaid-frame';frame.title='Diagram renderer';frame.setAttribute('aria-hidden','true');
    frame.sandbox='allow-scripts';frame.src='/static/mermaid-frame';
    frame.onload=()=>resolve(frame);frame.onerror=()=>reject(new Error('Renderer unavailable'));
    document.body.append(frame);
  }).catch(error=>{wikiMermaidFrame=null;throw error;});
  return wikiMermaidFrame;
}

async function wikiMermaidImage(source) {
  const frame=await wikiMermaidSandbox();
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const finish=(value,error)=>{clearTimeout(timer);window.removeEventListener('message',receive);error?reject(error):resolve(value);};
    const receive=event=>{
      if(event.source!==frame.contentWindow || event.data?.type!=='mayfly-mermaid-result' || event.data.id!==id)return;
      const url=event.data.url;
      if(typeof url==='string' && url.startsWith('data:image/svg+xml;base64,') && url.length<1500000)finish(url);
      else finish(null,new Error('Diagram unavailable'));
    };
    const timer=setTimeout(()=>finish(null,new Error('Renderer timed out')),15000);
    window.addEventListener('message',receive);
    frame.contentWindow.postMessage({type:'mayfly-mermaid-render',id,source},'*');
  });
}

function wikiMermaidBlock(source, count) {
  const card=document.createElement('div'), picture=document.createElement('div'), status=document.createElement('p');
  const details=document.createElement('details'), summary=document.createElement('summary'), pre=document.createElement('pre');
  card.className='wiki-mermaid';card.setAttribute('role','group');card.setAttribute('aria-label','Mermaid diagram');
  picture.className='wiki-mermaid-picture';status.className='meta';status.setAttribute('role','status');
  summary.textContent='Diagram source';pre.textContent=source;details.append(summary,pre);card.append(picture,status,details);
  if(count>10 || new TextEncoder().encode(source).length>8192) {
    status.textContent=count>10?'Only the first 10 diagrams on a page are rendered.':'Diagram source exceeds 8 KiB.';
    details.open=true;return card;
  }
  status.textContent='Rendering diagram…';
  const render=async()=>{
    if(!card.isConnected)return;
    try {
      const url=await wikiMermaidImage(source);if(!card.isConnected)return;
      const image=new Image();image.alt='Rendered Mermaid diagram';image.src=url;
      await image.decode();if(!card.isConnected)return;
      picture.replaceChildren(image);status.textContent='';
    } catch {
      if(card.isConnected){status.textContent='Diagram could not be rendered. Check its source.';details.open=true;}
    }
  };
  requestAnimationFrame(()=>{wikiMermaidQueue=wikiMermaidQueue.then(render,render);});
  return card;
}
