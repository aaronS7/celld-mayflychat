let unread = 0;
const poller = createPoller({
  read: signal => fetch(EVENTS+'?since='+last+'&wait=30', {signal, headers:hdr()}),
  deliver: async events => { const n=await render(events); if(!gone && document.hidden && n){unread+=n;tabTitle()} },
  isStopped: () => gone,
  onMissing: () => channelGone(),
  onUnauthorized: () => {status.textContent='The server rejected this key.'},
  onStatus: text => {status.textContent=text}
});
const poll=()=>poller.start(), wakePoll=()=>poller.wake();
watchPollLifecycle(poller,()=>{unread=0;tabTitle()});
