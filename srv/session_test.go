package srv

import "testing"

// TestBrowserSession keeps delivery and lost-ack recovery executable without a DOM.
func TestBrowserSession(t *testing.T) {
	requireNode(t)
	var source string
	for _, name := range []string{"validate.js", "session.js", "conversation.js"} {
		b, err := browserFS.ReadFile("browser/" + name)
		if err != nil {
			t.Fatal(err)
		}
		source += string(b) + "\n"
	}
	runNode(t, source+`
const assert = require('node:assert/strict');
(async () => {
  const conversation = createConversation(), rows = [], posts = [], locks = [], pending = [];
  let release, entered, failPost = true;
  const blocked = new Promise(resolve => release = resolve);
  const started = new Promise(resolve => entered = resolve);
  const session = createSession({
    open: async event => {
      if(event.seq===0){entered();await blocked}
      return event.message;
    },
    seal: async (seq, message) => ({nonce:'nonce-'+seq, ct:JSON.stringify(message)}),
    post: async (last, blob) => {
      posts.push({last, blob});
      if(failPost)throw Error('lost reply');
      return new Response('{}');
    },
    beginPresentation: () => ({
      apply(event, message) { const change=conversation.apply(event,message); if(change.kind==='row')rows.push(change); return Number(change.kind==='row'); },
      finish() {}
    }),
    onLock: name => locks.push(name),
    onPending: count => pending.push(count),
    isStopped: () => false
  });
  const initial = {seq:0, message:{from:'Peer',text:'hello'}};
  const delivery = session.deliver([initial]); await started;
  const post = session.append({from:'Ada',text:'/title Shared title'});
  await Promise.resolve();
  assert.equal(posts.length,0,'posting waits for in-progress delivery');
  assert.equal(session.setName('Grace'),false,'pending posts prevent name edits');
  assert.equal(session.last,-1,'decryption must complete before acknowledging an event');
  release(); await delivery;
  await assert.rejects(post,/lost reply/);
  assert.equal(session.last,0);
  assert.equal(posts[0].last,0);
  assert.equal(session.identity.locked,false);
  assert(session.setName('Grace'));
  const accepted = {seq:1, ...posts[0].blob, message:JSON.parse(posts[0].blob.ct)};
  await session.deliver([initial,accepted]);
  assert.equal(rows.length,1,'duplicate delivery and title commands add no rows');
  assert.equal(session.identity.name,'Ada','matching ciphertext restores the accepted name');
  assert.equal(session.identity.locked,true);
  assert.equal(session.setName('Another name'),false,'a successful post locks name editing');
  assert.deepEqual(locks,['Ada']);
  assert.equal(session.identity.attempts.length,0);
  failPost=false;
  await session.append({from:'Grace',text:'next'});
  assert.equal(JSON.parse(posts[1].blob.ct).from,'Ada');
  assert.equal(session.last,1,'a successful acknowledgement does not skip its own event');
  assert.deepEqual(pending,[1,0,1,0]);
  const reply = conversation.apply({seq:2},{from:'Ada',text:'/re 0 /title literal reply'});
  assert.equal(reply.kind,'row'); assert.equal(reply.reply.text,'/title literal reply');
  assert.equal(conversation.apply({seq:3},{from:'Ada',text:'/react 2 yes'}).kind,'reaction');
  assert(conversation.reacts[2].get('yes').has('Ada'));
  assert.equal(conversation.apply({seq:4},{from:'Ada',text:'/react 99 yes'}).kind,'row');
})().then(()=>process.exit(0),error=>{console.error(error);process.exit(1)});
`)
}
