// Kill Chrome before runNode's 60-second deadline, including a stuck CDP call.
const watchdog=setTimeout(()=>{console.error('CSP browser deadline');chrome.kill('SIGKILL');process.exit(1)},45000);
watchdog.unref();
async function state(){return (await fetch(config.host+'/csp-state')).json()}
async function visit(url,selector){
  const {targetId}=await cdp('Target.createTarget',{url:'about:blank'}), tab=await attach(targetId);
  await cdp('Page.navigate',{url},tab.sessionId);
  await until(()=>evaluate(tab,'document.readyState === "complete" && !!document.querySelector('+JSON.stringify(selector)+')'),'load '+selector);
  return tab;
}
const nonces=new Set();
async function styled(tab){
  const result=await evaluate(tab,"({nonces:[...document.querySelectorAll('script,style')].map(e=>e.nonce),sheets:[...document.querySelectorAll('style')].every(e=>!!e.sheet),display:getComputedStyle(document.querySelector('.shell')).display})");
  assert(result.nonces.length && result.nonces.every(n=>/^[A-Za-z0-9_-]{43}$/.test(n)),'all app scripts/styles have a 32-byte nonce');
  assert.equal(new Set(result.nonces).size,1,'one nonce per document');
  assert(!nonces.has(result.nonces[0]),'nonce reused across documents');nonces.add(result.nonces[0]);
  assert(result.sheets,'nonced stylesheets were rejected');assert.equal(result.display,'flex','shared CSS applies');
}
(async()=>{
  const version=await cdp('Browser.getVersion');
  const landing=await open('/');await styled(landing);
  await input(landing,'#newbtn',{});await channelReady(landing);await styled(landing);
  assert.equal((await state()).creates,1,'native creation posts once');
  await evaluate(landing,"document.getElementById('text').focus()");
  await cdp('Input.insertText',{text:'**Composed under CSP**'},landing.sessionId);
  await input(landing,'#sendbtn',{});
  await until(()=>evaluate(landing,"[...document.querySelectorAll('.txt strong')].some(e=>e.textContent==='Composed under CSP') && document.getElementById('text').value==='' && !document.getElementById('sendbtn').disabled"),'native form submission and delivery');
  await close(landing);

  const reader=await open(config.channel);await styled(reader);
  await until(()=>evaluate(reader,"document.querySelector('.txt')?.textContent.trim()==='fixture'"),'initial real poll');
  const response=await fetch(config.host+config.channel.split('#')[0]+'/events?last=0',{
    method:'POST',headers:{Authorization:'Bearer '+config.auth,'Content-Type':'application/json'},body:config.post});
  assert.equal(response.status,200);await response.text();
  await until(()=>evaluate(reader,"document.querySelectorAll('.load-image').length===2 && [...document.querySelectorAll('.txt strong')].some(e=>e.textContent==='Polled under CSP')"),'peer post through unmodified poll and Markdown');
  assert(await evaluate(reader,"[...document.querySelectorAll('.txt')].some(e=>e.textContent.includes('<img src='))"),'raw HTML stays literal');
  await sleep(150);assert.deepEqual((await state()).requests,{},'images must not preload');
  assert.equal(await evaluate(reader,"document.querySelectorAll('.txt img').length"),0);
  await input(reader,'.load-image',{});
  await until(()=>evaluate(reader,"document.querySelector('.txt img')?.naturalWidth===1"),'opted-in cross-origin HTTP image');
  assert.equal(await evaluate(reader,"document.querySelectorAll('.load-image').length"),1,'consent is per image');
  assert.deepEqual((await state()).requests,{'/probe/consented.png':1});

  // CDP only arranges DOM and observes state. All attempts below run from a
  // native click, outside Runtime.evaluate (whose eval privilege is not CSP evidence).
  await evaluate(reader,'('+function(probe){
    window.csp={executed:[],violations:[],evalError:null,fetchError:null};
    document.addEventListener('securitypolicyviolation',e=>csp.violations.push({directive:e.effectiveDirective,uri:e.blockedURI,disposition:e.disposition}));
    const run=document.createElement('button');run.id='csp-run';run.textContent='Run CSP probes';document.body.append(run);
    run.addEventListener('click',()=>{
      const inline=document.createElement('script');inline.textContent="csp.executed.push('inline')";document.body.append(inline);
      const script=document.createElement('script');script.src=location.origin+'/probe/self-script.js';document.body.append(script);
      const event=document.createElement('button');event.setAttribute('onclick',"csp.executed.push('event')");document.body.append(event);event.click();
      try { eval("csp.executed.push('eval')"); } catch(e) { csp.evalError=e.name; }
      const text=document.createElement('div');text.id='csp-style-text';document.body.append(text);
      const style=document.createElement('style');style.textContent='#csp-style-text{--csp-forbidden:yes}';document.head.append(style);
      const attr=document.createElement('div');attr.id='csp-style-attr';attr.setAttribute('style','--csp-forbidden:yes');document.body.append(attr);
      const base=document.createElement('base');base.href=probe+'/probe/base/';document.head.append(base);
      const frame=document.createElement('iframe');frame.src=probe+'/probe/frame';document.body.append(frame);
      const form=document.createElement('form');form.action=probe+'/probe/form';form.method='POST';document.body.append(form);form.requestSubmit();
      fetch(probe+'/probe/fetch',{mode:'no-cors'}).then(()=>csp.fetchError='allowed',e=>csp.fetchError=e.name);
      navigator.sendBeacon(probe+'/probe/beacon','blocked');
    },{once:true});
  }.toString()+')('+JSON.stringify(config.probe)+')');
  const originalURL=await evaluate(reader,'location.href');
  await input(reader,'#csp-run',{});
  const directives=['script-src-elem','script-src-attr','script-src','style-src-elem','style-src-attr','base-uri','frame-src','form-action','connect-src'];
  await until(async()=>{
    const evidence=await evaluate(reader,'csp');
    return evidence.fetchError && directives.every(d=>evidence.violations.some(v=>v.directive===d));
  },'CSP violation events for every probe');
  const evidence=await evaluate(reader,'csp');
  assert.deepEqual(evidence.executed,[],'unauthorized script executed');
  assert.equal(evidence.evalError,'EvalError','eval from a native click must be blocked');
  assert.equal(evidence.fetchError,'TypeError','cross-origin fetch must fail');
  assert(evidence.violations.every(v=>v.disposition==='enforce'),'report-only is insufficient');
  assert(evidence.violations.filter(v=>v.directive==='script-src-elem').length>=2,'inline and self-hosted scripts both blocked');
  assert(evidence.violations.some(v=>v.directive==='script-src' && v.uri==='eval'));
  assert(evidence.violations.filter(v=>v.directive==='connect-src').length>=2,'fetch and beacon both blocked');
  assert.equal(await evaluate(reader,'location.href'),originalURL,'form navigation blocked');
  assert.equal(await evaluate(reader,'document.baseURI'),originalURL,'base URL unchanged');
  assert.deepEqual(await evaluate(reader,"['csp-style-text','csp-style-attr'].map(id=>getComputedStyle(document.getElementById(id)).getPropertyValue('--csp-forbidden'))"),['',''],'inline stylesheet and style attribute blocked');
  await sleep(150);assert.deepEqual((await state()).requests,{'/probe/consented.png':1},'forbidden probes never reach either server');
  await close(reader);

  const docs=await visit(config.host+'/docs/about.md','#document h1');await styled(docs);
  assert.equal(await evaluate(docs,"getComputedStyle(document.getElementById('document')).minWidth"),'0px','document-specific CSS applies');
  assert.equal(await evaluate(docs,"!!document.getElementById('document-source')"),false,'trusted Markdown script rendered docs');await close(docs);
  const missing=await open(config.missing);await styled(missing);
  assert.equal(await evaluate(missing,"document.querySelector('.gone h1').textContent"),'No such channel');
  assert.equal(await evaluate(missing,"getComputedStyle(document.querySelector('.gone')).marginTop"),'32px','missing-page CSS applies');await close(missing);

  // Neither parent has CSP: an error document here is the app child's
  // frame-ancestors policy, not the parent's default-src/frame-src or SOP.
  for(const origin of [config.host,config.probe]){
    const parent=await visit(origin+'/csp-parent','#target');
    await evaluate(parent,'document.getElementById("target").src='+JSON.stringify(config.host+'/'));
    await until(async()=>{
      const tree=await cdp('Page.getFrameTree',{},parent.sessionId);
      const child=tree.frameTree.childFrames?.[0]?.frame;
      return child?.url==='chrome-error://chromewebdata/' && child.unreachableUrl===config.host+'/';
    },'app rejects '+(origin===config.host?'same':'cross')+'-origin framing');
    await close(parent);
  }
  assert.deepEqual((await state()).requests,{'/probe/consented.png':1});
  console.log(JSON.stringify({browser:version.product,creation:'native click',composition:'native send click',poll:'peer Markdown delivered',images:'one opted-in request; no preload',styles:'landing/channel/docs/missing',blocked:directives,framing:'same and cross origin'}));
  await cdp('Browser.close');await exited;clearTimeout(watchdog);
})().then(()=>process.exit(0),async err=>{console.error(err);chrome.kill('SIGKILL');await exited;process.exit(1)});
