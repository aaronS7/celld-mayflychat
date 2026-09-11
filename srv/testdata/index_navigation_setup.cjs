const assert = require('node:assert/strict');
globalThis.crypto = require('node:crypto').webcrypto;
const nodes = new Map();
function element(){return {textContent:'', attrs:{}, listeners:{},
  setAttribute(k,v){this.attrs[k]=v}, removeAttribute(k){delete this.attrs[k]},
  addEventListener(k,fn){this.listeners[k]=fn}}}
globalThis.document = {getElementById(id){if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id)}};
globalThis.window = {listeners:{}, addEventListener(k,fn){this.listeners[k]=fn}};
const navigations = [];
globalThis.location = {hash:config.hash, assign(url){navigations.push({kind:'assign',url})}, replace(url){navigations.push({kind:'replace',url})}};
const requests = [];
globalThis.fetch = (path, opts) => new Promise((resolve,reject) => {
  assert.equal(path, '/new'); assert.equal(opts.method, 'POST');
  assert.deepEqual(Object.keys(JSON.parse(opts.body)).sort(), ['auth_hash', 'id']);
  requests.push({resolve,reject});
});
const until = async fn => {for(let n=0;n<2000;n++){if(fn())return; await new Promise(r=>setTimeout(r,1))} throw new Error('condition timeout')};
