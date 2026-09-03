<template>
  <div
    ref="mount"
    class="canvas-stage"
    :class="[{ panning: isPanning }, `tool-${activeTool}`]"
    @wheel.prevent="onWheel"
    @mousedown="onMouseDown"
    @mousemove="onStageMouseMove"
    @dblclick="onStageDblClick"
  >
    <textarea
      v-if="inlineEdit"
      ref="inlineInput"
      class="inline-text-editor"
      :style="inlineStyle"
      v-model="inlineEdit.value"
      @mousedown.stop
      @wheel.stop
      @blur="commitInlineEdit"
      @keydown="onInlineKeydown"
    ></textarea>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore, type ToolId } from '@/stores/canvas'
import {
  CanvasRenderer,
  documentBounds,
  zoomViewBox,
  panViewBox,
  clampZoom,
  normalizeDragBox,
  resolveArtboardAtPoint,
  mergeMarqueeSelection,
  buildShapePayload,
  buildPenPayload,
  canvasPointToScreenRect,
  type Box,
  type RenderObject,
} from '@/services/canvas/svgEngine'
import { fitImageSize } from '@/services/canvas/userTools'

/* eslint-disable @typescript-eslint/no-explicit-any */

const store = useCanvasStore()
const { artboards, objects, objectOrder, selectedIds, selectedArtboardId, activeTool } =
  storeToRefs(store)

const mount = ref<HTMLElement | null>(null)
let renderer: CanvasRenderer | null = null
let baseBounds: Box = { x: 0, y: 0, width: 1000, height: 700 }

const isPanning = ref(false)
let panStart: { clientX: number; clientY: number; box: Box; moved: boolean } | null = null

// Held-space forces panning regardless of the active tool.
const spacePressed = ref(false)

// Drag interaction state for the marquee (select) and shape tools. Points are
// in canvas coordinates.
type DragKind = 'marquee' | 'shape'
let toolDrag: {
  kind: DragKind
  start: { x: number; y: number }
  current: { x: number; y: number }
  additive: boolean
  moved: boolean
} | null = null

const SHAPE_TOOLS = ['rect', 'ellipse', 'line'] as const
type ShapeTool = (typeof SHAPE_TOOLS)[number]
function isShapeTool(t: string): t is ShapeTool {
  return (SHAPE_TOOLS as readonly string[]).includes(t)
}

// Pen tool state: an in-progress list of anchor points (canvas coords) built
// up by successive clicks. `null` means no path is being drawn. Clicking near
// the first anchor closes the path; double-click / Enter finishes an open one.
let penPoints: { x: number; y: number }[] | null = null
// Close threshold in screen pixels (converted to canvas units at click time).
const PEN_CLOSE_PX = 12

// Inline text editing overlay state.
const inlineInput = ref<HTMLTextAreaElement | null>(null)
const inlineEdit = ref<{ id: string; value: string } | null>(null)
const inlineStyle = ref<Record<string, string>>({})

function computeInlineStyle(id: string) {
  const obj = store.getObject(id)
  if (!obj || obj.type !== 'text' || !renderer || !mount.value) return
  const artboard = obj.artboardId ? store.getArtboard(obj.artboardId) : null
  const canvasPoint = { x: (artboard?.x ?? 0) + obj.x, y: (artboard?.y ?? 0) + obj.y }
  const rect = mount.value.getBoundingClientRect()
  const { left, top, scale } = canvasPointToScreenRect(canvasPoint, renderer.getViewBox(), rect)
  const fontSize = (obj.fontSize || 24) * scale
  inlineStyle.value = {
    left: `${left - rect.left}px`,
    top: `${top - rect.top}px`,
    fontFamily: obj.fontFamily || 'Inter',
    fontSize: `${fontSize}px`,
    fontWeight: String(obj.fontWeight || 400),
    color: obj.fill || '#211A43',
    lineHeight: '1.1',
  }
}

