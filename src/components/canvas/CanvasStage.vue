<template>
  <div
    ref="mount"
    class="canvas-stage"
    :class="{ panning: isPanning }"
    @wheel.prevent="onWheel"
    @mousedown="onMouseDown"
  ></div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import {
  CanvasRenderer,
  documentBounds,
  zoomViewBox,
  panViewBox,
  clampZoom,
  type Box,
  type RenderObject,
} from '@/services/canvas/svgEngine'

/* eslint-disable @typescript-eslint/no-explicit-any */

const store = useCanvasStore()
const { artboards, objects, objectOrder, selectedIds } = storeToRefs(store)

const mount = ref<HTMLElement | null>(null)
let renderer: CanvasRenderer | null = null
let baseBounds: Box = { x: 0, y: 0, width: 1000, height: 700 }

const isPanning = ref(false)
let panStart: { clientX: number; clientY: number; box: Box; moved: boolean } | null = null

function snapshot() {
  return {
    artboards: JSON.parse(JSON.stringify(store.artboards)),
    objects: JSON.parse(JSON.stringify(store.objects)),
    objectOrder: [...store.objectOrder],
  }
}

function rerender() {
  if (!renderer) return
  renderer.render(snapshot())
  renderer.setSelection(store.selectedIds)
  renderer.setResizable(store.selectedIds, store.objects as any)
}

function onObjectResized(id: string, { width, height }: { width: number; height: number }) {
  store.snapshot('Resize')
  store.positionImage(id, { width, height })
}

function fitViewBox() {
  if (!renderer) return
  baseBounds = documentBounds(store.artboards)
  renderer.setViewBox(baseBounds)
}

// --- Interaction: object selection wiring ---------------------------------
function wireObject(obj: RenderObject, el: any) {
  el.node.addEventListener('mousedown', (e: MouseEvent) => {
    e.stopPropagation()
    const additive = e.shiftKey
    if (additive) {
      const next = new Set(store.selectedIds)
      if (next.has(obj.id)) next.delete(obj.id)
      else next.add(obj.id)
      store.selectObjects([...next])
    } else {
      store.selectObjects([obj.id])
    }
  })
}

// --- Interaction: zoom (wheel) --------------------------------------------
function onWheel(e: WheelEvent) {
  if (!renderer) return
  const focal = renderer.screenToCanvas(e.clientX, e.clientY)
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
  let box = zoomViewBox(renderer.getViewBox(), factor, focal)
  box = clampZoom(box, baseBounds)
  renderer.setViewBox(box)
}

// --- Interaction: pan (drag empty space) + empty-click deselect -----------
function onMouseDown(e: MouseEvent) {
  if (!renderer) return
  if (e.button !== 0) return
  panStart = {
    clientX: e.clientX,
    clientY: e.clientY,
    box: renderer.getViewBox(),
    moved: false,
  }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e: MouseEvent) {
  if (!panStart || !renderer) return
  const rect = (renderer.draw.node as SVGSVGElement).getBoundingClientRect()
  const box = panStart.box
  const scaleX = box.width / rect.width
  const scaleY = box.height / rect.height
  const dx = (e.clientX - panStart.clientX) * scaleX
  const dy = (e.clientY - panStart.clientY) * scaleY
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    panStart.moved = true
    isPanning.value = true
  }
  renderer.setViewBox(panViewBox(box, dx, dy))
}

function onMouseUp() {
  if (panStart && !panStart.moved) {
    store.clearSelection()
  }
  isPanning.value = false
  panStart = null
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

function onObjectDragEnd(id: string, { dx, dy }: { dx: number; dy: number }) {
  const obj = store.getObject(id)
  if (!obj) return
  store.snapshot('Move')
  store.moveObject(id, { x: (obj.x || 0) + dx, y: (obj.y || 0) + dy })
  if (!store.selectedIds.includes(id)) store.selectObjects([id])
}

function onKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  const tag = (target && target.tagName) || ''
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || target?.isContentEditable) return

  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    if (store.canUndo()) {
      e.preventDefault()
      store.undo()
    }
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedIds.length) {
    e.preventDefault()
    store.snapshot('Delete')
    ;[...store.selectedIds].forEach((id) => store.removeObject(id))
    return
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D') && store.selectedIds.length) {
    e.preventDefault()
    store.snapshot('Duplicate')
    const dups = [...store.selectedIds].map((id) => store.duplicateObject(id)).filter(Boolean)
    if (dups.length) store.selectObjects(dups.map((d) => d!.id))
  }
}

onMounted(() => {
  if (!mount.value) return
  renderer = new CanvasRenderer(mount.value)
  renderer.onObjectMounted = wireObject
  renderer.onObjectDragEnd = onObjectDragEnd
  renderer.onObjectResized = onObjectResized
  rerender()
  fitViewBox()
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('keydown', onKeyDown)
  if (renderer) renderer.destroy()
  renderer = null
})

watch(
  [artboards, objects, objectOrder],
  () => {
    rerender()
  },
  { deep: true },
)

watch(
  selectedIds,
  () => {
    if (renderer) {
      renderer.setSelection(store.selectedIds)
      renderer.setResizable(store.selectedIds, store.objects as any)
    }
  },
  { deep: true },
)

watch(
  artboards,
  () => {
    fitViewBox()
  },
  { deep: true },
)

defineExpose({ rerender, fitViewBox, getRenderer: () => renderer })
</script>

<style scoped>
.canvas-stage {
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: grab;
}
.canvas-stage.panning {
  cursor: grabbing;
}
:deep(.canvas-object) {
  cursor: pointer;
}
:deep(.artboard-bg) {
  filter: drop-shadow(0 6px 18px rgba(24, 24, 27, 0.1));
}
:deep(.artboard-label) {
  user-select: none;
  pointer-events: none;
}
/* Selection is visualized via a bounding-box overlay drawn by the renderer. */
</style>
