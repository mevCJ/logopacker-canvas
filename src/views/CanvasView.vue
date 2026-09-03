<template>
  <div class="canvas-page">
    <Toolbar
      :activity-open="showActivity"
      @fit-view="fitView"
      @toggle-activity="showActivity = !showActivity"
      @export="showExport = !showExport"
      @save="saveDocument"
      @load="openLoadPicker"
    />
    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      class="visually-hidden"
      @change="onFileChosen"
    />
    <div class="canvas-body">
      <CanvasStage ref="stage" class="canvas-stage-host" />
      <ToolSidebar @open-image-picker="onOpenImagePicker" />
      <ImageToolPopover v-if="imagePicker.open" :anchor="imagePicker.anchor" @close="imagePicker.open = false" />
      <div v-if="showExport" class="export-overlay" @mousedown="showExport = false">
        <ExportDialog @close="showExport = false" />
      </div>
      <PropertyPanel />
      <Transition name="activity-slide">
        <AgentActivityLog v-if="showActivity" />
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useCanvasStore } from '@/stores/canvas'
import { seedNova } from '@/services/canvas/novaSeed'
import { registerCanvasTools } from '@/services/canvas/tools'
import { buildImageTextTools } from '@/services/canvas/imageTextTools'
import { saveDocumentToFile, parseDocumentFile } from '@/services/canvas/documentIO'
import CanvasStage from '@/components/canvas/CanvasStage.vue'
import Toolbar from '@/components/canvas/Toolbar.vue'
import ToolSidebar from '@/components/canvas/ToolSidebar.vue'
import ImageToolPopover from '@/components/canvas/ImageToolPopover.vue'
import ExportDialog from '@/components/canvas/ExportDialog.vue'
import PropertyPanel from '@/components/canvas/PropertyPanel.vue'
import AgentActivityLog from '@/components/canvas/AgentActivityLog.vue'

const store = useCanvasStore()
const stage = ref<{ fitViewBox: () => void } | null>(null)
const showActivity = ref(false)
const showExport = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
let unregisterTools: (() => void) | null = null

const imagePicker = reactive<{ open: boolean; anchor: { left: number; top: number } | null }>({
  open: false,
  anchor: null,
})

function fitView() {
  stage.value?.fitViewBox()
}

// Serialize the whole document and download it as a .json file.
function saveDocument() {
  saveDocumentToFile(store.serializeDocument())
}

// Open the hidden file picker to load a saved document.
function openLoadPicker() {
  fileInput.value?.click()
}

// Parse the chosen file and replace the current document. Resets the input so
// picking the same file again still fires a change event.
async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const doc = await parseDocumentFile(file)
    store.loadDocument(doc)
    fitView()
  } catch (err) {
    window.alert((err as Error)?.message || 'Could not open that file.')
  }
}

// Open the image picker anchored just to the right of the image tool button.
function onOpenImagePicker(el: HTMLElement | null) {
  const bodyRect = el?.closest('.canvas-body')?.getBoundingClientRect()
  const btnRect = el?.getBoundingClientRect()
  if (btnRect && bodyRect) {
    imagePicker.anchor = {
      left: btnRect.right - bodyRect.left + 8,
      top: btnRect.top - bodyRect.top,
    }
  } else {
    imagePicker.anchor = { left: 72, top: 120 }
  }
  imagePicker.open = true
}

// Close the picker when the image tool is deselected.
watch(
  () => store.activeTool,
  (t) => {
    if (t !== 'image') imagePicker.open = false
  },
)

onMounted(() => {
  // Seed the NOVA primary logo (imports + tags src/assets/logoipsum.svg) only
  // when the page is opened with ?demo=1. Otherwise start with a blank canvas.
  const demo =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('demo') === '1'
  if (demo && store.artboards.length === 0) {
    seedNova(store)
  }
  // Register WebMCP tools so an external agent can operate the canvas.
  unregisterTools = registerCanvasTools(store, {
    extraTools: (s, logger) => buildImageTextTools(s, logger),
  })
})

onBeforeUnmount(() => {
  if (unregisterTools) unregisterTools()
  unregisterTools = null
  store.resetToolState()
})
</script>

<style scoped>
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.canvas-page {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  background: #ececed;
  overflow: hidden;
  font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
}
.canvas-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
  position: relative;
}
.canvas-stage-host {
  flex: 1;
  min-width: 0;
  height: 100%;
  background-color: #ececed;
  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.06) 1px, transparent 1px);
  background-size: 22px 22px;
}
/* Full-screen dimmed overlay that centers the export dialog. */
.export-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 27, 0.32);
}
.activity-slide-enter-active,
.activity-slide-leave-active {
  transition: margin-right 0.2s ease;
  overflow: hidden;
}
.activity-slide-enter-from,
.activity-slide-leave-to {
  margin-right: -300px;
}
</style>
