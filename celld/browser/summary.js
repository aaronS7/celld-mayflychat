// Shared chat/wiki presentation. The provider key and source selection stay on
// the server; only an explicit button press starts a model request.
(() => {
  if(document.body.dataset.aiSummary!=='1')return;
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
  const button=(text,fn)=>{const node=el('button',text);node.type='button';node.addEventListener('click',fn);return node;};
  const spark=()=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.classList.add('ai-summary-icon');path.setAttribute('d','m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6ZM20 2v4M18 4h4');svg.append(path);return svg;};
  async function init(){
    let cap,meta;
    try{
      cap=await MayflySpaces.capability(location.href);
      const response=await fetch(cap.path+(cap.kind==='chat'?'/config':''),{headers:{Authorization:'Bearer '+cap.auth},redirect:'error'});
      if(!response.ok)return;meta=await response.json();if(!meta.summary?.enabled)return;
    }catch{return;}
    const controls=el('div',null,'ai-summary-controls');controls.id='ai-summary-controls';
    const dialog=el('dialog',null,'ai-summary-dialog');dialog.id='ai-summary-dialog';dialog.setAttribute('aria-labelledby','ai-summary-heading');
    const heading=el('h2','AI summary');heading.id='ai-summary-heading';
    const close=button('Close',()=>dialog.close()),top=el('div',null,'ai-summary-top');top.append(spark(),heading,close);
    const title=el('p',null,'ai-summary-title'),coverage=el('p',null,'meta ai-summary-coverage');coverage.id='ai-summary-coverage';
    const notice=el('p','Selected saved text is sent to the configured AI provider. Review important details.', 'meta ai-summary-notice');
    const state=el('p',null,'ai-summary-state');state.id='ai-summary-state';state.setAttribute('role','status');state.setAttribute('aria-live','polite');
    const output=el('div',null,'ai-summary-output');output.id='ai-summary-output';output.setAttribute('aria-label','Generated summary');
    const sources=el('details',null,'ai-summary-sources');sources.hidden=true;
    const sourceHeading=el('summary','Sources'),sourceList=el('ol');sources.append(sourceHeading,sourceList);
    const stop=button('Stop',()=>active?.abort()),retry=button('Regenerate',()=>void start(target)),copy=button('Copy',async()=>{try{await navigator.clipboard.writeText(draft);state.textContent='Summary copied.';}catch{state.textContent='Could not copy. Select the summary text to copy it.';}});
    const actions=el('div',null,'ai-summary-actions');actions.append(stop,retry,copy);
    dialog.append(top,title,coverage,notice,state,output,sources,actions);document.body.append(dialog);
    let active=null,epoch=0,target=null,draft='',pending='',frame=null,finished=false,trigger=null;
    function flush(){
      frame=null;if(!pending)return;
      const span=el('span',pending,'ai-summary-piece');pending='';output.append(span);
    }
    function paint(){if(frame!==null){cancelAnimationFrame(frame);frame=null;}flush();}
    function renderFinal(){
      paint();output.classList.add('prose');
      output.replaceChildren(DOMPurify.sanitize(marked.parse(draft),{RETURN_DOM_FRAGMENT:true,ALLOWED_TAGS:['p','br','hr','strong','em','del','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','pre','code','table','thead','tbody','tr','th','td'],ALLOWED_ATTR:[],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false}));
    }
    function busy(value){dialog.dataset.busy=String(value);stop.hidden=!value;retry.disabled=value;copy.disabled=value||!draft;output.setAttribute('aria-busy',String(value));}
    function info(value){
      title.textContent=value.title;
      const unit=value.scope==='chat'?(value.total===1?'message':'messages'):(value.total===1?'page':'pages');
      coverage.textContent=(value.partial?'Bounded overview · ':'')+value.included+' of '+value.total+' '+unit+(value.sources.some(s=>s.excerpt)?' · Excerpts':'')+' · '+value.model;
      sourceList.replaceChildren();sources.hidden=false;sourceHeading.textContent='Sources · '+value.included;
      for(const source of value.sources){
        const li=el('li'),link=el('a',source.title+(source.revision?' · revision '+source.revision:'')+(source.excerpt?' · excerpt':''));
        if(cap.kind==='chat'&&Number.isSafeInteger(source.seq)){
          link.href=location.href;
          link.addEventListener('click',event=>{event.preventDefault();dialog.close();document.getElementById('m'+source.seq)?.scrollIntoView({block:'center'});});
        }else if(typeof source.url==='string'&&source.url.startsWith(cap.path+'?'))link.href=source.url+'#'+cap.key;
        li.append(link);sourceList.append(li);
      }
    }
    async function start(selection){
      if(!selection)return;
      const turn=++epoch;active?.abort();const abort=new AbortController();active=abort;target=selection;
      dialog.dataset.error='false';
      if(frame!==null)cancelAnimationFrame(frame);frame=null;pending=draft='';finished=false;
      output.replaceChildren();output.classList.remove('prose');sources.hidden=true;sources.open=false;sourceList.replaceChildren();
      title.textContent=selection.title;coverage.textContent='Reading saved text…';state.textContent='Preparing summary…';busy(true);
      if(!dialog.open)dialog.showModal();close.focus({preventScroll:true});
      try{
        const response=await fetch(cap.path+selection.path,{method:'POST',headers:{Authorization:'Bearer '+cap.auth},redirect:'error',signal:abort.signal});
        if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||'Summary unavailable. Try again.');}
        if(!response.body||!response.headers.get('content-type')?.startsWith('text/event-stream'))throw new Error('Summary streaming is unavailable.');
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        try{
          for(;;){
            const {value,done}=await reader.read();if(turn!==epoch)return;if(done)break;
            buffer+=decoder.decode(value,{stream:true});let end;
            while((end=buffer.indexOf('\n\n'))>=0){
              const record=buffer.slice(0,end);buffer=buffer.slice(end+2);
              const event=record.split('\n').find(line=>line.startsWith('event: '))?.slice(7),raw=record.split('\n').find(line=>line.startsWith('data: '))?.slice(6);
              if(!raw)continue;const data=JSON.parse(raw);
              if(event==='meta')info(data);
              else if(event==='delta'){
                if(typeof data.text!=='string'||draft.length+data.text.length>64000)throw new Error('Summary exceeded its limit.');
                draft+=data.text;pending+=data.text;state.textContent='Writing summary…';if(frame===null)frame=requestAnimationFrame(flush);
              }else if(event==='error')throw new Error(data.error||'Summary interrupted. Try again.');
              else if(event==='done'){finished=true;state.textContent=data.truncated?'Output limit reached. This summary is incomplete.':'Summary complete.';renderFinal();}
            }
            if(buffer.length>262144)throw new Error('Invalid summary stream.');
          }
        }finally{void reader.cancel().catch(()=>{});}
        if(!finished)throw new Error('The stream ended early. This summary is incomplete; try again.');
      }catch(error){
        if(turn!==epoch)return;paint();
        state.textContent=abort.signal.aborted?'Stopped. The summary is incomplete.':error.message;
        dialog.dataset.error=abort.signal.aborted?'false':'true';
      }finally{if(turn===epoch){active=null;busy(false);}}
    }
    dialog.addEventListener('close',()=>{active?.abort();trigger?.focus({preventScroll:true});});
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const items=[...dialog.querySelectorAll('button,a[href],summary')].filter(n=>!n.disabled&&n.checkVisibility());
      if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
      else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
    });
    window.addEventListener('pagehide',()=>active?.abort());
    function control(label,id,selection){const node=button('',()=>{trigger=node;dialog.dataset.error='false';void start(selection());});node.id=id;node.append(spark(),el('span',label));controls.append(node);return node;}
    if(cap.kind==='chat'){
      control('AI summary','chat-summary',()=>({path:'/summary',title:'Chat summary'}));
      document.querySelector('.view>header .actions').append(controls);
    }else{
      const page=control('Summarize page','wiki-summary-page',()=>{
        const query=new URLSearchParams(location.search),id=query.get('page');
        return id?{path:'/pages/'+encodeURIComponent(id)+'/summary'+(query.has('revision')?'?revision='+encodeURIComponent(query.get('revision')):''),title:'Page summary'}:null;
      });
      control('Summarize wiki','wiki-summary-all',()=>({path:'/summary',title:meta.title}));
      document.body.classList.add('ai-summary-enabled');document.getElementById('wiki-header').append(controls);
      const update=()=>{page.disabled=!new URLSearchParams(location.search).has('page')||!document.getElementById('wiki-editor').hidden;page.title=page.disabled?'Open a saved page to summarize it':'Summarize the saved page';};
      new MutationObserver(update).observe(document.getElementById('wiki-main'),{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});update();
    }
  }
  void init();
})();
