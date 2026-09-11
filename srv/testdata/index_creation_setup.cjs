const assert = require('node:assert/strict');
globalThis.crypto = require('node:crypto').webcrypto;
const nativeFetch = globalThis.fetch;
const nodes = new Map();
globalThis.document = {getElementById(id){if (!nodes.has(id)) nodes.set(id, {textContent:'', attrs:{}, setAttribute(k,v){this.attrs[k]=v}, removeAttribute(k){delete this.attrs[k]}, addEventListener(k, fn){this[k]=fn}}); return nodes.get(id)}};
globalThis.window = {addEventListener(k, fn){this[k]=fn}};
let destination, requests=0;
globalThis.location = {hash:'', assign(url){destination=url}, replace(){throw new Error('ordinary creation should preserve the landing history entry')}};
globalThis.fetch = (path, opts) => {
  requests++;
  assert.equal(path, '/new'); assert.equal(opts.method, 'POST');
  // Creation tells the server public metadata and nothing else: no key
  // material, and no name for the human who pressed the button.
  assert.deepEqual(Object.keys(JSON.parse(opts.body)).sort(), ['auth_hash', 'id']);
  return nativeFetch(new URL(path, config.host), opts);
};
