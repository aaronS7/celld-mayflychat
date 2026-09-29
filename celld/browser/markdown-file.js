// Fetch only on activation, without credentials or referrers. External requests
// run in an opaque sandbox so the main page keeps connect-src 'self'.
async function mayflyReadMarkdownFile(url) {
  const target=new URL(url), limit=256*1024;
  if(!['http:','https:'].includes(target.protocol) || target.username || target.password)throw new Error('Unsupported file URL');
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(target.href,{credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:'text/markdown, text/plain;q=0.9'},signal:controller.signal});
    if(!response.ok || !response.body)throw new Error('File unavailable');
    if(Number(response.headers.get('Content-Length'))>limit)throw new Error('size');
    const reader=response.body.getReader(), chunks=[];let size=0;
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      size+=value.length;if(size>limit)throw new Error('size');
      chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(source.includes('\0'))throw new Error('Not text');
    return source;
  } finally {clearTimeout(timer);controller.abort();}
}
function mayflyLoadMarkdownFile(url) {
  if(new URL(url).origin===location.origin)return mayflyReadMarkdownFile(url);
  return new Promise((resolve,reject)=>{
    const frame=document.createElement('iframe'), id=crypto.randomUUID();
    frame.hidden=true;frame.title='Load Markdown file';frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';
    const finish=(source,error)=>{
      clearTimeout(timer);window.removeEventListener('message',receive);frame.remove();
      if(error)reject(new Error(error));else resolve(source);
    };
    const receive=event=>{
      if(event.source!==frame.contentWindow || event.data?.type!=='mayfly-markdown-file-result' || event.data.id!==id)return;
      if(event.data.error){finish(null,event.data.error==='size'?'size':'File unavailable');return;}
      if(typeof event.data.source!=='string' || new TextEncoder().encode(event.data.source).length>256*1024){finish(null,'size');return;}
      finish(event.data.source);
    };
    const timer=setTimeout(()=>finish(null,'File unavailable'),20000);
    window.addEventListener('message',receive);
    frame.addEventListener('load',()=>frame.contentWindow?.postMessage({type:'mayfly-markdown-file',id,url},'*'),{once:true});
    frame.src='/static/markdown-file-frame';document.body.append(frame);
  });
}
