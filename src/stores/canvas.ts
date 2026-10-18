// Canvas store — the single source of truth for the vector canvas.
// SVG.js renders/syncs from this; both human interactions and WebMCP tools
// mutate this state.
import { defineStore } from 'pinia'
import { rectPathData, rotatePoint, nodesToPathData, nodesBounds, roundedPathData } from '@/services/canvas/svgEngine'
import type { Box, PathNode } from '@/services/canvas/svgEngine'
import type { GradientFill } from '@/services/canvas/gradient'
import { isNonePaint } from '@/services/canvas/color'
import { clearCharStyles, normalizeCharStyles, remapCharStyles, setCharStyle, type CharStyle, type CharStyles } from '@/services/canvas/textStyle'
import { flattenSubpaths, parsePathData } from '@/services/canvas/svgToPaths'

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
// 'textPath' types along an existing path; 'shapeBuilder' merges/deletes the
// overlapping regions of the selected paths; 'gradient' drags out the
// direction of a selected object's gradient fill.
export const TOOL_IDS = [
  'select',
  'node',
  'text',
  'textPath',
  'pen',
  'rect',
  'ellipse',
  'line',
  'image',
  'shapeBuilder',
  'gradient',
  'eyedropper',
] as const
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

// Preview paints objects normally; outline draws every object as a thin
// unfilled wireframe (Illustrator's Outline view) to inspect construction.
export const ALIGN_EDGES = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'] as const
export type AlignEdge = (typeof ALIGN_EDGES)[number]

export const VIEW_MODES = ['preview', 'outline'] as const
export type ViewMode = (typeof VIEW_MODES)[number]

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
  // Mirrored on the object's own horizontal/vertical axis (text and images;
  // reflecting a path rewrites its geometry instead).
  flipX?: boolean
  flipY?: boolean
  // The layer the object lives in (see Layer) and the innermost group it
  // belongs to, if any (see Group).
  layerId?: string
  groupId?: string
  // Layers panel state. `name` overrides the auto label; hidden objects aren't
  // drawn or exported; locked objects can't be picked on the canvas.
  name?: string
  hidden?: boolean
  locked?: boolean
}

export const STROKE_CAPS = ['butt', 'round', 'square'] as const
export type StrokeCap = (typeof STROKE_CAPS)[number]
export const STROKE_JOINS = ['miter', 'round', 'bevel'] as const
export type StrokeJoin = (typeof STROKE_JOINS)[number]

export interface PathObject extends BaseObject {
  type: 'path'
  d: string
  fill: string
  // When set, overrides `fill` with a linear/radial gradient.
  fillGradient?: GradientFill
  stroke: string
  strokeWidth: number
  // How open ends and corners of the stroke are drawn (Illustrator's Cap and
  // Corner). Absent means SVG's defaults: butt caps, miter joins.
  strokeLinecap?: StrokeCap
  strokeLinejoin?: StrokeJoin
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
  // Live corner radius, in the object's base coordinate space (scales with the
  // object). A rectangle regenerates its rounded outline from it; a node path
  // rounds every sharp corner of `nodes` into `d` (the nodes stay sharp).
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
  fillGradient?: GradientFill
  align: TextAlign | string
  // Area type (Illustrator's text box): text wraps inside width × height and
  // resizing the box re-flows it without scaling the font. Point type (the
  // default) is unwrapped and scales its font when resized.
  area?: boolean
  // Line spacing as a multiple of the font size (default 1.2).
  lineHeight?: number
  // Letter spacing in 1/1000 em (Illustrator's tracking).
  tracking?: number
  // Per-letter overrides (color, letter spacing), one entry per character;
  // see textStyle.ts. Kept aligned with `text` as it's edited.
  charStyles?: CharStyles
  // Text on a path: when set, glyphs flow along this path (in the text's local
  // frame) instead of a straight baseline. `pathOffset` is the start offset
  // along the path in percent (0..100).
  pathD?: string
  pathOffset?: number
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

// A document layer, as in Illustrator: a named container for artwork. Layers
// stack bottom (index 0) to top; everything in a higher layer paints above
// everything in a lower one. New artwork goes into the active layer. A hidden
// or locked layer hides or locks everything in it.
export interface Layer {
  id: string
  name: string
  color: string
  hidden?: boolean
  locked?: boolean
}

// A group: objects that select, move and transform as one. Groups nest: an
// object's groupId is its innermost group, and a group's parentId the group
// that contains it. Members of a group are contiguous in paint order and share
// a layer.
export interface Group {
  id: string
  name?: string
  parentId?: string
}

// Selection-box colors Illustrator cycles through for new layers.
const LAYER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#65a30d']

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
  layers: Layer[]
  groups: Record<string, Group>
  activeLayerId: string | null
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
  // Absent in documents saved before layers and groups existed.
  layers?: Layer[]
  groups?: Record<string, Group>
  viewport: { x: number; y: number; zoom: number }
  idCounter: number
}

