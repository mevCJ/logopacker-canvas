// Boolean path geometry (Pathfinder + Shape Builder) on top of paper.js.
//
// Objects store their geometry in a local/base frame and are placed by a
// translate → rotate(about the geometry center) → scale transform (see
// objectTransform). Boolean ops need everything in one shared space, so each
// source path is mapped into canvas space, combined there, and the result is
// written back as a fresh, untransformed path object (rotation 0, scale 1)
// whose `d` is rebased to its own top-left — the same convention pen/imported
// paths use.
//
// paper.js is loaded lazily: it's only needed once a boolean tool is used, and
// paper-core touches a 2D canvas context at import time.
// The typings declare a global `paper` namespace; this import pulls them in.
import type {} from 'paper/dist/paper-core'
import type { CanvasStore, PathObject, AddObjectPayload } from '@/stores/canvas'
import { flattenSubpaths, parsePathData } from './svgToPaths'
import { nodesToPathData } from './svgEngine'

type PathItem = paper.PathItem

let scopePromise: Promise<paper.PaperScope> | null = null
// Set once loaded, for the synchronous helpers that run after a load.
let loaded: paper.PaperScope | null = null

export function loadPaper(): Promise<paper.PaperScope> {
  if (!scopePromise) {
    scopePromise = import('paper/dist/paper-core').then((mod) => {
      // The module's export is itself a PaperScope; make a private one.
      const core = ((mod as unknown as { default?: paper.PaperScope }).default ?? mod) as paper.PaperScope
      const scope = new core.PaperScope()
      scope.setup(new scope.Size(1, 1))
      loaded = scope
      return scope
    })
  }
  return scopePromise
}

function point(x: number, y: number): paper.Point {
  if (!loaded) throw new Error('paper.js is not loaded yet; await loadPaper() first.')
  return new loaded.Point(x, y)
}

// Absolute origin of an object's artboard (0,0 when on the bare canvas).
function artboardOrigin(store: CanvasStore, artboardId: string | null): { x: number; y: number } {
  const ab = artboardId ? store.getArtboard(artboardId) : null
  return { x: ab?.x ?? 0, y: ab?.y ?? 0 }
}

// Build a paper item for a path object, in canvas space. Mirrors the renderer:
// scale about the local origin, rotate about the post-scale geometry center,
// then translate to the absolute position.
export function objectToCanvasItem(scope: paper.PaperScope, store: CanvasStore, obj: PathObject): PathItem {
  const item = new scope.CompoundPath({ pathData: obj.d || '', insert: false }) as PathItem
  const sx = obj.baseWidth ? obj.width / obj.baseWidth : 1
  const sy = obj.baseHeight ? obj.height / obj.baseHeight : 1
  if (sx !== 1 || sy !== 1) item.scale(sx, sy, new scope.Point(0, 0))
  if (obj.rotation) item.rotate(obj.rotation, item.bounds.center)
  const o = artboardOrigin(store, obj.artboardId)
  item.translate(new scope.Point(o.x + (obj.x || 0), o.y + (obj.y || 0)))
  return item
}

// Canvas-space path data for a path object (e.g. to lay text along it).
export async function objectCanvasPathData(store: CanvasStore, obj: PathObject): Promise<string> {
  const scope = await loadPaper()
  return objectToCanvasItem(scope, store, obj).pathData
}

// Geometry for laying text along a path object: the path's canvas-space shape
// rebased to its own top-left, plus that top-left in artboard-local coords.
export async function textPathGeometry(
  store: CanvasStore,
  obj: PathObject,
): Promise<{ pathD: string; x: number; y: number; width: number; height: number }> {
  const scope = await loadPaper()
  const item = objectToCanvasItem(scope, store, obj)
  const b = item.bounds
  item.translate(new scope.Point(-b.x, -b.y))
  const o = artboardOrigin(store, obj.artboardId)
  return { pathD: item.pathData, x: b.x - o.x, y: b.y - o.y, width: b.width, height: b.height }
}

export function itemArea(item: PathItem): number {
  return Math.abs((item as unknown as { area: number }).area || 0)
}

