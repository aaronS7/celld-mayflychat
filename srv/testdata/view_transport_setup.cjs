const assert = require('node:assert/strict');
globalThis.crypto = require('node:crypto').webcrypto;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (path, opts) => nativeFetch(new URL(path, config.host), opts);
function element(){ return {textContent:'', value:'', hidden:false, dateTime:config.expires,
  children:[], style:{setProperty(){}}, listeners:{}, classList:{add(){}, remove(){}},
  addEventListener(kind, fn){this.listeners[kind]=fn},
  fire(kind, props={}){return this.listeners[kind]?.({target:this, currentTarget:this, preventDefault(){}, ...props})},
  focus(){document.activeElement=this; return this.fire('focus')},
  blur(){document.activeElement=null; return this.fire('blur')},
  setSelectionRange(a,b){this.selectionStart=a; this.selectionEnd=b},
  scrollIntoView(){this.scrolled=true}, closest(){return element()}, replaceChildren(){this.textContent=''},
  querySelector(s){this.q ??= {}; return this.q[s] ??= element()}, appendChild(e){this.children.push(e); if(e.textContent) this.textContent += e.textContent}}; }
const nodes = new Map();
globalThis.document = {activeElement:null, body:{offsetHeight:0, scrollHeight:0},
  getElementById(id){if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id)},
  createElement:element, createDocumentFragment:element, createTextNode(text){return {textContent:text}}, addEventListener(){}};
globalThis.window = {innerHeight:1000, innerWidth:1000, scrollY:0, scrollX:0, scrollTo(){}, listeners:{}, addEventListener(kind, fn){this.listeners[kind]=fn}};
globalThis.history = {replaceState(){throw new Error('title must not change the URL')}};
globalThis.setInterval = () => 0;
let newURL;
globalThis.location = {origin:config.host, hash:'#'+config.key, assign(url){newURL=url}};
