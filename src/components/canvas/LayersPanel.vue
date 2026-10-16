<template>
  <section class="layers">
    <header class="ly-header">
      <span class="ly-title">Layers</span>
      <span class="ly-count">{{ total }}</span>
    </header>

    <div v-if="total === 0" class="ly-empty">No objects yet.</div>

    <div v-else class="ly-scroll">
      <div v-for="group in groups" :key="group.key" class="ly-group">
        <div class="ly-group-name">{{ group.name }}</div>
        <ul class="ly-list" @dragover.prevent>
          <li
            v-for="o in group.items"
            :key="o.id"
            class="ly-row"
            :class="{
              selected: selectedSet.has(o.id),
              hidden: o.hidden,
              locked: o.locked,
              'drop-above': dropTarget?.id === o.id && dropTarget.above,
              'drop-below': dropTarget?.id === o.id && !dropTarget.above,
            }"
            draggable="true"
            @click="onRowClick($event, o.id)"
            @dragstart="onDragStart($event, o.id)"
            @dragover.prevent="onDragOver($event, o.id)"
            @dragleave="onDragLeave(o.id)"
            @drop.prevent="onDrop(o.id, group.artboardId)"
            @dragend="dragId = null; dropTarget = null"
          >
            <button
              type="button"
              class="ly-icon-btn"
              :title="o.hidden ? 'Show' : 'Hide'"
              @click.stop="toggleHidden(o.id, !o.hidden)"
            >
              <svg v-if="!o.hidden" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4M6.6 6.6A17 17 0 002 12s3.6 7 10 7a9.9 9.9 0 005.4-1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <button
              type="button"
              class="ly-icon-btn"
              :class="{ on: o.locked }"
              :title="o.locked ? 'Unlock' : 'Lock'"
              @click.stop="toggleLocked(o.id, !o.locked)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
                <path :d="o.locked ? 'M8 11V7a4 4 0 018 0v4' : 'M8 11V7a4 4 0 017.7-1.5'" fill="none" stroke="currentColor" stroke-width="2" />
              </svg>
            </button>

            <span class="ly-thumb">
              <svg v-if="o.type === 'path'" :viewBox="thumbViewBox(o)" width="18" height="18" aria-hidden="true">
                <path :d="o.d" :fill="thumbPaint(o.fill)" :stroke="thumbPaint(o.stroke)" :stroke-width="o.strokeWidth || 0" />
              </svg>
              <span v-else-if="o.type === 'text'" class="ly-thumb-t">T</span>
              <img v-else-if="o.type === 'image' && o.href" :src="o.href" alt="" />
            </span>

            <input
              v-if="renamingId === o.id"
              ref="renameInput"
              class="ly-rename"
              :value="label(o)"
              @click.stop
              @keydown.enter="commitRename($event)"
              @keydown.escape="renamingId = null"
              @blur="commitRename($event)"
            />
            <span v-else class="ly-name" :title="label(o)" @dblclick.stop="startRename(o.id)">{{ label(o) }}</span>

            <span v-if="o.opacity < 1" class="ly-opacity">{{ Math.round(o.opacity * 100) }}%</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useCanvasStore, type CanvasObject } from '@/stores/canvas'
import { isNonePaint, splitPaint } from '@/services/canvas/color'

const store = useCanvasStore()

const selectedSet = computed(() => new Set(store.selectedIds))
const total = computed(() => store.objectOrder.length)

// Group by artboard (in artboard order) with objects listed front-to-back,
// i.e. reverse paint order, like Illustrator's layers panel.
const groups = computed(() => {
  const byAb = new Map<string | null, CanvasObject[]>()
  for (const o of [...store.orderedObjects].reverse()) {
    const key = o.artboardId && store.getArtboard(o.artboardId) ? o.artboardId : null
    if (!byAb.has(key)) byAb.set(key, [])
    byAb.get(key)!.push(o)
  }
  const out: { key: string; name: string; artboardId: string | null; items: CanvasObject[] }[] = []
  for (const ab of store.artboards) {
    const items = byAb.get(ab.id)
    if (items?.length) out.push({ key: ab.id, name: ab.name, artboardId: ab.id, items })
  }
  const loose = byAb.get(null)
  if (loose?.length) out.push({ key: '__canvas', name: 'Canvas', artboardId: null, items: loose })
  return out
})

function label(o: CanvasObject): string {
  if (o.name) return o.name
  if (o.type === 'text') return o.text?.trim() || 'Text'
  if (o.semanticRole && o.semanticRole !== 'none') return String(o.semanticRole)
  if (o.type === 'path') return o.shape ? o.shape[0]!.toUpperCase() + o.shape.slice(1) : 'Path'
  return o.alt || 'Image'
}

