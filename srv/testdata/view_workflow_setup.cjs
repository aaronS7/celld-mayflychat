const assert = require('node:assert/strict');
globalThis.crypto = require('node:crypto').webcrypto;
const nativeFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = (path, options) => {
  const url = new URL(path, config.host);
  assert(!url.href.includes(config.key));
  assert(!(options?.body || '').includes(config.key));
  requests.push({url:url.href, options});
  return nativeFetch(url, options);
};
function node(){return {value:'',textContent:'',hidden:true,disabled:false,children:[],className:'',
  listeners:{},classList:{add(){},remove(){}},style:{setProperty(){}},
  addEventListener(k,fn){this.listeners[k]=fn},
  fire(k,props={}){return this.listeners[k]?.({target:this,currentTarget:this,preventDefault(){},...props})},
  focus(){document.activeElement=this;return this.fire('focus')},blur(){document.activeElement=null;return this.fire('blur')},
  select(){this.selected=true},closest(){return node()},replaceChildren(){this.textContent=''},
  querySelector(s){this.q ??= {}; return this.q[s] ??= node()},
  appendChild(n){this.children.push(n);if(n.textContent)this.textContent+=n.textContent},
};}
const nodes = new Map();
globalThis.document={body:{offsetHeight:0},activeElement:null,
  getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)},
  createElement:node,createDocumentFragment:node,createTextNode(text){return {textContent:text}},addEventListener(){}};
globalThis.window={innerHeight:1000,scrollY:0,scrollTo(){},addEventListener(){}};
globalThis.setInterval=()=>0;
globalThis.location={origin:config.host,hash:'#'+config.key,assign(){}};
let copied, finishCopy;
Object.defineProperty(globalThis,'navigator',{value:{clipboard:{writeText(text){copied=text;return new Promise(r=>finishCopy=r)}}},configurable:true});
