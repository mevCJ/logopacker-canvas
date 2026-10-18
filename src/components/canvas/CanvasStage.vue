<template>
  <div
    ref="mount"
    class="canvas-stage"
    :class="[{ panning: isPanning, 'picking-color': canvasPickActive }, `tool-${activeTool}`]"
    @wheel.prevent="onWheel"
    @mousedown="onMouseDown"
    @mousemove="onStageMouseMove"
    @mouseleave="onStageMouseLeave"
    @dblclick="onStageDblClick"
  >
    <textarea
      v-if="inlineEdit"
      ref="inlineInput"
      class="inline-text-editor"
      :style="inlineStyle"
      v-model="inlineEdit.value"
      spellcheck="false"
      @mousedown.stop
      @wheel.stop
      @input="fitInlineSize"
      @blur="commitInlineEdit"
      @keydown="onInlineKeydown"
      @select="recordLetterSelection"
      @keyup="recordLetterSelection"
      @mouseup="recordLetterSelection"
    ></textarea>
    <div v-if="toolHint" class="tool-hint">{{ toolHint }}</div>
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
  constrainAngle,
  constrainSquare,
  pathCorners,
  reverseNodes,
  canvasPointToScreenRect,
  nodesBounds,
  nodesToPathData,
  translateNodes,
  type Box,
  type GroupTransformPatch,
  type PathCorner,
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
import { svgToPathObjects, placeImportedPaths } from '@/services/canvas/svgToPaths'
import {
  commitShapeBuilder,
  computeShapeRegions,
  regionAtPoint,
  replaceObjects,
  textPathGeometry,
  type ShapeRegion,
} from '@/services/canvas/pathBoolean'
import type { CanvasObject, PathObject } from '@/stores/canvas'
import { defaultGradient } from '@/services/canvas/gradient'
import { cssFontFamily, DEFAULT_LINE_HEIGHT, POINT_LEADING } from '@/services/canvas/textLayout'
import { trackingPx } from '@/services/canvas/textStyle'
import { clearLetterSelection, letterSelection, setLetterSelection } from '@/services/canvas/letterSelection'
import { buildScene, snapEdges, snapMove, snapPoint, type SnapOptions, type SnapScene } from '@/services/canvas/snapEngine'
import { snapSettings, SNAP_PX } from '@/services/canvas/snapSettings'
import { sampleColorAt } from '@/services/canvas/colorSampler'
import { canvasPickActive, deliverCanvasPick } from '@/services/canvas/canvasPick'
import { flattenSubpaths, parsePathData } from '@/services/canvas/svgToPaths'
import { isNonePaint } from '@/services/canvas/color'

/* eslint-disable @typescript-eslint/no-explicit-any */

const store = useCanvasStore()
const { artboards, objects, objectOrder, layers, selectedIds, selectedArtboardId, activeTool, viewMode } =
  storeToRefs(store)

// One-line contextual hint shown at the top of the stage for tools that need
// a precondition (e.g. the shape builder needs overlapping shapes selected).
const toolHint = ref('')

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
type DragKind = 'marquee' | 'shape' | 'textbox'
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
// Continuing an existing open path (clicked one of its endpoints): the pen
// works on that path's anchors and writes the result back to it.
let penExtend: { id: string; startCount: number } | null = null

// Inline text editing overlay state. While editing, the SVG text is hidden
// and a transparent textarea drawn in the same font, size, leading, alignment
// and rotation sits exactly over it, so typing happens "on the canvas".
const inlineInput = ref<HTMLTextAreaElement | null>(null)
const inlineEdit = ref<{ id: string; value: string; isNew: boolean } | null>(null)
const inlineStyle = ref<Record<string, string>>({})
// Point type renders multi-line text with svg.js's default leading.

function computeInlineStyle(id: string) {
  const obj = store.getObject(id)
  if (!obj || obj.type !== 'text' || !renderer || !mount.value) return
  const artboard = obj.artboardId ? store.getArtboard(obj.artboardId) : null
  const canvasPoint = { x: (artboard?.x ?? 0) + obj.x, y: (artboard?.y ?? 0) + obj.y }
  const rect = mount.value.getBoundingClientRect()
  const { left, top, scale } = canvasPointToScreenRect(canvasPoint, renderer.getViewBox(), rect)
  const fs = (obj.fontSize || 24) * scale
  const area = !!obj.area && !obj.pathD
  const leading = area ? obj.lineHeight || DEFAULT_LINE_HEIGHT : POINT_LEADING
  // The SVG puts the first baseline one font size below the origin; a CSS
  // line box puts it about (leading − 1)/2 + 0.93 em down. Nudge to match.
  const nudge = fs * (1 - ((leading - 1) / 2 + 0.93))
  const color = obj.fillGradient ? (obj.fillGradient.stops[0]?.color ?? '#211A43') : obj.fill
  const style: Record<string, string> = {
    left: `${left - rect.left}px`,
    top: `${top - rect.top + nudge}px`,
    fontFamily: cssFontFamily(obj.fontFamily || 'Inter'),
    fontSize: `${fs}px`,
    fontWeight: String(obj.fontWeight || 400),
    lineHeight: String(leading),
    color: isNonePaint(color) ? '#211A43' : color,
    textAlign: obj.align || 'left',
    letterSpacing: `${trackingPx(obj.tracking, fs)}px`,
  }
  const rot = obj.rotation || 0
  if (area) {
    style.width = `${(obj.width || 0) * scale}px`
    style.height = `${(obj.height || 0) * scale - nudge}px`
    style.whiteSpace = 'pre-wrap'
    style.overflowWrap = 'anywhere'
    style.outline = '1px dashed #2563eb'
    if (rot) {
      style.transform = `rotate(${rot}deg)`
      style.transformOrigin = `${((obj.width || 0) * scale) / 2}px ${((obj.height || 0) * scale) / 2 - nudge}px`
    }
  } else {
    style.whiteSpace = 'pre'
    // Point type is anchored at its origin per alignment (text-anchor).
    const shift = obj.align === 'center' ? '-50%' : obj.align === 'right' ? '-100%' : '0'
    style.transform = `translateX(${shift})${rot ? ` rotate(${rot}deg)` : ''}`
    style.transformOrigin = '50% 50%'
  }
  inlineStyle.value = style
  nextTick(fitInlineSize)
}

// Point type: grow the editor with its content (area type keeps its box).
function fitInlineSize() {
  const el = inlineInput.value
  const edit = inlineEdit.value
  const obj = edit ? store.getObject(edit.id) : null
  if (!el || !obj || obj.type !== 'text' || (obj.area && !obj.pathD)) return
  el.style.width = '0px'
  el.style.height = '0px'
  el.style.width = `${el.scrollWidth + 4}px`
  el.style.height = `${el.scrollHeight}px`
}

