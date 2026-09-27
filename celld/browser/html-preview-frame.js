// Only app-owned code runs here. The iframe sandbox gives this document an
// opaque origin; its CSP blocks network resources even when CSS names them.
const htmlPreviewRoot=document.getElementById('content');
const htmlPreviewCleaner=DOMPurify(window);
const htmlPreviewTags=['p','div','span','section','article','header','footer','main','aside','nav','h1','h2','h3','h4','h5','h6','br','hr','strong','b','em','i','u','s','small','mark','sub','sup','blockquote','pre','code','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','figure','figcaption','img','style'];
const htmlPreviewAttrs=['class','id','title','style','alt','src','width','height','colspan','rowspan','start','dir'];
const safeImage=/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
addEventListener('message',event=>{
  if(event.source!==parent || event.data?.type!=='mayfly-html-preview')return;
  const {id,source}=event.data;
  if(typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id) || typeof source!=='string' || new TextEncoder().encode(source).length>262144)return;
  let ok=false;
  try {
    if(!htmlPreviewCleaner.isSupported)throw new Error('Sanitizer unavailable');
    const fragment=htmlPreviewCleaner.sanitize(source,{ALLOWED_TAGS:htmlPreviewTags,ALLOWED_ATTR:htmlPreviewAttrs,ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,WHOLE_DOCUMENT:true,RETURN_DOM_FRAGMENT:true});
    for(const node of fragment.querySelectorAll('[src]')){
      const src=node.getAttribute('src');
      if(node.localName!=='img' || !src || src.length>131072 || !safeImage.test(src))node.removeAttribute('src');
    }
    const output=document.createDocumentFragment();
    for(const style of fragment.querySelectorAll('style'))output.append(style);
    const content=fragment.querySelector('body') || fragment;
    while(content.firstChild)output.append(content.firstChild);
    htmlPreviewRoot.replaceChildren(output);
    ok=true;
  } catch {htmlPreviewRoot.replaceChildren();}
  parent.postMessage({type:'mayfly-html-preview-result',id,ok},'*');
});
