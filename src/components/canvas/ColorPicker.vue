<template>
  <div class="cp" :class="{ open }">
    <div class="cp-row">
      <button
        type="button"
        class="cp-swatch"
        :class="{ 'is-none': isNone }"
        :title="open ? 'Close color picker' : 'Open color picker'"
        @click="toggle"
      >
        <span class="cp-swatch-fill" :style="{ background: isNone ? 'transparent' : modelValue }" />
      </button>
      <input
        type="text"
        class="cp-text"
        :value="modelValue"
        placeholder="Mixed"
        spellcheck="false"
        @change="onTextChange"
      />
    </div>

    <div v-if="open" class="cp-panel" @pointerdown="begin">
      <div class="cp-wheel-wrap">
        <canvas
          ref="wheel"
          class="cp-wheel"
          :width="WHEEL"
          :height="WHEEL"
          @pointerdown="onWheelDown"
        />
        <span class="cp-wheel-dot" :style="dotStyle" />
      </div>

      <label class="cp-slider-label">Brightness</label>
      <input
        type="range"
        class="cp-slider cp-slider-value"
        min="0"
        max="1"
        step="0.005"
        :value="hsv.v"
        :style="{ '--cp-track': valueTrack }"
        @input="setValue(num($event))"
      />

      <label class="cp-slider-label">
        Opacity <span class="cp-slider-num">{{ Math.round(alpha * 100) }}%</span>
      </label>
      <div class="cp-alpha-track">
        <input
          type="range"
          class="cp-slider cp-slider-alpha"
          min="0"
          max="1"
          step="0.01"
          :value="alpha"
          :style="{ '--cp-track': alphaTrack }"
          @input="setAlpha(num($event))"
        />
      </div>

      <div class="cp-swatches">
        <button
          v-if="allowNone"
          type="button"
          class="cp-chip cp-chip-none"
          title="None (no paint)"
          @click="emitValue('none')"
        />
        <button
          v-for="c in swatches"
          :key="c"
          type="button"
          class="cp-chip"
          :title="c"
          @click="pickSwatch(c)"
        >
          <span class="cp-chip-fill" :style="{ background: c }" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { formatColor, hsvToRgb, isNonePaint, parseColor, rgbToHsv, toHex, type Hsv } from '@/services/canvas/color'

const props = withDefaults(
  defineProps<{ modelValue: string; allowNone?: boolean; swatches?: string[]; defaultOpen?: boolean }>(),
  { allowNone: true, swatches: () => [], defaultOpen: false },
)
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  // Fired once at the start of each interaction so the host can snapshot undo.
  (e: 'begin'): void
}>()

const WHEEL = 168
const open = ref(props.defaultOpen)
const wheel = ref<HTMLCanvasElement | null>(null)

// HSV is kept locally so hue/saturation survive passing through black/grey
// (where they're undefined in RGB) while the user drags.
const hsv = ref<Hsv>({ h: 0, s: 0, v: 0 })
const alpha = ref(1)
let lastEmitted: string | null = null

// An empty value means a multi-selection with differing paints ("Mixed").
onMounted(() => {
  if (open.value) drawWheel()
})

const isNone = computed(() => props.modelValue !== '' && isNonePaint(props.modelValue))

function syncFromValue(value: string) {
  if (value === lastEmitted) return
  const c = parseColor(value)
  if (!c) return
  const next = rgbToHsv(c)
  // Keep the current hue/saturation when the incoming color has none.
  if (next.v === 0) next.h = hsv.value.h
  if (next.s === 0) next.h = hsv.value.h
  hsv.value = next
  alpha.value = c.a
}
watch(() => props.modelValue, syncFromValue, { immediate: true })

function emitValue(value: string) {
  lastEmitted = value
  emit('update:modelValue', value)
}

function emitFromHsv() {
  emitValue(formatColor({ ...hsvToRgb(hsv.value), a: alpha.value }))
}

function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value)
}

function begin() {
  emit('begin')
}

function toggle() {
  open.value = !open.value
  if (open.value) nextTick(drawWheel)
}

function onTextChange(e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim()
  emit('begin')
  if (isNonePaint(raw)) return emitValue('none')
  const c = parseColor(raw)
  // Re-emit in canonical form; leave unparseable input to the host as typed.
  emitValue(c ? formatColor(c) : raw)
  syncFromValue(c ? formatColor(c) : raw)
}

function setValue(v: number) {
  hsv.value = { ...hsv.value, v }
  // Coming from "none", start fully opaque so the change is visible.
  if (isNone.value) alpha.value = 1
  emitFromHsv()
  drawWheel()
}

function setAlpha(a: number) {
  alpha.value = a
  emitFromHsv()
}

