<template>
  <aside class="property-panel">
    <!-- Artboard properties (shown when an artboard is selected and no object is) -->
    <div v-if="!selected && artboard" class="pp-body">
      <header class="pp-header">
        <span class="pp-role">Artboard</span>
        <span class="pp-type">artboard</span>
      </header>

      <section class="pp-section">
        <label class="pp-label">Name</label>
        <input type="text" class="pp-text-input" :value="artboard.name" @change="updateArtboard({ name: val($event) })" />
      </section>

      <section class="pp-section pp-row-2">
        <div>
          <label class="pp-label">X</label>
          <input type="number" class="pp-number" :value="Math.round(artboard.x)" @input="updateArtboard({ x: num($event) })" />
        </div>
        <div>
          <label class="pp-label">Y</label>
          <input type="number" class="pp-number" :value="Math.round(artboard.y)" @input="updateArtboard({ y: num($event) })" />
        </div>
      </section>

      <section class="pp-section pp-row-2">
        <div>
          <label class="pp-label">Width</label>
          <input type="number" min="1" class="pp-number" :value="Math.round(artboard.width)" @input="updateArtboard({ width: Math.max(1, num($event)) })" />
        </div>
        <div>
          <label class="pp-label">Height</label>
          <input type="number" min="1" class="pp-number" :value="Math.round(artboard.height)" @input="updateArtboard({ height: Math.max(1, num($event)) })" />
        </div>
      </section>

      <section class="pp-section">
        <label class="pp-label">Background</label>
        <ColorPicker
          :model-value="artboard.backgroundColor"
          :allow-none="false"
          :swatches="docColors"
          @begin="store.snapshot('Edit artboard')"
          @update:model-value="store.setArtboardBackground(artboard.id, $event)"
        />
      </section>

      <section class="pp-section">
        <button
          type="button"
          class="pp-fit-btn"
          :disabled="!artboardHasArtwork"
          :title="artboardHasArtwork ? 'Resize this artboard to fit its artwork' : 'This artboard has no artwork to fit'"
          @click="fitArtboardToArtwork"
        >
          Fit artboard to artwork
        </button>
      </section>
    </div>

    <!-- Multi-selection: shared paint/opacity + Pathfinder / Shape Builder -->
    <div v-else-if="!selected && multi.length > 1" class="pp-body">
      <header class="pp-header">
        <span class="pp-role">{{ multi.length }} objects</span>
        <span class="pp-type">selection</span>
      </header>

      <section v-if="multiPaintable.length" class="pp-section">
        <label class="pp-label">Fill</label>
        <ColorPicker
          :model-value="multiFill"
          :swatches="docColors"
          @begin="store.snapshot('Recolor')"
          @update:model-value="setMultiFill"
        />
      </section>

      <section class="pp-section">
        <label class="pp-label">Opacity <span class="pp-value">{{ Math.round(multiOpacity * 100) }}%</span></label>
        <input type="range" min="0" max="1" step="0.01" class="pp-range" :value="multiOpacity" @pointerdown="store.snapshot('Opacity')" @input="setMultiOpacity(num($event))" />
      </section>

      <section v-if="multiPaths.length >= 2" class="pp-section">
        <label class="pp-label">Pathfinder</label>
        <div class="pp-pathfinder">
          <button v-for="op in pathfinderOps" :key="op.id" type="button" class="pp-pf-btn" :title="op.title" :disabled="busy" @click="runPathfinder(op.id)">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" v-html="op.icon" />
          </button>
        </div>
        <button type="button" class="pp-fit-btn pp-mt" title="Shape Builder (Shift+M)" @click="store.setActiveTool('shapeBuilder')">
          Shape Builder
        </button>
        <p v-if="opError" class="pp-error">{{ opError }}</p>
      </section>
    </div>

    <div v-else-if="!selected" class="pp-empty">
      <p class="pp-empty-title">No selection</p>
      <p class="pp-empty-sub">Select an object on the canvas to edit its properties.</p>
    </div>

    <div v-else class="pp-body">
      <header class="pp-header">
        <span class="pp-role">{{ roleLabel }}</span>
        <span class="pp-type">{{ selected.type }}</span>
      </header>

      <!-- Path properties -->
      <template v-if="selected.type === 'path'">
        <section class="pp-section">
          <label class="pp-label">Fill</label>
          <FillControl :target="selected" :swatches="docColors" />
        </section>

        <section class="pp-section">
          <label class="pp-label">Stroke</label>
          <ColorPicker :model-value="selected.stroke" :swatches="docColors" @begin="store.snapshot('Recolor')" @update:model-value="setStrokeColor" />
        </section>

        <section class="pp-section">
          <label class="pp-label">Stroke width</label>
          <input type="number" min="0" step="0.5" class="pp-number" :value="selected.strokeWidth" @input="setStrokeWidth(num($event))" />
        </section>

        <section v-if="selected.shape === 'rect'" class="pp-section">
          <label class="pp-label">Corner radius <span class="pp-value">{{ Math.round(selected.cornerRadius || 0) }}</span></label>
          <div class="pp-color-row">
            <input type="range" min="0" :max="maxCornerRadius" step="1" class="pp-range" :value="selected.cornerRadius || 0" @input="setCornerRadius(num($event))" />
            <input type="number" min="0" :max="maxCornerRadius" class="pp-number pp-rot-num" :value="Math.round(selected.cornerRadius || 0)" @input="setCornerRadius(num($event))" />
          </div>
        </section>
      </template>

      <!-- Text properties -->
      <template v-else-if="selected.type === 'text'">
        <section class="pp-section">
          <label class="pp-label">Text</label>
          <textarea class="pp-textarea" :value="selected.text" @input="update({ text: val($event) })" />
        </section>

        <section class="pp-section">
          <label class="pp-label">Font</label>
          <FontPicker :model-value="selected.fontFamily" @update:model-value="editText({ fontFamily: $event })" />
        </section>

        <section class="pp-section pp-row-2">
          <div>
            <label class="pp-label">Size</label>
            <input type="number" min="1" class="pp-number" :value="selected.fontSize" @change="editText({ fontSize: Math.max(1, num($event)) })" />
          </div>
          <div>
            <label class="pp-label">Weight</label>
            <select class="pp-select" :value="selected.fontWeight" @change="editText({ fontWeight: num($event) })">
              <option v-for="w in weightOptions(selected.fontFamily)" :key="w.value" :value="w.value">{{ w.label }}</option>
            </select>
          </div>
        </section>

        <section v-if="!selected.pathD" class="pp-section">
          <label class="pp-label">Type</label>
          <div class="pp-align">
            <button class="pp-align-btn" :class="{ active: !selected.area }" title="Point type: no wrapping; resizing scales the text" @click="setArea(false)">Point</button>
            <button class="pp-align-btn" :class="{ active: selected.area }" title="Area type: wraps inside a box; resizing re-flows the text" @click="setArea(true)">Area</button>
          </div>
        </section>

        <section v-if="selected.area" class="pp-section">
          <label class="pp-label">Leading <span class="pp-value">{{ (selected.lineHeight || 1.2).toFixed(2) }}×</span></label>
          <input type="range" min="0.8" max="2.5" step="0.05" class="pp-range" :value="selected.lineHeight || 1.2" @pointerdown="store.snapshot('Leading')" @input="update({ lineHeight: num($event) })" />
        </section>

        <section class="pp-section">
          <button type="button" class="pp-ghost-btn" title="Convert the text to vector paths (Shift+Cmd/Ctrl+O)" :disabled="busy" @click="outlines">
            Create Outlines
          </button>
          <p v-if="opError" class="pp-error">{{ opError }}</p>
        </section>

        <section class="pp-section">
          <label class="pp-label">Color</label>
          <FillControl :target="selected" :swatches="docColors" />
        </section>

        <section v-if="selected.pathD" class="pp-section">
          <label class="pp-label">Start on path <span class="pp-value">{{ Math.round(selected.pathOffset || 0) }}%</span></label>
          <input type="range" min="0" max="100" step="0.5" class="pp-range" :value="selected.pathOffset || 0" @pointerdown="store.snapshot('Text path offset')" @input="update({ pathOffset: num($event) })" />
          <button type="button" class="pp-ghost-btn pp-mt" @click="releaseTextPath">Release from path</button>
        </section>

        <section class="pp-section">
          <label class="pp-label">Alignment</label>
          <div class="pp-align">
            <button
              v-for="a in alignments"
              :key="a"
              class="pp-align-btn"
              :class="{ active: selected.align === a }"
              @click="update({ align: a })"
            >
              {{ a }}
            </button>
          </div>
        </section>
      </template>

      <!-- Image properties -->
      <template v-else-if="selected.type === 'image'">
        <p v-if="selected.alt" class="pp-alt">{{ selected.alt }}</p>

        <section class="pp-section pp-trace">
          <label class="pp-label">Image Trace</label>
          <label class="pp-label pp-sub">Colors <span class="pp-value">{{ trace.colors }}</span></label>
          <input v-model.number="trace.colors" type="range" min="2" max="16" step="1" class="pp-range" />
          <label class="pp-label pp-sub">Detail <span class="pp-value">{{ Math.round(trace.detail * 100) }}%</span></label>
          <input v-model.number="trace.detail" type="range" min="0" max="1" step="0.05" class="pp-range" />
          <label class="pp-check">
            <input v-model="trace.removeWhite" type="checkbox" />
            Remove white background
          </label>
          <button type="button" class="pp-fit-btn pp-mt" :disabled="busy" @click="vectorize">
            {{ busy ? 'Tracing…' : 'Vectorize' }}
          </button>
          <p v-if="opError" class="pp-error">{{ opError }}</p>
        </section>
      </template>

      <!-- Transform (shared): size + rotation -->
      <section class="pp-section pp-row-2">
        <div>
          <label class="pp-label">Width</label>
          <input type="number" min="1" class="pp-number" :value="Math.round(selected.width)" @input="setWidth(num($event))" />
        </div>
        <div>
          <label class="pp-label">Height</label>
          <input type="number" min="1" class="pp-number" :value="Math.round(selected.height)" @input="setHeight(num($event))" />
        </div>
      </section>

      <section class="pp-section">
        <label class="pp-label">Rotation <span class="pp-value">{{ Math.round(selected.rotation || 0) }}°</span></label>
        <div class="pp-color-row">
          <input type="range" min="0" max="360" step="1" class="pp-range" :value="selected.rotation || 0" @input="setRotation(num($event))" />
          <input type="number" min="0" max="360" class="pp-number pp-rot-num" :value="Math.round(selected.rotation || 0)" @input="setRotation(num($event))" />
        </div>
      </section>

      <!-- Opacity (shared) -->
      <section class="pp-section">
        <label class="pp-label">Opacity</label>
        <div class="pp-color-row">
          <input type="range" min="0" max="1" step="0.01" class="pp-range" :value="selected.opacity" @pointerdown="store.snapshot('Opacity')" @input="setOpacity(num($event))" />
          <input type="number" min="0" max="100" class="pp-number pp-rot-num" :value="Math.round(selected.opacity * 100)" @change="store.snapshot('Opacity'); setOpacity(Math.min(100, Math.max(0, num($event))) / 100)" />
        </div>
      </section>

      <!-- Semantic role (read + editable for demo clarity) -->
      <section class="pp-section">
        <label class="pp-label">Semantic role</label>
        <select class="pp-select" :value="selected.semanticRole" @change="update({ semanticRole: val($event) })">
          <option v-for="r in roles" :key="r" :value="r">{{ r }}</option>
        </select>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import ColorPicker from './ColorPicker.vue'