function thumbViewBox(o: CanvasObject): string {
  // Path geometry is authored at base size and may sit off-origin; frame the
  // nominal base box with a little room for strokes.
  const pad = 2
  return `${-pad} ${-pad} ${(o.baseWidth || 1) + pad * 2} ${(o.baseHeight || 1) + pad * 2}`
}
function thumbPaint(v: string | undefined): string {
  if (isNonePaint(v)) return 'none'
  return splitPaint(v).color
}

// --- Selection --------------------------------------------------------------
function onRowClick(e: MouseEvent, id: string) {
  const o = store.getObject(id)
  if (!o || o.hidden || o.locked) return
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    const next = new Set(store.selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    store.selectObjects([...next])
  } else {
    store.selectObjects([id])
  }
}

// --- Visibility / lock --------------------------------------------------------
function toggleHidden(id: string, hidden: boolean) {
  store.snapshot(hidden ? 'Hide' : 'Show')
  store.setObjectHidden(id, hidden)
}
function toggleLocked(id: string, locked: boolean) {
  store.snapshot(locked ? 'Lock' : 'Unlock')
  store.setObjectLocked(id, locked)
}

// --- Rename -------------------------------------------------------------------
const renamingId = ref<string | null>(null)
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
function startRename(id: string) {
  renamingId.value = id
  nextTick(() => {
    const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
    el?.focus()
    el?.select()
  })
}
function commitRename(e: Event) {
  const id = renamingId.value
  if (!id) return
  renamingId.value = null
  const value = (e.target as HTMLInputElement).value
  const o = store.getObject(id)
  if (!o || value === label(o)) return
  store.snapshot('Rename')
  store.renameObject(id, value)
}

// --- Drag to reorder ------------------------------------------------------------
const dragId = ref<string | null>(null)
const dropTarget = ref<{ id: string; above: boolean } | null>(null)

function onDragStart(e: DragEvent, id: string) {
  dragId.value = id
  e.dataTransfer?.setData('text/plain', id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e: DragEvent, id: string) {
  if (!dragId.value || dragId.value === id) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropTarget.value = { id, above: e.clientY < rect.top + rect.height / 2 }
}
function onDragLeave(id: string) {
  if (dropTarget.value?.id === id) dropTarget.value = null
}
function onDrop(targetId: string, artboardId: string | null) {
  const src = dragId.value
  const target = dropTarget.value
  dragId.value = null
  dropTarget.value = null
  if (!src || !target || src === targetId) return
  store.snapshot('Reorder layers')
  // Rows are front-to-back, so "above" a row means in front of it in paint
  // order: right after it in objectOrder.
  if (store.getObject(src)?.artboardId !== artboardId) store.reparentObject(src, artboardId)
  const without = store.objectOrder.filter((id) => id !== src)
  const ti = without.indexOf(targetId)
  store.reorderObject(src, target.above ? ti + 1 : ti)
}
</script>

<style scoped>
.layers {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  font-family: Inter, sans-serif;
}
.ly-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 16px 8px;
}
.ly-title {
  font-weight: 600;
  color: #211a43;
  font-size: 13px;
}
.ly-count {
  font-size: 11px;
  color: #a1a1aa;
}
.ly-empty {
  padding: 8px 16px;
  font-size: 12px;
  color: #a1a1aa;
}
.ly-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.ly-group-name {
  font-size: 11px;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 8px 8px 4px;
}
.ly-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ly-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 6px;
  border-radius: 6px;
  font-size: 12px;
  color: #211a43;
  cursor: default;
  user-select: none;
  border-top: 2px solid transparent;
  border-bottom: 2px solid transparent;
}
.ly-row:hover {
  background: #f4f4f5;
}
.ly-row.selected {
  background: #e0e7ff;
}
.ly-row.hidden .ly-name,
.ly-row.hidden .ly-thumb {
  opacity: 0.4;
}
.ly-row.locked .ly-name {
  color: #71717a;
}
.ly-row.drop-above {
  border-top-color: #2563eb;
}
.ly-row.drop-below {
  border-bottom-color: #2563eb;
}
.ly-icon-btn {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #a1a1aa;
  cursor: pointer;
  padding: 0;
}
.ly-icon-btn:hover {
  color: #211a43;
  background: rgba(0, 0, 0, 0.05);
}
.ly-row.hidden .ly-icon-btn:first-child,
.ly-icon-btn.on {
  color: #211a43;
}
.ly-thumb {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  background: #fff;
  overflow: hidden;
  margin: 0 4px 0 2px;
}
.ly-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ly-thumb-t {
  font-weight: 700;
  font-size: 12px;
  font-family: Georgia, serif;
}
.ly-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
}
.ly-rename {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 2px 4px;
  border: 1px solid #2563eb;
  border-radius: 4px;
  outline: none;
}
.ly-opacity {
  font-size: 10px;
  color: #a1a1aa;
  flex-shrink: 0;
}
</style>
