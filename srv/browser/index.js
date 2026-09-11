const link = document.getElementById('newbtn'), status = document.getElementById('status');
let creating = false;
async function createChannel(){
  if (creating) return;
  creating = true;
  link.setAttribute('aria-busy', 'true');
  status.textContent = 'Creating…';
  try {
    const url = await newChannel();
    if (location.hash === '#new') location.replace(url); else location.assign(url);
  } catch(err){
    status.textContent = 'Could not create a channel: ' + err.message;
    creating = false;
    link.removeAttribute('aria-busy');
  }
}
link.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  return createChannel();
});
// Back from an ordinary creation restores a usable, inert landing page.
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  creating = false; link.removeAttribute('aria-busy'); status.textContent = '';
});
if (location.hash === '#new') createChannel();
