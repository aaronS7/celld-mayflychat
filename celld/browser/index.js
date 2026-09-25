const link = document.getElementById('newbtn'), status = document.getElementById('status');
const withWiki = document.getElementById('create-with-wiki'), wikiTitle = document.getElementById('create-wiki-title');
let creating = false, pendingPair = null;
withWiki.addEventListener('change',()=>{document.getElementById('create-wiki-options').hidden=!withWiki.checked;});
async function createChannel(){
  if (creating) return;
  creating = true; link.setAttribute('aria-busy','true'); status.textContent = 'Creating…';
  try {
    let url;
    if (withWiki.checked && !document.getElementById('paired-creation').hidden) {
      if (!pendingPair) pendingPair = await MayflySpaces.plan(location.origin,{chat:true,wiki:true,title:wikiTitle.value});
      withWiki.disabled = wikiTitle.disabled = true;
      url = (await MayflySpaces.complete(pendingPair)).chat_url;
    } else url = await newChannel();
    if (location.hash === '#new') location.replace(url); else location.assign(url);
  } catch(err){
    status.textContent = 'Could not finish creation: '+err.message;
    mayflyRecovery(document.getElementById('creation-recovery'),err.recovery || pendingPair);
    creating = false; link.removeAttribute('aria-busy');
  }
}
link.addEventListener('click',e=>{
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault(); return createChannel();
});
window.addEventListener('pageshow',e=>{
  if (!e.persisted) return;
  creating = false; pendingPair = null; withWiki.disabled = wikiTitle.disabled = false;
  link.removeAttribute('aria-busy'); status.textContent = ''; document.getElementById('creation-recovery').replaceChildren();
});
if (location.hash === '#new') createChannel();