function pickSwatch(c: string) {
  const parsed = parseColor(c)
  if (!parsed) return
  lastEmitted = null
  syncFromValue(c)
  emitValue(formatColor(parsed))
  drawWheel()
}

// --- Wheel: hue = angle, saturation = radius, at the current brightness ----
function drawWheel() {
  const cv = wheel.value
  const ctx = cv?.getContext('2d')
  if (!cv || !ctx) return
  const img = ctx.createImageData(WHEEL, WHEEL)
  const r = WHEEL / 2
  for (let y = 0; y < WHEEL; y++) {
    for (let x = 0; x < WHEEL; x++) {
      const dx = x - r + 0.5
      const dy = y - r + 0.5
      const dist = Math.hypot(dx, dy)
      const i = (y * WHEEL + x) * 4
      if (dist > r) continue
      const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
      const { r: cr, g, b } = hsvToRgb({ h, s: Math.min(1, dist / r), v: hsv.value.v })
      img.data[i] = cr
      img.data[i + 1] = g
      img.data[i + 2] = b
      // Feather the rim by one pixel.
      img.data[i + 3] = dist > r - 1 ? Math.round((r - dist) * 255) : 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

function pickAt(clientX: number, clientY: number) {
  const cv = wheel.value
  if (!cv) return
  const rect = cv.getBoundingClientRect()
  const r = rect.width / 2
  const dx = clientX - rect.left - r
  const dy = clientY - rect.top - r
  const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
  const s = Math.min(1, Math.hypot(dx, dy) / r)
  // Picking on the wheel at zero brightness would be invisible; lift it.
  const v = hsv.value.v < 0.05 ? 1 : hsv.value.v
  if (isNone.value) alpha.value = 1
  const redraw = v !== hsv.value.v
  hsv.value = { h, s, v }
  emitFromHsv()
  if (redraw) drawWheel()
}

function onWheelDown(e: PointerEvent) {
  pickAt(e.clientX, e.clientY)
  const move = (ev: PointerEvent) => pickAt(ev.clientX, ev.clientY)
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

const dotStyle = computed(() => {
  const rad = (hsv.value.h * Math.PI) / 180
  const pct = (n: number) => `${50 + n * 50}%`
  return {
    left: pct(Math.cos(rad) * hsv.value.s),
    top: pct(Math.sin(rad) * hsv.value.s),
    background: toHex(hsvToRgb(hsv.value)),
  }
})

const valueTrack = computed(
  () => `linear-gradient(to right, #000, ${toHex(hsvToRgb({ ...hsv.value, v: 1 }))})`,
)
const alphaTrack = computed(() => {
  const hex = toHex(hsvToRgb(hsv.value))
  return `linear-gradient(to right, ${hex}00, ${hex})`
})
</script>

<style scoped>
.cp-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
/* Checkerboard behind every swatch so transparency is visible. */
.cp-swatch,
.cp-chip,
.cp-alpha-track {
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #d4d4d8 25%, transparent 25%),
    linear-gradient(-45deg, #d4d4d8 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #d4d4d8 75%),
    linear-gradient(-45deg, transparent 75%, #d4d4d8 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
}
.cp-swatch {
  position: relative;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
}
.cp.open .cp-swatch {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.cp-swatch-fill,
.cp-chip-fill {
  position: absolute;
  inset: 0;
}
/* "None": white with a red diagonal, Illustrator-style. */
.cp-swatch.is-none,
.cp-chip-none {
  background: linear-gradient(to top right, #fff calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), #fff calc(50% + 1px));
}
.cp-text {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 13px;
  color: #211a43;
  background: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.cp-panel {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  background: #fafafa;
}
.cp-wheel-wrap {
  position: relative;
  width: 168px;
  height: 168px;
  margin: 0 auto 12px;
}
.cp-wheel {
  width: 168px;
  height: 168px;
  border-radius: 50%;
  cursor: crosshair;
  touch-action: none;
  display: block;
}
.cp-wheel-dot {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
.cp-slider-label {
  display: block;
  font-size: 11px;
  color: #71717a;
  margin: 2px 0 4px;
}
.cp-slider-num {
  float: right;
  color: #a1a1aa;
}
.cp-alpha-track {
  border-radius: 6px;
  margin-bottom: 10px;
}
.cp-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 12px;
  margin: 0 0 10px;
  border-radius: 6px;
  background: var(--cp-track);
  border: 1px solid rgba(0, 0, 0, 0.08);
  display: block;
}
.cp-slider-alpha {
  margin: 0;
}
.cp-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.3);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  cursor: pointer;
}
.cp-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.3);
  cursor: pointer;
}
.cp-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cp-chip {
  position: relative;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid #e4e4e7;
  border-radius: 5px;
  cursor: pointer;
  overflow: hidden;
}
.cp-chip:hover {
  border-color: #211a43;
}
</style>
