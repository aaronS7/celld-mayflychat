function wikiExport({api, book, currentPage}) {
  const $=id=>document.getElementById(id), dialog=$('wiki-export-dialog'), prepare=$('wiki-export-prepare'), form=$('wiki-export-download'), progress=$('wiki-export-progress'), message=$('wiki-export-status');
  let job=null, timer=null, preparing=false, selection=null, opener=null;
  const say=(text,error=false)=>{message.textContent=text;message.classList.toggle('wiki-error',error);};
  const size=bytes=>bytes>=1073741824?(bytes/1073741824).toFixed(2)+' GiB':bytes>=1048576?(bytes/1048576).toFixed(1)+' MiB':Math.ceil(bytes/1024)+' KiB';
  function update(value) {
    job=value; form.hidden=value.state!=='ready'; prepare.disabled=['ready','downloading'].includes(value.state);
    $('wiki-export-cancel').hidden=!['ready','downloading'].includes(value.state);
    progress.hidden=false;progress.max=value.bytes||1;progress.value=value.sent||0;
    if(value.state==='ready') {
      progress.hidden=true;
      form.action=location.pathname.replace(/\/$/,'')+'/export/'+value.id+'/download';
      $('wiki-export-ticket').value=value.ticket;
      $('wiki-export-save').textContent='Download ZIP · '+size(value.bytes);
      const unresolved=value.unresolved_pages?.length||0;
      say(value.pages+' '+(value.pages===1?'page':'pages')+' and '+value.attachments+' uploaded '+(value.attachments===1?'file':'files')+'. Ready to download; this export expires in five minutes.'+(unresolved?' Review '+unresolved+' '+(unresolved===1?'link':'links')+' to other wiki pages before committing; see _mayfly/references.json.':''));
    } else if(value.state==='downloading') say('Downloading '+size(value.sent)+' of '+size(value.bytes)+'…');
    else if(value.state==='complete') {progress.value=value.bytes;say('ZIP sent to your browser. Check Downloads to confirm it finished.');}
    else {progress.hidden=true;say(value.error||(value.state==='canceled'?'Export canceled.':'Export unavailable. Please try again.'),value.state==='failed');}
  }
  async function poll() {
    if(!job)return;
    try {update(await api('/export/'+job.id));if(job.state==='downloading'||job.state==='ready')timer=setTimeout(poll,1000);}
    catch {prepare.disabled=false;form.hidden=true;progress.hidden=true;say('Could not check the export. Check your connection and browser Downloads, then try again.',true);}
  }
  function open(target, control) {
    const active=preparing||job&&['ready','downloading'].includes(job.state);
    if(!active){
      selection=target;job=null;clearTimeout(timer);form.hidden=true;progress.hidden=true;prepare.disabled=false;$('wiki-export-cancel').hidden=true;say('');
      $('wiki-export-heading').textContent=target?'Export this page':'Export this wiki';
      $('wiki-export-description').textContent=target?'Download “'+target.title+'” (saved revision '+target.revision+') and its referenced uploads in one ZIP, up to 1 GiB total.':'Download saved Markdown pages, uploaded files, page metadata and discussion in one ZIP, up to 1 GiB total.';
      $('wiki-export-note').textContent=target?'Save drafts first. Other pages and unreferenced uploads are excluded. Metadata and current discussion are included separately in _mayfly/. External files remain links. Pause edits and uploads until the download finishes.':'Save any drafts first. Old revisions, deleted pages and linked chats are excluded. External files remain links. Pause edits and uploads until the download finishes.';
      $('wiki-export-help').textContent=target?'Extract README.md and attachments/ into a folder on your repository branch, then commit them together and open a PR. Pasting Markdown into a PR description requires uploading attachments to GitHub separately.':'Extract the ZIP to migrate to another wiki. Import tools may need adjustments to links, hierarchy and discussion.';
    } else if(selection?.id!==target?.id||selection?.revision!==target?.revision) say('Finish or cancel this export, then reopen Export page or Export wiki to choose another download.');
    opener=control;book?.closeNavigation();dialog.showModal();
  }
  $('wiki-export').addEventListener('click',event=>open(null,event.currentTarget));
  $('wiki-export-page').addEventListener('click',event=>{const page=currentPage();if(page)open({id:page.id,title:page.title,revision:page.revision},event.currentTarget);});
  dialog.addEventListener('close',()=>{if(opener?.checkVisibility())opener.focus();else $('wiki-pages-toggle')?.focus();});
  prepare.addEventListener('click',async()=>{
    if(preparing)return;preparing=true;prepare.disabled=true;form.hidden=true;progress.hidden=false;progress.removeAttribute('value');
    clearTimeout(timer);say(selection?'Preparing the saved page, current discussion and referenced files…':'Preparing saved pages, discussion and uploaded files…');
    try {update(await api(selection?'/pages/'+selection.id+'/export?revision='+selection.revision:'/export',{method:'POST'}));}
    catch(error){progress.hidden=true;prepare.disabled=false;say(error.message,true);}
    finally{preparing=false;}
  });
  form.addEventListener('submit',()=>{
    if(!job||job.state!=='ready')return;
    say('Starting download…');form.hidden=true;clearTimeout(timer);timer=setTimeout(poll,500);
  });
  $('wiki-export-cancel').addEventListener('click',async()=>{
    if(!job)return;clearTimeout(timer);
    try {update(await api('/export/'+job.id,{method:'DELETE'}));}
    catch(error){say(error.message,true);}
  });
  window.addEventListener('pagehide',()=>clearTimeout(timer));
}
