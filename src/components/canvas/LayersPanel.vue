<template>
  <section class="layers">
    <header class="ly-header">
      <span class="ly-title">Layers</span>
      <span class="ly-count">{{ total }}</span>
      <span class="ly-spacer" />
      <button type="button" class="ly-head-btn" title="New layer" aria-label="New layer" @click="newLayer">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
      </button>
      <button
        type="button"
        class="ly-head-btn"
        title="Delete the active layer and its artwork"
        aria-label="Delete layer"
        :disabled="store.layers.length <= 1"
        @click="deleteLayer"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
      </button>
    </header>

    <div class="ly-scroll" @dragover.prevent>
      <ul class="ly-list">
        <li
          v-for="row in rows"
          :key="row.key"
          class="ly-row"
          :class="{
            'is-layer': row.kind === 'layer',
            active: row.kind === 'layer' && row.id === store.activeLayerId,
            selected: row.selected,
            hidden: row.hidden,
            locked: row.locked,
            'drop-above': drop?.key === row.key && drop.above,
            'drop-below': drop?.key === row.key && !drop.above,
          }"
          :style="{ paddingLeft: `${6 + row.depth * 16}px` }"
          :data-kind="row.kind"
          draggable="true"
          @click="onRowClick($event, row)"
          @dragstart="onDragStart($event, row)"
          @dragover.prevent="onDragOver($event, row)"
          @dragleave="drop?.key === row.key && (drop = null)"
          @drop.prevent="onDrop(row)"
          @dragend="dragRow = null; drop = null"
        >
          <button
            v-if="row.kind !== 'object'"
            type="button"
            class="ly-caret"
            :class="{ open: !collapsed.has(row.key) }"
            :aria-label="collapsed.has(row.key) ? 'Expand' : 'Collapse'"
            @click.stop="toggleCollapsed(row.key)"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <span v-else class="ly-caret-gap" />

          <button type="button" class="ly-icon-btn" :class="{ on: row.hidden }" :title="row.hidden ? 'Show' : 'Hide'" @click.stop="toggleHidden(row)">
            <svg v-if="!row.hidden" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" />
              <circle cx="12" cy="12" r="3" fill="currentColor" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4M6.6 6.6A17 17 0 002 12s3.6 7 10 7a9.9 9.9 0 005.4-1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" class="ly-icon-btn" :class="{ on: row.locked }" :title="row.locked ? 'Unlock' : 'Lock'" @click.stop="toggleLocked(row)">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
              <path :d="row.locked ? 'M8 11V7a4 4 0 018 0v4' : 'M8 11V7a4 4 0 017.7-1.5'" fill="none" stroke="currentColor" stroke-width="2" />
            </svg>
          </button>

          <span v-if="row.kind === 'layer'" class="ly-color" :style="{ background: row.color }" />
          <span v-else-if="row.kind === 'group'" class="ly-thumb ly-thumb-g" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="3" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2" /><rect x="10" y="10" width="11" height="11" rx="1.5" fill="currentColor" /></svg>
          </span>
          <span v-else class="ly-thumb">
            <svg v-if="row.obj!.type === 'path'" :viewBox="thumbViewBox(row.obj!)" width="18" height="18" aria-hidden="true">
              <path :d="row.obj!.d" :fill="thumbFill(row.obj!)" :stroke="thumbPaint(row.obj!.stroke)" :stroke-width="row.obj!.strokeWidth || 0" />
            </svg>
            <span v-else-if="row.obj!.type === 'text'" class="ly-thumb-t">T</span>
            <img v-else-if="row.obj!.type === 'image' && row.obj!.href" :src="row.obj!.href" alt="" />
          </span>

          <input
            v-if="renaming === row.key"
            ref="renameInput"
            class="ly-rename"
            :value="row.label"
            @click.stop
            @keydown.enter="commitRename($event, row)"
            @keydown.escape="renaming = null"
            @blur="commitRename($event, row)"
          />
          <span v-else class="ly-name" :title="row.label" @dblclick.stop="startRename(row.key)">{{ row.label }}</span>

          <span v-if="row.kind === 'object' && row.obj!.opacity < 1" class="ly-opacity">{{ Math.round(row.obj!.opacity * 100) }}%</span>

          <button
            v-if="row.kind === 'layer' && canMoveHere(row.id)"
            type="button"
            class="ly-move-here"
            :style="{ borderColor: row.color }"
            title="Move the selection to this layer"
            aria-label="Move the selection to this layer"
            @click.stop="moveSelectionHere(row.id)"
          />
          <span v-else-if="row.kind === 'layer' && row.selected" class="ly-sel-mark" :style="{ background: row.color }" title="Selected artwork is in this layer" />
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useCanvasStore, type CanvasObject } from '@/stores/canvas'
import { isNonePaint, splitPaint } from '@/services/canvas/color'

