<template>
  <div class="export-popover" @mousedown.stop @wheel.stop>
    <header class="ep-header">
      <span class="ep-title">Export</span>
      <button class="ep-close" title="Close" @click="emit('close')">×</button>
    </header>

    <!-- Scope -->
    <section class="ep-section">
      <span class="ep-label">What to export</span>
      <div class="ep-radios">
        <label class="ep-radio" :class="{ disabled: !hasSelection }">
          <input
            type="radio"
            value="selection"
            v-model="scope"
            :disabled="!hasSelection"
          />
          <span>Selected elements<template v-if="hasSelection"> ({{ selectionCount }})</template></span>
        </label>
        <label class="ep-radio" :class="{ disabled: !hasArtboards }">
          <input type="radio" value="artboard" v-model="scope" :disabled="!hasArtboards" />
          <span>Artboard</span>
        </label>
        <label class="ep-radio" :class="{ disabled: !hasArtboards }">
          <input type="radio" value="all" v-model="scope" :disabled="!hasArtboards" />
          <span>All artboards</span>
        </label>
      </div>

      <select v-if="scope === 'artboard'" v-model="artboardId" class="ep-select">
        <option v-for="ab in artboards" :key="ab.id" :value="ab.id">
          {{ ab.name || ab.id }}
        </option>
      </select>
    </section>

    <div class="ep-divider" />

    <!-- Format -->
    <section class="ep-section">
      <span class="ep-label">Format</span>
      <div class="ep-toggle">
        <button
          class="ep-toggle-btn"
          :class="{ active: format === 'svg' }"
          @click="format = 'svg'"
        >
          SVG
        </button>
        <button
          class="ep-toggle-btn"
          :class="{ active: format === 'png' }"
          @click="format = 'png'"
        >
          PNG
        </button>
      </div>
    </section>

    <!-- PNG options -->
    <section v-if="format === 'png'" class="ep-section">
      <span class="ep-label">Scale</span>
      <div class="ep-toggle">
        <button
          v-for="s in [1, 2, 3]"
          :key="s"
          class="ep-toggle-btn"
          :class="{ active: scale === s }"
          @click="scale = s"
        >
          {{ s }}x
        </button>
      </div>
    </section>

    <!-- Background -->
    <section class="ep-section">
      <span class="ep-label">Background</span>
      <div class="ep-toggle">
        <button
          class="ep-toggle-btn"
          :class="{ active: !transparent }"
          @click="transparent = false"
        >
          {{ scope === 'selection' ? 'White' : 'Artboard' }}
        </button>
        <button
          class="ep-toggle-btn"
          :class="{ active: transparent }"
          @click="transparent = true"
        >
          Transparent
        </button>
      </div>
    </section>

    <p v-if="error" class="ep-error">{{ error }}</p>

    <button class="ep-export" :disabled="!canExport || busy" @click="doExport">
      {{ busy ? 'Exporting…' : `Export ${format.toUpperCase()}` }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import {
  resolveExportSet,
  buildExportSvg,
  type ExportScope,
  type ExportStateSnapshot,
} from '@/services/canvas/svgExport'
import { exportSvg, exportPng, exportFilename } from '@/services/canvas/exportService'
import type { RenderObject } from '@/services/canvas/svgEngine'

const emit = defineEmits<{ (e: 'close'): void }>()

const store = useCanvasStore()
const { artboards, selectedIds, selectedArtboardId } = storeToRefs(store)

const hasSelection = computed(() => selectedIds.value.length > 0)
const selectionCount = computed(() => selectedIds.value.length)
const hasArtboards = computed(() => artboards.value.length > 0)

// Default scope from current selection: selected elements if any, else artboard.
const scope = ref<ExportScope>(hasSelection.value ? 'selection' : hasArtboards.value ? 'artboard' : 'selection')
const format = ref<'svg' | 'png'>('svg')
const scale = ref(2)
const transparent = ref(false)
const busy = ref(false)
const error = ref('')

// Default the artboard dropdown to the selected artboard, the selection's
// artboard, or the first artboard.
function defaultArtboardId(): string {
  if (selectedArtboardId.value) return selectedArtboardId.value
  const firstSel = selectedIds.value[0]
  const selObj = firstSel ? store.getObject(firstSel) : null
  if (selObj?.artboardId) return selObj.artboardId
  return artboards.value[0]?.id || ''
}
const artboardId = ref(defaultArtboardId())

watch(scope, (s) => {
  if (s === 'artboard' && !artboards.value.some((a) => a.id === artboardId.value)) {
    artboardId.value = defaultArtboardId()
  }
})

// Build a plain snapshot for pure scope resolution.
function snapshot(): ExportStateSnapshot {
  return {
    artboards: JSON.parse(JSON.stringify(store.artboards)),
    objects: JSON.parse(JSON.stringify(store.objects)) as Record<string, RenderObject>,
    objectOrder: [...store.objectOrder],
    selectedIds: [...store.selectedIds],
    selectedArtboardId: store.selectedArtboardId,
  }
}

const resolved = computed(() =>
  resolveExportSet(snapshot(), scope.value, artboardId.value),
)

const canExport = computed(() => resolved.value.objects.length > 0)

async function doExport() {
  error.value = ''
  const set = resolved.value
  if (!set.objects.length) {
    error.value = 'Nothing to export for this selection.'
    return
  }

  // Background: opaque unless transparent is chosen. For selection/all with a
  // solid fill we use white; artboard scope already paints its own background,
  // so the solid fill is only needed for selection scope.
  const solidBg =
    transparent.value || set.includeArtboardBackgrounds ? null : '#FFFFFF'

  const { svg, bounds } = buildExportSvg({
    objects: set.objects,
    artboards: set.artboards,
    includeArtboardBackgrounds: set.includeArtboardBackgrounds && !transparent.value,
    background: solidBg,
  })

  if (bounds.width <= 0 || bounds.height <= 0) {
    error.value = 'The selected content has no visible area to export.'
    return
  }

  try {
    if (format.value === 'svg') {
      exportSvg({ svgString: svg, filename: exportFilename(scope.value, 'svg') })
      emit('close')
      return
    }
    // PNG
    busy.value = true
    const pngBg = transparent.value ? null : '#FFFFFF'
    const res = await exportPng({
      svgString: svg,
      width: bounds.width,
      height: bounds.height,
      scale: scale.value,
      background: pngBg,
      filename: exportFilename(scope.value, 'png'),
    })
    if (res.failed.length) {
      error.value = `Exported, but ${res.failed.length} remote image(s) could not be embedded.`
    } else {
      emit('close')
    }
  } catch (err) {
    error.value = (err as Error)?.message || 'Export failed.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.export-popover {
  position: relative;
  width: 260px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 14px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(24, 24, 27, 0.16);
  font-family: Inter, sans-serif;
}
.ep-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.ep-title {
  font-weight: 600;
  color: #211a43;
  font-size: 14px;
}
.ep-close {
  border: none;
  background: none;
  font-size: 20px;
  line-height: 1;
  color: #a1a1aa;
  cursor: pointer;
}
.ep-close:hover {
  color: #211a43;
}
.ep-section {
  margin-bottom: 12px;
}
.ep-label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #71717a;
  margin-bottom: 6px;
}
.ep-radios {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ep-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #211a43;
  cursor: pointer;
}
.ep-radio.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ep-select {
  margin-top: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 13px;
  color: #211a43;
  background: #fff;
}
.ep-divider {
  height: 1px;
  background: #e4e4e7;
  margin: 4px 0 12px;
}
.ep-toggle {
  display: flex;
  gap: 6px;
}
.ep-toggle-btn {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  color: #211a43;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.ep-toggle-btn:hover {
  background: #f4f4f5;
}
.ep-toggle-btn.active {
  background: #211a43;
  border-color: #211a43;
  color: #fff;
}
.ep-error {
  color: #dc2626;
  font-size: 12px;
  margin: 0 0 10px;
}
.ep-export {
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
.ep-export:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