export interface CanvasState {
  artboards: Artboard[]
  objects: Record<string, CanvasObject>
  objectOrder: string[]
  layers: Layer[]
  groups: Record<string, Group>
  activeLayerId: string | null
  selectedIds: string[]
  selectedArtboardId: string | null
  viewport: { x: number; y: number; zoom: number }
  history: HistoryEntry[]
  activityLog: ActivityGroup[]
  currentGroup: string | null
  activeTool: ToolId
  pendingImage: PendingImage | null
  viewMode: ViewMode
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
  // Canvas units per screen pixel at the current zoom.
  unitsPerPixel?: () => number
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
    layers: [],
    groups: {},
    activeLayerId: null,
    selectedIds: [],
    selectedArtboardId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    history: [],
    activityLog: [],
    currentGroup: null,
    activeTool: 'select',
    pendingImage: null,
    viewMode: 'preview',
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

      // New artwork goes into the active layer (or the one asked for).
      obj.layerId = obj.layerId && this.getLayer(obj.layerId) ? obj.layerId : this.ensureActiveLayer().id
      if (obj.groupId && !this.groups[obj.groupId]) delete obj.groupId

      this.objects[id] = obj
      this.objectOrder.push(id)
      this._sortByLayers()

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
      // Editing the text keeps each letter's own style on that letter.
      if (obj.type === 'text' && typeof rest.text === 'string' && rest.charStyles === undefined && obj.charStyles) {
        rest.charStyles = remapCharStyles(obj.text || '', rest.text, obj.charStyles)
      }
      Object.assign(obj, rest)
      return obj
    },

    // Style letters [start, end) of a text object: color and/or letter
    // spacing (1/1000 em) of just those letters.
    setLetterStyle(id: string, start: number, end: number, patch: CharStyle): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'text' || end <= start) return null
      obj.charStyles = setCharStyle(obj.charStyles, (obj.text || '').length, start, end, patch)
      return obj
    },
    // Remove letter styles from [start, end), or from every letter.
    clearLetterStyles(id: string, start?: number, end?: number): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'text') return null
      obj.charStyles = clearCharStyles(obj.charStyles, (obj.text || '').length, start, end)
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
      const gid = obj.groupId
      delete this.objects[id]
      if (gid) this._pruneGroups()
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
      this._sortByLayers()
      return true
    },
    sendToBack(id: string): boolean {
      const i = this.objectOrder.indexOf(id)
      if (i === -1) return false
      this.objectOrder.splice(i, 1)
      this.objectOrder.unshift(id)
      this._sortByLayers()
      return true
    },
    // Move an object to an exact paint-order index (0 = backmost), clamped.
    reorderObject(id: string, index: number): boolean {
      const i = this.objectOrder.indexOf(id)
      if (i === -1) return false
      this.objectOrder.splice(i, 1)
      const to = Math.max(0, Math.min(this.objectOrder.length, Math.round(index)))
      this.objectOrder.splice(to, 0, id)
      this._sortByLayers()
      return true
    },
    // Step one place up (toward the front) or down in paint order.
    shiftObject(id: string, delta: 1 | -1): boolean {
      const i = this.objectOrder.indexOf(id)
      if (i === -1) return false
      return this.reorderObject(id, i + delta)
    },

    // An object's canvas-space box in its un-rotated frame (the renderer's
    // measured box when available). Its center is the object's rotation pivot.
    objectUnrotatedBox(id: string): Box | null {
      const o = this.objects[id]
      if (!o) return null
      const ab = o.artboardId ? this.getArtboard(o.artboardId) : null
      const measured = measureObjectBox ? measureObjectBox(o) : null
      return (
        measured ?? {
          x: (ab?.x ?? 0) + (o.x || 0),
          y: (ab?.y ?? 0) + (o.y || 0),
          width: o.width || 0,
          height: o.height || 0,
        }
      )
    },

    // Absolute (canvas-space) axis-aligned bounds of an object as drawn: the
    // renderer's measured box when available, expanded for rotation.
    objectCanvasBounds(id: string): Box | null {
      const o = this.objects[id]
      if (!o) return null
      const box = this.objectUnrotatedBox(id)
      if (!box) return null
      if (!o.rotation) return box
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      const pts = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
      ].map((p) => rotatePoint(center, p, o.rotation))
      const xs = pts.map((p) => p.x)
      const ys = pts.map((p) => p.y)
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
    },

    // Align objects' visible bounds to an edge/center of either the union of
    // the objects (selection) or each object's own artboard. A single object
    // always aligns to its artboard (Illustrator's "Align to Artboard").
    alignObjects(ids: string[], edge: AlignEdge, to: 'selection' | 'artboard' = 'selection'): string[] {
      const items = ids
        .map((id) => ({ id, b: this.objectCanvasBounds(id) }))
        .filter((i): i is { id: string; b: Box } => !!i.b)
      if (!items.length) return []
      const useArtboard = to === 'artboard' || items.length === 1
      let union: Box | null = null
      if (!useArtboard) {
        const minX = Math.min(...items.map((i) => i.b.x))
        const minY = Math.min(...items.map((i) => i.b.y))
        const maxX = Math.max(...items.map((i) => i.b.x + i.b.width))
        const maxY = Math.max(...items.map((i) => i.b.y + i.b.height))
        union = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      }
      const moved: string[] = []
      for (const { id, b } of items) {
        const o = this.objects[id]!
        const ab = o.artboardId ? this.getArtboard(o.artboardId) : null
        const t = union ?? (ab ? { x: ab.x, y: ab.y, width: ab.width, height: ab.height } : null)
        if (!t) continue
        let dx = 0
        let dy = 0
        if (edge === 'left') dx = t.x - b.x
        if (edge === 'hcenter') dx = t.x + t.width / 2 - (b.x + b.width / 2)
        if (edge === 'right') dx = t.x + t.width - (b.x + b.width)
        if (edge === 'top') dy = t.y - b.y
        if (edge === 'vcenter') dy = t.y + t.height / 2 - (b.y + b.height / 2)
        if (edge === 'bottom') dy = t.y + t.height - (b.y + b.height)
        if (!dx && !dy) continue
        o.x = (o.x || 0) + dx
        o.y = (o.y || 0) + dy
        moved.push(id)
      }
      return moved
    },

    // ---- Layer state (layers panel) ----------------------------------------
    // Hiding or locking an object also drops it from the selection, since it
    // can no longer be seen/picked on the canvas.
    setObjectHidden(id: string, hidden: boolean): CanvasObject | null {
      const obj = this.updateObject(id, { hidden })
      if (obj && hidden) this.selectedIds = this.selectedIds.filter((s) => s !== id)
      return obj
    },
    setObjectLocked(id: string, locked: boolean): CanvasObject | null {
      const obj = this.updateObject(id, { locked })
      if (obj && locked) this.selectedIds = this.selectedIds.filter((s) => s !== id)
      return obj
    },
    renameObject(id: string, name: string): CanvasObject | null {
      const trimmed = name.trim()
      return this.updateObject(id, { name: trimmed || undefined })
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
    // A solid fill replaces any gradient (as picking a color does in Illustrator).
    // On text it recolors every letter, replacing letter colors.
    setFill(id: string, fill: string): CanvasObject | null {
      this._dropLetterKey(id, 'fill')
      return this.updateObject(id, { fill, fillGradient: undefined })
    },
    // Letter spacing of a whole text object (1/1000 em), replacing the
    // spacing of individual letters.
    setTracking(id: string, tracking: number): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'text') return null
      this._dropLetterKey(id, 'tracking')
      obj.tracking = Math.round(tracking) || undefined
      return obj
    },
    _dropLetterKey(id: string, key: keyof CharStyle): void {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'text' || !obj.charStyles) return
      const next = obj.charStyles.map((st) => {
        if (!st || st[key] === undefined) return st
        const { [key]: _drop, ...rest } = st
        return rest
      })
      obj.charStyles = normalizeCharStyles(next, (obj.text || '').length)
    },
    // Set (or clear, with null) an object's gradient fill. Images have none.
    setFillGradient(id: string, gradient: GradientFill | null): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type === 'image') return null
      return this.updateObject(id, { fillGradient: gradient ? JSON.parse(JSON.stringify(gradient)) : undefined })
    },
    setStroke(
      id: string,
      {
        stroke,
        strokeWidth,
        cap,
        join,
      }: { stroke?: string; strokeWidth?: number; cap?: StrokeCap; join?: StrokeJoin } = {},
    ): CanvasObject | null {
      const patch: Record<string, unknown> = {}
      if (stroke !== undefined) patch.stroke = stroke
      if (strokeWidth !== undefined) patch.strokeWidth = strokeWidth
      if (cap !== undefined && STROKE_CAPS.includes(cap)) patch.strokeLinecap = cap
      if (join !== undefined && STROKE_JOINS.includes(join)) patch.strokeLinejoin = join
      return this.updateObject(id, patch)
    },
    // Step the font size of text objects (Illustrator's ⇧⌘> / ⇧⌘<). Point
    // type keeps its box proportional; area type keeps its box.
    bumpFontSize(ids: string[], delta: number): string[] {
      const changed: string[] = []
      for (const id of ids) {
        const o = this.objects[id]
        if (!o || o.type !== 'text') continue
        const prev = o.fontSize || 24
        const next = Math.max(1, Math.min(1296, Math.round(prev + delta)))
        if (next === prev) continue
        o.fontSize = next
        if (!o.area && !o.pathD) {
          o.width = (o.width || 0) * (next / prev)
          o.height = (o.height || 0) * (next / prev)
        }
        changed.push(id)
      }
      return changed
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
      // Keep the object's current display scale: node coords are in the base
      // frame, so a resized path must stay resized after its nodes change.
      const sx = obj.baseWidth ? obj.width / obj.baseWidth : 1
      const sy = obj.baseHeight ? obj.height / obj.baseHeight : 1
      obj.nodes = nodes
      // A node-edit drag moves anchors but not the subpath structure, so keep
      // the object's existing subpaths unless the caller passes a new layout.
      if (subpaths !== undefined) obj.subpaths = subpaths
      obj.d = roundedPathData(nodes, !!obj.closed, obj.subpaths, obj.cornerRadius)
      // Bounds drive the selection box + resize scale; the node coords are kept
      // in the existing frame (may extend past the origin), so d stays aligned.
      obj.width = b.width * sx
      obj.height = b.height * sy
      obj.baseWidth = b.width
      obj.baseHeight = b.height
      return obj
    },

    // Give a path an editable node model when it only has path data (shapes,
    // boolean results without nodes, hand-written `d`). The geometry is
    // unchanged; a shape stops being a live rectangle/ellipse primitive.
    ensurePathNodes(id: string): CanvasObject | null {
      const obj = this.objects[id]
      if (!obj || obj.type !== 'path') return null
      if (obj.nodes?.length) return obj
      if (obj.shape === 'rect') {
        // A rectangle becomes its four sharp corners; its radius carries on as
        // live corners, so the outline is unchanged.
        const w = obj.baseWidth
        const h = obj.baseHeight
        obj.nodes = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
        obj.subpaths = undefined
        obj.closed = true
        obj.d = roundedPathData(obj.nodes, true, undefined, obj.cornerRadius)
        delete obj.shape
        return obj
      }
      const { nodes, subpaths, closed } = flattenSubpaths(parsePathData(obj.d || ''))
      if (nodes.length < 2) return null
      obj.nodes = nodes
      obj.subpaths = subpaths.length > 1 ? subpaths : undefined
      obj.closed = closed
      obj.d = nodesToPathData(nodes, closed, obj.subpaths)
      delete obj.shape
      delete obj.cornerRadius
      return obj
    },

    // Delete anchors (Direct Selection + Delete). Neighbors are joined so the
    // path stays continuous; a subpath left with fewer than two anchors is
    // dropped, and a path with nothing left is deleted (returns null).
    deletePathNodes(id: string, indices: number[]): CanvasObject | null {
      const obj = this.ensurePathNodes(id)
      if (!obj || obj.type !== 'path' || !obj.nodes) return obj
      const drop = new Set(indices)
      const counts = obj.subpaths?.length ? obj.subpaths : [obj.nodes.length]
      const nodes: PathNode[] = []
      const nextCounts: number[] = []
      let i = 0
      for (const count of counts) {
        const kept = obj.nodes.slice(i, i + count).filter((_, k) => !drop.has(i + k))
        i += count
        if (kept.length >= 2) {
          nodes.push(...kept)
          nextCounts.push(kept.length)
        }
      }
      if (nodes.length < 2) {
        this.removeObject(id)
        return null
      }
      if (nextCounts.length > 1) return this.updatePathNodes(id, nodes, nextCounts)
      obj.subpaths = undefined
      return this.updatePathNodes(id, nodes)
    },

    // Set a path's live corner radius and regenerate its path data. Radius is
    // in the object's base coordinate space so it scales with the shape
    // (matching how the renderer scales all path geometry). A rectangle stays a
    // live rectangle; any other path gets a node model whose sharp corners are
    // rounded (smooth anchors are left as they are).
    setCornerRadius(id: string, radius: number): CanvasObject | null {
      const r = Math.max(0, radius)
      const cur = this.objects[id]
      if (!cur || cur.type !== 'path') return null
      if (cur.shape === 'rect') {
        cur.cornerRadius = r
        cur.d = rectPathData(cur.baseWidth, cur.baseHeight, r)
        return cur
      }
      const obj = this.ensurePathNodes(id)
      if (!obj || obj.type !== 'path' || !obj.nodes) return null
      // One radius for every corner: drop per-anchor overrides.
      if (obj.nodes.some((n) => n.radius !== undefined)) {
        obj.nodes = obj.nodes.map(({ radius: _r, ...n }) => n)
      }
      obj.cornerRadius = r || undefined
      obj.d = roundedPathData(obj.nodes, !!obj.closed, obj.subpaths, r)
      return obj
    },

    // Round only the given corner anchors (Direct Selection + corner widget).
    // Works on any path; a rectangle becomes a node path with live corners.
    setNodeCornerRadius(id: string, indices: number[], radius: number): CanvasObject | null {
      const obj = this.ensurePathNodes(id)
      if (!obj || obj.type !== 'path' || !obj.nodes) return null
      const r = Math.max(0, radius)
      const pick = new Set(indices)
      obj.nodes = obj.nodes.map((n, i) => (pick.has(i) ? { ...n, radius: r } : n))
      obj.d = roundedPathData(obj.nodes, !!obj.closed, obj.subpaths, obj.cornerRadius)
      return obj
    },

    // Swap fill and stroke colors (Illustrator's Shift+X; X here). A gradient
    // fill hands its first stop to the stroke. A stroke that becomes visible
    // gets a 1pt width if it had none. Text and images have no stroke.
    swapFillStroke(ids: string[]): void {
      for (const id of ids) {
        const obj = this.objects[id]
        if (!obj || obj.type !== 'path') continue
        const fill = obj.fillGradient ? obj.fillGradient.stops[0]?.color ?? 'none' : obj.fill
        const stroke = obj.stroke || 'none'
        obj.fill = stroke
        obj.fillGradient = undefined
        obj.stroke = fill || 'none'
        if (!isNonePaint(obj.stroke) && !(obj.strokeWidth > 0)) obj.strokeWidth = 1
      }
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

    // ---- Layers ------------------------------------------------------------
    getLayer(id: string | null | undefined): Layer | null {
      return (id && this.layers.find((l) => l.id === id)) || null
    },
    // The layer an object lives in (its own, else the bottom layer).
    layerOf(o: CanvasObject): Layer | null {
      return this.getLayer(o.layerId) ?? this.layers[0] ?? null
    },
    // Hidden or locked, itself or through its layer.
    isHidden(o: CanvasObject): boolean {
      return !!o.hidden || !!this.layerOf(o)?.hidden
    },
    isLocked(o: CanvasObject): boolean {
      return !!o.locked || !!this.layerOf(o)?.locked
    },
    // The active layer, creating "Layer 1" for an empty document.
    ensureActiveLayer(): Layer {
      const active = this.getLayer(this.activeLayerId)
      if (active) return active
      const top = this.layers[this.layers.length - 1]
      if (top) {
        this.activeLayerId = top.id
        return top
      }
      return this.addLayer()
    },
    // Add a layer above the active one (or on top) and make it active.
    addLayer(name?: string): Layer {
      const id = makeId('layer', this)
      const n = this.layers.length
      const layer: Layer = { id, name: name?.trim() || `Layer ${n + 1}`, color: LAYER_COLORS[n % LAYER_COLORS.length]! }
      const ai = this.layers.findIndex((l) => l.id === this.activeLayerId)
      this.layers.splice(ai === -1 ? n : ai + 1, 0, layer)
      this.activeLayerId = id
      return layer
    },
    setActiveLayer(id: string): Layer | null {
      const layer = this.getLayer(id)
      if (layer) this.activeLayerId = id
      return layer
    },
    renameLayer(id: string, name: string): Layer | null {
      const layer = this.getLayer(id)
      if (layer && name.trim()) layer.name = name.trim()
      return layer
    },
    setLayerHidden(id: string, hidden: boolean): void {
      const layer = this.getLayer(id)
      if (!layer) return
      layer.hidden = hidden || undefined
      this.selectedIds = this.selectedIds.filter((oid) => !this.isHidden(this.objects[oid]!))
    },
    setLayerLocked(id: string, locked: boolean): void {
      const layer = this.getLayer(id)
      if (!layer) return
      layer.locked = locked || undefined
      this.selectedIds = this.selectedIds.filter((oid) => !this.isLocked(this.objects[oid]!))
    },
    // Move a layer to a stack position (0 = bottom).
    moveLayer(id: string, index: number): void {
      const i = this.layers.findIndex((l) => l.id === id)
      if (i === -1) return
      const [layer] = this.layers.splice(i, 1)
      this.layers.splice(Math.max(0, Math.min(this.layers.length, index)), 0, layer!)
      this._sortByLayers()
    },
    // Delete a layer and the artwork in it. The last layer can't go.
    removeLayer(id: string): boolean {
      if (this.layers.length <= 1 || !this.getLayer(id)) return false
      for (const o of Object.values(this.objects)) if (this.layerOf(o)?.id === id) this.removeObject(o.id)
      this.layers = this.layers.filter((l) => l.id !== id)
      if (this.activeLayerId === id) this.activeLayerId = this.layers[this.layers.length - 1]!.id
      return true
    },
    // Move objects (whole groups) to the top of a layer, keeping their
    // stacking among themselves.
    moveObjectsToLayer(ids: string[], layerId: string): void {
      if (!this.getLayer(layerId)) return
      const moving = this.expandToGroups(ids)
      for (const oid of moving) this.objects[oid]!.layerId = layerId
      this.objectOrder = [...this.objectOrder.filter((oid) => !moving.includes(oid)), ...moving]
      this._sortByLayers()
    },
    // Keep paint order grouped by layer (stable within each layer).
    _sortByLayers(): void {
      if (this.layers.length < 2) return
      const rank = new Map(this.layers.map((l, i) => [l.id, i]))
      const pos = new Map(this.objectOrder.map((oid, i) => [oid, i]))
      const r = (oid: string) => rank.get(this.objects[oid]?.layerId ?? '') ?? 0
      this.objectOrder.sort((a, b) => r(a) - r(b) || pos.get(a)! - pos.get(b)!)
    },
    // Objects with their layer's visibility and lock applied, as the renderer
    // and exporters should see them (a deep copy).
    renderObjects(): Record<string, CanvasObject> {
      const out: Record<string, CanvasObject> = JSON.parse(JSON.stringify(this.objects))
      for (const o of Object.values(out)) {
        const layer = this.layerOf(o)
        if (layer?.hidden) o.hidden = true
        if (layer?.locked) o.locked = true
      }
      return out
    },

    // ---- Groups ------------------------------------------------------------
    // The outermost group an object belongs to, or null.
    topGroupOf(id: string): string | null {
      let gid = this.objects[id]?.groupId
      if (!gid || !this.groups[gid]) return null
      const seen = new Set<string>()
      while (this.groups[gid]?.parentId && this.groups[this.groups[gid]!.parentId!] && !seen.has(gid)) {
        seen.add(gid)
        gid = this.groups[gid]!.parentId!
      }
      return gid
    },
    // Whether an object is inside a group (at any depth).
    inGroup(id: string, groupId: string): boolean {
      let gid = this.objects[id]?.groupId
      const seen = new Set<string>()
      while (gid && !seen.has(gid)) {
        if (gid === groupId) return true
        seen.add(gid)
        gid = this.groups[gid]?.parentId
      }
      return false
    },
    // Every object in a group (nested groups included), in paint order.
    groupMembers(groupId: string): string[] {
      return this.objectOrder.filter((oid) => this.inGroup(oid, groupId))
    },
    // Widen ids to whole outermost groups: a click on any member of a group
    // selects the group.
    expandToGroups(ids: string[]): string[] {
      const out = new Set<string>()
      for (const oid of ids) {
        const top = this.topGroupOf(oid)
        if (top) this.groupMembers(top).forEach((m) => out.add(m))
        else if (this.objects[oid]) out.add(oid)
      }
      return this.objectOrder.filter((oid) => out.has(oid))
    },
    // Group the given objects (whole groups among them nest inside the new
    // one). Members move next to the frontmost one in paint order and into
    // its layer. Returns the new group's id, or null for fewer than 2 items.
    groupObjects(ids: string[], name?: string): string | null {
      const members = this.expandToGroups(ids)
      const tops = new Set(members.map((oid) => this.topGroupOf(oid) ?? oid))
      // A single object or a single existing group has nothing to group with.
      if (tops.size < 2) return null
      const gid = makeId('group', this)
      this.groups[gid] = { id: gid, ...(name?.trim() ? { name: name.trim() } : {}) }
      for (const top of tops) {
        if (this.groups[top]) this.groups[top]!.parentId = gid
        else this.objects[top]!.groupId = gid
      }
      // Contiguous at the frontmost member, in the frontmost member's layer.
      const front = members[members.length - 1]!
      const layerId = this.objects[front]!.layerId
      for (const m of members) this.objects[m]!.layerId = layerId
      const rest = this.objectOrder.filter((oid) => !members.includes(oid))
      const frontIndex = this.objectOrder.indexOf(front)
      const before = this.objectOrder.slice(0, frontIndex + 1).filter((oid) => !members.includes(oid)).length
      rest.splice(before, 0, ...members)
      this.objectOrder = rest
      this._sortByLayers()
      return gid
    },
    // Ungroup the outermost groups of the given objects (one level, as
    // Illustrator does). Returns the ids that were in them.
    ungroupObjects(ids: string[]): string[] {
      const tops = new Set(ids.map((oid) => this.topGroupOf(oid)).filter((g): g is string => !!g))
      const released: string[] = []
      for (const gid of tops) {
        released.push(...this.groupMembers(gid))
        for (const o of Object.values(this.objects)) if (o.groupId === gid) delete o.groupId
        for (const g of Object.values(this.groups)) if (g.parentId === gid) delete g.parentId
        delete this.groups[gid]
      }
      return released
    },
    renameGroup(id: string, name: string): void {
      const g = this.groups[id]
      if (!g) return
      if (name.trim()) g.name = name.trim()
      else delete g.name
    },
    // Drop groups left with nothing in them (after deletes).
    _pruneGroups(): void {
      let changed = true
      while (changed) {
        changed = false
        for (const gid of Object.keys(this.groups)) {
          const objectKids = Object.values(this.objects).filter((o) => o.groupId === gid)
          const groupKids = Object.values(this.groups).filter((g) => g.parentId === gid)
          if (objectKids.length + groupKids.length === 0) {
            delete this.groups[gid]
            changed = true
          }
        }
      }
    },
    // Layers panel drag and drop: move an object or a whole group next to a
    // target row (above = in front of it), into the target's layer and group;
    // or, for a layer target, to the top of that layer outside any group.
    relocate(
      drag: { kind: 'object' | 'group'; id: string },
      target: { kind: 'object' | 'group' | 'layer'; id: string },
      above = true,
    ): boolean {
      const moving = drag.kind === 'group' ? this.groupMembers(drag.id) : this.objects[drag.id] ? [drag.id] : []
      if (!moving.length) return false
      let layerId: string | undefined
      let parent: string | undefined
      let refIds: string[] = []
      if (target.kind === 'layer') {
        if (!this.getLayer(target.id)) return false
        layerId = target.id
      } else if (target.kind === 'group') {
        if (!this.groups[target.id]) return false
        refIds = this.groupMembers(target.id)
        parent = this.groups[target.id]!.parentId
      } else {
        const t = this.objects[target.id]
        if (!t) return false
        refIds = [target.id]
        parent = t.groupId
      }
      if (refIds.some((r) => moving.includes(r))) return false
      // A group can't move into itself.
      if (drag.kind === 'group' && parent) {
        for (let g: string | undefined = parent; g; g = this.groups[g]?.parentId) if (g === drag.id) return false
      }
      if (!layerId) layerId = this.objects[refIds[0]!]!.layerId
      for (const m of moving) this.objects[m]!.layerId = layerId
      if (drag.kind === 'object') {
        if (parent) this.objects[drag.id]!.groupId = parent
        else delete this.objects[drag.id]!.groupId
      } else if (parent) this.groups[drag.id]!.parentId = parent
      else delete this.groups[drag.id]!.parentId
      const rest = this.objectOrder.filter((oid) => !moving.includes(oid))
      let at: number
      if (target.kind === 'layer') {
        // Just above the layer's frontmost object (sorting puts it in place).
        at = rest.length
      } else {
        const idx = refIds.map((r) => rest.indexOf(r))
        at = above ? Math.max(...idx) + 1 : Math.min(...idx)
      }
      rest.splice(at, 0, ...moving)
      this.objectOrder = rest
      this._sortByLayers()
      this._pruneGroups()
      return true
    },

    // Duplicate objects; groups wholly inside the set are duplicated too, so a
    // copied group is a new group. Returns the copies in paint order.
    duplicateObjects(ids: string[], offset: { x: number; y: number } = { x: 20, y: 20 }): CanvasObject[] {
      const set = new Set(ids)
      const groupMap = new Map<string, string>()
      const whole = (gid: string) => this.groupMembers(gid).every((m) => set.has(m))
      const mapGroup = (gid: string | undefined): string | undefined => {
        if (!gid || !this.groups[gid]) return undefined
        if (!whole(gid)) return gid
        if (!groupMap.has(gid)) {
          const src = this.groups[gid]!
          const nid = makeId('group', this)
          groupMap.set(gid, nid)
          this.groups[nid] = { id: nid, ...(src.name ? { name: src.name } : {}) }
          const parent = mapGroup(src.parentId)
          if (parent) this.groups[nid]!.parentId = parent
        }
        return groupMap.get(gid)
      }
      const copies: CanvasObject[] = []
      for (const oid of this.objectOrder.filter((x) => set.has(x))) {
        const src = this.objects[oid]
        if (!src) continue
        const clone = JSON.parse(JSON.stringify(src)) as AddObjectPayload
        delete clone.id
        clone.groupId = mapGroup(src.groupId)
        clone.x = (src.x || 0) + (offset.x || 0)
        clone.y = (src.y || 0) + (offset.y || 0)
        copies.push(this.addObject(clone))
      }
      return copies
    },

    // ---- Selection ---------------------------------------------------------
    selectObjects(ids: string[] | string = []): string[] {
      const arr = Array.isArray(ids) ? ids : [ids]
      // Hidden and locked objects are not selectable (layers panel rules).
      this.selectedIds = arr.filter((id) => {
        const o = this.objects[id]
        return !!o && !this.isHidden(o) && !this.isLocked(o)
      })
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
    setViewMode(mode: ViewMode): ViewMode {
      this.viewMode = VIEW_MODES.includes(mode) ? mode : 'preview'
      return this.viewMode
    },
    toggleViewMode(): ViewMode {
      return this.setViewMode(this.viewMode === 'outline' ? 'preview' : 'outline')
    },

    // ---- Snapshot / Undo ---------------------------------------------------
    _captureState(): SerializedState {
      return {
        artboards: JSON.parse(JSON.stringify(this.artboards)),
        objects: JSON.parse(JSON.stringify(this.objects)),
        objectOrder: [...this.objectOrder],
        selectedIds: [...this.selectedIds],
        selectedArtboardId: this.selectedArtboardId,
        layers: JSON.parse(JSON.stringify(this.layers)),
        groups: JSON.parse(JSON.stringify(this.groups)),
        activeLayerId: this.activeLayerId,
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
      this.layers = JSON.parse(JSON.stringify(state.layers || []))
      this.groups = JSON.parse(JSON.stringify(state.groups || {}))
      this.activeLayerId = state.activeLayerId && this.getLayer(state.activeLayerId) ? state.activeLayerId : (this.layers.at(-1)?.id ?? null)
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
        layers: JSON.parse(JSON.stringify(this.layers)),
        groups: JSON.parse(JSON.stringify(this.groups)),
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
      // Layers and groups: keep well-formed entries; older documents get one
      // layer holding everything.
      this.layers = (Array.isArray(doc.layers) ? doc.layers : [])
        .filter((l) => l && typeof l.id === 'string')
        .map((l, i) => ({ ...l, name: String(l.name || `Layer ${i + 1}`), color: l.color || LAYER_COLORS[i % LAYER_COLORS.length]! }))
      this.groups = {}
      for (const [gid, g] of Object.entries(doc.groups || {})) {
        if (g && typeof g === 'object') this.groups[gid] = { ...g, id: gid }
      }
      this.activeLayerId = null
      const fallback = this.ensureActiveLayer().id
      for (const obj of Object.values(objects)) {
        if (!obj.layerId || !this.getLayer(obj.layerId)) obj.layerId = fallback
        if (obj.groupId && !this.groups[obj.groupId]) delete obj.groupId
      }
      for (const g of Object.values(this.groups)) if (g.parentId && !this.groups[g.parentId]) delete g.parentId
      this._pruneGroups()
      this._sortByLayers()

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
