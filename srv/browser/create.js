// newChannel creates a channel without the server ever holding its key:
// Generate K here and send only id + sha256(auth); the log starts empty.
async function newChannel(){
  await selfCheck();
  const K = crypto.getRandomValues(new Uint8Array(32));
  const ks = await derive(K);
  const auth_hash = b64u(await crypto.subtle.digest('SHA-256', te.encode(ks.auth)));
  const r = await fetch('/new', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: ks.id, auth_hash})});
  if (!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.error || r.status); }
  return '/c/' + ks.id + '#' + b64u(K);
}
