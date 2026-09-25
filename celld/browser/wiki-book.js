// Optional documentation layout. Content, editing and discussion keep the same
// controllers and capability URLs as the classic view.
function wikiBook({api,pageURL,fullURL,navigate,revealParents,report}) {
  if (document.body.dataset.wikiLayout !== 'book' || !document.body.dataset.wikiId) return null;
  const $ = id => document.getElementById(id);
  const el = (tag,text,id) => { const node=document.createElement(tag);if(text)node.textContent=text;if(id)node.id=id;return node; };
  const action = (text,id,fn) => { const node=el('button',text,id);node.type='button';node.addEventListener('click',fn);return node; };
  const icons={menu:'M4 6h16M4 12h16M4 18h16',close:'m6 6 12 12M6 18 18 6',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    book:'M12 5v16M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-6-2-10 1Z',file:'M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h6',
    chevron:'m9 5 7 7-7 7',plus:'M12 5v14M5 12h14',refresh:'M20 12a8 8 0 1 1-2.34-5.66L20 9M20 4v5h-5',check:'m5 12 4 4L19 6',
    chat:'M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4ZM8 10h8M8 14h5',options:'M5 6h14M5 12h14M5 18h14M9 3v6M15 9v6M10 15v6'};
  function icon(name){
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.classList.add('wiki-icon');path.setAttribute('d',icons[name]);svg.append(path);return svg;
  }
  function iconButton(node,name,label){node.replaceChildren(icon(name));node.classList.add('wiki-icon-button');node.setAttribute('aria-label',label);node.title=label;return node;}
  function summary(label,name){const node=el('summary');node.className='wiki-book-summary';node.append(icon(name),el('span',label),icon('chevron'));return node;}
  const primary = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  const visit = (node,id) => node.addEventListener('click',event=>{if(!primary(event))return;event.preventDefault();void navigate(id).catch(report);});
  const nav=$('wiki-pages-nav'), reading=$('wiki-reading'), header=$('wiki-header');
  const home=document.createComment('Desktop wiki navigation');nav.before(home);
  const mobile=matchMedia('(max-width:800px)'),drawer=el('dialog',null,'wiki-navigation-drawer');
  drawer.setAttribute('aria-labelledby','wiki-title');document.body.append(drawer);
  const pages=iconButton(action(null,'wiki-pages-toggle',()=>openDrawer()),'menu','Open page navigation');
  pages.setAttribute('aria-controls','wiki-navigation-drawer');pages.setAttribute('aria-expanded','false');pages.setAttribute('aria-haspopup','dialog');pages.hidden=true;
  const closePages=iconButton(action(null,'wiki-pages-close',()=>closeDrawer()),'close','Close page navigation');
  function settled(){pages.setAttribute('aria-expanded','false');document.body.classList.remove('wiki-drawer-open');}
  function closeDrawer(restore=true){
    const wasOpen=drawer.open;if(wasOpen)drawer.close();settled();if(wasOpen&&restore&&mobile.matches)pages.focus({preventScroll:true});return wasOpen;
  }
  function openDrawer(){
    if(!mobile.matches||drawer.open||$('wiki-main').hidden)return;
    drawer.showModal();document.body.classList.add('wiki-drawer-open');pages.setAttribute('aria-expanded','true');
    const target=nav.querySelector('a[aria-current=page]')||closePages;target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});
  }
  function placeNavigation(){closeDrawer(false);if(mobile.matches)drawer.append(nav);else home.after(nav);}
  drawer.addEventListener('cancel',event=>{event.preventDefault();closeDrawer();});
  drawer.addEventListener('close',()=>{if(!drawer.open)settled();});
  drawer.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const targets=[...drawer.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(node=>node.tabIndex>=0&&!node.disabled&&node.checkVisibility());
    const first=targets[0],last=targets.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
  const outside=event=>{const box=drawer.getBoundingClientRect();return event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom;};
  let backdropPress=false;
  drawer.addEventListener('pointerdown',event=>{backdropPress=event.target===drawer&&outside(event);});
  drawer.addEventListener('pointerup',event=>{backdropPress=backdropPress&&event.target===drawer&&outside(event);});
  drawer.addEventListener('pointercancel',()=>{backdropPress=false;});
  drawer.addEventListener('click',event=>{if(backdropPress&&event.target===drawer&&outside(event)){event.preventDefault();event.stopPropagation();closeDrawer();}backdropPress=false;});
  mobile.addEventListener('change',placeNavigation);
  const search=action(null,'wiki-book-search',()=>openSearch());search.hidden=true;
  search.append(icon('search'),el('span','Search this wiki'),el('kbd',/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ K':'Ctrl K'));search.setAttribute('aria-label','Search this wiki');
  search.setAttribute('aria-keyshortcuts','Control+K Meta+K');search.setAttribute('aria-haspopup','dialog');
  header.insertBefore(search,header.lastElementChild);header.prepend(pages);
  const searchDialog=el('dialog',null,'wiki-search-dialog');searchDialog.setAttribute('aria-labelledby','wiki-search-heading');
  const searchHeading=el('h2','Search this wiki','wiki-search-heading'),closeSearch=action('Close',null,()=>searchDialog.close());
  const searchTop=el('div');searchTop.className='wiki-actions';searchTop.append(searchHeading,closeSearch);
  searchDialog.append(searchTop,$('wiki-search-form'),$('wiki-results'));document.body.append(searchDialog);
  function openSearch(){closeDrawer(false);if(!searchDialog.open)searchDialog.showModal();$('wiki-query').focus();}
  document.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&!event.altKey&&!$('wiki-main').hidden && event.target.tagName!=='TEXTAREA'&&!event.target.isContentEditable){event.preventDefault();openSearch();}
  });
  const overview=$('wiki-overview'),options=el('details',null,'wiki-book-options');options.append(summary('Wiki options','options'));
  const navHead=el('div',null,'wiki-navigation-head'),identity=el('div');identity.append(el('small','KNOWLEDGE BASE'),$('wiki-title'));navHead.append(icon('book'),identity,closePages);
  const navTools=nav.querySelector('.wiki-actions');navTools.id='wiki-navigation-tools';navTools.querySelector('h2').textContent='Contents';
  iconButton($('wiki-new-page'),'plus','Create a new page');
  const refresh=iconButton($('wiki-refresh'),'refresh','Refresh pages'),refreshLabel=el('span','Refresh');refresh.append(refreshLabel);
  const refreshMessage=el('p',null,'wiki-refresh-status');refreshMessage.setAttribute('role','status');refreshMessage.setAttribute('aria-atomic','true');navTools.after(refreshMessage);
  let refreshReset;
  function refreshState(state='idle'){
    clearTimeout(refreshReset);refresh.dataset.state=state;
    refresh.replaceChildren(icon(state==='success'?'check':'refresh'),refreshLabel);
    refreshLabel.textContent=state==='loading'?'Refreshing…':state==='success'?'Updated':'Refresh';
    const label=state==='loading'?'Refreshing pages':state==='success'?'Updated. Refresh pages':'Refresh pages';refresh.setAttribute('aria-label',label);refresh.title=label;
    refreshMessage.textContent=state==='loading'?'Refreshing pages…':state==='success'?'Pages refreshed.':state==='error'?'Could not refresh pages. Try again.':'';
    refreshMessage.classList.toggle('wiki-error',state==='error');
    if(state==='success')refreshReset=setTimeout(()=>refreshState(),2000);
  }
  const scroll=el('div',null,'wiki-navigation-scroll');scroll.append($('wiki-tree'));nav.append(scroll);nav.prepend(navHead);
  options.append(...overview.children,header.querySelector('.wiki-actions').cloneNode(true),$('wiki-privacy'));overview.remove();
  const companions=el('details',null,'wiki-book-companions'),companionSummary=summary('Linked chats','chat');
  companions.append(companionSummary,$('companions'));scroll.append(companions,options);
  new MutationObserver(()=>{const count=$('companions').querySelectorAll('.space-list a').length;companionSummary.querySelector('span').textContent='Linked chats'+(count?' · '+count:'');}).observe($('companions'),{childList:true,subtree:true});
  placeNavigation();
  const crumbs=el('nav',null,'wiki-breadcrumbs');crumbs.setAttribute('aria-label','Breadcrumb');reading.prepend(crumbs);
  const pager=el('nav',null,'wiki-page-navigation');pager.setAttribute('aria-label','Previous and next pages');pager.hidden=true;reading.append(pager);
  const discussion=el('details',null,'wiki-book-discussion');discussion.append(summary('Discussion','chat'),$('wiki-discussion'));discussion.hidden=true;reading.append(discussion);
  const discuss=action('Discuss this page','wiki-open-discussion',()=>revealDiscussion());discuss.hidden=true;
  $('wiki-page-bar').querySelector('.wiki-actions').append(discuss);
  const outline=el('aside',null,'wiki-outline'),contents=el('details',null,'wiki-on-this-page'),toc=el('ol',null,'wiki-toc');
  outline.setAttribute('aria-label','On this page');contents.append(summary('On this page','file'),toc);outline.append(contents);$('wiki-main').querySelector('.wiki-layout').append(outline);outline.hidden=true;
  const wide=matchMedia('(min-width:1101px)');contents.open=wide.matches;wide.addEventListener('change',event=>{contents.open=event.matches;});
  let selected=null,epoch=0,observer=null,canDiscuss=false,isEditing=false,ancestors=[];
  function markPage(){for(const a of nav.querySelectorAll('a[data-page-id]')){if(a.dataset.pageId===selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}}
  function revealDiscussion(){
    if(!canDiscuss||isEditing)return;
    discussion.open=true;discussion.scrollIntoView({block:'start'});$('wiki-comment-body').focus({preventScroll:true});
  }
  function focusSection(node){for(const a of toc.querySelectorAll('a')){if(a.dataset.section===node.id)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');}}
  async function show(page,revision){
    const turn=++epoch,changed=selected!==page.id;selected=page.id;ancestors=[];canDiscuss=!revision&&!page.deleted;isEditing=false;markPage();
    discuss.hidden=discussion.hidden=!canDiscuss;discussion.open=false;
    const fromDrawer=closeDrawer(false);if(searchDialog.open)searchDialog.close();
    if(changed)reading.scrollIntoView({block:'start'});
    if(fromDrawer){reading.tabIndex=-1;reading.focus({preventScroll:true});}
    pager.hidden=true;pager.replaceChildren();crumbs.replaceChildren();toc.replaceChildren();observer?.disconnect();
    const root=el('a',$('wiki-title').textContent);root.href=fullURL();crumbs.append(root,el('span',' / '+page.title));
    const all=[...$('wiki-content').querySelectorAll('h1,h2,h3,h4,h5,h6')];
    if(all[0]?.tagName==='H1'&&all.length>1)all.shift();
    const headings=all.slice(0,200);
    for(const [index,node] of headings.entries()){
      if(!node.id)node.id='outline-'+index;node.tabIndex=-1;node.classList.add('wiki-anchor');
      const copy=node.cloneNode(true);for(const button of copy.querySelectorAll('button'))button.remove();
      const a=el('a',copy.textContent.trim()),li=el('li');li.className='wiki-toc-level-'+node.tagName.slice(1);a.dataset.section=node.id;a.href=pageURL(page.id,revision,node.id);
      a.addEventListener('click',event=>{if(!primary(event))return;event.preventDefault();history.replaceState({},'',a.href);node.scrollIntoView({block:'start'});node.focus({preventScroll:true});focusSection(node);});
      li.append(a);toc.append(li);
    }
    if(all.length>200)toc.append(el('li','Showing the first 200 headings.'));
    outline.hidden=!headings.length;
    if(headings.length){
      observer=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);if(visible[0])focusSection(visible[0].target);},{rootMargin:'-90px 0px -65% 0px'});
      for(const node of headings)observer.observe(node);
    }
    if(page.deleted)return;
    try{
      const navigation=await api('/pages/'+page.id+'/navigation');if(turn!==epoch)return;
      ancestors=navigation.ancestors;
      crumbs.replaceChildren(root);
      for(const item of navigation.ancestors){const a=el('a',item.title);a.href=pageURL(item.id);visit(a,item.id);crumbs.append(el('span',' / '),a);}
      const title=el('span',page.title);title.setAttribute('aria-current','page');crumbs.append(el('span',' / '),title);
      for(const [direction,item] of [['Previous',navigation.previous],['Next',navigation.next]])if(item){
        const a=el('a');a.className='wiki-page-'+direction.toLowerCase();a.href=pageURL(item.id);a.append(el('small',direction+' page'),el('strong',item.title));visit(a,item.id);pager.append(a);
      }
      pager.hidden=isEditing||!pager.children.length;
      await revealParents(navigation.ancestors,()=>turn===epoch);if(turn===epoch)markPage();
    }catch(error){if(turn===epoch)report(error);}
  }
  return {
    ready(){pages.hidden=search.hidden=false;},show,markPage,revealDiscussion,refreshState,closeNavigation:()=>closeDrawer(false),
    async treeRefreshed(){const turn=epoch;await revealParents(ancestors,()=>turn===epoch);if(turn===epoch)markPage();},
    pageRow(page,link,expand){
      const row=el('div');row.className='wiki-page-row';link.replaceChildren(icon(page.has_children?'book':'file'),el('span',page.title));
      row.append(link);
      if(page.has_children){expand.className='wiki-branch-toggle';expand.replaceChildren(icon('chevron'));row.append(expand);}
      return row;
    },
    editing(value){if(value)closeDrawer(false);isEditing=value;outline.hidden=value||!toc.children.length;pager.hidden=value||!pager.children.length;discussion.hidden=discuss.hidden=value||!canDiscuss;},
  };
}