// Split a boolean result into its visually separate pieces: each outer contour
// with the holes it contains. Boolean results are reoriented by paper, so
// outers share the orientation of the largest contour and holes are opposite.
export function splitIntoPieces(scope: paper.PaperScope, item: PathItem): PathItem[] {
  const children = (item as paper.CompoundPath).children as paper.Path[] | undefined
  if (!children || item instanceof scope.Path) return [item]
  const contours = [...children].sort((a, b) => Math.abs(b.area) - Math.abs(a.area))
  if (contours.length <= 1) return [item]
  const outerCw = contours[0]!.clockwise
  const outers: { outer: paper.Path; holes: paper.Path[] }[] = []
  for (const c of contours) {
    if (c.clockwise === outerCw) {
      outers.push({ outer: c, holes: [] })
      continue
    }
    // Assign the hole to the smallest outer containing it.
    const p = c.interiorPoint
    const host = [...outers].reverse().find((o) => o.outer.contains(p))
    if (host) host.holes.push(c)
    else outers.push({ outer: c, holes: [] })
  }
  return outers.map(({ outer, holes }) => {
    if (!holes.length) return outer.clone({ insert: false }) as PathItem
    return new scope.CompoundPath({
      children: [outer, ...holes].map((p) => p.clone({ insert: false })),
      insert: false,
    }) as PathItem
  })
}

// Style carried from a source object onto a boolean result.
export interface PathStyle {
  fill: string
  fillGradient?: PathObject['fillGradient']
  stroke: string
  strokeWidth: number
  opacity: number
  semanticRole: string
  artboardId: string | null
}

export function styleOf(obj: PathObject): PathStyle {
  // Strokes draw at their own width whatever the object's scale, so the
  // width carries over unchanged.
  return {
    fill: obj.fill,
    fillGradient: obj.fillGradient,
    stroke: obj.stroke,
    strokeWidth: obj.strokeWidth || 0,
    opacity: obj.opacity ?? 1,
    semanticRole: String(obj.semanticRole || 'none'),
    artboardId: obj.artboardId,
  }
}

// Turn a canvas-space item into a path-object payload in its artboard's local
// frame, with node data so the node tool can keep editing it.
export function itemToPayload(store: CanvasStore, item: PathItem, style: PathStyle): AddObjectPayload | null {
  const o = artboardOrigin(store, style.artboardId)
  const b = item.bounds
  if (!b || b.width <= 0 || b.height <= 0) return null
  const local = item.clone({ insert: false }) as PathItem
  local.translate(point(-b.x, -b.y))
  const { nodes, subpaths, closed } = flattenSubpaths(parsePathData(local.pathData))
  if (nodes.length < 2) return null
  return {
    type: 'path',
    d: nodesToPathData(nodes, closed, subpaths),
    nodes,
    subpaths,
    closed,
    x: b.x - o.x,
    y: b.y - o.y,
    width: b.width,
    height: b.height,
    baseWidth: b.width,
    baseHeight: b.height,
    rotation: 0,
    fill: style.fill,
    fillGradient: style.fillGradient ? JSON.parse(JSON.stringify(style.fillGradient)) : undefined,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    opacity: style.opacity,
    semanticRole: style.semanticRole,
    artboardId: style.artboardId,
  }
}