import FillControl from './FillControl.vue'
import FontPicker from './FontPicker.vue'
import { weightOptions } from '@/services/canvas/fontLibrary'
import { createOutlines } from '@/services/canvas/textOutlines'
import { applyPathfinder, type PathfinderOp } from '@/services/canvas/pathBoolean'
import { vectorizeImageObject, VECTORIZE_DEFAULTS } from '@/services/canvas/vectorize'
import { documentColors } from '@/services/canvas/documentColors'
import {
  useCanvasStore,
  TEXT_ALIGNMENTS,
  SEMANTIC_ROLES,
} from '@/stores/canvas'

const store = useCanvasStore()

const alignments = TEXT_ALIGNMENTS
const roles = SEMANTIC_ROLES

const selected = computed(() => store.singleSelected)
const multi = computed(() => store.selectedObjects)
const multiPaths = computed(() => multi.value.filter((o) => o.type === 'path'))
const multiPaintable = computed(() => multi.value.filter((o) => o.type !== 'image'))
const multiFill = computed(() => {
  const fills = new Set(multiPaintable.value.map((o) => (o as { fill: string }).fill))
  return fills.size === 1 ? [...fills][0]! : ''
})
const multiOpacity = computed(() => {
  const list = multi.value
  return list.length ? list.reduce((s, o) => s + (o.opacity ?? 1), 0) / list.length : 1
})

