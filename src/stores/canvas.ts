// Canvas store — the single source of truth for the vector canvas.
// SVG.js renders/syncs from this; both human interactions and WebMCP tools
// mutate this state.
import { defineStore } from 'pinia'
import { rectPathData, rotatePoint, nodesToPathData, nodesBounds } from '@/services/canvas/svgEngine'
import type { Box, PathNode } from '@/services/canvas/svgEngine'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SEMANTIC_ROLES = [
  'logoSymbol',
  'wordmark',
  'headline',
  'bodyText',
  'background',
  'heroImage',
  'decorative',
  'none',
] as const
export type SemanticRole = (typeof SEMANTIC_ROLES)[number]

export const OBJECT_TYPES = ['path', 'text', 'image'] as const
export type ObjectType = (typeof OBJECT_TYPES)[number]

// User-facing canvas tools (the floating tool sidebar). 'select' is the idle
// default; the others arm a creation mode until the user switches back.
export const TOOL_IDS = ['select', 'node', 'text', 'pen', 'rect', 'ellipse', 'line', 'image'] as const
export type ToolId = (typeof TOOL_IDS)[number]

// A staged image chosen (uploaded or picked from Pexels) but not yet placed.
export interface PendingImage {
  href: string
  sourceUrl?: string
  alt?: string
  width?: number
  height?: number
  // Raw SVG markup when the staged item is an SVG. Lets the image tool convert
  // it to editable path objects on placement instead of embedding an image.
  svgMarkup?: string
}

