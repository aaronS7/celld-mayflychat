// This frame has no wiki/chat credentials or access to the parent document.
let markdownFileStarted=false;
window.addEventListener('message',async event=>{
  if(markdownFileStarted || event.source!==parent || event.data?.type!=='mayfly-markdown-file' || typeof event.data.id!=='string' || typeof event.data.url!=='string')return;
  markdownFileStarted=true;
  const {id,url}=event.data;
  try {parent.postMessage({type:'mayfly-markdown-file-result',id,source:await mayflyReadMarkdownFile(url)},'*');}
  catch(error){parent.postMessage({type:'mayfly-markdown-file-result',id,error:error.message==='size'?'size':'File unavailable'},'*');}
});
