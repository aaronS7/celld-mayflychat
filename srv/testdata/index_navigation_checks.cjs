(async () => {
  const link = nodes.get('newbtn'), status = nodes.get('status');
  const click = props => {
    const event = {button:0, defaultPrevented:false, preventDefault(){this.defaultPrevented=true}, ...props};
    const done = link.listeners.click(event);
    return {event,done};
  };
  const nativeGestures = [{metaKey:true}, {ctrlKey:true}, {shiftKey:true}, {altKey:true},
    {metaKey:true,shiftKey:true}, {ctrlKey:true,shiftKey:true}, {button:1}, {button:2}, {defaultPrevented:true}];
  const checkNative = () => {
    const before = {creating, text:status.textContent, busy:link.attrs['aria-busy'], requests:requests.length, navigations:navigations.length};
    for (const props of nativeGestures) {
      const {event,done} = click(props);
      assert.equal(event.defaultPrevented, !!props.defaultPrevented, JSON.stringify(props));
      assert.equal(done, undefined);
    }
    assert.equal(link.listeners.auxclick, undefined);
    assert.equal(link.listeners.contextmenu, undefined);
    assert.deepEqual({creating, text:status.textContent, busy:link.attrs['aria-busy'], requests:requests.length, navigations:navigations.length}, before);
  };
  // Only the explicit marker starts automatically. The initial pageshow
  // neither duplicates that operation nor activates an otherwise inert page.
  assert.equal(creating, config.hash === '#new');
  window.listeners.pageshow({persisted:false});
  checkNative();
  if (config.hash !== '#new') {
    assert.equal(requests.length, 0); assert.equal(status.textContent, '');
    assert.equal(click().event.defaultPrevented, true);
  }
  assert.equal(creating, true); assert.equal(link.attrs['aria-busy'], 'true');
  assert.equal(status.textContent, 'Creating…');
  // Synchronous duplicates and duplicates with a request in flight are both
  // suppressed; modifiers still pass through while ordinary creation is busy.
  assert.equal(click().event.defaultPrevented, true);
  await until(() => requests.length === 1);
  checkNative();
  await click().done;
  assert.equal(requests.length, 1);
  requests[0].reject(new Error('offline'));
  await until(() => !creating);
  assert.match(status.textContent, /Could not create a channel: offline/);
  assert.equal(link.attrs['aria-busy'], undefined); assert.equal(navigations.length, 0);
  checkNative();
  click(); await until(() => requests.length === 2);
  requests[1].resolve({ok:false, status:429, json:async()=>({error:'try later'})});
  await until(() => !creating);
  assert.match(status.textContent, /Could not create a channel: try later/);
  assert.equal(link.attrs['aria-busy'], undefined); assert.equal(navigations.length, 0);
  // A successful retry creates one channel and retains the fragment key.
  const final = click();
  assert.equal(status.textContent, 'Creating…');
  await until(() => requests.length === 3);
  requests[2].resolve({ok:true}); await final.done;
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].kind, config.hash === '#new' ? 'replace' : 'assign');
  assert.match(navigations[0].url, /^\/c\/[\w-]{22}#[\w-]{43}$/);
  const ks = await derive(unb64u(navigations[0].url.split('#')[1]));
  assert.equal(navigations[0].url.split('#')[0], '/c/'+ks.id);
  assert.equal(creating, true); checkNative(); await click().done;
  assert.equal(requests.length, 3); assert.equal(navigations.length, 1);
  // Only #newbtn owns a click handler; ordinary anchors and the document
  // have no delegated navigation interception from this script.
  assert.deepEqual([...nodes.keys()].sort(), ['newbtn','status']);
  assert.deepEqual(Object.keys(link.listeners), ['click']);
  assert.deepEqual(Object.keys(window.listeners), ['pageshow']);
})().then(() => process.exit(0), err => {console.error(err); process.exit(1)});