const store = useCanvasStore()

type RowKind = 'layer' | 'group' | 'object'
interface Row {
  key: string
  kind: RowKind
  id: string
  depth: number
  label: string
  color?: string
  obj?: CanvasObject
  selected: boolean
  hidden: boolean
  locked: boolean
}

const total = computed(() => store.objectOrder.length)
const selectedSet = computed(() => new Set(store.selectedIds))
const collapsed = ref(new Set<string>())
function toggleCollapsed(key: string) {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

// The panel as a flat list of rows: layers top to bottom, each with its
// groups and objects front to back (reverse paint order), as in Illustrator.
const rows = computed<Row[]>(() => {
  const order = new Map(store.objectOrder.map((id, i) => [id, i]))
  const objects = store.orderedObjects
  const groupFront = (gid: string) => Math.max(-1, ...store.groupMembers(gid).map((m) => order.get(m) ?? -1))
  const out: Row[] = []

  const children = (layerId: string, groupId: string | undefined) => {
    const items: { kind: 'group' | 'object'; id: string; front: number }[] = []
    for (const o of objects) {
      if (store.layerOf(o)?.id !== layerId) continue
      if ((o.groupId ?? undefined) === groupId) items.push({ kind: 'object', id: o.id, front: order.get(o.id)! })
    }
    for (const g of Object.values(store.groups)) {
      if ((g.parentId ?? undefined) !== groupId) continue
      const members = store.groupMembers(g.id)
      const first = members[0] && store.getObject(members[0])
      if (!first || store.layerOf(first)?.id !== layerId) continue
      items.push({ kind: 'group', id: g.id, front: groupFront(g.id) })
    }
    return items.sort((a, b) => b.front - a.front)
  }

  const walk = (layerId: string, groupId: string | undefined, depth: number) => {
    for (const item of children(layerId, groupId)) {
      if (item.kind === 'object') {
        const o = store.getObject(item.id)!
        out.push({ key: o.id, kind: 'object', id: o.id, depth, label: label(o), obj: o, selected: selectedSet.value.has(o.id), hidden: !!o.hidden, locked: !!o.locked })
      } else {
        const members = store.groupMembers(item.id).map((m) => store.getObject(m)!)
        const key = `g:${item.id}`
        out.push({
          key,
          kind: 'group',
          id: item.id,
          depth,
          label: store.groups[item.id]?.name || 'Group',
          selected: members.length > 0 && members.every((m) => selectedSet.value.has(m.id)),
          hidden: members.length > 0 && members.every((m) => m.hidden),
          locked: members.length > 0 && members.every((m) => m.locked),
        })
        if (!collapsed.value.has(key)) walk(layerId, item.id, depth + 1)
      }
    }
  }

  for (const layer of [...store.layers].reverse()) {
    const key = `l:${layer.id}`
    out.push({
      key,
      kind: 'layer',
      id: layer.id,
      depth: 0,
      label: layer.name,
      color: layer.color,
      selected: store.selectedObjects.some((o) => store.layerOf(o)?.id === layer.id),
      hidden: !!layer.hidden,
      locked: !!layer.locked,
    })
    if (!collapsed.value.has(key)) walk(layer.id, undefined, 1)
  }
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
function thumbFill(o: CanvasObject): string {
  if (o.type !== 'image' && o.fillGradient) return splitPaint(o.fillGradient.stops[0]?.color ?? 'none').color
  return thumbPaint((o as { fill?: string }).fill)
}

// --- Selection / active layer -------------------------------------------------
function onRowClick(e: MouseEvent, row: Row) {
  if (row.kind === 'layer') {
    // A layer row makes that layer the target for new artwork.
    store.setActiveLayer(row.id)
    return
  }
  const ids = row.kind === 'group' ? store.groupMembers(row.id) : [row.id]
  const first = store.getObject(ids[0]!)
  if (!first || store.isHidden(first) || store.isLocked(first)) return
  // Selecting artwork makes its layer active, as in Illustrator.
  const layer = store.layerOf(first)
  if (layer) store.setActiveLayer(layer.id)
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    const next = new Set(store.selectedIds)
    const all = ids.every((id) => next.has(id))
    for (const id of ids) {
      if (all) next.delete(id)
      else next.add(id)
    }
    store.selectObjects([...next])
  } else {
    store.selectObjects(ids)
  }
}

function canMoveHere(layerId: string): boolean {
  return store.selectedObjects.length > 0 && store.selectedObjects.some((o) => store.layerOf(o)?.id !== layerId)
}
function moveSelectionHere(layerId: string) {
  store.snapshot('Move to layer')
  store.moveObjectsToLayer([...store.selectedIds], layerId)
  store.setActiveLayer(layerId)
}

function newLayer() {
  store.snapshot('New layer')
  store.addLayer()
}
function deleteLayer() {
  const layer = store.getLayer(store.activeLayerId)
  if (!layer || store.layers.length <= 1) return
  const count = store.orderedObjects.filter((o) => store.layerOf(o)?.id === layer.id).length
  if (count && !window.confirm(`Delete “${layer.name}” and the ${count} object${count === 1 ? '' : 's'} in it?`)) return
  store.snapshot('Delete layer')
  store.removeLayer(layer.id)
}

// --- Visibility / lock --------------------------------------------------------
function targets(row: Row): string[] {
  return row.kind === 'group' ? store.groupMembers(row.id) : [row.id]
}
function toggleHidden(row: Row) {
  const hidden = !row.hidden
  store.snapshot(hidden ? 'Hide' : 'Show')
  if (row.kind === 'layer') store.setLayerHidden(row.id, hidden)
  else for (const id of targets(row)) store.setObjectHidden(id, hidden)
}
function toggleLocked(row: Row) {
  const locked = !row.locked
  store.snapshot(locked ? 'Lock' : 'Unlock')
  if (row.kind === 'layer') store.setLayerLocked(row.id, locked)
  else for (const id of targets(row)) store.setObjectLocked(id, locked)
}

// --- Rename -------------------------------------------------------------------
const renaming = ref<string | null>(null)
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
function startRename(key: string) {
  renaming.value = key
  nextTick(() => {
    const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
    el?.focus()
    el?.select()
  })
}
function commitRename(e: Event, row: Row) {
  if (renaming.value !== row.key) return
  renaming.value = null
  const value = (e.target as HTMLInputElement).value
  if (value === row.label) return
  store.snapshot('Rename')
  if (row.kind === 'layer') store.renameLayer(row.id, value)
  else if (row.kind === 'group') store.renameGroup(row.id, value)
  else store.renameObject(row.id, value)
}

// --- Drag and drop ------------------------------------------------------------
// Objects and groups drop next to another row (into its layer and group) or
// onto a layer row (top of that layer); layers drop between layers.
const dragRow = ref<Row | null>(null)
const drop = ref<{ key: string; above: boolean } | null>(null)

function onDragStart(e: DragEvent, row: Row) {
  dragRow.value = row
  e.dataTransfer?.setData('text/plain', row.key)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e: DragEvent, row: Row) {
  const src = dragRow.value
  if (!src || src.key === row.key) return
  // Layers only reorder among layers.
  if (src.kind === 'layer' && row.kind !== 'layer') return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  drop.value = { key: row.key, above: e.clientY < rect.top + rect.height / 2 }
}
function onDrop(row: Row) {
  const src = dragRow.value
  const target = drop.value
  dragRow.value = null
  drop.value = null
  if (!src || !target || src.key === row.key) return
  if (src.kind === 'layer') {
    if (row.kind !== 'layer') return
    store.snapshot('Reorder layers')
    // Rows list layers top first; "above" a row means higher in the stack.
    const without = store.layers.filter((l) => l.id !== src.id)
    const ti = without.findIndex((l) => l.id === row.id)
    store.moveLayer(src.id, target.above ? ti + 1 : ti)
    return
  }
  store.snapshot('Reorder layers')
  if (!store.relocate({ kind: src.kind, id: src.id }, { kind: row.kind, id: row.id }, target.above)) store.undo()
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
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px 16px;
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
.ly-spacer {
  flex: 1;
}
.ly-head-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #52525b;
  cursor: pointer;
  padding: 0;
}
.ly-head-btn:hover:not(:disabled) {
  background: #f4f4f5;
  color: #211a43;
}
.ly-head-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.ly-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.ly-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ly-row {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 30px;
  padding-right: 6px;
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
.ly-row.is-layer {
  font-weight: 600;
}
.ly-row.is-layer.active {
  background: #f4f4f5;
  box-shadow: inset 2px 0 0 #211a43;
}
.ly-row.selected:not(.is-layer) {
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
.ly-caret,
.ly-caret-gap {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.ly-caret {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: #71717a;
  cursor: pointer;
  padding: 0;
  transition: transform 0.12s;
}
.ly-caret.open {
  transform: rotate(90deg);
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
.ly-icon-btn.on {
  color: #211a43;
}
.ly-color {
  width: 4px;
  height: 18px;
  border-radius: 2px;
  flex-shrink: 0;
  margin: 0 6px 0 2px;
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
.ly-thumb-g {
  color: #52525b;
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
  font-weight: 400;
}
.ly-move-here {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid;
  border-radius: 2px;
  background: #fff;
  cursor: pointer;
  padding: 0;
}
.ly-sel-mark {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border-radius: 2px;
}
</style>
