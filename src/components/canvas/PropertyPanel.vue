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
        <div class="pp-color-row">
          <input type="color" class="pp-swatch" :value="normalizeColor(artboard.backgroundColor)" @input="setArtboardBackground(val($event))" />
          <input type="text" class="pp-text-input" :value="artboard.backgroundColor" @change="setArtboardBackground(val($event))" />
        </div>
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
          <div class="pp-color-row">
            <input type="color" class="pp-swatch" :value="normalizeColor(selected.fill)" @input="setFill(val($event))" />
            <input type="text" class="pp-text-input" :value="selected.fill" @change="setFill(val($event))" />
          </div>
        </section>

        <section class="pp-section">
          <label class="pp-label">Stroke</label>
          <div class="pp-color-row">
            <input type="color" class="pp-swatch" :value="normalizeColor(selected.stroke)" @input="setStrokeColor(val($event))" />
            <input type="text" class="pp-text-input" :value="selected.stroke" @change="setStrokeColor(val($event))" />
          </div>
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
          <select class="pp-select" :value="selected.fontFamily" @change="update({ fontFamily: val($event) })">
            <option v-for="f in fonts" :key="f.value" :value="f.value">{{ f.label }}</option>
          </select>
        </section>

        <section class="pp-section pp-row-2">
          <div>
            <label class="pp-label">Size</label>
            <input type="number" min="1" class="pp-number" :value="selected.fontSize" @input="update({ fontSize: num($event) })" />
          </div>
          <div>
            <label class="pp-label">Weight</label>
            <select class="pp-select" :value="selected.fontWeight" @change="update({ fontWeight: num($event) })">
              <option v-for="w in weights" :key="w.value" :value="w.value">{{ w.label }}</option>
            </select>
          </div>
        </section>

        <section class="pp-section">
          <label class="pp-label">Color</label>
          <div class="pp-color-row">
            <input type="color" class="pp-swatch" :value="normalizeColor(selected.fill)" @input="setFill(val($event))" />
            <input type="text" class="pp-text-input" :value="selected.fill" @change="setFill(val($event))" />
          </div>
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
        <label class="pp-label">Opacity <span class="pp-value">{{ Math.round(selected.opacity * 100) }}%</span></label>
        <input type="range" min="0" max="1" step="0.01" class="pp-range" :value="selected.opacity" @input="setOpacity(num($event))" />
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
import { computed } from 'vue'
import {
  useCanvasStore,
  FONT_FAMILIES,
  FONT_WEIGHTS,
  TEXT_ALIGNMENTS,
  SEMANTIC_ROLES,
} from '@/stores/canvas'

const store = useCanvasStore()

const fonts = FONT_FAMILIES
const weights = FONT_WEIGHTS
const alignments = TEXT_ALIGNMENTS
const roles = SEMANTIC_ROLES

const selected = computed(() => store.singleSelected)
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
function setArtboardBackground(v: string) {
  if (!artboard.value) return
  store.snapshot('Edit artboard')
  store.setArtboardBackground(artboard.value.id, v)
}
function fitArtboardToArtwork() {
  if (!artboard.value || !artboardHasArtwork.value) return
  store.snapshot('Fit artboard to artwork')
  store.fitArtboardToArtwork(artboard.value.id)
}

function normalizeColor(c: unknown): string {
  if (typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return c
  return '#000000'
}
</script>

<style scoped>
.property-panel {
  width: 260px;
  flex-shrink: 0;
  background: #ffffff;
  border-left: 1px solid #e4e4e7;
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
.pp-fit-btn:disabled {
  background: #f4f4f5;
  color: #a1a1aa;
  border-color: #e4e4e7;
  cursor: not-allowed;
}
</style>
