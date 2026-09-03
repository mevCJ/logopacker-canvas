<template>
  <div class="toolbar">
    <div class="toolbar-brand">NOVA</div>
    <div class="toolbar-actions">
      <button class="tb-btn tb-btn-undo" :disabled="!canUndo" :title="undoTitle" @click="undo">
        {{ undoLabel }}
      </button>
      <span class="tb-sep" />
      <button class="tb-btn" title="Add artboard" @click="addArtboard">Add artboard</button>
      <button class="tb-btn" title="Fit view" @click="emit('fit-view')">Fit view</button>
      <span class="tb-sep" />
      <button class="tb-btn" :disabled="!hasSelection" title="Duplicate (Cmd/Ctrl+D)" @click="duplicate">
        Duplicate
      </button>
      <button class="tb-btn" :disabled="!hasSelection" title="Delete (Del)" @click="remove">
        Delete
      </button>
      <span class="tb-sep" />
      <span class="tb-hint">{{ selectionLabel }}</span>
      <span class="tb-sep" />
      <button
        class="tb-btn"
        :class="{ 'tb-btn-active': activityOpen }"
        :title="activityOpen ? 'Hide agent activity' : 'Show agent activity'"
        @click="emit('toggle-activity')"
      >
        Agent activity
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'

const emit = defineEmits<{ (e: 'fit-view'): void; (e: 'toggle-activity'): void }>()

defineProps<{ activityOpen?: boolean }>()

const store = useCanvasStore()
const { selectedIds, history } = storeToRefs(store)

const hasSelection = computed(() => selectedIds.value.length > 0)
const canUndo = computed(() => history.value.length > 0)
const topLabel = computed(() => {
  const last = history.value[history.value.length - 1]
  return last ? last.label : ''
})
const undoLabel = computed(() => (canUndo.value ? `Undo ${topLabel.value}` : 'Undo'))
const undoTitle = computed(() => (canUndo.value ? `Undo: ${topLabel.value}` : 'Nothing to undo'))

function undo() {
  store.undo()
}

const selectionLabel = computed(() => {
  const n = selectedIds.value.length
  if (n === 0) return 'Nothing selected'
  if (n === 1) {
    const firstId = selectedIds.value[0]
    const obj = firstId ? store.getObject(firstId) : null
    const role = obj?.semanticRole && obj.semanticRole !== 'none' ? obj.semanticRole : obj?.type
    return `Selected: ${role}`
  }
  return `${n} objects selected`
})

function addArtboard() {
  store.snapshot('Add artboard')
  store.addArtboardAuto({ name: `Artboard ${store.artboards.length + 1}`, width: 400, height: 400 })
}
function duplicate() {
  store.snapshot('Duplicate')
  const dups = [...store.selectedIds].map((id) => store.duplicateObject(id)).filter(Boolean)
  if (dups.length) store.selectObjects(dups.map((d) => d!.id))
}
function remove() {
  store.snapshot('Delete')
  ;[...store.selectedIds].forEach((id) => store.removeObject(id))
}
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 16px;
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  font-family: Inter, sans-serif;
}
.toolbar-brand {
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #211a43;
  font-size: 15px;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tb-btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid #e4e4e7;
  background: #fff;
  color: #211a43;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.tb-btn:hover:not(:disabled) {
  background: #f4f4f5;
}
.tb-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tb-btn-active {
  background: #211a43;
  border-color: #211a43;
  color: #fff;
}
.tb-btn-active:hover:not(:disabled) {
  background: #2d2456;
}
.tb-sep {
  width: 1px;
  height: 24px;
  background: #e4e4e7;
  margin: 0 4px;
}
.tb-hint {
  font-size: 12px;
  color: #71717a;
  min-width: 140px;
}
</style>
