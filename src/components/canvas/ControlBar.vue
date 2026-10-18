<template>
  <!-- Contextual Control bar, after Illustrator's: the options shown follow
       what is selected (object type, artboard, or nothing). -->
  <div ref="root" class="cb">
    <!-- Objects selected -->
    <template v-if="objects.length">
      <span class="cb-kind">{{ kindLabel }}</span>

      <template v-if="paintable.length">
        <span class="cb-sep" />
        <div class="cb-field cb-pop-host">
          <span class="cb-label">Fill</span>
          <button type="button" class="cb-swatch" :class="{ 'is-none': fillIsNone }" title="Fill" data-pop="fill" @click="toggle('fill', $event)">
            <span class="cb-swatch-fill" :style="{ background: fillPreview }" />
          </button>
          <div v-if="pop === 'fill'" class="cb-pop" :style="popStyle">
            <FillControl v-if="single && single.type !== 'image'" :target="single" :swatches="swatches" default-open @picked="pop = null" />
            <ColorPicker
              v-else
              :model-value="multiFill"
              :swatches="swatches"
              default-open
              @picked="pop = null"
              @begin="store.snapshot('Recolor')"
              @update:model-value="setMultiFill"
            />
          </div>
        </div>
      </template>

      <template v-if="paths.length">
        <div class="cb-field cb-pop-host">
          <span class="cb-label">Stroke</span>
          <button type="button" class="cb-swatch cb-swatch-stroke" :class="{ 'is-none': strokeIsNone }" title="Stroke" data-pop="stroke" @click="toggle('stroke', $event)">
            <span class="cb-swatch-fill" :style="{ background: strokeIsNone ? 'transparent' : paths[0]!.stroke }" />
          </button>
          <div v-if="pop === 'stroke'" class="cb-pop" :style="popStyle">
            <ColorPicker
              :model-value="sameValue(paths.map((p) => p.stroke))"
              :swatches="swatches"
              default-open
              @picked="pop = null"
              @begin="store.snapshot('Recolor')"
              @update:model-value="setStroke"
            />
          </div>
          <input
            type="number"
            min="0"
            step="0.5"
            class="cb-num cb-num-s"
            title="Stroke weight"
            :value="sameValue(paths.map((p) => p.strokeWidth))"
            @change="setStrokeWidth(num($event))"
          />
          <span class="cb-unit">pt</span>
        </div>
      </template>

      <span class="cb-sep" />
      <div class="cb-field">
        <span class="cb-label">Opacity</span>
        <input type="number" min="0" max="100" class="cb-num cb-num-s" :value="opacityPct" @change="setOpacity(num($event))" />
        <span class="cb-unit">%</span>
      </div>

      <!-- Character options for a single text object -->
      <template v-if="single && single.type === 'text'">
        <span class="cb-sep" />
        <div class="cb-field">
          <FontPicker compact :model-value="single.fontFamily" @update:model-value="updateSingle({ fontFamily: $event })" />
          <select class="cb-select cb-select-s" title="Font weight" :value="single.fontWeight" @change="updateSingle({ fontWeight: Number(val($event)) })">
            <option v-for="w in weightOptions(single.fontFamily)" :key="w.value" :value="w.value">{{ w.label }}</option>
          </select>
          <input type="number" min="1" class="cb-num cb-num-s" title="Font size (Shift+Cmd/Ctrl+> / <)" :value="single.fontSize" @change="updateSingle({ fontSize: Math.max(1, num($event)) })" />
          <span class="cb-unit">pt</span>
          <span class="cb-label cb-tracking" title="Tracking: letter spacing in 1/1000 em">VA</span>
          <input type="number" step="10" class="cb-num cb-num-s" title="Tracking (1/1000 em)" :value="single.tracking || 0" @change="setTracking(num($event))" />
        </div>
        <button type="button" class="cb-btn" title="Convert to vector paths (Shift+Cmd/Ctrl+O)" @click="outlines">Create Outlines</button>
      </template>

      <template v-if="single && single.type === 'image'">
        <span class="cb-sep" />
        <button type="button" class="cb-btn" :disabled="busy" @click="imageTrace">{{ busy ? 'Tracing…' : 'Image Trace' }}</button>
        <button type="button" class="cb-btn" title="Straighten, remove shadows and binarize a photographed sketch" @click="openSketchDialog(single.id)">Clean Up Sketch…</button>
      </template>

      <span class="cb-sep" />
      <div class="cb-field" :title="objects.length > 1 ? 'Align to selection' : 'Align to artboard'">
        <span class="cb-label">Align</span>
        <button v-for="a in ALIGNS" :key="a.edge" type="button" class="cb-icon" :title="a.title" :data-align="a.edge" @click="align(a.edge)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" v-html="a.icon" />
        </button>
      </div>

      <span class="cb-sep" />
      <div class="cb-field">
        <button v-for="r in REFLECTS" :key="r.axis" type="button" class="cb-icon" :title="r.title" :aria-label="r.title" @click="reflectSelection(store, r.axis)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" v-html="r.icon" />
        </button>
        <button v-if="joinable" type="button" class="cb-btn" :title="objects.length > 1 ? 'Join the two paths at their nearest ends (Cmd/Ctrl+J)' : 'Close the path (Cmd/Ctrl+J)'" @click="joinSelection(store)">
          {{ objects.length > 1 ? 'Join' : 'Close Path' }}
        </button>
      </div>

      <template v-if="single">
        <span class="cb-sep" />
        <div class="cb-field cb-transform">
          <label class="cb-label">X</label>
          <input type="number" class="cb-num" :value="Math.round(single.x)" @change="moveSingle({ x: num($event) })" />
          <label class="cb-label">Y</label>
          <input type="number" class="cb-num" :value="Math.round(single.y)" @change="moveSingle({ y: num($event) })" />
          <label class="cb-label">W</label>
          <input type="number" min="1" class="cb-num" :value="Math.round(single.width)" @change="resize('width', num($event))" />
          <label class="cb-label">H</label>
          <input type="number" min="1" class="cb-num" :value="Math.round(single.height)" @change="resize('height', num($event))" />
        </div>
      </template>
    </template>

    <!-- Artboard selected -->
    <template v-else-if="artboard">
      <span class="cb-kind">Artboard</span>
      <span class="cb-sep" />
      <input type="text" class="cb-text" :value="artboard.name" title="Artboard name" @change="updateArtboard({ name: val($event) })" />
      <div class="cb-field cb-transform">
        <label class="cb-label">W</label>
        <input type="number" min="1" class="cb-num" :value="Math.round(artboard.width)" @change="updateArtboard({ width: Math.max(1, num($event)) })" />
        <label class="cb-label">H</label>
        <input type="number" min="1" class="cb-num" :value="Math.round(artboard.height)" @change="updateArtboard({ height: Math.max(1, num($event)) })" />
      </div>
      <div class="cb-field cb-pop-host">
        <span class="cb-label">Background</span>
        <button type="button" class="cb-swatch" title="Artboard background" data-pop="bg" @click="toggle('bg', $event)">
          <span class="cb-swatch-fill" :style="{ background: artboard.backgroundColor }" />
        </button>
        <div v-if="pop === 'bg'" class="cb-pop" :style="popStyle">
          <ColorPicker
            :model-value="artboard.backgroundColor"
            :allow-none="false"
            :swatches="swatches"
            default-open
            @picked="pop = null"
            @begin="store.snapshot('Edit artboard')"
            @update:model-value="store.setArtboardBackground(artboard.id, $event)"
          />
        </div>
      </div>
      <button type="button" class="cb-btn" @click="fitArtboard">Fit to Artwork</button>
    </template>

    <!-- Nothing selected -->
    <template v-else>
      <span class="cb-kind">No Selection</span>
      <span class="cb-sep" />
      <button type="button" class="cb-btn" @click="addArtboard">New Artboard</button>
      <button type="button" class="cb-btn" @click="emit('fit-view')">Fit All</button>
      <button type="button" class="cb-btn" @click="openSketchDialog()">Capture Sketch…</button>
      <span class="cb-hint">Tip: press and hold a tool to see its group · ⌘Y toggles Outline</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ColorPicker from './ColorPicker.vue'
