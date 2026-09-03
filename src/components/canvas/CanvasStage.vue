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
import {
  useCanvasStore,
  setObjectBoxMeasurer,
  setViewportController,
  type ToolId,
} from '@/stores/canvas'
import {
  CanvasRenderer,
  documentBounds,
  zoomViewBox,
  panViewBox,
  clampZoom,
  normalizeDragBox,
  resolveArtboardAtPoint,
  artboardAtPoint,
  mergeMarqueeSelection,
  buildShapePayload,
  buildPenNodesPayload,
  canvasPointToScreenRect,
  nodesBounds,
  nodesToPathData,
  translateNodes,
  type Box,
  type PathNode,
  type RenderObject,
} from '@/services/canvas/svgEngine'
import { fitImageSize, readFileAsDataUrl, probeImageSize } from '@/services/canvas/userTools'
import {
  classifyClipboard,
  svgIntrinsicSize,
  svgToDataUrl,
  type ClipboardPaste,
} from '@/services/canvas/pasteTools'
import { svgToPathObjects } from '@/services/canvas/svgToPaths'

/* eslint-disable @typescript-eslint/no-explicit-any */

const store = useCanvasStore()
const { artboards, objects, objectOrder, selectedIds, selectedArtboardId, activeTool } =
  storeToRefs(store)

const mount = ref<HTMLElement | null>(null)
let renderer: CanvasRenderer | null = null
let baseBounds: Box = { x: 0, y: 0, width: 1000, height: 700 }

// In-flight viewBox animation frame id (for smooth zoom transitions). Any
// direct viewport interaction cancels it so manual input takes over instantly.
let viewBoxAnimId: number | null = null

const isPanning = ref(false)
let panStart: { clientX: number; clientY: number; box: Box; moved: boolean } | null = null

// Held-space forces panning regardless of the active tool.
const spacePressed = ref(false)

// Last known cursor position over the stage. Used as the drop point for
// clipboard pastes; falls back to the viewport center when the pointer has
// never been over the stage.
let lastPointer: { clientX: number; clientY: number } | null = null

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

// Pen tool state: the committed anchors of the in-progress path (canvas
// coords). `null` means no path is being drawn. A click adds a corner anchor;
// a press-drag pulls symmetric Bézier handles for a smooth anchor. Clicking
// near the first anchor closes the path; double-click / Enter finishes it.
let penNodes: PathNode[] | null = null
// The anchor currently being placed by the active mousedown, with the live
// drag position that shapes its handles. Committed to penNodes on mouseup.
let penDraft: { anchor: { x: number; y: number }; drag: { x: number; y: number }; moved: boolean } | null =
  null
// Close threshold in screen pixels (converted to canvas units at use time).
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

// Recompute the document bounds used for zoom clamping. Does NOT touch the
// viewBox, so the user's/agent's current zoom & pan are preserved when the
// document changes (objects added, artboards moved, etc.).
function refreshBaseBounds() {
  baseBounds = documentBounds(store.artboards)
}

// Reset the viewport to frame the whole document. Used on initial mount and as
// a deliberate "fit all" action — not on every document mutation.
function fitViewBox() {
  if (!renderer) return
  refreshBaseBounds()
  renderer.setViewBox(baseBounds)
}

// Cancel any in-flight smooth-zoom animation. Called before a fresh animation
// and by any direct viewport interaction (wheel/pan) so manual input wins.
function cancelViewBoxAnimation() {
  if (viewBoxAnimId !== null) {
    cancelAnimationFrame(viewBoxAnimId)
    viewBoxAnimId = null
  }
}

