// A page session owns the delivered cursor, serialized folds, and local post evidence.
// Crypto, HTTP, and presentation enter through callbacks; this state never touches the DOM.
function createSession({open, seal, post, beginPresentation, onLock, onPending, isStopped}) {
  const identity = {name:'human', locked:false, pending:0, attempts:[]};
  let last = -1, queue = Promise.resolve();
  function setName(name) {
    if (identity.locked || identity.pending || isStopped()) return false;
    if (!validFrom(name)) throw new Error(NAME_RULE);
    identity.name = name;
    return true;
  }
  function discardPostEvidence() {
    identity.attempts = [];
  }
  function lockName(from) {
    if (identity.locked) return;
    identity.locked = true;
    identity.name = from;
    discardPostEvidence();
    onLock(from);
  }
  function observe(event) {
    const own = identity.attempts.find(a => a.seq === event.seq && a.nonce === event.nonce && a.ct === event.ct);
    if (own) lockName(own.from);
    identity.attempts = identity.attempts.filter(a => a.seq > event.seq);
  }
  function deliver(events) {
    const next = queue.then(async () => {
      const presentation = beginPresentation();
      let visible = 0;
      for (const event of events) {
        observe(event);
        if (event.seq <= last) continue;
        const message = await open(event);
        last = event.seq;
        visible += presentation.apply(event, message);
      }
      presentation.finish(visible);
      return visible;
    });
    queue = next.catch(() => {});
    return next;
  }
  async function append(obj) {
    if (!validFrom(obj.from)) throw new Error(NAME_RULE);
    if (!validString(obj.text) || !trimSpace(obj.text)) throw new Error('Message must be nonblank UTF-8 text.');
    onPending(++identity.pending);
    try {
      for (let i = 0; i < 50; i++) {
        await queue;
        if (isStopped()) throw new Error('Channel deleted.');
        const prev = last, from = identity.locked ? identity.name : obj.from;
        const blob = await seal(prev + 1, {from, text:obj.text});
        if (isStopped()) throw new Error('Channel deleted.');
        if (identity.locked && from !== identity.name) continue;
        const attempt = {seq:prev + 1, ...blob, from};
        if (!identity.locked && attempt.seq > last) identity.attempts.push(attempt);
        const response = await post(prev, blob);
        const reply = await response.json().catch(() => ({}));
        // Acknowledgments establish ownership, but only deliveries advance last.
        if (response.ok) {
          lockName(from);
          return;
        }
        // Retain ambiguous attempts until matching delivery proves success or rules them out.
        if ((response.status >= 400 && response.status < 500) || (response.status === 503 && reply.posted === false && (reply.error === 'restarting' || reply.code === 'moderation_unavailable'))) {
          identity.attempts = identity.attempts.filter(a => a !== attempt);
        }
        if (response.status === 409) {
          await deliver(reply.events || []);
          continue;
        }
        throw new Error(reply.error || response.status);
      }
      throw new Error('The conversation kept moving. Try again.');
    } finally { onPending(--identity.pending); }
  }
  return {identity, setName, discardPostEvidence, deliver, append, get last() { return last; }};
}