import FillControl from './FillControl.vue'
import {
  useCanvasStore,
  type AlignEdge,
  type PathObject,
  type TextObject,
} from '@/stores/canvas'
import { gradientCss } from '@/services/canvas/gradient'
import { isNonePaint } from '@/services/canvas/color'
import { documentColors } from '@/services/canvas/documentColors'
import { vectorizeImageObject } from '@/services/canvas/vectorize'
import { openSketchDialog } from '@/services/capture/captureState'
import FontPicker from './FontPicker.vue'
import { weightOptions } from '@/services/canvas/fontLibrary'
import { createOutlines } from '@/services/canvas/textOutlines'
import { canJoin, joinSelection, reflectSelection, type ReflectAxis } from '@/services/canvas/pathEdit'

const emit = defineEmits<{ (e: 'fit-view'): void }>()
const store = useCanvasStore()

const objects = computed(() => store.selectedObjects)
const single = computed(() => store.singleSelected)
const artboard = computed(() => store.selectedArtboard)
const paintable = computed(() => objects.value.filter((o): o is PathObject | TextObject => o.type !== 'image'))
const paths = computed(() => objects.value.filter((o): o is PathObject => o.type === 'path'))
const swatches = computed(() => documentColors(store))

const kindLabel = computed(() => {
  const list = objects.value
  if (list.length > 1) return `${list.length} Objects`
  const o = list[0]!
  if (o.type === 'text') return o.pathD ? 'Type on a Path' : 'Type'
  if (o.type === 'image') return 'Image'
  if (o.type === 'path' && o.shape) return { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' }[o.shape]
  return 'Path'
})

// A shared value across the selection, or '' when mixed.
function sameValue<T>(values: T[]): T | '' {
  return values.length && values.every((v) => v === values[0]) ? values[0]! : ''
}

const multiFill = computed(() => String(sameValue(paintable.value.map((o) => o.fill))))
const fillIsNone = computed(() => {
  const o = paintable.value[0]
  return !!o && !o.fillGradient && isNonePaint(o.fill)
})
const fillPreview = computed(() => {
  const o = paintable.value[0]
  if (!o) return 'transparent'
  if (o.fillGradient) return gradientCss(o.fillGradient, 'swatch')
  return isNonePaint(o.fill) ? 'transparent' : o.fill
})
const strokeIsNone = computed(() => isNonePaint(paths.value[0]?.stroke))
const opacityPct = computed(() => {
  const v = sameValue(objects.value.map((o) => Math.round((o.opacity ?? 1) * 100)))
  return v === '' ? '' : v
})

// --- Popovers -------------------------------------------------------------------
const pop = ref<string | null>(null)
const root = ref<HTMLElement | null>(null)
// Popovers are position:fixed (the bar scrolls horizontally, which would clip
// them), placed under the swatch that opened them and kept on screen.
const popStyle = ref<Record<string, string>>({})
function toggle(id: string, e: MouseEvent) {
  pop.value = pop.value === id ? null : id
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const left = Math.max(8, Math.min(r.left - 8, window.innerWidth - 276))
  popStyle.value = { left: `${left}px`, top: `${r.bottom + 8}px` }
}
function onDocDown(e: MouseEvent) {
  if (!pop.value) return
  const t = e.target as HTMLElement
  if (t.closest('.cb-pop') || t.closest(`[data-pop="${pop.value}"]`)) return
  pop.value = null
}
watch(() => store.selectedIds.join(',') + (store.selectedArtboardId ?? ''), () => (pop.value = null))
onMounted(() => document.addEventListener('mousedown', onDocDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown))

// --- Edits ----------------------------------------------------------------------
function val(e: Event): string {
  return (e.target as HTMLInputElement | HTMLSelectElement).value
}
function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value) || 0
}
function setMultiFill(v: string) {
  for (const o of paintable.value) store.setFill(o.id, v)
}
function setStroke(v: string) {
  for (const o of paths.value) store.setStroke(o.id, { stroke: v })
}
function setStrokeWidth(v: number) {
  store.snapshot('Stroke weight')
  for (const o of paths.value) store.setStroke(o.id, { strokeWidth: Math.max(0, v) })
}
function setOpacity(pct: number) {
  store.snapshot('Opacity')
  const v = Math.min(100, Math.max(0, pct)) / 100
  for (const o of objects.value) store.setOpacity(o.id, v)
}
function setTracking(v: number) {
  if (!single.value) return
  store.snapshot('Tracking')
  store.setTracking(single.value.id, v)
}
function updateSingle(patch: Record<string, unknown>) {
  if (!single.value) return
  store.snapshot('Edit')
  store.updateObject(single.value.id, patch)
}
function moveSingle(pos: { x?: number; y?: number }) {
  if (!single.value) return
  store.snapshot('Move')
  store.moveObject(single.value.id, pos)
}
function resize(dim: 'width' | 'height', v: number) {
  const o = single.value
  if (!o || v < 1) return
  store.snapshot('Resize')
  if (o.type === 'text' && dim === 'height') {
    // Text scales its font with its height, matching the canvas handles.
    const ratio = v / (o.height || 1)
    store.updateObject(o.id, { height: v, fontSize: Math.max(1, Math.round((o.fontSize || 24) * ratio)) })
  } else {
    store.resizeObject(o.id, { [dim]: v })
  }
}

