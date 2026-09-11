(async () => {
  const button = nodes.get('newbtn');
  const click = () => button.click({button:0, preventDefault(){}});
  assert.equal(requests, 0); // Plain / never starts creation.
  await click();
  assert(destination, document.getElementById('status').textContent);
  // The link remains busy while navigating away; another ordinary activation
  // must not post again, without preventing native modified activations.
  assert.equal(button.attrs['aria-busy'], 'true');
  await click();
  assert.equal(requests, 1);
  assert.match(destination, /^\/c\/[\w-]{22}#[\w-]{43}$/);
  assert.equal(requests, 1);
  const ks = await derive(unb64u(destination.split('#')[1]));
  assert.equal('/c/' + ks.id, destination.split('#')[0]);
  const page = await (await nativeFetch(config.host+'/c/'+ks.id+'/events', {headers:{Authorization:'Bearer '+ks.auth}})).json();
  // A new channel is empty: no creation event, creator, or attribution.
  assert.equal(page.events.length, 0); assert.equal(page.last, -1);
  assert.deepEqual(Object.keys(page).sort(), ['events', 'last', 'more']);
  assert.equal(requests, 1);
  // A creation that cannot be done safely is not done at all.
  const firstURL = destination;
  window.pageshow({persisted:true}); // Returning from the created channel.
  assert.equal(button.attrs['aria-busy'], undefined);
  assert.equal(nodes.get('status').textContent, '');
  assert.equal(requests, 1);
  crypto.subtle.deriveBits = async () => {throw new Error('crypto unavailable')};
  await click();
  assert.equal(requests, 1); assert.equal(destination, firstURL);
  assert.equal(button.attrs['aria-busy'], undefined);
  assert.match(nodes.get('status').textContent, /Could not create a channel: crypto unavailable/);
  console.log(JSON.stringify({destination}));
})().then(() => process.exit(0), err => {console.error(err); process.exit(1)});
