<script setup lang="ts">
import { useData, withBase } from 'vitepress';
const { isDark } = useData();
withDefaults(defineProps<{ name: string; alt: string; caption?: string; eager?: boolean; width?: number; height?: number }>(), { eager: false, width: 1120 });
</script>

<template>
  <figure class="demo-image" :style="{ maxWidth: width + 'px' }">
    <a :href="withBase(`/media/${name}-${isDark ? 'dark' : 'light'}.png`)" target="_blank" rel="noopener" title="Open screenshot at full size">
      <img :src="withBase(`/media/${name}-${isDark ? 'dark' : 'light'}.png`)" :alt="alt" :loading="eager ? 'eager' : 'lazy'" :width="width" :height="height ?? (name === 'screening' ? 982 : 860)" />
    </a>
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>