// Reflect across the selection's center (Object ▸ Transform ▸ Reflect).
const REFLECTS: { axis: ReflectAxis; title: string; icon: string }[] = [
  {
    axis: 'horizontal',
    title: 'Reflect Horizontal',
    icon: '<path d="M12 3v18" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/><path d="M10 6 3 18h7z" fill="currentColor"/><path d="M14 6l7 12h-7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  },
  {
    axis: 'vertical',
    title: 'Reflect Vertical',
    icon: '<path d="M3 12h18" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/><path d="M6 10 18 3v7z" fill="currentColor"/><path d="M6 14l12 7v-7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  },
]
const joinable = computed(() => canJoin(store, store.selectedIds))

const ALIGNS: { edge: AlignEdge; title: string; icon: string }[] = [
  { edge: 'left', title: 'Horizontal Align Left', icon: '<path d="M4 3v18" stroke="currentColor" stroke-width="2"/><rect x="7" y="6" width="12" height="4" fill="currentColor"/><rect x="7" y="14" width="7" height="4" fill="currentColor"/>' },
  { edge: 'hcenter', title: 'Horizontal Align Center', icon: '<path d="M12 3v18" stroke="currentColor" stroke-width="2"/><rect x="5" y="6" width="14" height="4" fill="currentColor"/><rect x="8" y="14" width="8" height="4" fill="currentColor"/>' },
  { edge: 'right', title: 'Horizontal Align Right', icon: '<path d="M20 3v18" stroke="currentColor" stroke-width="2"/><rect x="5" y="6" width="12" height="4" fill="currentColor"/><rect x="10" y="14" width="7" height="4" fill="currentColor"/>' },
  { edge: 'top', title: 'Vertical Align Top', icon: '<path d="M3 4h18" stroke="currentColor" stroke-width="2"/><rect x="6" y="7" width="4" height="12" fill="currentColor"/><rect x="14" y="7" width="4" height="7" fill="currentColor"/>' },
  { edge: 'vcenter', title: 'Vertical Align Center', icon: '<path d="M3 12h18" stroke="currentColor" stroke-width="2"/><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="8" width="4" height="8" fill="currentColor"/>' },
  { edge: 'bottom', title: 'Vertical Align Bottom', icon: '<path d="M3 20h18" stroke="currentColor" stroke-width="2"/><rect x="6" y="5" width="4" height="12" fill="currentColor"/><rect x="14" y="10" width="4" height="7" fill="currentColor"/>' },
]
function align(edge: AlignEdge) {
  store.snapshot('Align')
  store.alignObjects([...store.selectedIds], edge)
}

const busy = ref(false)
async function imageTrace() {
  const o = single.value
  if (!o || o.type !== 'image' || busy.value) return
  busy.value = true
  store.snapshot('Vectorize')
  try {
    store.selectObjects(await vectorizeImageObject(store, o.id))
  } catch (err) {
    store.undo()
    window.alert((err as Error).message)
  } finally {
    busy.value = false
  }
}

async function outlines() {
  const o = single.value
  if (!o || o.type !== 'text') return
  store.snapshot('Create outlines')
  try {
    store.selectObjects(await createOutlines(store, [o.id]))
  } catch (err) {
    store.undo()
    window.alert((err as Error).message)
  }
}

function updateArtboard(patch: Record<string, unknown>) {
  if (!artboard.value) return
  store.snapshot('Edit artboard')
  store.updateArtboard(artboard.value.id, patch)
}
function fitArtboard() {
  if (!artboard.value) return
  store.snapshot('Fit artboard to artwork')
  store.fitArtboardToArtwork(artboard.value.id)
}
function addArtboard() {
  store.snapshot('Add artboard')
  store.addArtboardAuto({ name: `Artboard ${store.artboards.length + 1}`, width: 400, height: 400 })
}
</script>

<style scoped>
.cb-tracking {
  margin-left: 6px;
  letter-spacing: 0.08em;
  font-weight: 600;
}
.cb {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  font-size: 12px;
  color: #211a43;
  background: #fafafa;
  overflow-x: auto;
  overflow-y: visible;
  white-space: nowrap;
}
.cb-kind {
  font-weight: 600;
  font-size: 12px;
  min-width: 72px;
}
.cb-sep {
  width: 1px;
  height: 22px;
  background: #e4e4e7;
  flex-shrink: 0;
}
.cb-field {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.cb-label {
  color: #71717a;
  font-size: 12px;
}
.cb-unit {
  color: #a1a1aa;
  font-size: 11px;
}
.cb-hint {
  color: #a1a1aa;
  margin-left: 8px;
}
.cb-num,
.cb-text,
.cb-select {
  height: 26px;
  padding: 0 6px;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  color: #211a43;
}
.cb-num {
  width: 62px;
}
.cb-num-s {
  width: 50px;
}
.cb-text {
  width: 140px;
}
.cb-select {
  max-width: 120px;
}
.cb-select-s {
  max-width: 90px;
}
.cb-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  background: #fff;
  color: #211a43;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}
.cb-btn:hover:not(:disabled),
.cb-icon:hover {
  background: #f0f0f2;
}
.cb-icon {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #211a43;
  cursor: pointer;
}
.cb-pop-host {
  position: relative;
}
/* Swatch: checkerboard under the paint so transparency shows. */
.cb-swatch {
  position: relative;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid #d4d4d8;
  border-radius: 5px;
  overflow: hidden;
  cursor: pointer;
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #d4d4d8 25%, transparent 25%),
    linear-gradient(-45deg, #d4d4d8 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #d4d4d8 75%),
    linear-gradient(-45deg, transparent 75%, #d4d4d8 75%);
  background-size: 6px 6px;
  background-position: 0 0, 0 3px, 3px -3px, -3px 0;
}
.cb-swatch-fill {
  position: absolute;
  inset: 0;
}
/* Stroke swatch: a hollow ring, as in Illustrator. */
.cb-swatch-stroke::after {
  content: '';
  position: absolute;
  inset: 6px;
  background: #fafafa;
  border: 1px solid #d4d4d8;
  border-radius: 2px;
}
.cb-swatch.is-none {
  background: linear-gradient(to top right, #fff calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), #fff calc(50% + 1px));
}
.cb-pop {
  position: fixed;
  width: 260px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  padding: 12px;
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(24, 24, 27, 0.16);
  z-index: 60;
  white-space: normal;
}
</style>