// Smoothly tween the renderer's viewBox from its current value to `target`
// over `duration` ms using an ease-in-out curve. Interpolating x/y/width/height
// linearly (with eased time) reads as a natural pan-and-zoom between frames.
function animateViewBox(target: Box, duration = 350) {
  if (!renderer) return
  cancelViewBoxAnimation()
  const from = renderer.getViewBox()
  // Skip the animation when there's effectively nothing to move (or in
  // environments without rAF, e.g. tests) — just snap to the target.
  const negligible =
    Math.abs(from.x - target.x) < 0.5 &&
    Math.abs(from.y - target.y) < 0.5 &&
    Math.abs(from.width - target.width) < 0.5 &&
    Math.abs(from.height - target.height) < 0.5
  if (negligible || typeof requestAnimationFrame === 'undefined') {
    renderer.setViewBox(target)
    return
  }
  const start = performance.now()
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
  const step = (now: number) => {
    if (!renderer) return
    const t = Math.min(1, (now - start) / duration)
    const k = ease(t)
    renderer.setViewBox({
      x: from.x + (target.x - from.x) * k,
      y: from.y + (target.y - from.y) * k,
      width: from.width + (target.width - from.width) * k,
      height: from.height + (target.height - from.height) * k,
    })
    if (t < 1) {
      viewBoxAnimId = requestAnimationFrame(step)
    } else {
      viewBoxAnimId = null
    }
  }
  viewBoxAnimId = requestAnimationFrame(step)
}

// Frame a canvas-space box into view, adding uniform padding as a fraction of
// the box's larger side, then clamp to the allowed zoom range. Animates the
// transition for a smooth glide between artboards. Used by the zoom_to_artboard
// WebMCP tool via the store's viewport controller.
function fitBoxToView(box: Box, opts: { paddingRatio?: number; animate?: boolean } = {}) {
  if (!renderer) return
  const pad = Math.max(0, opts.paddingRatio ?? 0.1) * Math.max(box.width, box.height)
  const padded: Box = {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  }
  const target = clampZoom(padded, baseBounds)
  if (opts.animate === false) {
    cancelViewBoxAnimation()
    renderer.setViewBox(target)
  } else {
    animateViewBox(target)
  }
}

