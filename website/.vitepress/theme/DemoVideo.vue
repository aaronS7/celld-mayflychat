<script setup lang="ts">
import { withBase } from 'vitepress';
</script>

<template>
  <figure class="demo-video">
    <video controls playsinline muted preload="metadata" :poster="withBase('/media/chat-light.png')" width="1120" height="860" aria-label="Mayfly demo: send a message, receive tags, and see a rejected message">
      <source :src="withBase('/media/mayfly-demo.mp4')" type="video/mp4" />
      <track kind="captions" srclang="en" label="English" :src="withBase('/media/mayfly-demo.vtt')" default />
      <p><a :href="withBase('/media/mayfly-demo.mp4')">Download the Mayfly demo</a>.</p>
    </video>
    <figcaption>A short, silent tour of tagging and message screening. Synthetic conversation; deterministic Jev demo responses.</figcaption>
  </figure>
</template>
