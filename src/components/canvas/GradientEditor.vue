<template>
  <div class="ge" @pointerdown="emit('begin')">
    <!-- Linear/radial is chosen by the host (FillControl's fill mode). -->
    <div class="ge-row ge-angle">
      <template v-if="modelValue.type === 'linear'">
        <label class="ge-label">Angle</label>
        <input type="range" min="0" max="359" step="1" class="ge-range" :value="gradientAngle(modelValue)" @input="emitG(withAngle(modelValue, num($event)))" />
        <input type="number" min="0" max="359" class="ge-num" :value="gradientAngle(modelValue)" @change="emitG(withAngle(modelValue, num($event)))" />
      </template>
      <span v-else class="ge-pct">Drag with the Gradient tool (G) to move the center.</span>
      <button type="button" class="ge-icon-btn" title="Reverse gradient" @click="emitG(reverseStops(modelValue))">⇄</button>
    </div>

    <!-- Stop bar: click to add a stop, drag stops to move them. -->
    <div ref="bar" class="ge-bar" title="Click to add a color stop" @pointerdown="onBarDown">
      <div class="ge-bar-fill" :style="{ background: gradientCss(modelValue) }" />
      <span
        v-for="(s, i) in modelValue.stops"
        :key="i"
        class="ge-stop"
        :class="{ selected: i === selected }"
        :style="{ left: `${s.offset * 100}%` }"
        :title="`${Math.round(s.offset * 100)}%`"
        @pointerdown.stop="onStopDown($event, i)"
      >
        <span class="ge-stop-chip" :style="{ background: s.color }" />
      </span>
    </div>

    <div v-if="stop" class="ge-row ge-stop-row">
      <label class="ge-label">Stop</label>
      <input type="number" min="0" max="100" class="ge-num" :value="Math.round(stop.offset * 100)" @change="setOffset(selected, num($event) / 100)" />
      <span class="ge-pct">%</span>
      <button type="button" class="ge-icon-btn" :disabled="modelValue.stops.length <= 2" title="Delete stop" @click="removeStop">✕</button>
    </div>
    <ColorPicker
      v-if="stop"
      :key="selected"
      :model-value="stop.color"
      :allow-none="false"
      :swatches="swatches"
      default-open
      @update:model-value="setColor"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ColorPicker from './ColorPicker.vue'
import {
  gradientAngle,
  gradientCss,
  reverseStops,
  sampleGradient,
  withAngle,
  type GradientFill,
} from '@/services/canvas/gradient'

const props = withDefaults(defineProps<{ modelValue: GradientFill; swatches?: string[] }>(), { swatches: () => [] })
const emit = defineEmits<{
  (e: 'update:modelValue', g: GradientFill): void
  (e: 'begin'): void
}>()

const selected = ref(0)
const bar = ref<HTMLElement | null>(null)
const stop = computed(() => props.modelValue.stops[selected.value] ?? null)
watch(
  () => props.modelValue.stops.length,
  (n) => {
    if (selected.value >= n) selected.value = Math.max(0, n - 1)
  },
)

const r3 = (n: number) => Math.round(n * 1000) / 1000
function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value) || 0
}
function emitG(g: GradientFill) {
  emit('update:modelValue', g)
}

function setColor(color: string) {
  const stops = props.modelValue.stops.map((s, i) => (i === selected.value ? { ...s, color } : s))
  emitG({ ...props.modelValue, stops })
}
function setOffset(i: number, offset: number) {
  const o = r3(Math.min(1, Math.max(0, offset)))
  const stops = props.modelValue.stops.map((s, j) => (j === i ? { ...s, offset: o } : s))
  emitG({ ...props.modelValue, stops })
}
function removeStop() {
  if (props.modelValue.stops.length <= 2) return
  const stops = props.modelValue.stops.filter((_, i) => i !== selected.value)
  selected.value = Math.max(0, selected.value - 1)
  emitG({ ...props.modelValue, stops })
}

function offsetAt(clientX: number): number {
  const r = bar.value?.getBoundingClientRect()
  if (!r || !r.width) return 0
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
}

function onBarDown(e: PointerEvent) {
  const offset = r3(offsetAt(e.clientX))
  const stops = [...props.modelValue.stops, { offset, color: sampleGradient(props.modelValue, offset) }]
  selected.value = stops.length - 1
  emitG({ ...props.modelValue, stops })
}

function onStopDown(e: PointerEvent, i: number) {
  emit('begin')
  selected.value = i
  const move = (ev: PointerEvent) => setOffset(i, offsetAt(ev.clientX))
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  e.preventDefault()
}
</script>

<style scoped>
.ge {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ge-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ge-icon-btn {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  color: #211a43;
  cursor: pointer;
  font-size: 13px;
}
.ge-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ge-label {
  font-size: 12px;
  color: #71717a;
  width: 40px;
  flex-shrink: 0;
}
.ge-range {
  flex: 1;
  min-width: 0;
}
.ge-num {
  width: 56px;
  padding: 5px 7px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 12px;
  color: #211a43;
}
.ge-pct {
  font-size: 12px;
  color: #a1a1aa;
  flex: 1;
}
/* Checkerboard under the bar so translucent stops read correctly. */
.ge-bar {
  position: relative;
  height: 22px;
  margin: 0 7px 10px;
  border-radius: 6px;
  cursor: copy;
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #d4d4d8 25%, transparent 25%),
    linear-gradient(-45deg, #d4d4d8 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #d4d4d8 75%),
    linear-gradient(-45deg, transparent 75%, #d4d4d8 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  touch-action: none;
}
.ge-bar-fill {
  position: absolute;
  inset: 0;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.1);
}
.ge-stop {
  position: absolute;
  top: 14px;
  width: 14px;
  height: 18px;
  margin-left: -7px;
  cursor: ew-resize;
}
.ge-stop::before {
  /* Pointer notch up into the bar. */
  content: '';
  position: absolute;
  left: 3px;
  top: -4px;
  border: 4px solid transparent;
  border-bottom-color: #71717a;
  border-top: 0;
}
.ge-stop-chip {
  position: absolute;
  inset: 0;
  border: 2px solid #fff;
  border-radius: 3px;
  box-shadow: 0 0 0 1px #71717a;
}
.ge-stop.selected .ge-stop-chip {
  box-shadow: 0 0 0 2px #2563eb;
}
.ge-stop.selected::before {
  border-bottom-color: #2563eb;
}
.ge-stop-row {
  margin-top: 4px;
}
</style>
