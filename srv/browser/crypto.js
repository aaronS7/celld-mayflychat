// The channel construction, in WebCrypto.
// K (32 bytes, base64url, from the URL fragment) → HKDF-SHA256, empty salt:
// id ("mayfly id", 16 B), auth ("mayfly auth", 32 B), enc ("mayfly enc", 32 B).
// AES-256-GCM, 96-bit random nonce, AAD = UTF-8 channel id + ':' + decimal(seq).
// Plaintext is padded with spaces to a multiple of 256 bytes.
const te = new TextEncoder(), td = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
const b64u = b => {
  const bytes = new Uint8Array(b);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
async function derive(K){
  if (K.length !== 32) throw new Error('URL requires a 32-byte key fragment');
  const km = await crypto.subtle.importKey('raw', K, 'HKDF', false, ['deriveBits']);
  const bits = (info, n) => crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt:new Uint8Array(0), info:te.encode(info)}, km, n*8);
  const [id, auth, enc] = await Promise.all([bits('mayfly id', 16), bits('mayfly auth', 32), bits('mayfly enc', 32)]);
  return {id: b64u(id), auth: b64u(auth), enc: await crypto.subtle.importKey('raw', enc, 'AES-GCM', false, ['encrypt','decrypt'])};
}
async function sealWith(ks, seq, nonce, obj){
  let pt = te.encode(JSON.stringify(obj));
  const padded = new Uint8Array(Math.ceil(pt.length/256)*256 || 0).fill(0x20); padded.set(pt);
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce, additionalData:te.encode(ks.id + ':' + seq)}, ks.enc, padded);
  return {nonce: b64u(nonce), ct: b64u(ct)};
}
const seal = (ks, seq, obj) => sealWith(ks, seq, crypto.getRandomValues(new Uint8Array(12)), obj);
// The native celld host injects its explicit mode into the page. The Go
// reference does not, and retains the original encrypted protocol.
const transportConfig = () => typeof MAYFLY_CONFIG === 'undefined'
  ? {encryption:true, postingAllowed:true} : MAYFLY_CONFIG;
function sealMessage(ks, seq, obj){
  if (!transportConfig().postingAllowed) throw new Error('Server encryption setting changed. Create a new channel to send messages.');
  return transportConfig().encryption ? seal(ks, seq, obj)
    : {nonce:b64u(crypto.getRandomValues(new Uint8Array(12))), from:obj.from, text:obj.text};
}
function openMessage(ks, ev){
  return transportConfig().encryption ? open(ks, ev) : {from:ev.from, text:ev.text};
}
async function open(ks, ev){
  let pt;
  try { pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64u(ev.nonce), additionalData:te.encode(ks.id + ':' + ev.seq)}, ks.enc, unb64u(ev.ct)); }
  catch { return null; }
  // Only authentication failures return null; malformed plaintext gets an invalid row.
  try { return JSON.parse(td.decode(pt)) || {}; }
  catch { return {}; }
}
// Self-check against the fixed vectors shared with every client and the Go tests.
async function selfCheck(){
  for (const v of VECTORS){
    const ks = await derive(unb64u(v.K));
    if (ks.id !== v.id || ks.auth !== v.auth) throw new Error('HKDF mismatch');
    if (v.plaintext){
      const s = await sealWith(ks, v.seq, unb64u(v.nonce), JSON.parse(v.plaintext));
      const o = await open(ks, {seq: v.seq, nonce: v.nonce, ct: v.ct});
      if (JSON.stringify(o) !== JSON.stringify(JSON.parse(v.plaintext))) throw new Error('AES-GCM open mismatch');
      if (await open(ks, {seq: v.seq + 1, nonce: v.nonce, ct: v.ct}) !== null) throw new Error('AES-GCM accepted wrong sequence');
      // Seal compares after re-serialization: JSON.stringify and Go/Python agree on these compact vectors.
      if (s.ct !== v.ct) throw new Error('AES-GCM seal mismatch');
    }
  }
}
