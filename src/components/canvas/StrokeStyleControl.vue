<template>
  <!-- Illustrator's stroke Cap and Corner options. A '' value (mixed
       selection) highlights nothing. -->
  <section class="ss">
    <div>
      <label class="ss-label">Cap</label>
      <div class="ss-row">
        <button
          v-for="c in CAPS"
          :key="c.value"
          type="button"
          class="ss-btn"
          :class="{ active: cap === c.value }"
          :title="c.title"
          :aria-label="c.title"
          @click="emit('change', { cap: c.value })"
        >
          <svg viewBox="0 0 18 14" width="18" height="14" aria-hidden="true">
            <line x1="2" y1="7" x2="10" y2="7" stroke="currentColor" stroke-width="6" :stroke-linecap="c.value" />
            <line x1="10" y1="1" x2="10" y2="13" stroke="#ef4444" stroke-width="1" />
          </svg>
        </button>
      </div>
    </div>
    <div>
      <label class="ss-label">Corner</label>
      <div class="ss-row">
        <button
          v-for="j in JOINS"
          :key="j.value"
          type="button"
          class="ss-btn"
          :class="{ active: join === j.value }"
          :title="j.title"
          :aria-label="j.title"
          @click="emit('change', { join: j.value })"
        >
          <svg viewBox="0 0 18 14" width="18" height="14" aria-hidden="true">
            <polyline points="4,13 4,4 15,4" fill="none" stroke="currentColor" stroke-width="5" :stroke-linejoin="j.value" />
          </svg>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { StrokeCap, StrokeJoin } from '@/stores/canvas'

defineProps<{ cap: StrokeCap | ''; join: StrokeJoin | '' }>()
const emit = defineEmits<{ (e: 'change', patch: { cap?: StrokeCap; join?: StrokeJoin }): void }>()

const CAPS: { value: StrokeCap; title: string }[] = [
  { value: 'butt', title: 'Butt cap' },
  { value: 'round', title: 'Round cap' },
  { value: 'square', title: 'Projecting cap' },
]
const JOINS: { value: StrokeJoin; title: string }[] = [
  { value: 'miter', title: 'Miter join' },
  { value: 'round', title: 'Round join' },
  { value: 'bevel', title: 'Bevel join' },
]
</script>

<style scoped>
.ss {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 14px;
}
.ss-label {
  display: block;
  font-size: 12px;
  color: #71717a;
  margin-bottom: 6px;
}
.ss-row {
  display: flex;
  gap: 6px;
}
.ss-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px 0;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}
.ss-btn.active {
  background: #211a43;
  color: #fff;
  border-color: #211a43;
}
</style>
