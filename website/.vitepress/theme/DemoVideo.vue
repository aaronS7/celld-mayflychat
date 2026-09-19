<script setup lang="ts">
import { withBase } from 'vitepress';
withDefaults(defineProps<{name?: string; poster?: string; width?: number; height?: number; label?: string; caption?: string}>(), {
  name: 'mayfly-demo', poster: 'chat-light.png', width: 1120, height: 860,
  label: 'Mayfly demo: send a message, receive tags, and see a rejected message',
  caption: 'A short, silent tour of tagging and message screening. Synthetic conversation; deterministic Jev demo responses.',
});
</script>

<template>
  <figure class="demo-video" :class="{ portrait: width < height }">
    <video controls playsinline muted preload="metadata" :poster="withBase(`/media/${poster}`)" :width="width" :height="height" :aria-label="label">
      <source :src="withBase(`/media/${name}.mp4`)" type="video/mp4" />
      <track kind="captions" srclang="en" label="English" :src="withBase(`/media/${name}.vtt`)" default />
      <p><a :href="withBase(`/media/${name}.mp4`)">Download the recording</a>.</p>
    </video>
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.portrait { max-width: 390px; margin-inline: auto; }
</style>