// --- Interaction: object selection wiring ---------------------------------
function wireObject(obj: RenderObject, el: any) {
  el.node.addEventListener('mousedown', (e: MouseEvent) => {
    // The select and node-edit tools select objects on click (not while
    // space-panning). With a creation tool active, let the event bubble to the
    // stage so the tool can draw/place over existing objects.
    if ((store.activeTool !== 'select' && store.activeTool !== 'node') || spacePressed.value) return
    e.stopPropagation()
    const additive = e.shiftKey
    if (additive) {
      const next = new Set(store.selectedIds)
      if (next.has(obj.id)) next.delete(obj.id)
      else next.add(obj.id)
      store.selectObjects([...next])
    } else if (!store.selectedIds.includes(obj.id)) {
      // Clicking an already-selected object keeps the whole selection so the
      // ensuing drag moves the group; only a fresh click collapses to one.
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
  cancelViewBoxAnimation()
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

  cancelViewBoxAnimation()
  const tool = store.activeTool

  // Pen has its own press-drag-release cycle: press places an anchor, dragging
  // pulls its Bézier handles, release commits it. Space still forces panning.
  if (tool === 'pen' && !spacePressed.value) {
    penMouseDown(e.clientX, e.clientY)
    window.addEventListener('mousemove', onPenDragMove)
    window.addEventListener('mouseup', onPenDragUp)
    return
  }

  const wantPan = spacePressed.value || tool === 'image' || tool === 'text'

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
  store.clearSelection()
}

// --- Pen tool: Bézier path builder ---------------------------------------
// Click for a corner anchor; press-drag to pull symmetric tangent handles for
// a smooth anchor. Close by clicking near the first anchor; finish an open path
// with double-click / Enter; cancel with Escape.
function penDistanceThreshold(): number {
  // Convert the screen-pixel close radius to canvas units at current zoom.
  if (!renderer || !mount.value) return PEN_CLOSE_PX
  const rect = mount.value.getBoundingClientRect()
  const vb = renderer.getViewBox()
  const perPx = rect.width ? vb.width / rect.width : 1
  return PEN_CLOSE_PX * perPx
}

// Is the given canvas point within the close radius of the first anchor (and is
// the path long enough to close)?
function penNearStart(p: { x: number; y: number }): boolean {
  if (!penNodes || penNodes.length < 2) return false
  const first = penNodes[0]!
  return Math.hypot(p.x - first.x, p.y - first.y) <= penDistanceThreshold()
}

function penMouseDown(clientX: number, clientY: number) {
  if (!renderer) return
  const p = renderer.screenToCanvas(clientX, clientY)
  // Clicking near the first anchor of a 2+ node path closes it.
  if (penNearStart(p) && penNodes && penNodes.length >= 2) {
    finishPen(true)
    return
  }
  penDraft = { anchor: p, drag: p, moved: false }
}

// While the mouse is down on a fresh anchor, dragging shapes its handles.
function onPenDragMove(e: MouseEvent) {
  if (!renderer || !penDraft) return
  penDraft.drag = renderer.screenToCanvas(e.clientX, e.clientY)
  const d = penDraft.drag
  if (Math.hypot(d.x - penDraft.anchor.x, d.y - penDraft.anchor.y) > 2) penDraft.moved = true
  renderPenPreview(draftNode())
}

function onPenDragUp() {
  window.removeEventListener('mousemove', onPenDragMove)
  window.removeEventListener('mouseup', onPenDragUp)
  if (!penDraft) return
  const node = draftNode()
  penDraft = null
  if (!penNodes) penNodes = []
  penNodes.push(node)
  renderPenPreview(null)
}

// Build the PathNode for the current draft: a corner when undragged, else a
// smooth anchor whose out handle is the drag point and in handle its mirror.
function draftNode(): PathNode {
  const { anchor, drag, moved } = penDraft!
  if (!moved) return { x: anchor.x, y: anchor.y }
  return {
    x: anchor.x,
    y: anchor.y,
    outX: drag.x,
    outY: drag.y,
    inX: anchor.x - (drag.x - anchor.x),
    inY: anchor.y - (drag.y - anchor.y),
  }
}

// Draw the committed anchors plus, optionally, the anchor being dragged.
function renderPenPreview(draft: PathNode | null) {
  if (!renderer) return
  const nodes = [...(penNodes || [])]
  if (draft) nodes.push(draft)
  renderer.showPenPreview(nodes, penNearStart(penDraftPoint()))
}

// The live cursor/anchor point used for the close-affordance highlight.
function penDraftPoint(): { x: number; y: number } {
  if (penDraft) return penDraft.anchor
  const n = penNodes && penNodes[penNodes.length - 1]
  return n ? { x: n.x, y: n.y } : { x: 0, y: 0 }
}

// Commit the in-progress pen path as a path object, or discard if too short.
function finishPen(closed: boolean) {
  const nodes = penNodes
  penNodes = null
  penDraft = null
  if (renderer) renderer.hidePenPreview()
  if (!nodes || nodes.length < 2) return
  // A double-click's first click commits an anchor immediately before finishing,
  // duplicating the last one; drop a coincident trailing corner node.
  if (nodes.length >= 2) {
    const a = nodes[nodes.length - 1]!
    const b = nodes[nodes.length - 2]!
    if (a.x === b.x && a.y === b.y && a.outX === undefined && a.inX === undefined) nodes.pop()
  }
  if (nodes.length < 2) return
  const artboard = resolveArtboardAtPoint(store.artboards, nodes[0]!)
  const payload = buildPenNodesPayload(nodes, artboard, closed)
  if (!payload) return
  store.snapshot('Add path')
  const obj = store.addObject({ ...payload, artboardId: artboard?.id ?? null })
  store.selectObjects([obj.id])
  // Tool stays armed for drawing multiple paths.
}

function cancelPen() {
  penNodes = null
  penDraft = null
  if (renderer) renderer.hidePenPreview()
}

function onStageMouseMove(e: MouseEvent) {
  lastPointer = { clientX: e.clientX, clientY: e.clientY }
  // While drawing but between anchors (no button down), show a rubber-band from
  // the last anchor to the cursor.
  if (store.activeTool === 'pen' && penNodes && !penDraft && renderer) {
    const cursor = renderer.screenToCanvas(e.clientX, e.clientY)
    renderer.showPenPreview([...penNodes, { x: cursor.x, y: cursor.y }], penNearStart(cursor))
  }
}

function onStageDblClick(e: MouseEvent) {
  if (store.activeTool !== 'pen' || !penNodes) return
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
  // A staged SVG converts to editable path objects (node-tool reshapeable),
  // falling back to the image embed below when nothing is convertible.
  if (pending.svgMarkup && placeSvgAsPaths(pending.svgMarkup, p, 'Add image')) return
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

// --- Clipboard paste: images, SVG, and text -------------------------------
// Resolve the canvas point to drop a paste at: the cursor if it's been over the
// stage, otherwise the center of the current viewport.
function pasteDropPoint(): { x: number; y: number } | null {
  if (!renderer) return null
  if (lastPointer) return renderer.screenToCanvas(lastPointer.clientX, lastPointer.clientY)
  const vb = renderer.getViewBox()
  return { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 }
}

// Center an object of the given size on `point` and return artboard-local
// coordinates plus the resolved artboard.
function centeredPlacement(point: { x: number; y: number }, width: number, height: number) {
  const artboard = resolveArtboardAtPoint(store.artboards, point)
  return {
    artboard,
    x: point.x - width / 2 - (artboard?.x ?? 0),
    y: point.y - height / 2 - (artboard?.y ?? 0),
  }
}

async function pasteImageFile(file: File, point: { x: number; y: number }) {
  const href = await readFileAsDataUrl(file)
  const natural = await probeImageSize(href)
  const artboard = resolveArtboardAtPoint(store.artboards, point)
  const size = fitImageSize(
    { width: natural.width || 300, height: natural.height || 200 },
    artboard?.width ? artboard.width * 0.9 : 300,
    artboard?.height ? artboard.height * 0.9 : 300,
  )
  const localX = point.x - size.width / 2 - (artboard?.x ?? 0)
  const localY = point.y - size.height / 2 - (artboard?.y ?? 0)
  store.snapshot('Paste image')
  const obj = store.addImage({
    href,
    sourceUrl: file.name || '',
    alt: file.name || '',
    width: size.width,
    height: size.height,
    x: localX,
    y: localY,
    artboardId: artboard?.id ?? null,
  })
  store.selectObjects([obj.id])
}

// Convert imported SVG markup into native, node-editable path objects centered
// on `point`, so the node tool can reshape their anchors. Every <path> in the
// markup (with ancestor transforms + viewBox baked in) becomes one PathObject;
// the whole set is uniformly scaled to fit the artboard and translated under
// the cursor. Returns false when the markup has no convertible paths so the
// caller can fall back to embedding it as a single image.
function placeSvgAsPaths(markup: string, point: { x: number; y: number }, label: string): boolean {
  const parsed = svgToPathObjects(markup)
  if (!parsed) return false

  const dims = svgIntrinsicSize(markup)
  const artboard = resolveArtboardAtPoint(store.artboards, point)
  const size = fitImageSize(
    dims,
    artboard?.width ? artboard.width * 0.9 : 300,
    artboard?.height ? artboard.height * 0.9 : 300,
  )
  // Uniform scale from viewBox units to the fitted display size (fitImageSize
  // preserves aspect ratio, so sx===sy up to rounding — use one factor).
  const scale = dims.width ? size.width / dims.width : 1
  // Top-left of the placed artwork in artboard-local coords: centered on point.
  const originX = point.x - size.width / 2 - (artboard?.x ?? 0)
  const originY = point.y - size.height / 2 - (artboard?.y ?? 0)
  const vb = parsed.viewBox

  store.snapshot(label)
  const ids: string[] = []
  for (const p of parsed.paths) {
    // viewBox coords -> placed coords: subtract the viewBox origin, scale, then
    // offset to the drop origin. Then rebase each path so its own object origin
    // (x,y) is its geometry's top-left, matching how pen/shape paths are stored.
    const placed = p.nodes.map((n) => {
      const map = (x: number, y: number) => ({
        x: originX + (x - vb.x) * scale,
        y: originY + (y - vb.y) * scale,
      })
      const a = map(n.x, n.y)
      const out = { x: a.x, y: a.y, inX: undefined as number | undefined, inY: undefined as number | undefined, outX: undefined as number | undefined, outY: undefined as number | undefined }
      if (n.inX !== undefined && n.inY !== undefined) {
        const h = map(n.inX, n.inY)
        out.inX = h.x
        out.inY = h.y
      }
      if (n.outX !== undefined && n.outY !== undefined) {
        const h = map(n.outX, n.outY)
        out.outX = h.x
        out.outY = h.y
      }
      return out
    })
    const bounds = nodesBounds(placed)
    const rel = translateNodes(placed, -bounds.x, -bounds.y)
    const obj = store.addObject({
      type: 'path',
      d: nodesToPathData(rel, p.closed, p.subpaths),
      nodes: rel,
      closed: p.closed,
      subpaths: p.subpaths,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      fill: p.fill,
      stroke: p.stroke,
      strokeWidth: p.strokeWidth * scale,
      artboardId: artboard?.id ?? null,
      semanticRole: 'decorative',
    })
    ids.push(obj.id)
  }
  store.selectObjects(ids)
  return true
}

function pasteSvgMarkup(markup: string, point: { x: number; y: number }) {
  // Prefer converting to editable path objects so the node tool can reshape the
  // imported artwork. Falls back to embedding the SVG as one image when nothing
  // is convertible (no <path>, or only shapes/text/gradients we don't parse).
  if (placeSvgAsPaths(markup, point, 'Paste SVG')) return

  const dims = svgIntrinsicSize(markup)
  const artboard = resolveArtboardAtPoint(store.artboards, point)
  const size = fitImageSize(
    dims,
    artboard?.width ? artboard.width * 0.9 : 300,
    artboard?.height ? artboard.height * 0.9 : 300,
  )
  const localX = point.x - size.width / 2 - (artboard?.x ?? 0)
  const localY = point.y - size.height / 2 - (artboard?.y ?? 0)
  store.snapshot('Paste SVG')
  const obj = store.addImage({
    href: svgToDataUrl(markup),
    sourceUrl: '',
    alt: 'Pasted SVG',
    width: size.width,
    height: size.height,
    x: localX,
    y: localY,
    artboardId: artboard?.id ?? null,
  })
  store.selectObjects([obj.id])
}

function pasteText(text: string, point: { x: number; y: number }) {
  const trimmed = text.replace(/\s+$/, '')
  const { artboard, x, y } = centeredPlacement(point, 0, 0)
  store.snapshot('Paste text')
  const obj = store.addObject({
    type: 'text',
    text: trimmed,
    x,
    y,
    artboardId: artboard?.id ?? null,
    semanticRole: 'bodyText',
  })
  store.selectObjects([obj.id])
}

async function handlePaste(e: ClipboardEvent) {
  // Don't hijack paste while editing text inline or in any form field.
  const target = e.target as HTMLElement | null
  const tag = (target && target.tagName) || ''
  if (inlineEdit.value || /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || target?.isContentEditable) {
    return
  }
  const result: ClipboardPaste = classifyClipboard(e.clipboardData)
  if (result.kind === 'none') return

  const point = pasteDropPoint()
  if (!point) return

  e.preventDefault()
  try {
    if (result.kind === 'image') {
      await pasteImageFile(result.file, point)
    } else if (result.kind === 'svg') {
      pasteSvgMarkup(result.markup, point)
    } else if (result.kind === 'text') {
      pasteText(result.text, point)
    }
  } catch (err) {
    console.warn('[paste] failed to place clipboard content:', (err as Error)?.message)
  }
}

function onObjectDragEnd(id: string, { dx, dy, alt }: { dx: number; dy: number; alt: boolean }) {
  // Only the select tool moves objects; creation tools ignore object drags.
  if (store.activeTool !== 'select') return
  const obj = store.getObject(id)
  if (!obj) return
  // Dragging any object of a multi-selection moves the whole group by the same
  // delta; a drag on an unselected object acts on it alone.
  const groupIds = store.selectedIds.includes(id) ? [...store.selectedIds] : [id]

  // Alt-drag leaves the originals in place and drops copies at the drag offset.
  if (alt) {
    store.snapshot('Duplicate')
    const dups = groupIds
      .map((gid) => store.duplicateObject(gid, { x: dx, y: dy }))
      .filter((d): d is NonNullable<typeof d> => !!d)
    if (dups.length) store.selectObjects(dups.map((d) => d.id))
    return
  }

  store.snapshot('Move')
  for (const gid of groupIds) moveAndReparent(gid, dx, dy)

  if (!store.selectedIds.includes(id)) store.selectObjects([id])
}

// Shift one object by (dx, dy) in canvas space, then reparent it if its new
// center lands over a different artboard (keeping it visually in place).
// Dropping over empty canvas leaves ownership unchanged.
function moveAndReparent(id: string, dx: number, dy: number) {
  const obj = store.getObject(id)
  if (!obj) return
  store.moveObject(id, { x: (obj.x || 0) + dx, y: (obj.y || 0) + dy })

  const currentArtboard = obj.artboardId ? store.getArtboard(obj.artboardId) : null
  const center = {
    x: (currentArtboard?.x ?? 0) + (obj.x || 0) + (obj.width || 0) / 2,
    y: (currentArtboard?.y ?? 0) + (obj.y || 0) + (obj.height || 0) / 2,
  }
  const target = artboardAtPoint(store.artboards, center)
  if (target && target.id !== obj.artboardId) {
    store.reparentObject(id, target.id)
  }
}

// Node-edit commit: the renderer hands back the reshaped nodes (local frame);
// snapshot once per drag and persist, which regenerates the path's `d`.
function onPathNodesChanged(id: string, nodes: PathNode[]) {
  store.snapshot('Edit nodes')
  store.updatePathNodes(id, nodes)
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
  if (store.activeTool === 'pen' && penNodes) {
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
  renderer.onPathNodesChanged = onPathNodesChanged
  // Let the store measure true rendered geometry (e.g. for fit-to-artwork).
  setObjectBoxMeasurer((obj) => (renderer ? renderer.measureObjectBox(obj as any) : null))
  // Let WebMCP tools (which only have the store) drive the viewport.
  setViewportController({ fitBox: (box, o) => fitBoxToView(box, o) })
  renderer.setNodeEditMode(store.activeTool === 'node')
  rerender()
  fitViewBox()
  // Text may paint before the Inter web font finishes loading, leaving glyphs
  // in a fallback face (wrong family/weight) and mis-measured selection boxes.
  // Re-render once the fonts are ready so text picks up the real face.
  if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
    ;(document as any).fonts.ready.then(() => {
      if (renderer) rerender()
    })
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('paste', handlePaste)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('mousemove', onPenDragMove)
  window.removeEventListener('mouseup', onPenDragUp)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('paste', handlePaste)
  cancelViewBoxAnimation()
  setObjectBoxMeasurer(null)
  setViewportController(null)
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

// When the document changes, keep the zoom-clamp bounds current but preserve
// the current viewport (don't snap back to fit-all on every agent/human edit).
watch(
  artboards,
  () => {
    refreshBaseBounds()
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
  penNodes = null
  penDraft = null
  if (renderer) renderer.setNodeEditMode(store.activeTool === 'node')
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
.canvas-stage.tool-select,
.canvas-stage.tool-node {
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