function startInlineEdit(id: string, isNew = false) {
  const obj = store.getObject(id)
  if (!obj || obj.type !== 'text' || store.isLocked(obj)) return
  if (inlineEdit.value && inlineEdit.value.id !== id) commitInlineEdit()
  store.selectObjects([id])
  inlineEdit.value = { id, value: obj.text || '', isNew }
  renderer?.setEditingObject(id)
  computeInlineStyle(id)
  nextTick(() => {
    const el = inlineInput.value
    if (!el) return
    el.focus()
    // Caret at the end, ready to keep typing.
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

// Letters selected in the editor become the letter selection the panels
// style (a collapsed caret clears it).
function recordLetterSelection() {
  const el = inlineInput.value
  const edit = inlineEdit.value
  if (!el || !edit) return
  setLetterSelection(edit.id, el.selectionStart, el.selectionEnd)
}

function commitInlineEdit() {
  const edit = inlineEdit.value
  inlineEdit.value = null
  renderer?.setEditingObject(null)
  if (!edit) return
  const obj = store.getObject(edit.id)
  if (!obj || obj.type !== 'text') return
  if (!edit.value.trim()) {
    // Empty text isn't kept (a new one just disappears; an edited one is
    // deleted as its own undo step).
    if (!edit.isNew) store.snapshot('Delete text')
    store.removeObject(edit.id)
  } else if (obj.text !== edit.value) {
    if (!edit.isNew) store.snapshot('Edit text')
    store.updateObject(edit.id, { text: edit.value })
  }
}

// ⇧⌘> / ⇧⌘< (Illustrator): font size up/down by 2 pt.
function isFontSizeKey(e: KeyboardEvent): 1 | -1 | 0 {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return 0
  if (e.code === 'Period' || e.key === '>') return 1
  if (e.code === 'Comma' || e.key === '<') return -1
  return 0
}

function onInlineKeydown(e: KeyboardEvent) {
  // Escape (like Illustrator) or Cmd/Ctrl+Enter finishes editing; plain Enter
  // starts a new line.
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault()
    e.stopPropagation()
    inlineInput.value?.blur()
    return
  }
  const dir = isFontSizeKey(e)
  if (dir && inlineEdit.value) {
    e.preventDefault()
    store.snapshot(dir > 0 ? 'Increase font size' : 'Decrease font size')
    store.bumpFontSize([inlineEdit.value.id], dir * 2)
    computeInlineStyle(inlineEdit.value.id)
  }
}

function snapshot() {
  return {
    artboards: JSON.parse(JSON.stringify(store.artboards)),
    // Layer visibility and lock applied.
    objects: store.renderObjects(),
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
  if (obj.type === 'text' && obj.area && !obj.pathD) {
    // Area type: the box changes, the text re-flows, the font stays.
    store.updateObject(id, { x, y, width: Math.max(10, width), height: Math.max(10, height) })
  } else if (obj.type === 'text') {
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

// A multi-selection scaled or rotated as one: every object moves (and, when
// scaling, resizes) together in a single undo step.
function onObjectsTransformed(patches: GroupTransformPatch[], kind: 'scale' | 'rotate') {
  store.snapshot(kind === 'rotate' ? 'Rotate' : 'Scale')
  for (const p of patches) {
    const obj = store.getObject(p.id)
    if (!obj) continue
    const patch: Record<string, unknown> = { x: p.x, y: p.y, rotation: p.rotation }
    if (kind === 'scale') {
      if (obj.type === 'text') {
        // Type keeps crisp glyphs: its font size scales, and an area box
        // stretches with the selection.
        patch.fontSize = Math.max(1, Math.round((obj.fontSize || 24) * p.scale * 100) / 100)
        const min = obj.area ? 10 : 0
        patch.width = Math.max(min, p.width)
        patch.height = Math.max(min, p.height)
      } else {
        patch.width = Math.max(1, p.width)
        patch.height = Math.max(1, p.height)
      }
    }
    store.updateObject(p.id, patch)
  }
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
  el.node.addEventListener('dblclick', (e: MouseEvent) => {
    if (store.activeTool !== 'select' && store.activeTool !== 'node') return
    const o = store.getObject(obj.id)
    if (!o) return
    // Selection tool on a grouped object: the first double-click picks that
    // object out of its group (a click selects the whole group).
    const alone = store.selectedIds.length === 1 && store.selectedIds[0] === o.id
    if (store.activeTool === 'select' && o.groupId && !alone) {
      e.stopPropagation()
      store.selectObjects([o.id])
      return
    }
    // Double-click text with the selection tools to edit it in place.
    if (o.type !== 'text') return
    e.stopPropagation()
    startInlineEdit(obj.id)
  })
  // Direct Selection: hovering a path previews its outline and anchors.
  // Direct Selection and the Pen preview a path's outline and anchors on
  // hover; for the pen, an open path's endpoints (click to continue) stand out.
  el.node.addEventListener('mouseenter', () => {
    const tool = store.activeTool
    if ((tool !== 'node' && tool !== 'pen') || spacePressed.value) return
    const o = store.getObject(obj.id)
    if (!o || o.type !== 'path' || store.isLocked(o)) return
    if (tool === 'node' && store.selectedIds.length === 1 && store.selectedIds[0] === o.id) return
    if (tool === 'pen' && penExtend?.id === o.id) return
    renderer?.setHoverObject(o as any, { openEnds: tool === 'pen' && !penNodes && isOpenPath(o) })
  })
  el.node.addEventListener('mouseleave', () => renderer?.setHoverObject(null))
  el.node.addEventListener('mousedown', (e: MouseEvent) => {
    renderer?.setHoverObject(null)
    // Direct Selection on a path's body selects the path, not its anchors.
    if (store.activeTool === 'node' && !spacePressed.value && store.getObject(obj.id)?.type === 'path') {
      renderer?.setNodeSelection(obj.id, [])
    }
    // Type tool on existing text: edit it right there.
    if (store.activeTool === 'text' && !spacePressed.value && store.getObject(obj.id)?.type === 'text') {
      e.stopPropagation()
      e.preventDefault()
      startInlineEdit(obj.id)
      return
    }
    // Type on a path: clicking a path converts it into the guide of a new
    // text object.
    // Gradient tool: pressing an unselected object selects it, then the press
    // continues to the stage, which starts the gradient drag.
    if (store.activeTool === 'gradient' && !spacePressed.value) {
      if (!store.selectedIds.includes(obj.id)) store.selectObjects([obj.id])
      return
    }
    if (store.activeTool === 'textPath' && !spacePressed.value) {
      const target = store.getObject(obj.id)
      if (target?.type === 'path') {
        e.stopPropagation()
        placeTextOnPath(target)
      }
      return
    }
    // The select and node-edit tools select objects on click (not while
    // space-panning). With a creation tool active, let the event bubble to the
    // stage so the tool can draw/place over existing objects.
    if ((store.activeTool !== 'select' && store.activeTool !== 'node') || spacePressed.value) return
    e.stopPropagation()
    // The Selection tool picks whole groups; Direct Selection reaches inside.
    const unit = store.activeTool === 'select' ? store.expandToGroups([obj.id]) : [obj.id]
    const additive = e.shiftKey
    if (additive) {
      const next = new Set(store.selectedIds)
      const all = unit.every((u) => next.has(u))
      for (const u of unit) {
        if (all) next.delete(u)
        else next.add(u)
      }
      store.selectObjects([...next])
    } else if (!store.selectedIds.includes(obj.id)) {
      // Clicking an already-selected object keeps the whole selection so the
      // ensuing drag moves the group; only a fresh click collapses to one.
      store.selectObjects(unit)
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
// Two-finger scrolling (and the mouse wheel) pans, as in Illustrator; a
// trackpad pinch (sent as Ctrl+wheel) or Cmd/Ctrl/Alt+wheel zooms at the pointer.
function onWheel(e: WheelEvent) {
  if (!renderer) return
  cancelViewBoxAnimation()
  // Lines/pages → pixels for wheels that report in those units.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  if (e.ctrlKey || e.metaKey || e.altKey) {
    const focal = renderer.screenToCanvas(e.clientX, e.clientY)
    const dy = Math.max(-30, Math.min(30, e.deltaY * unit))
    let box = zoomViewBox(renderer.getViewBox(), Math.exp(-dy * 0.01), focal)
    box = clampZoom(box, baseBounds)
    renderer.setViewBox(box)
    return
  }
  let dx = e.deltaX * unit
  let dy = e.deltaY * unit
  // Shift+wheel scrolls sideways on mice that only have a vertical wheel.
  if (e.shiftKey && !dx) {
    dx = dy
    dy = 0
  }
  const px = renderer.canvasUnitsPerPixel()
  renderer.setViewBox(panViewBox(renderer.getViewBox(), -dx * px, -dy * px))
}

// --- Interaction: empty-space mousedown dispatches by active tool ---------
// Space-held always pans. Otherwise: select → marquee/deselect; shapes → draw;
// text/image are handled on click (no drag) in onMouseUp.
function onMouseDown(e: MouseEvent) {
  if (!renderer) return
  if (e.button !== 0) return

  cancelViewBoxAnimation()
  const tool = store.activeTool

  if (tool === 'eyedropper' && !spacePressed.value) {
    eyedropAt(e)
    return
  }

  // Pen has its own press-drag-release cycle: press places an anchor, dragging
  // pulls its Bézier handles, release commits it. Space still forces panning.
  if (tool === 'pen' && !spacePressed.value) {
    penMouseDown(e.clientX, e.clientY, e)
    window.addEventListener('mousemove', onPenDragMove)
    window.addEventListener('mouseup', onPenDragUp)
    return
  }

  if (tool === 'shapeBuilder' && !spacePressed.value && sbStart(e)) return
  if (tool === 'gradient' && !spacePressed.value && gradStart(e)) return

  const wantPan =
    spacePressed.value ||
    tool === 'image' ||
    tool === 'textPath' ||
    tool === 'shapeBuilder' ||
    tool === 'gradient'

  if (!wantPan && (tool === 'select' || tool === 'node' || tool === 'text' || isShapeTool(tool))) {
    const raw = renderer.screenToCanvas(e.clientX, e.clientY)
    const marquee = tool === 'select' || tool === 'node'
    // Shapes and text boxes start on a snapped point; the marquee doesn't snap.
    const p = marquee ? raw : snapCanvasPoint(raw, e)
    toolDrag = {
      kind: marquee ? 'marquee' : tool === 'text' ? 'textbox' : 'shape',
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
    const raw = renderer.screenToCanvas(e.clientX, e.clientY)
    toolDrag.current = toolDrag.kind === 'marquee' ? raw : snapCanvasPoint(raw, e)
    // Shift keeps shapes (and text boxes) square and lines at 45° steps.
    if (toolDrag.kind !== 'marquee' && e.shiftKey) {
      toolDrag.current =
        store.activeTool === 'line'
          ? constrainAngle(toolDrag.start, toolDrag.current)
          : constrainSquare(toolDrag.start, toolDrag.current)
    }
    if (toolDrag.kind !== 'marquee' && snapSettings.smartGuides) {
      const b = normalizeDragBox(toolDrag.start, toolDrag.current)
      // Keep the snap guides and add a size readout.
      const scene = ensureScene([])
      const guides = snapPoint(scene, toolDrag.current, snapTol(), snapOptions(e)).guides
      renderer.showGuides(guides, { ...raw, text: `W ${Math.round(b.width)}  H ${Math.round(b.height)}` })
    }
    const box = normalizeDragBox(toolDrag.start, toolDrag.current)
    if (box.width > 1 || box.height > 1) toolDrag.moved = true
    if (toolDrag.kind === 'marquee') {
      renderer.showMarquee(box)
    } else if (toolDrag.kind === 'textbox') {
      renderer.showShapePreview('rect', box)
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
    endSnap()
    if (drag.kind === 'marquee') {
      renderer.hideMarquee()
      if (drag.moved && store.activeTool === 'node') {
        selectAnchorsInBox(normalizeDragBox(drag.start, drag.current), drag.additive)
      } else if (drag.moved) {
        const box = normalizeDragBox(drag.start, drag.current)
        const hits = store.expandToGroups(renderer.hitTestBox(box))
        store.selectObjects(mergeMarqueeSelection(store.selectedIds, hits, drag.additive))
      } else {
        // A click with no drag clears the selection (unless additive).
        if (!drag.additive) store.clearSelection()
      }
    } else if (drag.kind === 'textbox') {
      renderer.hideShapePreview()
      // A real drag makes a text box; a click makes point type.
      const box = normalizeDragBox(drag.start, drag.current)
      const vb = renderer.getViewBox()
      if (drag.moved && Math.max(box.width, box.height) > vb.width / 150) placeAreaText(drag.start, drag.current)
      else placeText(e.clientX, e.clientY)
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

// Direct Selection marquee: select the anchors inside the box, on the
// selected path if it has any there, else the frontmost path that does.
function selectAnchorsInBox(box: Box, additive: boolean) {
  if (!renderer) return
  const inside = (p: { x: number; y: number }) =>
    p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height
  const current = store.selectedIds.length === 1 ? store.selectedIds[0]! : null
  const candidates = [current, ...[...store.objectOrder].reverse()].filter((id): id is string => !!id)
  for (const id of candidates) {
    const o = store.getObject(id)
    if (!o || o.type !== 'path' || store.isHidden(o) || store.isLocked(o)) continue
    const hits = renderer
      .pathAnchorsOnCanvas(o as any)
      .map((p, i) => (inside(p) ? i : -1))
      .filter((i) => i >= 0)
    if (!hits.length) continue
    const prev = additive && id === current ? renderer.getNodeSelection()?.indices ?? [] : []
    store.selectObjects([id])
    renderer.setNodeSelection(id, [...new Set([...prev, ...hits])])
    return
  }
  if (!additive) store.clearSelection()
}

// Empty-space click behavior for the image tool and the deselect fallback.
// (The Type tool's click/drag is handled with the shape-style drag.)
function handleEmptyClick(e: MouseEvent) {
  const tool = store.activeTool
  if (tool === 'image') {
    placeImage(e.clientX, e.clientY)
    return
  }
  store.clearSelection()
}

// --- Smart guides & snapping --------------------------------------------------
// One scene (everything snappable except what's moving) is built when an
// interaction first asks to snap and dropped when it ends. Holding Cmd/Ctrl
// bypasses snapping for that drag.
let snapScene: SnapScene | null = null
let snapExclude = ''
// Anchors cached per object path data, in local coordinates.
const anchorCache = new Map<string, { d: string; pts: PathNode[] }>()
const MAX_ANCHORS = 20000

function snapTol(): number {
  return SNAP_PX * (renderer?.canvasUnitsPerPixel() ?? 1)
}

function snapOptions(ev?: MouseEvent): SnapOptions {
  const bypass = !!ev && (ev.metaKey || ev.ctrlKey)
  return { points: snapSettings.snapToPoint && !bypass, guides: snapSettings.smartGuides && !bypass }
}

function localAnchors(o: { id: string; d?: string; nodes?: PathNode[]; shape?: string; baseWidth?: number; baseHeight?: number }): PathNode[] {
  if (o.nodes?.length) return o.nodes
  // A live rectangle's anchors are its four corners (rounded or not), the
  // same nodes ensurePathNodes gives it.
  if (o.shape === 'rect') {
    const w = o.baseWidth || 0
    const h = o.baseHeight || 0
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
  }
  const d = o.d || ''
  const cached = anchorCache.get(o.id)
  if (cached && cached.d === d) return cached.pts
  let pts: PathNode[] = []
  try {
    pts = flattenSubpaths(parsePathData(d)).nodes
  } catch {
    /* unparseable path: no anchors */
  }
  anchorCache.set(o.id, { d, pts })
  return pts
}

// Live corners of a path (local frame) and its radius. A rectangle's corners
// are its box corners; other paths use their sharp node corners. Ellipses
// and lines have none.
function liveCorners(o: CanvasObject): { corners: PathCorner[]; radius: number } | null {
  if (o.type !== 'path' || o.shape === 'ellipse' || o.shape === 'line') return null
  const radius = o.cornerRadius || 0
  if (o.shape === 'rect') return { corners: pathCorners(localAnchors(o), true), radius }
  if (o.nodes?.length) return { corners: pathCorners(o.nodes, !!o.closed, o.subpaths), radius }
  try {
    const f = flattenSubpaths(parsePathData(o.d || ''))
    return { corners: pathCorners(f.nodes, f.closed, f.subpaths), radius }
  } catch {
    return null
  }
}

// Corner widget drag: one undo step for the whole drag, radius clamped to
// the roundest any of the affected corners can get. `only` limits it to the
// selected corner anchors.
let cornerDragSnapped = false
function onCornerRadiusDrag(id: string, radius: number, phase: 'start' | 'move' | 'end', only: number[] | null) {
  if (phase !== 'move') {
    cornerDragSnapped = false
    return
  }
  const o = store.getObject(id)
  const info = o ? liveCorners(o) : null
  if (!info?.corners.length) return
  if (!cornerDragSnapped) {
    store.snapshot('Corner radius')
    cornerDragSnapped = true
  }
  const affected = only ? info.corners.filter((c) => only.includes(c.index)) : info.corners
  if (!affected.length) return
  const r = Math.round(Math.min(radius, Math.max(...affected.map((c) => c.maxRadius))) * 100) / 100
  if (only) store.setNodeCornerRadius(id, only, r)
  else store.setCornerRadius(id, r)
}

function canvasAnchors(id: string): { x: number; y: number }[] {
  const o = store.getObject(id)
  if (!o || o.type !== 'path' || !renderer) return []
  return renderer.objectLocalToCanvas(o as any, localAnchors(o))
}

// `extra`: anchors not in the document yet (the path the pen is drawing).
function ensureScene(exclude: string[], extra: { x: number; y: number }[] = []): SnapScene {
  const k = exclude.slice().sort().join(',') + '|' + extra.map((p) => `${p.x},${p.y}`).join(';')
  if (snapScene && snapExclude === k) return snapScene
  const skip = new Set(exclude)
  const boxes: Box[] = []
  const anchors: { x: number; y: number }[] = []
  for (const o of store.orderedObjects) {
    if (skip.has(o.id) || store.isHidden(o)) continue
    const b = store.objectCanvasBounds(o.id)
    if (b) boxes.push(b)
    if (anchors.length < MAX_ANCHORS) anchors.push(...canvasAnchors(o.id))
  }
  anchors.push(...extra)
  const artboardBoxes = store.artboards.map((a) => ({ x: a.x, y: a.y, width: a.width, height: a.height }))
  snapScene = buildScene({ boxes, anchors, artboards: artboardBoxes }, snapTol())
  snapExclude = k
  return snapScene
}

function endSnap() {
  snapScene = null
  snapExclude = ''
  renderer?.hideGuides()
}

function unionBounds(ids: string[]): Box | null {
  const bs = ids.map((id) => store.objectCanvasBounds(id)).filter((b): b is Box => !!b)
  if (!bs.length) return null
  const x = Math.min(...bs.map((b) => b.x))
  const y = Math.min(...bs.map((b) => b.y))
  return {
    x,
    y,
    width: Math.max(...bs.map((b) => b.x + b.width)) - x,
    height: Math.max(...bs.map((b) => b.y + b.height)) - y,
  }
}

// Readout position relative to the artboard under a canvas point.
function artboardLocal(p: { x: number; y: number }): { x: number; y: number } {
  const ab = resolveArtboardAtPoint(store.artboards, p)
  return { x: p.x - (ab?.x ?? 0), y: p.y - (ab?.y ?? 0) }
}

function wireSnapping(r: CanvasRenderer) {
  r.snapMove = (ids, dx, dy, ev) => {
    const opts = snapOptions(ev)
    const box = unionBounds(ids)
    if (!box) return { dx, dy }
    let res = { dx, dy, guides: [] as ReturnType<typeof snapMove>['guides'] }
    if (opts.points || opts.guides) {
      const scene = ensureScene(ids)
      const moving = ids.length <= 3 ? ids.flatMap(canvasAnchors).slice(0, 400) : []
      res = snapMove(scene, box, moving, dx, dy, snapTol(), opts)
    }
    if (snapSettings.smartGuides) {
      const at = artboardLocal({ x: box.x + res.dx, y: box.y + res.dy })
      const cursor = ev ? r.screenToCanvas(ev.clientX, ev.clientY) : { x: box.x + res.dx, y: box.y + res.dy }
      r.showGuides(res.guides, { ...cursor, text: `X ${Math.round(at.x)}  Y ${Math.round(at.y)}` })
    }
    return res
  }
  r.snapResize = (id, handle, box, ev) => {
    const opts = snapOptions(ev)
    let out = box
    let guides: ReturnType<typeof snapEdges>['guides'] = []
    if (opts.points || opts.guides) {
      const edges = {
        left: handle.includes('w'),
        right: handle.includes('e'),
        top: handle.includes('n'),
        bottom: handle.includes('s'),
      }
      ;({ box: out, guides } = snapEdges(ensureScene([id]), box, edges, snapTol(), opts))
    }
    if (snapSettings.smartGuides) {
      const cursor = r.screenToCanvas(ev.clientX, ev.clientY)
      r.showGuides(guides, { ...cursor, text: `W ${Math.round(out.width)}  H ${Math.round(out.height)}` })
    }
    return out
  }
  r.snapNodePoint = (id, p, ev) => {
    const q = snapCanvasPoint(p, ev, [id])
    return { x: q.x, y: q.y }
  }
  r.onSnapEnd = endSnap
}

// Snap a free point (pen anchors, shape corners, node drags) and show guides.
function snapCanvasPoint(
  p: { x: number; y: number },
  ev?: MouseEvent,
  exclude: string[] = [],
  extra: { x: number; y: number }[] = [],
): { x: number; y: number } {
  const opts = snapOptions(ev)
  if (!renderer || (!opts.points && !opts.guides)) {
    renderer?.hideGuides()
    return p
  }
  const r = snapPoint(ensureScene(exclude, extra), p, snapTol(), opts)
  renderer.showGuides(r.guides)
  return { x: r.x, y: r.y }
}

// --- Eyedropper ------------------------------------------------------------------
// Click a color on the canvas to apply it to the selection's fill (paths and
// text). Like Illustrator, sampling a gradient-filled object copies the
// gradient; Shift-click takes just the solid color under the cursor.
async function eyedropAt(e: MouseEvent) {
  if (!renderer) return
  const sample = await sampleColorAt(store, renderer, e.clientX, e.clientY)
  if (!sample) {
    toolHint.value = 'Eyedropper: no color there.'
    return
  }
  const targets = store.selectedObjects.filter((o) => o.type !== 'image' && o.id !== sample.sourceId)
  if (!targets.length) {
    toolHint.value = `Picked ${sample.color} — select shapes or text first to apply it.`
    return
  }
  store.snapshot('Eyedropper')
  for (const o of targets) {
    if (sample.gradient && !e.shiftKey) store.setFillGradient(o.id, sample.gradient)
    else store.setFill(o.id, sample.color)
  }
  toolHint.value = `Applied ${sample.gradient && !e.shiftKey ? 'gradient' : sample.color} to ${targets.length} object${targets.length > 1 ? 's' : ''}.`
}

// While a color picker is open, a canvas click picks a color for it instead of
// selecting anything (capture phase, so objects never see the press).
async function onPickCapture(e: MouseEvent) {
  if (!canvasPickActive.value || e.button !== 0 || spacePressed.value || !renderer) return
  if ((e.target as HTMLElement).closest('.inline-text-editor')) return
  e.stopPropagation()
  e.preventDefault()
  const sample = await sampleColorAt(store, renderer, e.clientX, e.clientY)
  if (sample) deliverCanvasPick(sample.color)
}

// --- Pen tool: Bézier path builder ---------------------------------------
// Click for a corner anchor; press-drag to pull symmetric tangent handles for
// a smooth anchor. Close by clicking near the first anchor; finish an open path
// with double-click / Enter / Escape, or by switching tools (the path is kept,
// as in Illustrator).
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

function penMouseDown(clientX: number, clientY: number, ev?: MouseEvent) {
  if (!renderer) return
  const raw = renderer.screenToCanvas(clientX, clientY)
  const last = penNodes?.[penNodes.length - 1]
  // Shift locks the new segment to horizontal / vertical / 45° (no snapping).
  const p = ev?.shiftKey && last ? constrainAngle(last, raw) : penSnap(raw, ev)
  renderer.hideGuides()
  // Not drawing yet: clicking an endpoint of an open path continues it.
  if (!penNodes) {
    const hit = openEndpointAt(p)
    if (hit) {
      startExtend(hit.id, hit.nodes)
      return
    }
  }
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
  const raw = renderer.screenToCanvas(e.clientX, e.clientY)
  // Shift constrains the handle's angle too.
  penDraft.drag = e.shiftKey ? constrainAngle(penDraft.anchor, raw) : raw
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

// Is this path open (one subpath, not closed), so the pen can continue it?
function isOpenPath(o: { nodes?: PathNode[]; closed?: boolean; subpaths?: number[]; d?: string }): boolean {
  if (o.nodes?.length) return !o.closed && (o.subpaths?.length ?? 1) <= 1
  try {
    const f = flattenSubpaths(parsePathData(o.d || ''))
    return !f.closed && f.subpaths.length === 1
  } catch {
    return false
  }
}

// The open path whose first or last anchor is under p (frontmost first). Its
// canvas-space anchors come back oriented so the clicked end is last.
function openEndpointAt(p: { x: number; y: number }): { id: string; nodes: PathNode[] } | null {
  if (!renderer) return null
  const tol = penDistanceThreshold()
  for (const id of [...store.objectOrder].reverse()) {
    const o = store.getObject(id)
    if (!o || o.type !== 'path' || store.isHidden(o) || store.isLocked(o) || !isOpenPath(o)) continue
    const nodes = renderer.pathNodesOnCanvas(o as any)
    if (nodes.length < 2) continue
    const near = (n: PathNode) => Math.hypot(n.x - p.x, n.y - p.y) <= tol
    if (near(nodes[nodes.length - 1]!)) return { id, nodes }
    if (near(nodes[0]!)) return { id, nodes: reverseNodes(nodes) }
  }
  return null
}

function startExtend(id: string, nodes: PathNode[]) {
  penNodes = nodes
  penExtend = { id, startCount: nodes.length }
  store.selectObjects([id])
  renderer?.setHoverObject(null)
  renderPenPreview(null)
  toolHint.value = 'Continuing path — click to add points · click its other end to close · Enter or Esc to finish'
}

// Write a continued path back to its object. The geometry is rebuilt in
// artboard space (rotation and scale baked in), so the existing part stays
// exactly where it was.
function commitExtend(id: string, nodes: PathNode[], closed: boolean) {
  const o = store.getObject(id)
  if (!o || o.type !== 'path') return
  const ab = o.artboardId ? store.getArtboard(o.artboardId) : null
  const payload = buildPenNodesPayload(nodes, ab, closed)
  if (!payload) return
  store.snapshot(closed ? 'Close path' : 'Extend path')
  store.updateObject(id, {
    d: payload.d,
    nodes: payload.nodes,
    closed,
    subpaths: undefined,
    shape: undefined,
    cornerRadius: undefined,
    x: payload.x,
    y: payload.y,
    width: payload.width,
    height: payload.height,
    baseWidth: payload.width,
    baseHeight: payload.height,
    rotation: 0,
  })
  // Corners keep their rounding (the nodes carry their radii).
  if (payload.nodes.some((n) => n.radius)) store.updatePathNodes(id, payload.nodes)
  store.selectObjects([id])
}

// Commit the in-progress pen path as a path object, or discard if too short.
function finishPen(closed: boolean) {
  const nodes = penNodes
  const extending = penExtend
  penNodes = null
  penDraft = null
  penExtend = null
  endSnap()
  if (renderer) renderer.hidePenPreview()
  if (toolHint.value.startsWith('Continuing path')) toolHint.value = ''
  // A double-click's first click commits an anchor immediately before finishing,
  // duplicating the last one; drop a coincident trailing corner node.
  if (nodes && nodes.length >= 2) {
    const a = nodes[nodes.length - 1]!
    const b = nodes[nodes.length - 2]!
    if (a.x === b.x && a.y === b.y && a.outX === undefined && a.inX === undefined) nodes.pop()
  }
  if (extending) {
    if (nodes && (closed || nodes.length > extending.startCount)) commitExtend(extending.id, nodes, closed)
    return
  }
  if (!nodes || nodes.length < 2) return
  const artboard = resolveArtboardAtPoint(store.artboards, nodes[0]!)
  const payload = buildPenNodesPayload(nodes, artboard, closed)
  if (!payload) return
  store.snapshot('Add path')
  const obj = store.addObject({ ...payload, artboardId: artboard?.id ?? null })
  store.selectObjects([obj.id])
  // Tool stays armed for drawing multiple paths.
}

function onStageMouseMove(e: MouseEvent) {
  lastPointer = { clientX: e.clientX, clientY: e.clientY }
  if (store.activeTool === 'shapeBuilder' && sb.regions && !sb.dragging && renderer) {
    const hover = regionAtPoint(sb.regions, renderer.screenToCanvas(e.clientX, e.clientY))
    if (hover !== sb.hover) {
      sb.hover = hover
      drawShapeRegions()
    }
  }
  // Pen hovering (no button down): smart guides show where the next anchor
  // would land, before the first click too. While drawing, a rubber band runs
  // from the last anchor to the cursor.
  if (store.activeTool === 'pen' && !penDraft && !spacePressed.value && renderer) {
    const raw = renderer.screenToCanvas(e.clientX, e.clientY)
    const last = penNodes?.[penNodes.length - 1]
    const cursor = e.shiftKey && last ? (renderer.hideGuides(), constrainAngle(last, raw)) : penSnap(raw, e)
    if (penNodes) renderer.showPenPreview([...penNodes, { x: cursor.x, y: cursor.y }], penNearStart(cursor))
  }
}

// Pen snapping: existing artwork plus the anchors already placed on the path
// being drawn, so a new anchor can line up with the path's own points.
function penSnap(raw: { x: number; y: number }, ev?: MouseEvent): { x: number; y: number } {
  return snapCanvasPoint(raw, ev, [], (penNodes ?? []).map((n) => ({ x: n.x, y: n.y })))
}

function onStageMouseLeave() {
  if (store.activeTool === 'pen' && !penDraft) renderer?.hideGuides()
}

function onStageDblClick(e: MouseEvent) {
  if (store.activeTool !== 'pen' || !penNodes) return
  e.preventDefault()
  finishPen(false)
}

// --- Type on a path ----------------------------------------------------------
// The clicked path becomes the text's guide (Illustrator converts the path the
// same way): a text object takes its place in paint order, laid along the
// path's canvas-space geometry.
async function placeTextOnPath(path: PathObject) {
  let geo
  try {
    geo = await textPathGeometry(store, path)
  } catch {
    return
  }
  store.snapshot('Type on path')
  const [id] = replaceObjects(store, [path.id], [
    {
      type: 'text',
      text: 'Type on a path',
      pathD: geo.pathD,
      pathOffset: 0,
      x: geo.x,
      y: geo.y,
      width: geo.width,
      height: geo.height,
      fontSize: Math.max(12, Math.round(Math.min(48, Math.max(geo.width, geo.height) / 12))),
      artboardId: path.artboardId,
      semanticRole: 'wordmark',
    },
  ])
  store.setActiveTool('select')
  if (id) store.selectObjects([id])
}

// --- Shape Builder --------------------------------------------------------------
// With overlapping paths selected, the union is split into regions. Hover
// highlights a region; drag across regions to merge them into one shape, or
// hold Alt while dragging to erase them. Regions not touched stay as separate
// shapes. The selection is replaced by the result so the user can keep going.
const sb: {
  sources: string[]
  regions: ShapeRegion[] | null
  hover: number
  picked: number[]
  erase: boolean
  dragging: boolean
  token: number
} = { sources: [], regions: null, hover: -1, picked: [], erase: false, dragging: false, token: 0 }

async function prepareShapeBuilder() {
  const token = ++sb.token
  sb.regions = null
  sb.hover = -1
  sb.picked = []
  renderer?.hideShapeRegions()
  if (store.activeTool !== 'shapeBuilder') return
  const paths = store.selectedObjects.filter((o) => o.type === 'path')
  if (paths.length < 2) {
    toolHint.value = 'Shape Builder: select two or more overlapping shapes (V), then switch back (Shift+M).'
    return
  }
  sb.sources = paths.map((o) => o.id)
  toolHint.value = 'Drag across regions to merge · Alt-drag to erase · Esc to finish'
  const regions = await computeShapeRegions(store, sb.sources)
  if (token !== sb.token) return
  sb.regions = regions
  drawShapeRegions()
}

function drawShapeRegions() {
  if (!renderer || !sb.regions) return
  const picked = new Set(sb.picked)
  renderer.showShapeRegions(
    sb.regions.map((r, i) => ({
      d: r.pathData,
      state: picked.has(i) ? (sb.erase ? 'erase' : 'merge') : i === sb.hover ? 'hover' : 'idle',
    })),
  )
}

function sbStart(e: MouseEvent): boolean {
  if (!renderer || !sb.regions) return false
  const i = regionAtPoint(sb.regions, renderer.screenToCanvas(e.clientX, e.clientY))
  if (i < 0) return false
  sb.dragging = true
  sb.erase = e.altKey
  sb.picked = [i]
  drawShapeRegions()
  window.addEventListener('mousemove', sbMove)
  window.addEventListener('mouseup', sbUp)
  return true
}

function sbMove(e: MouseEvent) {
  if (!renderer || !sb.regions) return
  const i = regionAtPoint(sb.regions, renderer.screenToCanvas(e.clientX, e.clientY))
  if (e.altKey) sb.erase = true
  if (i >= 0 && !sb.picked.includes(i)) {
    sb.picked.push(i)
    drawShapeRegions()
  }
}

function sbUp() {
  window.removeEventListener('mousemove', sbMove)
  window.removeEventListener('mouseup', sbUp)
  window.removeEventListener('mousemove', gradMove)
  window.removeEventListener('mouseup', gradUp)
  sb.dragging = false
  if (!sb.regions || !sb.picked.length) return
  const regions = sb.regions
  const picked = sb.picked
  store.snapshot(sb.erase ? 'Shape builder erase' : 'Shape builder merge')
  const ids = commitShapeBuilder(store, sb.sources, regions, picked, sb.erase)
  // Selecting the result re-runs prepareShapeBuilder via the selection watch.
  store.selectObjects(ids)
}

// --- Gradient tool ---------------------------------------------------------------
// Drag across the selection to set the gradient's start and end (Illustrator's
// Gradient tool). Objects without a gradient get a default one from their fill.
// A plain click just applies a gradient. The vector is stored in each object's
// bounding-box fractions, so the drag maps per object through its transform.
let gradDrag: { start: { x: number; y: number }; end: { x: number; y: number }; moved: boolean } | null = null

function gradientTargets() {
  return store.selectedObjects.filter((o) => o.type !== 'image')
}

function drawGradientAnnotator() {
  if (!renderer) return
  renderer.hideGradientAnnotator()
  if (store.activeTool !== 'gradient') return
  if (gradDrag) {
    renderer.showGradientAnnotator(gradDrag.start, gradDrag.end)
    return
  }
  const targets = gradientTargets()
  const o = targets.length === 1 ? targets[0]! : null
  const g = o && (o.type === 'path' || o.type === 'text') ? o.fillGradient : undefined
  if (!o || !g) return
  const a = renderer.objectFractionToCanvas(o as any, { x: g.x1, y: g.y1 })
  const b = renderer.objectFractionToCanvas(o as any, { x: g.x2, y: g.y2 })
  if (a && b) renderer.showGradientAnnotator(a, b)
}

function gradStart(e: MouseEvent): boolean {
  if (!renderer || !gradientTargets().length) return false
  const p = renderer.screenToCanvas(e.clientX, e.clientY)
  gradDrag = { start: p, end: p, moved: false }
  window.addEventListener('mousemove', gradMove)
  window.addEventListener('mouseup', gradUp)
  return true
}

function gradMove(e: MouseEvent) {
  if (!renderer || !gradDrag) return
  gradDrag.end = renderer.screenToCanvas(e.clientX, e.clientY)
  const vb = renderer.getViewBox()
  if (Math.hypot(gradDrag.end.x - gradDrag.start.x, gradDrag.end.y - gradDrag.start.y) > vb.width / 300) {
    gradDrag.moved = true
  }
  drawGradientAnnotator()
}

function gradUp() {
  window.removeEventListener('mousemove', gradMove)
  window.removeEventListener('mouseup', gradUp)
  const drag = gradDrag
  gradDrag = null
  if (!renderer || !drag) return
  const targets = gradientTargets()
  if (!targets.length) return drawGradientAnnotator()
  store.snapshot('Gradient')
  for (const o of targets) {
    const base = o.fillGradient ?? defaultGradient(o.fill)
    if (!drag.moved) {
      if (!o.fillGradient) store.setFillGradient(o.id, base)
      continue
    }
    const a = renderer.canvasToObjectFraction(o as any, drag.start)
    const b = renderer.canvasToObjectFraction(o as any, drag.end)
    if (!a || !b) continue
    const r = (n: number) => Math.round(n * 1000) / 1000
    store.setFillGradient(o.id, { ...base, x1: r(a.x), y1: r(a.y), x2: r(b.x), y2: r(b.y) })
  }
  // The store watch redraws the annotator once the new gradient renders.
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
  startInlineEdit(obj.id, true)
}

// Type tool drag: an area-type box (Illustrator's text box). The text wraps
// inside it and resizing the box re-flows the text instead of scaling it.
function placeAreaText(start: { x: number; y: number }, end: { x: number; y: number }) {
  const box = normalizeDragBox(start, end)
  const artboard = resolveArtboardAtPoint(store.artboards, start)
  store.snapshot('Add text box')
  const obj = store.addObject({
    type: 'text',
    text: '',
    area: true,
    x: box.x - (artboard?.x ?? 0),
    y: box.y - (artboard?.y ?? 0),
    width: Math.max(20, box.width),
    height: Math.max(24, box.height),
    artboardId: artboard?.id ?? null,
    semanticRole: 'bodyText',
  })
  startInlineEdit(obj.id, true)
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
  // viewBox coords -> placed coords: subtract the viewBox origin, scale, then
  // offset to the drop origin.
  const ids = placeImportedPaths(store, parsed.paths, {
    map: (x, y) => ({ x: originX + (x - vb.x) * scale, y: originY + (y - vb.y) * scale }),
    scale,
    artboardId: artboard?.id ?? null,
  })
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
    const dups = store.duplicateObjects(groupIds, { x: dx, y: dy })
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

// --- Nudge ----------------------------------------------------------------------
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}
// Held or repeated arrow presses share one undo step.
let lastNudge = 0
function nudgeSnapshot() {
  const now = Date.now()
  if (now - lastNudge > 1000) store.snapshot('Nudge')
  lastNudge = now
}

// Move the selection by (dx, dy) canvas units: the selected anchors with
// Direct Selection, otherwise the selected objects. False when there's
// nothing to move.
function nudge(dx: number, dy: number): boolean {
  const sel = store.activeTool === 'node' ? renderer?.getNodeSelection() : null
  if (sel) {
    const o = store.getObject(sel.id)
    if (!o || o.type !== 'path' || store.isLocked(o)) return false
    nudgeSnapshot()
    const path = store.ensurePathNodes(sel.id)
    if (!path || path.type !== 'path' || !path.nodes) return false
    // Canvas delta into the path's local frame: undo rotation, then scale.
    const a = (-(path.rotation || 0) * Math.PI) / 180
    const lx = (dx * Math.cos(a) - dy * Math.sin(a)) / (path.baseWidth ? path.width / path.baseWidth || 1 : 1)
    const ly = (dx * Math.sin(a) + dy * Math.cos(a)) / (path.baseHeight ? path.height / path.baseHeight || 1 : 1)
    const pick = new Set(sel.indices)
    const shift = (v: number | undefined, d: number) => (v === undefined ? undefined : v + d)
    const nodes = path.nodes.map((n, i) =>
      pick.has(i)
        ? { ...n, x: n.x + lx, y: n.y + ly, inX: shift(n.inX, lx), inY: shift(n.inY, ly), outX: shift(n.outX, lx), outY: shift(n.outY, ly) }
        : n,
    )
    store.updatePathNodes(sel.id, nodes)
    return true
  }
  const ids = store.selectedObjects.filter((o) => !store.isLocked(o)).map((o) => o.id)
  if (!ids.length) return false
  nudgeSnapshot()
  for (const id of ids) {
    const o = store.getObject(id)!
    store.moveObject(id, { x: (o.x || 0) + dx, y: (o.y || 0) + dy })
  }
  return true
}

// Node-edit commit: the renderer hands back the reshaped nodes (local frame);
// snapshot once per drag and persist, which regenerates the path's `d`.
function onPathNodesChanged(id: string, nodes: PathNode[]) {
  store.snapshot('Edit nodes')
  // First edit of a shape/imported path: adopt the derived node model.
  store.ensurePathNodes(id)
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

  // Pen: Enter or Escape ends the in-progress path, keeping it (without
  // leaving the tool) so the next click starts a new path.
  if (store.activeTool === 'pen' && penNodes) {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      finishPen(false)
      return
    }
  }

  // Escape returns to the Select tool (and closes any transient state).
  if (e.key === 'Escape' && store.activeTool !== 'select') {
    e.preventDefault()
    store.setActiveTool('select')
    return
  }

  // Cmd/Ctrl+Y toggles Outline / Preview view, as in Illustrator.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault()
    store.toggleViewMode()
    return
  }

  // Shift+M arms the shape builder (Illustrator's shortcut).
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'M' || e.key === 'm')) {
    e.preventDefault()
    store.setActiveTool('shapeBuilder')
    return
  }

  // X swaps the selection's fill and stroke colors.
  if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'x' || e.key === 'X')) {
    const ids = store.selectedObjects.filter((o) => o.type === 'path').map((o) => o.id)
    if (ids.length) {
      e.preventDefault()
      store.snapshot('Swap fill and stroke')
      store.swapFillStroke(ids)
    }
    return
  }

  // Single-key tool hotkeys (ignore when a modifier is held, e.g. Cmd+T).
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    // Illustrator's single-key tool shortcuts.
    const toolKeys: Record<string, ToolId> = {
      v: 'select',
      a: 'node',
      t: 'text',
      p: 'pen',
      m: 'rect',
      l: 'ellipse',
      '\\': 'line',
      g: 'gradient',
      i: 'eyedropper',
    }
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
  // Arrow keys nudge the selection 1pt (Shift: 10pt), as in Illustrator.
  const arrow = ARROWS[e.key]
  if (arrow && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const step = e.shiftKey ? 10 : 1
    if (nudge(arrow[0] * step, arrow[1] * step)) e.preventDefault()
    return
  }

  // Direct Selection: Delete removes the selected anchors, not the object.
  if ((e.key === 'Delete' || e.key === 'Backspace') && store.activeTool === 'node') {
    const sel = renderer?.getNodeSelection()
    if (sel) {
      e.preventDefault()
      store.snapshot(sel.indices.length > 1 ? 'Delete anchor points' : 'Delete anchor point')
      store.deletePathNodes(sel.id, sel.indices)
      renderer?.setNodeSelection(sel.id, [])
      return
    }
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
    const dups = store.duplicateObjects([...store.selectedIds])
    if (dups.length) store.selectObjects(dups.map((d) => d.id))
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
  renderer.onObjectsTransformed = onObjectsTransformed
  renderer.onArtboardMounted = wireArtboard
  renderer.onArtboardResized = onArtboardResized
  renderer.onPathNodesChanged = onPathNodesChanged
  renderer.canDragObjects = () => store.activeTool === 'select' && !spacePressed.value
  wireSnapping(renderer)
  mount.value.addEventListener('mousedown', onPickCapture, true)
  // Shapes and imported paths without a node model get derived anchors, so
  // Direct Selection works on every path.
  renderer.resolveNodes = (obj) => (obj.type === 'path' ? localAnchors(obj) : null)
  renderer.resolveCorners = (obj) => liveCorners(obj as any)
  renderer.onCornerRadiusDrag = onCornerRadiusDrag
  renderer.setSelectionChromeHidden(store.activeTool === 'pen')
  // Let the store measure true rendered geometry (e.g. for fit-to-artwork).
  setObjectBoxMeasurer((obj) => (renderer ? renderer.measureObjectBox(obj as any) : null))
  // Let WebMCP tools (which only have the store) drive the viewport.
  setViewportController({
    fitBox: (box, o) => fitBoxToView(box, o),
    unitsPerPixel: () => renderer?.canvasUnitsPerPixel() ?? 1,
  })
  renderer.setNodeEditMode(store.activeTool === 'node')
  renderer.setViewMode(store.viewMode)
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
  window.removeEventListener('mousemove', sbMove)
  window.removeEventListener('mouseup', sbUp)
  mount.value?.removeEventListener('mousedown', onPickCapture, true)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('paste', handlePaste)
  cancelViewBoxAnimation()
  setObjectBoxMeasurer(null)
  setViewportController(null)
  if (renderer) renderer.destroy()
  renderer = null
})

// Layers too: a hidden or locked layer changes how its objects render.
watch(
  [artboards, objects, objectOrder, layers],
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

watch(viewMode, (mode) => renderer?.setViewMode(mode))

// Letter selection: tinted on the canvas while the editor is closed (the
// editor shows its own selection), and dropped once its object isn't the
// selection or its text no longer reaches the range.
watch(
  () => [letterSelection.id, letterSelection.start, letterSelection.end, inlineEdit.value?.id ?? null] as const,
  ([id, start, end, editing]) => renderer?.setLetterHighlight(id && editing !== id ? { id, start, end } : null),
)
watch(
  () => [store.selectedIds.join(','), letterSelection.id ? (store.getObject(letterSelection.id) as { text?: string } | null)?.text : undefined] as const,
  ([ids, text]) => {
    const id = letterSelection.id
    // While editing, the range refers to the editor's (uncommitted) text.
    if (!id || inlineEdit.value?.id === id) return
    if (ids !== id || typeof text !== 'string' || letterSelection.end > text.length) clearLetterSelection()
  },
)

// Any document change invalidates the cached snap scene.
watch([objects, objectOrder, artboards, layers], () => (snapScene = null), { deep: true })

// Shape builder regions follow the selection and any document change (undo,
// agent edits) while the tool is armed.
watch(
  [selectedIds, objects, objectOrder],
  () => {
    if (store.activeTool === 'shapeBuilder' && !sb.dragging) prepareShapeBuilder()
    // After the renderer has applied the change (render runs in an earlier watch).
    if (store.activeTool === 'gradient') nextTick(drawGradientAnnotator)
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
  // The Pen works over the artwork: no transform box or handles in the way.
  renderer?.setSelectionChromeHidden(store.activeTool === 'pen')
  if (inlineEdit.value) commitInlineEdit()
  // Switching away mid-path keeps what was drawn (finishPen ignores < 2 anchors).
  if (penNodes) finishPen(false)
  if (renderer) {
    renderer.hideMarquee()
    renderer.hideShapePreview()
    renderer.hidePenPreview()
  }
  toolDrag = null
  penNodes = null
  penDraft = null
  endSnap()
  renderer?.setHoverObject(null)
  if (renderer) renderer.setNodeEditMode(store.activeTool === 'node')
  toolHint.value =
    store.activeTool === 'textPath'
      ? 'Type on a path: click any path to flow text along it.'
      : store.activeTool === 'gradient'
        ? 'Gradient: drag across a selected shape or text to set its direction · click to apply'
        : store.activeTool === 'eyedropper'
          ? 'Eyedropper: click a color to apply it to the selection · Shift: just the color under the cursor'
          : ''
  gradDrag = null
  drawGradientAnnotator()
  // Sets its own hint when the shape builder is armed.
  prepareShapeBuilder()
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
.canvas-stage.tool-pen,
.canvas-stage.tool-textPath,
.canvas-stage.tool-shapeBuilder,
.canvas-stage.tool-gradient {
  cursor: crosshair;
}
/* Type on a path, the pen and Direct Selection: a path is hittable anywhere
   inside its shape, not only on a thin stroke (locked objects keep their
   pointer-events="none"). */
.canvas-stage.tool-textPath :deep(path.canvas-object:not([pointer-events='none'])),
.canvas-stage.tool-pen :deep(path.canvas-object:not([pointer-events='none'])),
.canvas-stage.tool-node :deep(path.canvas-object:not([pointer-events='none'])) {
  pointer-events: all;
}
.tool-hint {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 25;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(33, 26, 67, 0.92);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}
/* Outline view: every object becomes a 1px unfilled wireframe. CSS beats the
   presentation attributes the renderer sets, so no object data changes. */
:deep(svg.outline-mode .canvas-object) {
  fill: none !important;
  stroke: #18181b !important;
  stroke-width: 1px !important;
  stroke-opacity: 1 !important;
  opacity: 1 !important;
  vector-effect: non-scaling-stroke;
}
:deep(svg.outline-mode image.canvas-object) {
  opacity: 0.25 !important;
  filter: grayscale(1);
}
.canvas-stage.tool-eyedropper,
.canvas-stage.picking-color,
.canvas-stage.picking-color :deep(.canvas-object) {
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M19.5 4.5a2.1 2.1 0 00-3 0l-2.3 2.3-1.1-1.1-1.4 1.4 1.1 1.1L5 16v3h3l7.8-7.8 1.1 1.1 1.4-1.4-1.1-1.1 2.3-2.3a2.1 2.1 0 000-3z' fill='white' stroke='%23211a43' stroke-width='1.4' stroke-linejoin='round'/%3E%3Cpath d='M5 19l-2 2' stroke='%23211a43' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") 2 22, crosshair;
}
.canvas-stage.tool-image {
  cursor: copy;
}
.inline-text-editor {
  position: absolute;
  z-index: 30;
  margin: 0;
  padding: 0;
  border: none;
  outline: none;
  /* Transparent: the text appears to be edited right on the canvas. */
  background: transparent;
  caret-color: #2563eb;
  resize: none;
  overflow: hidden;
  min-width: 4px;
  min-height: 1em;
  white-space: pre;
  box-sizing: content-box;
  font-kerning: normal;
}
.inline-text-editor::selection {
  background: rgba(37, 99, 235, 0.25);
}
/* The SVG text under the editor is hidden while it's being edited. */
:deep(.canvas-object.is-editing) {
  visibility: hidden;
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
