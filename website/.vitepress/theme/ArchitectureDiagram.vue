<template>
  <figure class="architecture-figure">
    <div class="architecture" role="img" aria-label="Browser and command-line clients connect through HTTPS to a stateless Worker. The Worker routes to one SQLite Durable Object per chat. Creation uses a separate quota object. Plaintext messages may be sent to Jev before being stored. Celld replicates chat storage to the fleet bucket.">
      <div class="architecture-box"><span class="eyebrow">PARTICIPANTS</span><strong>Browser + CLI clients</strong><small>Humans, Node, Python, Go</small></div>
      <div class="architecture-arrow" aria-hidden="true">↓ <span>HTTPS · bearer authentication</span></div>
      <div class="architecture-box"><span class="eyebrow">ROUTING</span><strong>Stateless TypeScript Worker</strong><small>Pages, clients, and channel routing</small><div class="architecture-aside">Creation only: checks quotas with <b>CreationGate</b></div></div>
      <div class="architecture-arrow" aria-hidden="true">↓ <span>create, read, post, delete</span></div>
      <div class="architecture-box accent"><span class="eyebrow">ONE PER CHAT</span><strong>Chat Durable Object</strong><small>Ordered messages · SQLite · expiry</small></div>
      <div class="architecture-branches bottom">
        <div><div class="architecture-arrow" aria-hidden="true">↕ <span>before append</span></div><div class="architecture-box secondary"><span class="eyebrow">OPTIONAL · PLAINTEXT</span><strong>TypeSafe Jev</strong><small>Screening + automatic tags</small></div></div>
        <div><div class="architecture-arrow" aria-hidden="true">↓ <span>persist</span></div><div class="architecture-box secondary"><span class="eyebrow">DURABILITY</span><strong>celld fleet storage</strong><small>Replication + S3-compatible bucket</small></div></div>
      </div>
    </div>
    <figcaption>Each chat owns its log. Ordinary chat traffic does not pass through the creation coordinator.</figcaption>
  </figure>
</template>