// Replace `removeIds` with new objects built from `payloads`, inserting them
// where the backmost removed object sat in paint order. Returns new ids.
export function replaceObjects(store: CanvasStore, removeIds: string[], payloads: AddObjectPayload[]): string[] {
  const indices = removeIds.map((id) => store.objectOrder.indexOf(id)).filter((i) => i >= 0)
  let insertAt = indices.length ? Math.min(...indices) : store.objectOrder.length
  for (const id of removeIds) store.removeObject(id)
  insertAt = Math.min(insertAt, store.objectOrder.length)
  const ids: string[] = []
  for (const p of payloads) {
    const obj = store.addObject(p)
    store.reorderObject(obj.id, insertAt++)
    ids.push(obj.id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Pathfinder (whole-object boolean ops)
// ---------------------------------------------------------------------------

export const PATHFINDER_OPS = ['unite', 'minusFront', 'intersect', 'exclude'] as const
export type PathfinderOp = (typeof PATHFINDER_OPS)[number]

function selectedPaths(store: CanvasStore, ids: string[]): PathObject[] {
  // Paint order, back to front.
  return store.objectOrder
    .filter((id) => ids.includes(id))
    .map((id) => store.getObject(id))
    .filter((o): o is PathObject => !!o && o.type === 'path' && !!o.d)
}

// Combine ≥2 path objects into one. Unite/intersect/exclude take the frontmost
// object's style; minus-front keeps the backmost object's style and subtracts
// everything in front of it (Illustrator semantics). Returns the new ids.
export async function applyPathfinder(store: CanvasStore, ids: string[], op: PathfinderOp): Promise<string[]> {
  const paths = selectedPaths(store, ids)
  if (paths.length < 2) throw new Error('Pathfinder needs at least two path objects.')
  const scope = await loadPaper()
  const items = paths.map((p) => objectToCanvasItem(scope, store, p))
  let result = items[0]!
  for (const next of items.slice(1)) {
    if (op === 'unite') result = result.unite(next, { insert: false })
    else if (op === 'minusFront') result = result.subtract(next, { insert: false })
    else if (op === 'intersect') result = result.intersect(next, { insert: false })
    else result = result.exclude(next, { insert: false })
  }
  const styleSource = op === 'minusFront' ? paths[0]! : paths[paths.length - 1]!
  const payload = itemArea(result) > 1e-6 ? itemToPayload(store, result, styleOf(styleSource)) : null
  return replaceObjects(store, paths.map((p) => p.id), payload ? [payload] : [])
}

// ---------------------------------------------------------------------------
// Shape Builder (region-level merge / delete)
// ---------------------------------------------------------------------------

export interface ShapeRegion {
  item: PathItem
  // The frontmost source covering this region; its style wins on merge.
  ownerId: string
  pathData: string
}

// Partition the union of the given paths into disjoint regions: every distinct
// overlap and leftover area becomes its own region (Illustrator's shape
// builder "pieces"). Exponential in the worst case, fine for logo-sized sets.
export async function computeShapeRegions(store: CanvasStore, ids: string[]): Promise<ShapeRegion[]> {
  const paths = selectedPaths(store, ids)
  if (paths.length < 2) return []
  const scope = await loadPaper()
  const items = paths.map((p) => ({ id: p.id, item: objectToCanvasItem(scope, store, p) }))
  const total = items.reduce((sum, i) => sum + itemArea(i.item), 0)
  const minArea = Math.max(1e-6, total * 1e-6)

  let regions: { item: PathItem; ownerId: string }[] = []
  let covered: PathItem | null = null
  for (const { id, item } of items) {
    const next: { item: PathItem; ownerId: string }[] = []
    for (const r of regions) {
      const inside = r.item.intersect(item, { insert: false })
      const outside = r.item.subtract(item, { insert: false })
      if (itemArea(inside) > minArea) next.push({ item: inside, ownerId: id })
      if (itemArea(outside) > minArea) next.push({ item: outside, ownerId: r.ownerId })
    }
    const fresh = covered ? item.subtract(covered, { insert: false }) : item
    if (itemArea(fresh) > minArea) next.push({ item: fresh, ownerId: id })
    covered = covered ? covered.unite(item, { insert: false }) : item
    regions = next
  }

  const out: ShapeRegion[] = []
  for (const r of regions) {
    for (const piece of splitIntoPieces(scope, r.item)) {
      if (itemArea(piece) > minArea) out.push({ item: piece, ownerId: r.ownerId, pathData: piece.pathData })
    }
  }
  return out
}

export function regionAtPoint(regions: ShapeRegion[], p: { x: number; y: number }): number {
  for (let i = 0; i < regions.length; i++) {
    const item = regions[i]!.item
    const pt = point(p.x, p.y)
    if (item.bounds.contains(pt) && item.contains(pt)) return i
  }
  return -1
}

// Commit a shape-builder gesture. `picked` regions are merged into one shape
// (style of the first picked region's owner) or, with `erase`, deleted. Every
// other region becomes its own object with its owner's style, replacing the
// original source objects. Returns the new object ids.
export function commitShapeBuilder(
  store: CanvasStore,
  sourceIds: string[],
  regions: ShapeRegion[],
  picked: number[],
  erase: boolean,
): string[] {
  if (!picked.length) return []
  const sources = selectedPaths(store, sourceIds)
  const owners = new Map(sources.map((p) => [p.id, p]))
  const depth = new Map(sources.map((p, i) => [p.id, i]))
  const pickedSet = new Set(picked)
  // Collected with their owner's stacking depth so output keeps source order.
  const out: { depth: number; payload: AddObjectPayload }[] = []

  if (!erase) {
    const first = regions[picked[0]!]!
    let merged = first.item
    for (const i of picked.slice(1)) merged = merged.unite(regions[i]!.item, { insert: false })
    const owner = owners.get(first.ownerId)
    if (owner) {
      const p = itemToPayload(store, merged, styleOf(owner))
      if (p) out.push({ depth: depth.get(owner.id)!, payload: p })
    }
  }
  regions.forEach((r, i) => {
    if (pickedSet.has(i)) return
    const owner = owners.get(r.ownerId)
    if (!owner) return
    const p = itemToPayload(store, r.item, styleOf(owner))
    if (p) out.push({ depth: depth.get(owner.id)!, payload: p })
  })
  out.sort((a, b) => a.depth - b.depth)
  return replaceObjects(store, [...owners.keys()], out.map((o) => o.payload))
}