const docColors = computed(() => documentColors(store))

// Long-running ops (paper.js load, tracing) share one busy flag + error line.
const busy = ref(false)
const opError = ref('')
watch(() => store.selectedIds.join(','), () => (opError.value = ''))

const trace = reactive({
  colors: VECTORIZE_DEFAULTS.colors,
  detail: VECTORIZE_DEFAULTS.detail,
  removeWhite: VECTORIZE_DEFAULTS.removeWhite,
})

async function vectorize() {
  const o = selected.value
  if (!o || o.type !== 'image' || busy.value) return
  busy.value = true
  opError.value = ''
  store.snapshot('Vectorize')
  try {
    const ids = await vectorizeImageObject(store, o.id, { ...trace })
    store.selectObjects(ids)
  } catch (err) {
    store.undo()
    opError.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

const pathfinderOps: { id: PathfinderOp; title: string; icon: string }[] = [
  { id: 'unite', title: 'Unite', icon: '<path d="M3 3h11v7h7v11H10v-7H3z" fill="currentColor"/>' },
  { id: 'minusFront', title: 'Minus Front', icon: '<path d="M3 3h11v7h-4v4H3z" fill="currentColor"/><path d="M10.5 10.5h10v10h-10z" fill="none" stroke="currentColor" stroke-dasharray="2 2"/>' },
  { id: 'intersect', title: 'Intersect', icon: '<path d="M3.5 3.5h10v10h-10zM10.5 10.5h10v10h-10z" fill="none" stroke="currentColor" stroke-dasharray="2 2"/><path d="M10 10h4v4h-4z" fill="currentColor"/>' },
  { id: 'exclude', title: 'Exclude', icon: '<path d="M3 3h11v7h-4v4H3zM14 10h7v11H10v-7h4z" fill="currentColor"/>' },
]

async function runPathfinder(op: PathfinderOp) {
  if (busy.value) return
  busy.value = true
  opError.value = ''
  store.snapshot('Pathfinder')
  try {
    const ids = await applyPathfinder(store, multiPaths.value.map((o) => o.id), op)
    store.selectObjects(ids)
  } catch (err) {
    store.undo()
    opError.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function setMultiFill(v: string) {
  for (const o of multiPaintable.value) store.setFill(o.id, v)
}
function setMultiOpacity(v: number) {
  for (const o of multi.value) store.setOpacity(o.id, v)
}

// Text edits from the panel are one undo step each.
function editText(patch: Record<string, unknown>) {
  if (!selected.value) return
  store.snapshot('Edit text')
  store.updateObject(selected.value.id, patch)
}

// Point ⇄ area type. Both put the first baseline one font size below the
// origin, so the origin stays and the box is sized to the drawn text.
function setArea(area: boolean) {
  const o = selected.value
  if (!o || o.type !== 'text' || !!o.area === area) return
  store.snapshot(area ? 'Convert to area type' : 'Convert to point type')
  if (area) {
    const b = store.objectCanvasBounds(o.id)
    const ab = o.artboardId ? store.getArtboard(o.artboardId) : null
    const ox = (ab?.x ?? 0) + o.x
    const oy = (ab?.y ?? 0) + o.y
    const fs = o.fontSize || 24
    const width = Math.max(40, Math.ceil(b ? b.x + b.width - ox : o.width) + 4)
    const height = Math.max(fs * 1.4, Math.ceil(b ? b.y + b.height - oy : o.height) + fs * 0.3)
    store.updateObject(o.id, { area: true, width, height })
  } else {
    store.updateObject(o.id, { area: false })
  }
}

async function outlines() {
  const o = selected.value
  if (!o || o.type !== 'text' || busy.value) return
  busy.value = true
  opError.value = ''
  store.snapshot('Create outlines')
  try {
    store.selectObjects(await createOutlines(store, [o.id]))
  } catch (err) {
    store.undo()
    opError.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function releaseTextPath() {
  const o = selected.value
  if (!o || o.type !== 'text') return
  store.snapshot('Release text path')
  store.updateObject(o.id, { pathD: undefined, pathOffset: undefined })
}
const artboard = computed(() => store.selectedArtboard)
const artboardHasArtwork = computed(() =>
  (artboard.value?.objectIds || []).some((id) => !!store.getObject(id)),
)
const roleLabel = computed(() => {
  const r = selected.value?.semanticRole
  return r && r !== 'none' ? r : selected.value?.type || ''
})

// Corner radius is capped at half the rectangle's shorter (base) side.
const maxCornerRadius = computed(() => {
  const o = selected.value
  if (!o || o.type !== 'path') return 0
  return Math.floor(Math.min(o.baseWidth, o.baseHeight) / 2)
})

// Event value helpers keep the template terse while staying type-safe.
function val(e: Event): string {
  return (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value
}
function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value)
}

function update(patch: Record<string, unknown>) {
  if (!selected.value) return
  store.updateObject(selected.value.id, patch)
}
function setFill(v: string) {
  if (!selected.value) return
  store.setFill(selected.value.id, v)
}
function setStrokeColor(v: string) {
  if (!selected.value) return
  store.setStroke(selected.value.id, { stroke: v })
}
function setStrokeWidth(v: number) {
  if (!selected.value) return
  store.setStroke(selected.value.id, { strokeWidth: v })
}
function setOpacity(v: number) {
  if (!selected.value) return
  store.setOpacity(selected.value.id, v)
}
function setWidth(v: number) {
  const o = selected.value
  if (!o || !v || v < 1) return
  store.resizeObject(o.id, { width: v })
}
function setHeight(v: number) {
  const o = selected.value
  if (!o || !v || v < 1) return
  if (o.type === 'text') {
    // Match the canvas handle behavior: text scales its font with its height.
    const prevH = o.height || 1
    const ratio = v / prevH
    const nextFont = Math.max(1, Math.round((o.fontSize || 24) * ratio))
    store.updateObject(o.id, { height: v, fontSize: nextFont })
  } else {
    store.resizeObject(o.id, { height: v })
  }
}
function setCornerRadius(v: number) {
  if (!selected.value) return
  store.setCornerRadius(selected.value.id, Math.max(0, v))
}
function setRotation(v: number) {
  if (!selected.value) return
  store.rotateObject(selected.value.id, v)
}

function updateArtboard(patch: Record<string, unknown>) {
  if (!artboard.value) return
  store.snapshot('Edit artboard')
  store.updateArtboard(artboard.value.id, patch)
}
function fitArtboardToArtwork() {
  if (!artboard.value || !artboardHasArtwork.value) return
  store.snapshot('Fit artboard to artwork')
  store.fitArtboardToArtwork(artboard.value.id)
}
</script>

<style scoped>
.property-panel {
  background: #ffffff;
  font-family: Inter, sans-serif;
  overflow-y: auto;
  padding: 16px;
}
.pp-empty {
  color: #a1a1aa;
  padding-top: 24px;
  text-align: center;
}
.pp-empty-title {
  font-weight: 600;
  color: #71717a;
  margin-bottom: 4px;
}
.pp-empty-sub {
  font-size: 12px;
  line-height: 1.4;
}
.pp-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f4f4f5;
}
.pp-role {
  font-weight: 600;
  color: #211a43;
  text-transform: capitalize;
}
.pp-type {
  font-size: 11px;
  color: #a1a1aa;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.pp-section {
  margin-bottom: 14px;
}
.pp-row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.pp-label {
  display: block;
  font-size: 12px;
  color: #71717a;
  margin-bottom: 6px;
}
.pp-value {
  color: #a1a1aa;
  float: right;
}
.pp-color-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.pp-swatch {
  width: 32px;
  height: 32px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  padding: 0;
  cursor: pointer;
  background: none;
}
.pp-text-input,
.pp-number,
.pp-select,
.pp-textarea {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 13px;
  color: #211a43;
  background: #fff;
}
.pp-textarea {
  resize: vertical;
  min-height: 56px;
  font-family: inherit;
}
.pp-range {
  width: 100%;
}
.pp-rot-num {
  width: 64px;
  flex-shrink: 0;
}
.pp-align {
  display: flex;
  gap: 6px;
}
.pp-align-btn {
  flex: 1;
  padding: 6px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  font-size: 12px;
  text-transform: capitalize;
  cursor: pointer;
}
.pp-align-btn.active {
  background: #211a43;
  color: #fff;
  border-color: #211a43;
}
.pp-alt {
  font-size: 12px;
  color: #a1a1aa;
  line-height: 1.4;
}
.pp-fit-btn {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid #211a43;
  border-radius: 8px;
  background: #211a43;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.pp-fit-btn:hover:not(:disabled) {
  background: #2e2559;
}
.pp-mt {
  margin-top: 8px;
}
.pp-sub {
  margin-top: 6px;
}
.pp-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #3f3f46;
  margin: 8px 0 2px;
}
.pp-error {
  margin-top: 8px;
  font-size: 12px;
  color: #b91c1c;
  line-height: 1.4;
}
.pp-ghost-btn {
  width: 100%;
  padding: 7px 12px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  color: #211a43;
  font-size: 12px;
  cursor: pointer;
}
.pp-ghost-btn:hover {
  background: #f4f4f5;
}
.pp-pathfinder {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.pp-pf-btn {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  color: #211a43;
  cursor: pointer;
}
.pp-pf-btn:hover:not(:disabled) {
  background: #f4f4f5;
}
.pp-fit-btn:disabled {
  background: #f4f4f5;
  color: #a1a1aa;
  border-color: #e4e4e7;
  cursor: not-allowed;
}
</style>
