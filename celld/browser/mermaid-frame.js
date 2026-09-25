// This document has a sandboxed opaque origin and no access to wiki secrets.
let queue=Promise.resolve();
addEventListener('message',event=>{
  if(event.source!==parent || event.data?.type!=='mayfly-mermaid-render')return;
  const {id,source}=event.data;
  if(typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id) || typeof source!=='string' || new TextEncoder().encode(source).length>8192)return;
  const render=async()=>{
    let url;
    try {
      const result=await window.mayflyMermaid.render('mayfly-mermaid-'+id.replaceAll('-',''),source);
      const blob=new Blob([result.svg],{type:'image/svg+xml'});
      if(blob.size>1024*1024)throw new Error('Diagram output too large');
      url=await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch { /* The source remains available in the parent page. */ }
    parent.postMessage({type:'mayfly-mermaid-result',id,url},'*');
  };
  queue=queue.then(render,render);
});
