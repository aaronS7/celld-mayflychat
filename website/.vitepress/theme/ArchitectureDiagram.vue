<template>
  <figure class="architecture-figure">
    <div class="architecture" role="img" aria-label="Browser and command-line clients connect through HTTPS to a stateless Worker. Each chat and wiki has a separate SQLite Durable Object and creation quota gate. Optional Jev calls screen and tag chat messages or rank wiki passages. Explicit summary requests send bounded saved text to Mercury and stream the result. Celld persists object storage; wiki images use R2.">
      <div class="architecture-box"><span class="eyebrow">PARTICIPANTS</span><strong>Browser + CLI clients</strong><small>Humans, Node, Python, Go</small></div>
      <div class="architecture-arrow" aria-hidden="true">↓ <span>HTTPS · bearer authentication</span></div>
      <div class="architecture-box"><span class="eyebrow">ROUTING</span><strong>Stateless TypeScript Worker</strong><small>Pages, clients, chat and wiki routing</small><div class="architecture-aside">Creation only: <b>CreationGate</b> or <b>WikiCreationGate</b></div></div>
      <div class="architecture-arrow" aria-hidden="true">↓ <span>authenticated reads and writes</span></div>
      <div class="architecture-branches">
        <div class="architecture-box accent"><span class="eyebrow">ONE PER CHAT</span><strong>Chat Durable Object</strong><small>Ordered messages · SQLite · idle expiry</small></div>
        <div class="architecture-box accent"><span class="eyebrow">ONE PER WIKI</span><strong>Wiki Durable Object</strong><small>Pages · revisions · discussion · FTS5</small></div>
      </div>
      <div class="architecture-arrow"><span>Optional providers used by both chats and wikis</span></div>
      <div class="architecture-branches bottom">
        <div class="architecture-box secondary"><span class="eyebrow">OPTIONAL · PLAINTEXT</span><strong>TypeSafe Jev</strong><small>Chat screening/tags · wiki relevance</small></div>
        <div class="architecture-box secondary"><span class="eyebrow">ON REQUEST · SAVED TEXT</span><strong>Mercury 2.5</strong><small>Chat, page and bounded wiki summaries</small></div>
      </div>
      <div class="architecture-aside">Object data persists in <b>celld fleet storage</b>; wiki images use the <b>WIKI_FILES R2 binding</b>.</div>
    </div>
    <figcaption>Chats and wikis keep separate storage and lifetimes. Generated summaries are not saved automatically; providers are outside celld's storage boundary.</figcaption>
  </figure>
</template>
