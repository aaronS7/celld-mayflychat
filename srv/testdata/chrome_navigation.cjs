async function open(path){
  const {targetId}=await cdp('Target.createTarget',{url:'about:blank'}), tab=await attach(targetId);
  await cdp('Page.navigate',{url:config.host+path},tab.sessionId);
  await until(()=>evaluate(tab,"document.readyState === 'complete' && !!document.getElementById('newbtn')"),'page load');
  if(path.startsWith('/c/') && path!==config.missing)await channelReady(tab);
  return tab;
}
async function channelReady(tab){
  return until(()=>evaluate(tab,"/^\\/c\\/[\\w-]{22}#[\\w-]{43}$/.test(location.pathname+location.hash) && typeof KS !== 'undefined' && KS !== null && !document.getElementById('main').hidden"),'channel ready');
}
async function close(tab){await cdp('Target.closeTarget',{targetId:tab.targetId})}
async function count(){return Number(await (await fetch(config.host+'/test-creates')).text())}
async function input(tab,selector,gesture){
  await cdp('Page.bringToFront',{},tab.sessionId);
  const point=await evaluate(tab, '(() => { const el=document.querySelector('+JSON.stringify(selector)+'); el.scrollIntoView(); el.focus(); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()');
  if(gesture.key){
    const p={key:'Enter',code:'Enter',windowsVirtualKeyCode:13};
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',...p},tab.sessionId);
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',...p},tab.sessionId);
  } else {
    const p={...point,button:gesture.button||'left',modifiers:gesture.modifiers||0,clickCount:1};
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...p},tab.sessionId);
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...p},tab.sessionId);
  }
}
