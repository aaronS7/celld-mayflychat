async function historyHasNoTransition(tab){
  const history=await cdp('Page.getNavigationHistory',{},tab.sessionId);
  assert(history.entries.every(e=>e.url!==config.host+'/#new'),'creation transition leaked into history');
}
const reports=[];
(async()=>{
  const version=await cdp('Browser.getVersion');
  // Linux Chrome uses Ctrl for a new tab. Meta/Alt pass-through is separately
  // checked with all modifiers in the served-script unit test.
  const newTabModifier=process.platform==='darwin'?4:2;
  for(const path of ['/',config.channel,config.missing]) {
    for(const gesture of [{name:'primary'}, {name:'enter',key:true},
      {name:'new-tab',modifiers:newTabModifier}, {name:'middle',button:'middle'},
      {name:'shift-window',modifiers:8}, {name:'foreground-tab',modifiers:newTabModifier|8}]) {
      const source=await open(path), before=await count(), original=config.host+path;
      const native=!!(gesture.modifiers||gesture.button);
      assert.equal(await evaluate(source,"document.getElementById('newbtn').tagName"),'A');
      if(path===config.missing)assert.equal(await evaluate(source,"document.querySelector('h1').textContent"),'No such channel');
      assert.equal(await evaluate(source,"document.getElementById('newbtn').getAttribute('href')"),'/#new');
      await evaluate(source,"window.creationRequests=0; const originalFetch=fetch; window.fetch=(path,...args)=>{if(path==='/new')creationRequests++;return originalFetch(path,...args)}");
      const oldTargets=new Set((await cdp('Target.getTargets')).targetInfos.map(t=>t.targetId));
      await input(source,'#newbtn',gesture);
      let destination=source;
      if(native){
        const created=await until(async()=> (await cdp('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!oldTargets.has(t.targetId)),gesture.name+' native target');
        destination=await attach(created.targetId);
      }
      await channelReady(destination);
      await until(async()=>await count()===before+1,'one creation');
      await sleep(40);
      assert.equal(await count(),before+1,'one POST per activation');
      await historyHasNoTransition(destination);
      const destinationURL=await evaluate(destination,'location.href');
      assert.notEqual(destinationURL,original);
      if(native){
        const sourceWindow=await cdp('Browser.getWindowForTarget',{targetId:source.targetId});
        const destinationWindow=await cdp('Browser.getWindowForTarget',{targetId:destination.targetId});
        assert.equal(sourceWindow.windowId===destinationWindow.windowId,gesture.name!=='shift-window','native tab/window choice');
        assert.equal(await evaluate(source,'location.href'),original,'originating tab overwritten');
        assert.equal(await evaluate(source,'creationRequests'),0,'background creation in originating tab');
        assert.equal(await evaluate(source,"document.getElementById('newbtn').hasAttribute('aria-busy')"),false);
        await close(destination);
      }
      if(path==='/' && gesture.name==='primary'){
        const history=await cdp('Page.getNavigationHistory',{},source.sessionId);
        const landing=history.entries.find(e=>e.url===config.host+'/');
        assert(landing,'ordinary creation must retain the landing history entry');
        await cdp('Page.navigateToHistoryEntry',{entryId:landing.id},source.sessionId);
        await until(()=>evaluate(source,"location.pathname==='/' && typeof creating !== 'undefined' && !creating && !document.getElementById('newbtn').hasAttribute('aria-busy')"),'usable landing after Back');
        assert.equal(await count(),before+1,'Back must not create again');
      }
      reports.push({page:path==='/'?'landing':path===config.missing?'missing':'channel',gesture:gesture.name,nativeNewTarget:native});
      await close(source);
    }
  }
  // Direct #new entry creates once and replaces, rather than preserving, the
  // transition in browser history. Other fragments remain inert.
  let before=await count(), direct=await open('/#new');
  await channelReady(direct); await historyHasNoTransition(direct); await sleep(40);
  assert.equal(await count(),before+1); await close(direct);
  for(const path of ['/','/#NEW']){
    before=await count(); const tab=await open(path); await sleep(40);
    assert.equal(await count(),before); assert.equal(await evaluate(tab,'location.href'),config.host+path); await close(tab);
  }
  // Brand/footer/document navigation is not commandeered by the new action.
  // Observe a normal primary navigation and a native modified navigation.
  for(const fixture of [
    {path:'/',selector:'footer a[href="/docs/about.md"]',destination:'/docs/about.md'},
    {path:config.channel,selector:'a.brand',destination:'/'},
    {path:'/docs/about.md',selector:'footer a[href="/docs/security.md"]',destination:'/docs/security.md'},
    {path:config.channel,selector:'.txt a[href="'+config.external+'"]',destination:config.external,newTarget:true}]) {
    for(const native of [false,true]) {
      const {targetId}=await cdp('Target.createTarget',{url:'about:blank'}), source=await attach(targetId);
      await cdp('Page.navigate',{url:config.host+fixture.path},source.sessionId);
      await until(()=>evaluate(source,'document.readyState === "complete" && !!document.querySelector('+JSON.stringify(fixture.selector)+')'),'ordinary link page');
      const newTarget=native||fixture.newTarget;
      const oldTargets=new Set((await cdp('Target.getTargets')).targetInfos.map(t=>t.targetId)), before=await count();
      await input(source,fixture.selector,{modifiers:native?newTabModifier:0});
      let destination=source;
      if(newTarget){
        const created=await until(async()=> (await cdp('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!oldTargets.has(t.targetId)),'ordinary native target');
        destination=await attach(created.targetId);
      }
      await until(()=>evaluate(destination,'location.href === '+JSON.stringify(new URL(fixture.destination,config.host).href)+' && document.readyState === "complete"'),'ordinary destination');
      assert.equal(await count(),before,'ordinary link created a channel');
      if(newTarget){assert.equal(await evaluate(source,'location.href'),config.host+fixture.path);await close(destination)}
      await close(source);
    }
  }
  console.log(JSON.stringify({browser:version.product,creation:reports,directFragment:'pass',ordinaryLinks:'8 passed'}));
  await cdp('Browser.close'); await exited;
})().then(()=>process.exit(0),async err=>{console.error(err);chrome.kill();await exited;process.exit(1)});