// Intentionally small, polished typography set for the demo.
export const FONT_FAMILIES = [
  { label: 'Inter', value: 'Inter' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Courier', value: '"Courier New", monospace' },
] as const

export const FONT_WEIGHTS = [
  { label: 'Light', value: 300 },
  { label: 'Regular', value: 400 },
  { label: 'Medium', value: 500 },
  { label: 'Semibold', value: 600 },
  { label: 'Bold', value: 700 },
] as const

export const TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const
export type TextAlign = (typeof TEXT_ALIGNMENTS)[number]

export interface Artboard {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor: string
  objectIds: string[]
}

interface BaseObject {
  id: string
  type: ObjectType
  artboardId: string | null
  semanticRole: SemanticRole | string
  x: number
  y: number
  width: number
  height: number
  // Intrinsic (unscaled) dimensions the geometry was authored at. The renderer
  // derives a scale factor from width/height over these, so resizing never has
  // to rewrite path `d` or an image's intrinsic size. Defaults to width/height.
  baseWidth: number
  baseHeight: number
  rotation: number
  opacity: number
}

export interface PathObject extends BaseObject {
  type: 'path'
  d: string
  fill: string
  stroke: string
  strokeWidth: number
  // Editable Bézier anchors (local/base frame), the source of truth for
  // pen-drawn paths. When present, `d` is derived from these; the node-edit
  // tool reshapes the path by mutating them. Absent for shapes/imported paths.
  nodes?: PathNode[]
  // Whether the node path is closed (last anchor connects back to the first).
  closed?: boolean
  // For compound paths: the node count of each subpath, so one flat `nodes`
  // list serializes as multiple M...Z runs (e.g. a glyph with a hole). Absent
  // for simple single-subpath paths.
  subpaths?: number[]
  // Optional primitive discriminator for shapes drawn by the shape tool. Lets
  // the UI offer shape-specific controls (e.g. rectangle corner radius).
  shape?: 'rect' | 'ellipse' | 'line'
  // Rectangle corner radius, in the object's base coordinate space (scales with
  // the object). Only meaningful when shape === 'rect'.
  // ponytail: corners scale with the object's transform, so non-uniform resize
  // (width≠height ratio vs base) skews round corners into elliptical ones, same
  // as scaling a rounded rect in most vector tools. Upgrade path: regenerate d
  // from current width/height on resize instead of scaling d via transform.
  cornerRadius?: number
}

export interface TextObject extends BaseObject {
  type: 'text'
  text: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  fill: string
  align: TextAlign | string
}

export interface ImageObject extends BaseObject {
  type: 'image'
  href: string
  sourceUrl: string
  alt: string
}

export type CanvasObject = PathObject | TextObject | ImageObject

export interface ActivityStep {
  id: string
  label: string
  status: 'done' | 'running' | 'error'
  ts: number
}

export interface ActivityGroup {
  id: string
  kind: 'group'
  title: string
  status: 'done' | 'running' | 'error'
  steps: ActivityStep[]
  ts: number
}

interface HistoryEntry {
  label: string
  state: SerializedState
  ts: number
}

interface SerializedState {
  artboards: Artboard[]
  objects: Record<string, CanvasObject>
  objectOrder: string[]
  selectedIds: string[]
  selectedArtboardId: string | null
}

// Bump when the saved-document shape changes in a breaking way.
export const DOCUMENT_VERSION = 1

// The full, self-contained document written to / read from a .json file.
// Everything here is plain JSON — image data lives inline on objects (data:
// URLs for uploads, remote URLs for stock images), so a saved file reloads
// without any external dependencies beyond fonts and still-reachable URLs.
export interface CanvasDocument {
  version: number
  artboards: Artboard[]
  objects: Record<string, CanvasObject>
  objectOrder: string[]
  viewport: { x: number; y: number; zoom: number }
  idCounter: number
}

export interface CanvasState {
  artboards: Artboard[]
  objects: Record<string, CanvasObject>
  objectOrder: string[]
  selectedIds: string[]
  selectedArtboardId: string | null
  viewport: { x: number; y: number; zoom: number }
  history: HistoryEntry[]
  activityLog: ActivityGroup[]
  currentGroup: string | null
  activeTool: ToolId
  pendingImage: PendingImage | null
  _idCounter: number
}

// Payloads accept partial/loose input; actions fill defaults.
export type AddObjectPayload = Partial<CanvasObject> & {
  type?: ObjectType
  [key: string]: unknown
}
export type AddArtboardPayload = Partial<Omit<Artboard, 'objectIds'>>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(prefix: string, state: CanvasState): string {
  state._idCounter += 1
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${state._idCounter}_${rand}`
}

const OBJECT_DEFAULTS = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  baseWidth: 100,
  baseHeight: 100,
  rotation: 0,
  opacity: 1,
  semanticRole: 'none' as SemanticRole,
}

const TYPE_DEFAULTS: Record<ObjectType, Record<string, unknown>> = {
  path: { d: '', fill: '#000000', stroke: 'none', strokeWidth: 0 },
  text: {
    text: 'Text',
    fontFamily: 'Inter',
    fontSize: 24,
    fontWeight: 400,
    fill: '#211A43',
    align: 'left',
  },
  image: { href: '', sourceUrl: '', alt: '' },
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out as Partial<T>
}

// ---------------------------------------------------------------------------
// Geometry measurement hook
// ---------------------------------------------------------------------------
// The store holds nominal object dimensions, but for paths/text the actual
// rendered geometry can differ (seeded/imported paths default to 100×100 and
// their `d` may start off-origin). The renderer knows the true bbox, so it can
// register a measurement function here. `fitArtboardToArtwork` uses it when
// present and falls back to stored dims otherwise (e.g. in tests without a DOM).
// The box returned is absolute canvas-space bounds in the object's UN-rotated
// frame; rotation is applied by the caller about the box center.

export type ObjectBoxMeasurer = (obj: CanvasObject) => Box | null

let measureObjectBox: ObjectBoxMeasurer | null = null

export function setObjectBoxMeasurer(fn: ObjectBoxMeasurer | null): void {
  measureObjectBox = fn
}

// Viewport control lives in the renderer (it owns the SVG viewBox), not the
// store. The renderer host (CanvasStage) registers a controller here so that
// WebMCP tools — which only have the store — can drive the viewport. `fitBox`
// frames the given canvas-space box (with optional padding as a fraction of the
// box's larger side) into view. Absent in non-DOM/test environments.
export interface ViewportController {
  fitBox: (box: Box, opts?: { paddingRatio?: number }) => void
}

let viewportController: ViewportController | null = null

export function setViewportController(controller: ViewportController | null): void {
  viewportController = controller
}

export function getViewportController(): ViewportController | null {
  return viewportController
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCanvasStore = defineStore('canvas', {
  state: (): CanvasState => ({
    artboards: [],
    objects: {},
    objectOrder: [],
    selectedIds: [],
    selectedArtboardId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    history: [],
    activityLog: [],
    currentGroup: null,
    activeTool: 'select',
    pendingImage: null,
    _idCounter: 0,
  }),

  getters: {
    orderedObjects(state): CanvasObject[] {
      return state.objectOrder
        .map((id) => state.objects[id])
        .filter((o): o is CanvasObject => !!o)
    },
    selectedObjects(state): CanvasObject[] {
      return state.selectedIds
        .map((id) => state.objects[id])
        .filter((o): o is CanvasObject => !!o)
    },
    singleSelected(state): CanvasObject | null {
      if (state.selectedIds.length !== 1) return null
      const id = state.selectedIds[0]
      return (id && state.objects[id]) || null
    },
    hasSelection(state): boolean {
      return state.selectedIds.length > 0
    },
    selectedArtboard(state): Artboard | null {
      if (!state.selectedArtboardId) return null
      return state.artboards.find((a) => a.id === state.selectedArtboardId) || null
    },
  },

  actions: {
    // ---- Artboards ---------------------------------------------------------
    addArtboard(payload: AddArtboardPayload = {}): Artboard {
      const id = payload.id || makeId('ab', this)
      const artboard: Artboard = {
        id,
        name: payload.name || `Artboard ${this.artboards.length + 1}`,
        x: payload.x ?? 0,
        y: payload.y ?? 0,
        width: payload.width ?? 400,
        height: payload.height ?? 400,
        backgroundColor: payload.backgroundColor ?? '#FFFFFF',
        objectIds: [],
      }
      this.artboards.push(artboard)
      return artboard
    },

    getArtboard(id: string): Artboard | null {
      return this.artboards.find((a) => a.id === id) || null
    },

    updateArtboard(id: string, patch: Partial<Artboard> = {}): Artboard | null {
      const artboard = this.getArtboard(id)
      if (!artboard) return null
      const { id: _i, objectIds: _o, ...rest } = patch
      Object.assign(artboard, rest)
      return artboard
    },

    nextArtboardPosition(width = 400, height = 400, gap = 80): { x: number; y: number } {
      if (this.artboards.length === 0) return { x: 0, y: 0 }
      let maxRight = -Infinity
      let topY = Infinity
      for (const ab of this.artboards) {
        maxRight = Math.max(maxRight, ab.x + ab.width)
        topY = Math.min(topY, ab.y)
      }
      return { x: maxRight + gap, y: topY === Infinity ? 0 : topY }
    },

    addArtboardAuto(payload: AddArtboardPayload = {}): Artboard {
      const width = payload.width ?? 400
      const height = payload.height ?? 400
      const pos =
        payload.x != null && payload.y != null
          ? { x: payload.x, y: payload.y }
          : this.nextArtboardPosition(width, height)
      return this.addArtboard({ ...payload, width, height, x: pos.x, y: pos.y })
    },

    arrangeArtboards({ columns = 3, gap = 80 }: { columns?: number; gap?: number } = {}): void {
      if (this.artboards.length === 0) return
      let x = 0
      let y = 0
      let rowHeight = 0
      let col = 0
      for (const ab of this.artboards) {
        if (col === columns) {
          col = 0
          x = 0
          y += rowHeight + gap
          rowHeight = 0
        }
        ab.x = x
        ab.y = y
        x += ab.width + gap
        rowHeight = Math.max(rowHeight, ab.height)
        col += 1
      }
    },

    setArtboardBackground(id: string, backgroundColor: string): Artboard | null {
      return this.updateArtboard(id, { backgroundColor })
    },

    removeArtboard(id: string): boolean {
      const idx = this.artboards.findIndex((a) => a.id === id)
      if (idx === -1) return false
      const artboard = this.artboards[idx]
      if (!artboard) return false
      ;[...artboard.objectIds].forEach((objId) => this.removeObject(objId))
      this.artboards.splice(idx, 1)
      if (this.selectedArtboardId === id) this.selectedArtboardId = null
      return true
    },

    // Resize (and reposition) an artboard so it tightly wraps the artwork it
    // contains. Object x/y are stored relative to the artboard, so we compute
    // the artwork's axis-aligned bounds in that local space (accounting for each
    // object's rotation about its own center), then shrink/move the artboard to
    // match. Objects are offset by the inverse so they stay put in canvas space.
    // No-op (returns null) for an empty artboard. `padding` insets a uniform
    // margin of blank space around the artwork on all sides.
    fitArtboardToArtwork(id: string, { padding = 0 }: { padding?: number } = {}): Artboard | null {
      const artboard = this.getArtboard(id)
      if (!artboard) return null

      const objs = artboard.objectIds
        .map((oid) => this.objects[oid])
        .filter((o): o is CanvasObject => !!o)
      if (objs.length === 0) return null

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity

      for (const o of objs) {
        // Prefer the renderer's measured bounds (true rendered extent). Those
        // are absolute canvas-space; convert to artboard-local by removing the
        // artboard origin. Fall back to the object's stored local box.
        const measured = measureObjectBox ? measureObjectBox(o) : null
        const localX = measured ? measured.x - artboard.x : o.x || 0
        const localY = measured ? measured.y - artboard.y : o.y || 0
        const w = measured ? measured.width : o.width || 0
        const h = measured ? measured.height : o.height || 0

        const center = { x: localX + w / 2, y: localY + h / 2 }
        const rot = o.rotation || 0
        const corners = [
          { x: localX, y: localY },
          { x: localX + w, y: localY },
          { x: localX + w, y: localY + h },
          { x: localX, y: localY + h },
        ].map((p) => (rot ? rotatePoint(center, p, rot) : p))
        for (const p of corners) {
          minX = Math.min(minX, p.x)
          minY = Math.min(minY, p.y)
          maxX = Math.max(maxX, p.x)
          maxY = Math.max(maxY, p.y)
        }
      }

      const pad = Math.max(0, padding)
      const boxX = minX - pad
      const boxY = minY - pad
      const width = Math.max(1, maxX - minX + pad * 2)
      const height = Math.max(1, maxY - minY + pad * 2)

      // Move the artboard to the artwork's location and shift objects back by
      // the same amount so they don't visually move on the canvas.
      artboard.x += boxX
      artboard.y += boxY
      artboard.width = width
      artboard.height = height
      for (const o of objs) {
        o.x = (o.x || 0) - boxX
        o.y = (o.y || 0) - boxY
      }

      return artboard
    },

    // ---- Objects -----------------------------------------------------------
    addObject(payload: AddObjectPayload = {}): CanvasObject {
      const type: ObjectType = (payload.type as ObjectType) || 'path'
      if (!TYPE_DEFAULTS[type]) {
        throw new Error(`Unknown object type: ${type}`)
      }
      const id = payload.id || makeId(type, this)
      const artboardId =
        payload.artboardId || (this.artboards[0] && this.artboards[0].id) || null

      const { id: _pid, type: _pt, artboardId: _pab, ...rest } = stripUndefined(payload)
      const obj = {
        ...OBJECT_DEFAULTS,
        ...TYPE_DEFAULTS[type],
        ...rest,
        id,
        type,
        artboardId,
      } as CanvasObject

      // Base (intrinsic) dimensions anchor the resize scale. Unless the caller
      // supplied them, they equal the initial width/height so scale starts at 1.
      if (payload.baseWidth === undefined) obj.baseWidth = obj.width
      if (payload.baseHeight === undefined) obj.baseHeight = obj.height

      this.objects[id] = obj
      this.objectOrder.push(id)

      if (artboardId) {
        const artboard = this.getArtboard(artboardId)
        if (artboard && !artboard.objectIds.includes(id)) {
          artboard.objectIds.push(id)
        }
      }
      return obj
    },

    getObject(id: string): CanvasObject | null {
      return this.objects[id] || null
    },

    updateObject(id: string, patch: Record<string, unknown> = {}): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj) return null
      const { id: _i, type: _t, ...rest } = patch
      if (rest.artboardId !== undefined && rest.artboardId !== obj.artboardId) {
        this.assignToArtboard(id, rest.artboardId as string | null)
        delete rest.artboardId
      }
      Object.assign(obj, rest)
      return obj
    },

    removeObject(id: string): boolean {
      const obj = this.objects[id]
      if (!obj) return false
      if (obj.artboardId) {
        const artboard = this.getArtboard(obj.artboardId)
        if (artboard) {
          const i = artboard.objectIds.indexOf(id)
          if (i !== -1) artboard.objectIds.splice(i, 1)
        }
      }
      const oi = this.objectOrder.indexOf(id)
      if (oi !== -1) this.objectOrder.splice(oi, 1)
      const si = this.selectedIds.indexOf(id)
      if (si !== -1) this.selectedIds.splice(si, 1)
      delete this.objects[id]
      return true
    },

    duplicateObject(
      id: string,
      offset: { x: number; y: number } = { x: 20, y: 20 },
    ): CanvasObject | null {
      const src = this.objects[id]
      if (!src) return null
      const clone = JSON.parse(JSON.stringify(src)) as AddObjectPayload
      delete clone.id
      clone.x = (src.x || 0) + (offset.x || 0)
      clone.y = (src.y || 0) + (offset.y || 0)
      return this.addObject(clone)
    },

    moveObject(id: string, { x, y }: { x?: number; y?: number } = {}): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj) return null
      if (typeof x === 'number') obj.x = x
      if (typeof y === 'number') obj.y = y
      return obj
    },

    // ---- Layering (z-order) ------------------------------------------------
    // objectOrder is the single global paint order the renderer draws in, so
    // moving an id to the end brings it to front, to the start sends it back.
    bringToFront(id: string): boolean {
      const i = this.objectOrder.indexOf(id)
      if (i === -1) return false
      this.objectOrder.splice(i, 1)
      this.objectOrder.push(id)
      return true
    },
    sendToBack(id: string): boolean {
      const i = this.objectOrder.indexOf(id)
      if (i === -1) return false
      this.objectOrder.splice(i, 1)
      this.objectOrder.unshift(id)
      return true
    },

    assignToArtboard(id: string, artboardId: string | null): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj) return null
      if (obj.artboardId) {
        const prev = this.getArtboard(obj.artboardId)
        if (prev) {
          const i = prev.objectIds.indexOf(id)
          if (i !== -1) prev.objectIds.splice(i, 1)
        }
      }
      obj.artboardId = artboardId
      if (artboardId) {
        const next = this.getArtboard(artboardId)
        if (next && !next.objectIds.includes(id)) next.objectIds.push(id)
      }
      return obj
    },

    // Move an object to a different artboard while keeping it visually in place.
    // Object x/y are stored relative to their artboard, so switching artboards
    // must rebase them by the difference in artboard origins. No-op when the
    // target is the object's current artboard. Passing null detaches it to the
    // canvas (origin 0,0), converting its coordinates to absolute canvas space.
    reparentObject(id: string, artboardId: string | null): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj) return null
      if (obj.artboardId === artboardId) return obj

      const prev = obj.artboardId ? this.getArtboard(obj.artboardId) : null
      const next = artboardId ? this.getArtboard(artboardId) : null
      // Ignore a requested move to an artboard id that doesn't exist.
      if (artboardId && !next) return obj

      const prevX = prev ? prev.x : 0
      const prevY = prev ? prev.y : 0
      const nextX = next ? next.x : 0
      const nextY = next ? next.y : 0

      // absolute = artboardOrigin + local; keep absolute constant across move.
      obj.x = (obj.x || 0) + prevX - nextX
      obj.y = (obj.y || 0) + prevY - nextY

      this.assignToArtboard(id, artboardId)
      return obj
    },

    // Add an image object to an artboard.
    addImage(payload: Record<string, any> = {}): CanvasObject {
      const href = payload.href || payload.src || payload.thumb || ''
      return this.addObject({
        type: 'image',
        artboardId: payload.artboardId,
        x: payload.x ?? 0,
        y: payload.y ?? 0,
        width: payload.width ?? 300,
        height: payload.height ?? 200,
        href,
        sourceUrl: payload.sourceUrl || payload.url || payload.src || href,
        alt: payload.alt || '',
        semanticRole: payload.semanticRole || 'heroImage',
      })
    },

    positionImage(
      id: string,
      { x, y, width, height }: { x?: number; y?: number; width?: number; height?: number } = {},
    ): CanvasObject | null {
      const patch: Record<string, number> = {}
      if (typeof x === 'number') patch.x = x
      if (typeof y === 'number') patch.y = y
      if (typeof width === 'number') patch.width = width
      if (typeof height === 'number') patch.height = height
      return this.updateObject(id, patch)
    },

    // Resize any object: sets position and/or dimensions. Dimensions are the
    // displayed size; the renderer derives a scale from width/baseWidth so the
    // underlying geometry (path d / image intrinsic size) is never rewritten.
    resizeObject(
      id: string,
      { x, y, width, height }: { x?: number; y?: number; width?: number; height?: number } = {},
    ): CanvasObject | null {
      const patch: Record<string, number> = {}
      if (typeof x === 'number') patch.x = x
      if (typeof y === 'number') patch.y = y
      if (typeof width === 'number') patch.width = Math.max(1, width)
      if (typeof height === 'number') patch.height = Math.max(1, height)
      return this.updateObject(id, patch)
    },

    // Rotate an object to an absolute angle in degrees (normalized to 0..360).
    rotateObject(id: string, degrees: number): CanvasObject | null {
      const norm = ((degrees % 360) + 360) % 360
      return this.updateObject(id, { rotation: norm })
    },

    // ---- Style helpers -----------------------------------------------------
    setFill(id: string, fill: string): CanvasObject | null {
      return this.updateObject(id, { fill })
    },
    setStroke(
      id: string,
      { stroke, strokeWidth }: { stroke?: string; strokeWidth?: number } = {},
    ): CanvasObject | null {
      const patch: Record<string, unknown> = {}
      if (stroke !== undefined) patch.stroke = stroke
      if (strokeWidth !== undefined) patch.strokeWidth = strokeWidth
      return this.updateObject(id, patch)
    },
    setOpacity(id: string, opacity: number): CanvasObject | null {
      return this.updateObject(id, { opacity })
    },
    setPathData(id: string, d: string): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'path') return null
      obj.d = d
      return obj
    },

    // Replace a path's Bézier nodes (in the object's local/base frame) and
    // regenerate `d`. Keeps the object origin fixed (the node-edit tool works in
    // place); width/height/base are resynced from the node bounds so the
    // renderer's display->base scale stays 1:1 while editing. No-op for a
    // non-path or a path without a node model.
    updatePathNodes(id: string, nodes: PathNode[], subpaths?: number[]): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'path') return null
      const b = nodesBounds(nodes)
      obj.nodes = nodes
      // A node-edit drag moves anchors but not the subpath structure, so keep
      // the object's existing subpaths unless the caller passes a new layout.
      if (subpaths !== undefined) obj.subpaths = subpaths
      obj.d = nodesToPathData(nodes, !!obj.closed, obj.subpaths)
      // Bounds drive the selection box + resize scale; the node coords are kept
      // in the existing frame (may extend past the origin), so d stays aligned.
      obj.width = b.width
      obj.height = b.height
      obj.baseWidth = b.width
      obj.baseHeight = b.height
      return obj
    },

    // Set a rectangle's corner radius and regenerate its path data. Radius is in
    // the object's base coordinate space so it scales with the shape (matching
    // how the renderer scales all path geometry). No-op for non-rect paths.
    setCornerRadius(id: string, radius: number): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'path' || obj.shape !== 'rect') return null
      const r = Math.max(0, radius)
      obj.cornerRadius = r
      obj.d = rectPathData(obj.baseWidth, obj.baseHeight, r)
      return obj
    },

    // Center an object within its artboard.
    centerObjectInArtboard(
      id: string,
      {
        horizontal = true,
        vertical = false,
        objWidth,
        objHeight,
      }: { horizontal?: boolean; vertical?: boolean; objWidth?: number; objHeight?: number } = {},
    ): CanvasObject | null {
      const o = this.objects[id]
      if (!o) return null
      const ab = o.artboardId ? this.getArtboard(o.artboardId) : null
      if (!ab) return null
      const w = objWidth ?? o.width ?? 0
      const h = objHeight ?? o.height ?? 0
      if (horizontal) o.x = Math.round((ab.width - w) / 2)
      if (vertical) o.y = Math.round((ab.height - h) / 2)
      return o
    },

    // Duplicate every object of a role into a target artboard.
    copyRoleToArtboard(
      role: string,
      targetArtboardId: string,
      { recolorFill, sourceArtboardId }: { recolorFill?: string; sourceArtboardId?: string } = {},
    ): string[] {
      let sources = this.findByRole(role)
      if (sourceArtboardId) {
        sources = sources.filter((o) => o.artboardId === sourceArtboardId)
      }
      const newIds: string[] = []
      for (const src of sources) {
        const dup = this.duplicateObject(src.id, { x: 0, y: 0 })
        if (!dup) continue
        this.assignToArtboard(dup.id, targetArtboardId)
        if (recolorFill && dup.type !== 'image') this.setFill(dup.id, recolorFill)
        newIds.push(dup.id)
      }
      return newIds
    },

    // ---- Semantic role querying -------------------------------------------
    findByRole(role: string): CanvasObject[] {
      return this.objectOrder
        .map((id) => this.objects[id])
        .filter((o): o is CanvasObject => !!o && o.semanticRole === role)
    },

    // ---- Selection ---------------------------------------------------------
    selectObjects(ids: string[] | string = []): string[] {
      const arr = Array.isArray(ids) ? ids : [ids]
      this.selectedIds = arr.filter((id) => !!this.objects[id])
      // Object and artboard selection are mutually exclusive.
      if (this.selectedIds.length) this.selectedArtboardId = null
      return this.selectedIds
    },
    selectArtboard(id: string | null): string | null {
      if (id && this.getArtboard(id)) {
        this.selectedArtboardId = id
        // Selecting an artboard clears any object selection.
        this.selectedIds = []
      } else {
        this.selectedArtboardId = null
      }
      return this.selectedArtboardId
    },
    clearSelection(): void {
      this.selectedIds = []
      this.selectedArtboardId = null
    },

    // ---- Tool state (floating tool sidebar) --------------------------------
    setActiveTool(tool: ToolId): ToolId {
      this.activeTool = TOOL_IDS.includes(tool) ? tool : 'select'
      // Leaving the image tool discards any staged image so it can't leak into
      // a later placement with a different tool.
      if (this.activeTool !== 'image') this.pendingImage = null
      return this.activeTool
    },
    setPendingImage(payload: PendingImage | null): PendingImage | null {
      this.pendingImage = payload && payload.href ? { ...payload } : null
      return this.pendingImage
    },
    resetToolState(): void {
      this.activeTool = 'select'
      this.pendingImage = null
    },

    // ---- Snapshot / Undo ---------------------------------------------------
    _captureState(): SerializedState {
      return {
        artboards: JSON.parse(JSON.stringify(this.artboards)),
        objects: JSON.parse(JSON.stringify(this.objects)),
        objectOrder: [...this.objectOrder],
        selectedIds: [...this.selectedIds],
        selectedArtboardId: this.selectedArtboardId,
      }
    },

    snapshot(label = 'Edit'): void {
      this.history.push({ label, state: this._captureState(), ts: Date.now() })
      if (this.history.length > 50) this.history.shift()
    },

    beginGroup(label = 'Agent changes'): string {
      this.snapshot(label)
      return label
    },

    undo(): string | null {
      const entry = this.history.pop()
      if (!entry) return null
      this._restoreState(entry.state)
      return entry.label
    },

    _restoreState(state: SerializedState): void {
      this.artboards = JSON.parse(JSON.stringify(state.artboards))
      this.objects = JSON.parse(JSON.stringify(state.objects))
      this.objectOrder = [...state.objectOrder]
      this.selectedIds = (state.selectedIds || []).filter((id) => !!this.objects[id])
      const abId = state.selectedArtboardId || null
      this.selectedArtboardId = abId && this.getArtboard(abId) ? abId : null
    },

    canUndo(): boolean {
      return this.history.length > 0
    },

    // ---- Document save / load ----------------------------------------------
    // Serialize the full persistable document: the artwork (artboards, objects,
    // order) plus viewport and the id counter so ids stay unique after a load.
    // Excludes transient/session state (history, activity log, active tool,
    // pending image, selection) — those don't belong in a saved file.
    serializeDocument(): CanvasDocument {
      return {
        version: DOCUMENT_VERSION,
        artboards: JSON.parse(JSON.stringify(this.artboards)),
        objects: JSON.parse(JSON.stringify(this.objects)),
        objectOrder: [...this.objectOrder],
        viewport: { ...this.viewport },
        idCounter: this._idCounter,
      }
    },

    // Replace the current document with a loaded one. Validates defensively
    // since file input is untrusted: keeps only objects present in the map,
    // drops dangling order/objectIds refs, and clamps the id counter so new
    // ids never collide with restored ones. Clears undo history and selection.
    loadDocument(doc: CanvasDocument): void {
      if (!doc || typeof doc !== 'object') {
        throw new Error('Invalid document: expected an object.')
      }
      if (doc.version !== DOCUMENT_VERSION) {
        throw new Error(
          `Unsupported document version ${String(doc.version)} (expected ${DOCUMENT_VERSION}).`,
        )
      }

      const objects: Record<string, CanvasObject> = JSON.parse(
        JSON.stringify(doc.objects || {}),
      )
      const validObjectId = (id: string) => !!objects[id]

      const artboards: Artboard[] = (
        JSON.parse(JSON.stringify(doc.artboards || [])) as Artboard[]
      ).map((ab) => ({
        ...ab,
        objectIds: (ab.objectIds || []).filter(validObjectId),
      }))

      // Global paint order: keep only known ids, then append any object that
      // was left out of the saved order so nothing silently disappears.
      const order = (doc.objectOrder || []).filter(validObjectId)
      for (const id of Object.keys(objects)) {
        if (!order.includes(id)) order.push(id)
      }

      // Repair each object's artboardId to a still-existing artboard.
      const artboardIds = new Set(artboards.map((a) => a.id))
      for (const obj of Object.values(objects)) {
        if (obj.artboardId && !artboardIds.has(obj.artboardId)) {
          obj.artboardId = null
        }
      }

      this.artboards = artboards
      this.objects = objects
      this.objectOrder = order
      this.selectedIds = []
      this.selectedArtboardId = null

      const vp = doc.viewport
      this.viewport =
        vp && typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.zoom === 'number'
          ? { x: vp.x, y: vp.y, zoom: vp.zoom }
          : { x: 0, y: 0, zoom: 1 }

      // Ensure future ids never collide with restored ones.
      const restoredCounter = typeof doc.idCounter === 'number' ? doc.idCounter : 0
      this._idCounter = Math.max(restoredCounter, this._idCounter)

      // A load is a fresh document — undo history and tool state don't carry over.
      this.history = []
      this.resetToolState()
    },

    // ---- Agent activity log ------------------------------------------------
    beginActivityGroup(title = 'Agent request'): string {
      const gid = makeId('grp', this)
      this.currentGroup = gid
      this.activityLog.push({
        id: gid,
        kind: 'group',
        title,
        status: 'running',
        steps: [],
        ts: Date.now(),
      })
      return gid
    },

    logStep(
      label: string,
      { status = 'done', groupId = null }: { status?: ActivityStep['status']; groupId?: string | null } = {},
    ): ActivityStep {
      const gid = groupId || this.currentGroup
      let group = gid ? this.activityLog.find((g) => g.id === gid) : null
      if (!group) {
        const id = this.beginActivityGroup('Activity')
        group = this.activityLog.find((g) => g.id === id) || null
      }
      const step: ActivityStep = { id: makeId('step', this), label, status, ts: Date.now() }
      if (group) group.steps.push(step)
      return step
    },

    endActivityGroup(
      { status = 'done', groupId = null }: { status?: ActivityGroup['status']; groupId?: string | null } = {},
    ): ActivityGroup | null {
      const gid = groupId || this.currentGroup
      const group = gid ? this.activityLog.find((g) => g.id === gid) : null
      if (group) group.status = status
      if (!groupId || groupId === this.currentGroup) this.currentGroup = null
      return group || null
    },

    clearActivityLog(): void {
      this.activityLog = []
      this.currentGroup = null
    },
  },
})

export type CanvasStore = ReturnType<typeof useCanvasStore>
