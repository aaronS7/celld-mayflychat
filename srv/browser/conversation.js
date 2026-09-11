// Commands are ordinary messages that the browser view interprets when the
// whole trimmed text matches; the server and the CLIs never parse them.
function validTitle(t){ return !!t && !/[\p{Cc}\u2028\u2029]/u.test(t) && t === t.trim(); }
function validReaction(t){ return typeof t === 'string' && !!t && !/[\p{White_Space}\p{Cc}]/u.test(t); }
function command(text){
  const s = text.trim();
  if (s === '/title') return {kind:'title', text:''};
  if (s.startsWith('/title ') && validTitle(s.slice(7))) return {kind:'title', text:s.slice(7)};
  const m = /^\/(react|unreact) (0|[1-9][0-9]*) ([^\p{White_Space}\p{Cc}]+)$/u.exec(s);
  if (m && Number.isSafeInteger(Number(m[2]))) return {kind:m[1], to:Number(m[2]), reaction:m[3]};
  const re = /^\/re (0|[1-9][0-9]*) ([\s\S]+)$/.exec(s);
  if (re && Number.isSafeInteger(Number(re[1])) && re[2].trim()) return {kind:'reply', to:Number(re[1]), text:re[2]};
  return null;
}
// commandText composes each command the way command() parses it.
const commandText = {
  title: text => text ? '/title ' + text : '/title',
  react: (id, token) => `/react ${id} ${token}`,
  unreact: (id, token) => `/unreact ${id} ${token}`,
  reply: (id, body) => `/re ${id} ${body}`,
};
// An introduction is an ordinary message shown as prose only when the
// self-asserted name matches its sender; anything else stays literal.
function joinOf(text, from){
  const s = text.trim();
  return s.startsWith('/join ') && s.slice(6) === from && validFrom(from) ? from : null;
}

// Conversation state contains plain values; the view owns the corresponding DOM rows.
function createConversation() {
  const messages = Object.create(null), reacts = Object.create(null), used = Object.create(null);
  function applyReaction(ev){
    const m = reacts[ev.to] ??= new Map();
    if (ev.kind === 'react'){
      if (!m.has(ev.reaction)) m.set(ev.reaction, new Set());
      m.get(ev.reaction).add(ev.from);
      used[ev.reaction] = (used[ev.reaction]||0) + 1;
    } else {
      m.get(ev.reaction)?.delete(ev.from);
      if (m.get(ev.reaction)?.size === 0) m.delete(ev.reaction);
    }
  }

  function apply(event, message) {
    let text, from, reply = null, join = null;
    if (!message) { text = '(undecryptable message)'; from = '?'; }
    else if (typeof message !== 'object' || !validFrom(message.from) || !validString(message.text)) {
      text = '(invalid message)'; from = '?';
    } else {
      ({text, from} = message);
      const cmd = command(text);
      if (cmd?.kind === 'title') return cmd;
      if ((cmd?.kind === 'react' || cmd?.kind === 'unreact') && messages[cmd.to]) {
        applyReaction({...cmd, from});
        return {kind:'reaction', to:cmd.to};
      }
      if (cmd?.kind === 'reply' && messages[cmd.to]) reply = cmd;
      join = joinOf(text, from);
    }
    messages[event.seq] = {text, from};
    return {kind:'row', event, text, from, reply, join};
  }
  return {messages, reacts, used, apply};
}
