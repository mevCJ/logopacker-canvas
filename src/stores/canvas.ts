// Canvas store — the single source of truth for the vector canvas.
// SVG.js renders/syncs from this; both human interactions and WebMCP tools
// mutate this state.
import { defineStore } from 'pinia'

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
  rotation: number
  opacity: number
}

export interface PathObject extends BaseObject {
  type: 'path'
  d: string
  fill: string
  stroke: string
  strokeWidth: number
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
}

export interface CanvasState {
  artboards: Artboard[]
  objects: Record<string, CanvasObject>
  objectOrder: string[]
  selectedIds: string[]
  viewport: { x: number; y: number; zoom: number }
  history: HistoryEntry[]
  activityLog: ActivityGroup[]
  currentGroup: string | null
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
// Store
// ---------------------------------------------------------------------------

export const useCanvasStore = defineStore('canvas', {
  state: (): CanvasState => ({
    artboards: [],
    objects: {},
    objectOrder: [],
    selectedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    history: [],
    activityLog: [],
    currentGroup: null,
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
      return true
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
      return this.selectedIds
    },
    clearSelection(): void {
      this.selectedIds = []
    },

    // ---- Snapshot / Undo ---------------------------------------------------
    _captureState(): SerializedState {
      return {
        artboards: JSON.parse(JSON.stringify(this.artboards)),
        objects: JSON.parse(JSON.stringify(this.objects)),
        objectOrder: [...this.objectOrder],
        selectedIds: [...this.selectedIds],
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
    },

    canUndo(): boolean {
      return this.history.length > 0
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
