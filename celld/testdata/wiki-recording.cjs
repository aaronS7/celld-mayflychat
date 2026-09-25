const recordingFS=require('node:fs/promises'),recordingPath=require('node:path');
(async()=>{try{
  const {targetInfos}=await cdp('Target.getTargets'),tab=await attach(targetInfos.find(t=>t.type==='page').targetId);
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"window.recordingErrors=[];window.recordingViolations=[];window.addEventListener('error',e=>recordingErrors.push(e.message));window.addEventListener('unhandledrejection',e=>recordingErrors.push(String(e.reason)));window.addEventListener('securitypolicyviolation',e=>recordingViolations.push(e.violatedDirective));"},tab.sessionId);
  for(const mobile of [false,true]){
    const name=mobile?'mobile':'desktop',width=mobile?390:1440,height=mobile?844:1040,frames=recordingPath.join(config.frames,name);
    await recordingFS.mkdir(frames);
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile},tab.sessionId);
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:mobile},tab.sessionId);
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]},tab.sessionId);
    await cdp('Page.navigate',{url:config.url},tab.sessionId);
    await until(()=>evaluate(tab,'!!document.querySelector("#wiki-page-navigation a") && new URLSearchParams(location.search).has("page")'),'recording ready');
    await evaluate(tab,'document.fonts.ready');await sleep(350);
    const poster=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},tab.sessionId);
    await recordingFS.writeFile(recordingPath.join(config.output,'wiki-'+name+'-poster.png'),Buffer.from(poster.data,'base64'));
    // Presentation-only click feedback. Inputs still go through Chrome's actual
    // mouse/touch APIs; the nonce keeps the application's CSP intact.
    await evaluate(tab,`(()=>{const style=document.createElement('style');style.nonce=document.querySelector('style[nonce]').nonce;style.textContent='.demo-tap{position:fixed;pointer-events:none;width:32px;height:32px;border:2px solid var(--accent);border-radius:50%;background:color-mix(in srgb,var(--accent) 16%,transparent);z-index:10000;transform:translate(-50%,-50%);animation:demo-tap .65s ease-out forwards}@keyframes demo-tap{0%{opacity:1;scale:.65}100%{opacity:0;scale:1.5}}';document.head.append(style);window.showDemoTap=(x,y)=>{const ring=document.createElement('span');ring.className='demo-tap';ring.style.left=x+'px';ring.style.top=y+'px';(document.querySelector('dialog:modal')||document.body).append(ring);setTimeout(()=>ring.remove(),700);};})()`);
    let recording=true,frame=0;
    const cues=[],mark=text=>cues.push({start:frame/config.fps,text});
    const record=(async()=>{while(recording){const start=Date.now(),shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},tab.sessionId);await recordingFS.writeFile(recordingPath.join(frames,'frame-'+String(frame++).padStart(5,'0')+'.png'),Buffer.from(shot.data,'base64'));await sleep(Math.max(0,1000/config.fps-(Date.now()-start)));}})();
    const tapPoint=async(x,y)=>{
      await evaluate(tab,'window.showDemoTap('+x+','+y+')');
      if(mobile){await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]},tab.sessionId);await sleep(90);await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},tab.sessionId);}
      else {await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y},tab.sessionId);await sleep(130);await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x,y},tab.sessionId);await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y},tab.sessionId);}
    };
    const click=async selector=>{
      await evaluate(tab,'(()=>{const el=document.querySelector('+JSON.stringify(selector)+');if(el.closest("#wiki-header"))return;const r=el.getBoundingClientRect();if(el.closest("#wiki-navigation-scroll"))el.scrollIntoView({block:"nearest",behavior:"smooth"});else if(r.top<90||r.bottom>innerHeight-16)el.scrollIntoView({block:"center",behavior:"smooth"});})()');await sleep(550);
      const point=await evaluate(tab,'(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');await tapPoint(point.x,point.y);
    };
    const row=key=>'#wiki-tree a[data-page-id="'+config.pages[key]+'"]';
    const expand=key=>'button[aria-controls="wiki-children-'+config.pages[key]+'"]';
    const page=key=>until(()=>evaluate(tab,'new URLSearchParams(location.search).get("page")==='+JSON.stringify(config.pages[key])+' && !!document.querySelector("#wiki-page-navigation a")'),'page '+key);
    const menu=async()=>{await click('#wiki-pages-toggle');await until(()=>evaluate(tab,'document.getElementById("wiki-navigation-drawer").open && getComputedStyle(document.getElementById("wiki-navigation-drawer")).transform==="none"'),'drawer');};
    try{
      mark(mobile?'Mobile: the search bar stays in the header.':'Desktop: explore the sidebar without leaving the article.');await sleep(1700);
      if(mobile){mark('Open the page navigation drawer.');await menu();await sleep(1700);}
      mark('Refresh shows loading and completion. Network delay is simulated.');
      await cdp('Network.enable',{},tab.sessionId);
      await cdp('Network.emulateNetworkConditions',{offline:false,latency:1000,downloadThroughput:-1,uploadThroughput:-1},tab.sessionId);
      await click('#wiki-refresh');await until(()=>evaluate(tab,'document.getElementById("wiki-refresh").dataset.state==="loading"'),'refresh loading');
      await until(()=>evaluate(tab,'document.getElementById("wiki-refresh").dataset.state==="success"'),'refresh completed');
      await cdp('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1},tab.sessionId);await sleep(2200);
      mark('Expand a chapter to browse its pages.');await click(expand('guides'));await until(()=>evaluate(tab,'!document.getElementById("wiki-children-'+config.pages.guides+'").hidden'),'expanded guides');await sleep(1700);
      if(mobile){
        mark('The page tree scrolls independently of the article.');
        const point={x:170,y:620};await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]},tab.sessionId);
        for(let n=1;n<=10;n++){await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:170,y:620-n*25}]},tab.sessionId);await sleep(35);}
        await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},tab.sessionId);await sleep(1400);
      }
      mark(mobile?'Choose a page; the drawer closes and reading continues.':'Open a nested page. Breadcrumbs and selection follow along.');
      await click(row('agents'));await page('agents');await sleep(2100);
      if(mobile){
        mark('Reopen navigation at your current page.');await menu();await sleep(1500);
        mark('Tap the backdrop to return to the article.');await tapPoint(width-12,400);await until(()=>evaluate(tab,'!document.getElementById("wiki-navigation-drawer").open'),'backdrop dismissal');await sleep(1300);
      }else{
        mark('Jump straight to a section using the page outline.');await click('#wiki-toc li:nth-child(2) a');await sleep(1600);
      }
      mark('Search stays in its familiar position at the top.');await click('#wiki-book-search');await sleep(1100);
      await click('#wiki-query');for(const text of 'fencing'){await cdp('Input.insertText',{text},tab.sessionId);await sleep(125);}
      await until(()=>evaluate(tab,'!!document.querySelector("#wiki-results a")'),'search results');await sleep(1700);
      mark('Open the matching passage, with its source revision.');await click('#wiki-results a');await page('recovery');await sleep(2100);
      if(mobile){
        mark('The sidebar opens the matching chapter automatically.');await menu();await sleep(2000);
        await click(row('recovery'));await until(()=>evaluate(tab,'!new URLSearchParams(location.search).has("revision")'),'current page');await sleep(1400);
        mark('Open and close navigation without losing your place.');await menu();await sleep(1200);await click('#wiki-pages-close');await sleep(1200);
      }else{
        await click(row('recovery'));await until(()=>evaluate(tab,'!new URLSearchParams(location.search).has("revision")'),'current page');
        mark('Page discussion remains shared by people and agents.');await click('#wiki-open-discussion');await until(()=>evaluate(tab,'document.getElementById("wiki-book-discussion").open'),'discussion');await sleep(2200);
      }
      assert.deepEqual(await evaluate(tab,'recordingErrors'),[]);assert.deepEqual(await evaluate(tab,'recordingViolations'),[]);
      assert.ok(await evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'));
    }finally{recording=false;await record;}
    const time=seconds=>{const ms=Math.round(seconds*1000);return String(Math.floor(ms/3600000)).padStart(2,'0')+':'+String(Math.floor(ms/60000)%60).padStart(2,'0')+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0');};
    await recordingFS.writeFile(recordingPath.join(config.output,'wiki-'+name+'-demo.vtt'),'WEBVTT\n\n'+cues.map((cue,i)=>time(cue.start)+' --> '+time(cues[i+1]?.start??frame/config.fps)+'\n'+cue.text+'\n').join('\n'));
    console.log(name+': recorded '+frame+' frames from the running application; no browser errors or CSP violations.');
  }
}finally{chrome.kill('SIGTERM');await exited;}})().catch(error=>{console.error(error);process.exitCode=1;});
