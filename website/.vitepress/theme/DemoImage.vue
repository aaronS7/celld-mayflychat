<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useData, withBase } from 'vitepress';
const { isDark } = useData();
const props = withDefaults(defineProps<{ name: string; alt: string; caption?: string; eager?: boolean; width?: number; height?: number }>(), { eager: false, width: 1120 });
const mounted = ref(false);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const imageHeight = computed(() => props.height ?? (props.name === 'screening' ? 982 : 860));
// Static HTML cannot know a visitor's saved/system theme. Keep the placeholder
// through hydration, then request only the image for VitePress's resolved mode.
const source = computed(() => mounted.value ? withBase(`/media/${props.name}-${isDark.value ? 'dark' : 'light'}.png`) : undefined);
onMounted(() => { mounted.value = true; });
watch(source, () => { state.value = 'loading'; }, { flush: 'sync' });

async function loaded(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  try {
    await image.decode();
    if (image.isConnected && image.getAttribute('src') === source.value) state.value = 'ready';
  } catch {
    failed(event, image);
  }
}
function failed(event: Event, image = event.currentTarget as HTMLImageElement) {
  if (image.isConnected && image.getAttribute('src') === source.value) state.value = 'error';
}
</script>

<template>
  <figure class="demo-image" :style="{ maxWidth: width + 'px' }">
    <a class="demo-image-frame" :style="{ aspectRatio: `${width} / ${imageHeight}` }" :href="source" :aria-busy="state === 'loading'" target="_blank" rel="noopener" title="Open screenshot at full size">
      <img v-if="source" :key="source" :src="source" :class="{ 'is-ready': state === 'ready' }" :alt="alt" :loading="eager ? 'eager' : 'lazy'" decoding="async" :width="width" :height="imageHeight" @load="loaded" @error="failed" />
      <span v-if="state !== 'ready'" class="demo-image-placeholder" role="status">
        <span v-if="state === 'loading'" class="demo-image-spinner" aria-hidden="true"></span>
        {{ state === 'error' ? 'Screenshot unavailable' : 'Loading screenshot…' }}
      </span>
    </a>
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>