function startInlineEdit(id: string) {
  const obj = store.getObject(id)
  if (!obj || obj.type !== 'text') return
  inlineEdit.value = { id, value: obj.text || '' }
  computeInlineStyle(id)
  nextTick(() => {
    inlineInput.value?.focus()
  })
}

function commitInlineEdit() {
  const edit = inlineEdit.value
  inlineEdit.value = null
  if (!edit) return
  const value = edit.value.trim()
  const obj = store.getObject(edit.id)
  if (!obj) return
  if (!value) {
    // Discard empty text objects (and the snapshot noise is acceptable).
    store.removeObject(edit.id)
  } else if (obj.type === 'text' && obj.text !== edit.value) {
    store.updateObject(edit.id, { text: edit.value })
  }
}

function cancelInlineEdit() {
  const edit = inlineEdit.value
  inlineEdit.value = null
  if (!edit) return
  const obj = store.getObject(edit.id)
  // A freshly-placed, still-empty text object is removed on cancel.
  if (obj && obj.type === 'text' && !(obj.text || '').trim() && !edit.value.trim()) {
    store.removeObject(edit.id)
  }
}

function onInlineKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelInlineEdit()
    inlineInput.value?.blur()
    return
  }
  // Enter commits; Shift+Enter inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    commitInlineEdit()
  }
}

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
  renderer.setSelection(store.selectedIds, store.selectedObjects as any)
  renderer.setArtboardSelection(store.selectedArtboardId)
}

function onObjectResized(
  id: string,
  { x, y, width, height }: { x: number; y: number; width: number; height: number },
) {
  const obj = store.getObject(id)
  if (!obj) return
  store.snapshot('Resize')
  if (obj.type === 'text') {
    // Text scales its font size with the box height (keeps glyphs crisp rather
    // than transform-stretching), then stores the new box.
    const prevH = obj.height || 1
    const ratio = prevH > 0 ? height / prevH : 1
    const nextFont = Math.max(1, Math.round((obj.fontSize || 24) * ratio))
    store.updateObject(id, { x, y, width, height, fontSize: nextFont })
  } else {
    store.resizeObject(id, { x, y, width, height })
  }
}

function onObjectRotated(id: string, degrees: number) {
  store.snapshot('Rotate')
  store.rotateObject(id, degrees)
}

function fitViewBox() {
  if (!renderer) return
  baseBounds = documentBounds(store.artboards)
  renderer.setViewBox(baseBounds)
}

