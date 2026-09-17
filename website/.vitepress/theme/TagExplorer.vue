<script setup lang="ts">
import { computed, ref } from 'vue';
const names = ['research', 'question', 'information', 'command', 'undetermined'];
const scores = ref([92, 86, 18, 81, 4]);
const tags = computed(() => {
  const selected = names.slice(0, 4).filter((_, i) => scores.value[i] >= 75);
  if (scores.value[4] >= 60 && scores.value.slice(0, 4).every(n => n < 30)) selected.push('undetermined');
  return selected;
});
const presets = [
  { name: 'Several tags', values: [92, 86, 18, 81, 4] },
  { name: 'Undetermined', values: [18, 12, 20, 5, 68] },
  { name: 'No match', values: [50, 55, 35, 10, 65] },
];
</script>

<template>
  <section class="tag-explorer" aria-label="Try the tagging thresholds">
    <div class="explorer-heading"><span class="eyebrow">TRY THE RULES</span><span class="local-note">Runs in your browser · no API calls</span></div>
    <div class="preset-buttons" aria-label="Example probabilities">
      <button v-for="preset in presets" :key="preset.name" type="button" @click="scores = [...preset.values]">{{ preset.name }}</button>
    </div>
    <div class="score-row" v-for="(name, i) in names" :key="name">
      <label :for="`score-${name}`">{{ name }}</label>
      <input :id="`score-${name}`" type="range" min="0" max="100" step="1" v-model.number="scores[i]" :aria-valuetext="`${scores[i]} percent`" />
      <output :for="`score-${name}`">{{ scores[i] }}%</output>
    </div>
    <div class="tag-result" role="status" aria-live="polite">
      <span class="result-label">Message tags</span>
      <span v-for="tag in tags" :key="tag" class="tag">{{ tag }}</span>
      <span v-if="!tags.length" class="local-note">No tags — none of the rules match.</span>
    </div>
    <p class="threshold-note">Main labels: ≥75%. Undetermined: ≥60%, with every other score &lt;30%.</p>
  </section>
</template>