// --- Interaction: object selection wiring ---------------------------------
function wireObject(obj: RenderObject, el: any) {
  el.node.addEventListener('mousedown', (e: MouseEvent) => {
    // Only the select tool (and not while space-panning) selects objects on
    // click. With a creation tool active, let the event bubble to the stage so
    // the tool can draw/place over existing objects.
    if (store.activeTool !== 'select' || spacePressed.value) return
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

// --- Interaction: artboard selection via its name label -------------------
function wireArtboard(
  artboard: { id: string },
  els: { group: any; label: any },
) {
  els.label.node.addEventListener('mousedown', (e: MouseEvent) => {
    e.stopPropagation()
    store.selectArtboard(artboard.id)
  })
}

function onArtboardResized(
  id: string,
  box: { x: number; y: number; width: number; height: number },
) {
  const ab = store.getArtboard(id)
  if (!ab) return
  if (ab.width === box.width && ab.height === box.height && ab.x === box.x && ab.y === box.y) {
    return
  }
  store.snapshot('Resize artboard')
  store.updateArtboard(id, {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
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

// --- Interaction: empty-space mousedown dispatches by active tool ---------
// Space-held always pans. Otherwise: select → marquee/deselect; shapes → draw;
// text/image are handled on click (no drag) in onMouseUp.
function onMouseDown(e: MouseEvent) {
  if (!renderer) return
  if (e.button !== 0) return

  const tool = store.activeTool
  const wantPan = spacePressed.value || tool === 'image' || tool === 'text' || tool === 'pen'

  if (!wantPan && (tool === 'select' || isShapeTool(tool))) {
    const p = renderer.screenToCanvas(e.clientX, e.clientY)
    toolDrag = {
      kind: tool === 'select' ? 'marquee' : 'shape',
      start: p,
      current: p,
      additive: e.shiftKey,
      moved: false,
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return
  }

  // Pan (default, or space-forced).
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
  if (!renderer) return

  if (toolDrag) {
    toolDrag.current = renderer.screenToCanvas(e.clientX, e.clientY)
    const box = normalizeDragBox(toolDrag.start, toolDrag.current)
    if (box.width > 1 || box.height > 1) toolDrag.moved = true
    if (toolDrag.kind === 'marquee') {
      renderer.showMarquee(box)
    } else {
      const type = store.activeTool as ShapeTool
      // Lines use raw start→current so they can go in any direction.
      if (type === 'line') {
        renderer.showShapePreview('line', {
          x: toolDrag.start.x,
          y: toolDrag.start.y,
          width: toolDrag.current.x - toolDrag.start.x,
          height: toolDrag.current.y - toolDrag.start.y,
        })
      } else {
        renderer.showShapePreview(type, box)
      }
    }
    return
  }

  if (!panStart) return
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

function onMouseUp(e: MouseEvent) {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)

  if (toolDrag && renderer) {
    const drag = toolDrag
    toolDrag = null
    if (drag.kind === 'marquee') {
      renderer.hideMarquee()
      if (drag.moved) {
        const box = normalizeDragBox(drag.start, drag.current)
        const hits = renderer.hitTestBox(box)
        store.selectObjects(mergeMarqueeSelection(store.selectedIds, hits, drag.additive))
      } else {
        // A click with no drag clears the selection (unless additive).
        if (!drag.additive) store.clearSelection()
      }
    } else {
      renderer.hideShapePreview()
      if (drag.moved) commitShape(store.activeTool as ShapeTool, drag.start, drag.current)
    }
    isPanning.value = false
    return
  }

  if (panStart && !panStart.moved) {
    // A plain click on empty space.
    handleEmptyClick(e)
  }
  isPanning.value = false
  panStart = null
}

// Empty-space click behavior for the tools handled on click (text/image) and
// the deselect fallback.
function handleEmptyClick(e: MouseEvent) {
  const tool = store.activeTool
  if (tool === 'text') {
    placeText(e.clientX, e.clientY)
    return
  }
  if (tool === 'image') {
    placeImage(e.clientX, e.clientY)
    return
  }
  if (tool === 'pen') {
    penClick(e.clientX, e.clientY)
    return
  }
  store.clearSelection()
}

// --- Pen tool: multi-click polygonal path builder ------------------------
function penDistanceThreshold(): number {
  // Convert the screen-pixel close radius to canvas units at current zoom.
  if (!renderer || !mount.value) return PEN_CLOSE_PX
  const rect = mount.value.getBoundingClientRect()
  const vb = renderer.getViewBox()
  const perPx = rect.width ? vb.width / rect.width : 1
  return PEN_CLOSE_PX * perPx
}

function penClick(clientX: number, clientY: number) {
  if (!renderer) return
  const p = renderer.screenToCanvas(clientX, clientY)
  if (!penPoints) {
    penPoints = [p]
  } else {
    const first = penPoints[0]!
    const dx = p.x - first.x
    const dy = p.y - first.y
    const near = Math.hypot(dx, dy) <= penDistanceThreshold()
    if (near && penPoints.length >= 3) {
      finishPen(true)
      return
    }
    penPoints.push(p)
  }
  renderer.showPenPreview(penPoints, null, false)
}

// Live rubber-band segment from the last anchor to the cursor.
function onPenMove(e: MouseEvent) {
  if (!renderer || !penPoints || !penPoints.length) return
  const cursor = renderer.screenToCanvas(e.clientX, e.clientY)
  const first = penPoints[0]!
  const near =
    penPoints.length >= 3 &&
    Math.hypot(cursor.x - first.x, cursor.y - first.y) <= penDistanceThreshold()
  renderer.showPenPreview(penPoints, cursor, near)
}

// Commit the in-progress pen path as a path object, or discard if too short.
function finishPen(closed: boolean) {
  const points = penPoints
  penPoints = null
  if (renderer) renderer.hidePenPreview()
  if (!points || points.length < 2) return
  // A double-click fires a click (adding an anchor) immediately before it, so
  // drop a duplicated trailing point to avoid a zero-length final segment.
  if (points.length >= 2) {
    const a = points[points.length - 1]!
    const b = points[points.length - 2]!
    if (a.x === b.x && a.y === b.y) points.pop()
  }
  if (points.length < 2) return
  const artboard = resolveArtboardAtPoint(store.artboards, points[0]!)
  const payload = buildPenPayload(points, artboard, closed)
  if (!payload) return
  store.snapshot('Add path')
  const obj = store.addObject({ ...payload, artboardId: artboard?.id ?? null })
  store.selectObjects([obj.id])
  // Tool stays armed for drawing multiple paths.
}

function cancelPen() {
  penPoints = null
  if (renderer) renderer.hidePenPreview()
}

function onStageMouseMove(e: MouseEvent) {
  if (store.activeTool === 'pen' && penPoints) onPenMove(e)
}

function onStageDblClick(e: MouseEvent) {
  if (store.activeTool !== 'pen' || !penPoints) return
  e.preventDefault()
  finishPen(false)
}

// --- Shape tool: commit a drawn shape to the store ------------------------
function commitShape(type: ShapeTool, start: { x: number; y: number }, current: { x: number; y: number }) {
  const artboard = resolveArtboardAtPoint(store.artboards, start)
  const payload = buildShapePayload(type, start, current, artboard)
  if (!payload) return
  store.snapshot('Add shape')
  const obj = store.addObject({ ...payload, artboardId: artboard?.id ?? null })
  store.selectObjects([obj.id])
  // Tool stays armed for placing multiple.
}

// --- Text tool: place a text object and open the inline editor ------------
function placeText(clientX: number, clientY: number) {
  if (!renderer) return
  const p = renderer.screenToCanvas(clientX, clientY)
  const artboard = resolveArtboardAtPoint(store.artboards, p)
  store.snapshot('Add text')
  const obj = store.addObject({
    type: 'text',
    text: '',
    x: p.x - (artboard?.x ?? 0),
    y: p.y - (artboard?.y ?? 0),
    artboardId: artboard?.id ?? null,
    semanticRole: 'bodyText',
  })
  store.selectObjects([obj.id])
  startInlineEdit(obj.id)
}

// --- Image tool: place the staged image -----------------------------------
function placeImage(clientX: number, clientY: number) {
  if (!renderer) return
  const pending = store.pendingImage
  if (!pending) return
  const p = renderer.screenToCanvas(clientX, clientY)
  const artboard = resolveArtboardAtPoint(store.artboards, p)
  store.snapshot('Add image')
  const size = fitImageSize(
    { width: pending.width || 300, height: pending.height || 200 },
    artboard?.width ? artboard.width * 0.9 : 300,
    artboard?.height ? artboard.height * 0.9 : 300,
  )
  const obj = store.addImage({
    href: pending.href,
    sourceUrl: pending.sourceUrl,
    alt: pending.alt,
    width: size.width,
    height: size.height,
    x: p.x - (artboard?.x ?? 0),
    y: p.y - (artboard?.y ?? 0),
    artboardId: artboard?.id ?? null,
  })
  store.selectObjects([obj.id])
  // Tool stays armed; pendingImage kept for easy multiple placement.
}

function onObjectDragEnd(id: string, { dx, dy }: { dx: number; dy: number }) {
  // Only the select tool moves objects; creation tools ignore object drags.
  if (store.activeTool !== 'select') return
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

  if (e.key === ' ' || e.code === 'Space') {
    spacePressed.value = true
    // Don't scroll the page; don't preventDefault globally to keep other keys.
    return
  }

  // Pen: Enter finishes an open path; Escape cancels an in-progress path
  // (without leaving the tool) so the user can start over.
  if (store.activeTool === 'pen' && penPoints) {
    if (e.key === 'Enter') {
      e.preventDefault()
      finishPen(false)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelPen()
      return
    }
  }

  // Escape returns to the Select tool (and closes any transient state).
  if (e.key === 'Escape' && store.activeTool !== 'select') {
    e.preventDefault()
    store.setActiveTool('select')
    return
  }

  // Single-key tool hotkeys (ignore when a modifier is held, e.g. Cmd+T).
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    const toolKeys: Record<string, ToolId> = { v: 'select', t: 'text', p: 'pen', l: 'rect' }
    const tool = toolKeys[e.key.toLowerCase()]
    if (tool) {
      e.preventDefault()
      store.setActiveTool(tool)
      return
    }
  }

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

function onKeyUp(e: KeyboardEvent) {
  if (e.key === ' ' || e.code === 'Space') spacePressed.value = false
}

onMounted(() => {
  if (!mount.value) return
  renderer = new CanvasRenderer(mount.value)
  renderer.onObjectMounted = wireObject
  renderer.onObjectDragEnd = onObjectDragEnd
  renderer.onObjectResized = onObjectResized
  renderer.onObjectRotated = onObjectRotated
  renderer.onArtboardMounted = wireArtboard
  renderer.onArtboardResized = onArtboardResized
  rerender()
  fitViewBox()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
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
      renderer.setSelection(store.selectedIds, store.selectedObjects as any)
    }
  },
  { deep: true },
)

watch(selectedArtboardId, () => {
  if (renderer) renderer.setArtboardSelection(store.selectedArtboardId)
})

watch(
  artboards,
  () => {
    fitViewBox()
  },
  { deep: true },
)

// Clean up transient tool state whenever the active tool changes.
watch(activeTool, () => {
  if (inlineEdit.value) commitInlineEdit()
  if (renderer) {
    renderer.hideMarquee()
    renderer.hideShapePreview()
    renderer.hidePenPreview()
  }
  toolDrag = null
  penPoints = null
})

// Keep the inline editor aligned while its target text object exists.
watch(
  selectedIds,
  () => {
    if (inlineEdit.value) computeInlineStyle(inlineEdit.value.id)
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
  position: relative;
}
/* Select tool uses a pointer; space-drag panning still shows the grab hand. */
.canvas-stage.tool-select {
  cursor: default;
}
.canvas-stage.panning {
  cursor: grabbing;
}
/* Creation tools use a crosshair; select keeps the grab/move affordance. */
.canvas-stage.tool-rect,
.canvas-stage.tool-ellipse,
.canvas-stage.tool-line,
.canvas-stage.tool-text,
.canvas-stage.tool-pen {
  cursor: crosshair;
}
.canvas-stage.tool-image {
  cursor: copy;
}
.inline-text-editor {
  position: absolute;
  z-index: 30;
  margin: 0;
  padding: 0;
  border: 1px dashed #2563eb;
  outline: none;
  background: rgba(255, 255, 255, 0.85);
  resize: none;
  overflow: hidden;
  min-width: 40px;
  min-height: 1em;
  white-space: pre;
  transform-origin: top left;
}
:deep(.canvas-object) {
  cursor: pointer;
}
:deep(.artboard-bg) {
  filter: drop-shadow(0 6px 18px rgba(24, 24, 27, 0.1));
}
:deep(.artboard-label) {
  user-select: none;
  cursor: pointer;
}
:deep(.artboard-label.is-selected) {
  fill: #2563eb;
}
/* Selection is visualized via a bounding-box overlay drawn by the renderer. */
</style>
