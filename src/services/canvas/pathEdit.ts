// Object ▸ Transform ▸ Reflect and Object ▸ Path ▸ Join.
//
// Reflect mirrors the selection across its center, as Illustrator's Reflect
// does. Each object's center moves to its mirror image, its rotation
// reverses, and its content mirrors on its own axis: paths have their
// geometry rewritten (so node editing, booleans and export see the real
// shape), text and images carry a flip flag the renderer applies.
//
// Join connects open paths at their nearest endpoints. Endpoints within the
// tolerance merge into one anchor; farther ones are bridged by a straight
// segment. A single open path is closed. The joined path is rebuilt in canvas
// space (rotation and scale baked in) and takes the front path's style.
import svgpath from 'svgpath'
import { getViewportController, type CanvasStore, type CanvasObject, type PathObject, type AddObjectPayload } from '@/stores/canvas'
import { buildPenNodesPayload, nodePointToCanvas, reverseNodes, type Box, type PathNode } from './svgEngine'
import { flattenSubpaths, parsePathData } from './svgToPaths'
import { replaceObjects } from './pathBoolean'

type Pt = { x: number; y: number }
export type ReflectAxis = 'horizontal' | 'vertical'

const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  }
}

function artboardOrigin(store: CanvasStore, obj: CanvasObject): Pt {
  const ab = obj.artboardId ? store.getArtboard(obj.artboardId) : null
  return { x: ab?.x ?? 0, y: ab?.y ?? 0 }
}

const scaleOf = (o: CanvasObject) => ({
  sx: o.baseWidth && o.width ? o.width / o.baseWidth : 1,
  sy: o.baseHeight && o.height ? o.height / o.baseHeight : 1,
})

// Mirror a node's anchor and handles across x = c (horizontal) or y = c.
function mirrorNode(n: PathNode, axis: ReflectAxis, c: number): PathNode {
  const m = (v: number | undefined) => (v === undefined ? undefined : 2 * c - v)
  return axis === 'horizontal'
    ? { ...n, x: 2 * c - n.x, inX: m(n.inX), outX: m(n.outX) }
    : { ...n, y: 2 * c - n.y, inY: m(n.inY), outY: m(n.outY) }
}

// Reflect objects across the center of their combined bounds. Mutates the
// store; the caller takes the undo snapshot.
export function reflectObjects(store: CanvasStore, ids: string[], axis: ReflectAxis): void {
  const objs = ids.map((id) => store.getObject(id)).filter((o): o is CanvasObject => !!o && !o.locked)
  const all = unionBox(objs.map((o) => store.objectCanvasBounds(o.id)).filter((b): b is Box => !!b))
  if (!all) return
  const g = center(all)
  for (const obj of objs) {
    const box = store.objectUnrotatedBox(obj.id)
    if (!box) continue
    const c = center(box)
    const target = axis === 'horizontal' ? { x: 2 * g.x - c.x, y: c.y } : { x: c.x, y: 2 * g.y - c.y }
    const patch: Record<string, unknown> = {
      x: (obj.x || 0) + target.x - c.x,
      y: (obj.y || 0) + target.y - c.y,
      rotation: obj.rotation ? (360 - obj.rotation) % 360 : 0,
    }
    if (obj.type === 'path') {
      // The object's center in its own base frame: the mirror line.
      const o = artboardOrigin(store, obj)
      const { sx, sy } = scaleOf(obj)
      const mid = axis === 'horizontal' ? (c.x - o.x - (obj.x || 0)) / sx : (c.y - o.y - (obj.y || 0)) / sy
      if (obj.nodes?.length) {
        store.updatePathNodes(obj.id, obj.nodes.map((n) => mirrorNode(n, axis, mid)))
      } else if (obj.shape !== 'rect' && obj.shape !== 'ellipse') {
        // Rectangles and ellipses are symmetric; other path data mirrors.
        const p = svgpath(obj.d || '')
        patch.d = (axis === 'horizontal' ? p.scale(-1, 1).translate(2 * mid, 0) : p.scale(1, -1).translate(0, 2 * mid))
          .round(3)
          .toString()
      }
    } else if (axis === 'horizontal') {
      patch.flipX = !obj.flipX
    } else {
      patch.flipY = !obj.flipY
    }
    if (obj.type !== 'image' && obj.fillGradient) {
      const gr = { ...obj.fillGradient }
      if (axis === 'horizontal') {
        gr.x1 = 1 - gr.x1
        gr.x2 = 1 - gr.x2
      } else {
        gr.y1 = 1 - gr.y1
        gr.y2 = 1 - gr.y2
      }
      patch.fillGradient = gr
    }
    store.updateObject(obj.id, patch)
  }
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

// A path's anchors in its local frame and whether it is one open subpath.
function localPath(obj: PathObject): { nodes: PathNode[]; open: boolean } {
  if (obj.nodes?.length) return { nodes: obj.nodes, open: !obj.closed && (obj.subpaths?.length ?? 1) <= 1 }
  if (obj.shape === 'rect' || obj.shape === 'ellipse') return { nodes: [], open: false }
  try {
    const f = flattenSubpaths(parsePathData(obj.d || ''))
    return { nodes: f.nodes, open: !f.closed && f.subpaths.length === 1 }
  } catch {
    return { nodes: [], open: false }
  }
}

// An open path's anchors in canvas space (rotation and scale applied; corner
// radii scaled with it), or null if the path isn't a single open subpath.
export function openPathOnCanvas(store: CanvasStore, obj: CanvasObject): PathNode[] | null {
  if (obj.type !== 'path' || obj.locked) return null
  const { nodes, open } = localPath(obj)
  if (!open || nodes.length < 2) return null
  const box = store.objectUnrotatedBox(obj.id)
  if (!box) return null
  const o = artboardOrigin(store, obj)
  const absX = o.x + (obj.x || 0)
  const absY = o.y + (obj.y || 0)
  const { sx, sy } = scaleOf(obj)
  const c = center(box)
  const t = { absX, absY, rotationDeg: obj.rotation || 0, scaleX: sx, scaleY: sy, cx: c.x - absX, cy: c.y - absY }
  const s = Math.sqrt(Math.abs(sx * sy)) || 1
  return nodes.map((n) => {
    const a = nodePointToCanvas(n, t)
    const out: PathNode = { x: a.x, y: a.y }
    const r = n.radius ?? obj.cornerRadius
    if (r) out.radius = r * s
    if (n.inX !== undefined && n.inY !== undefined) {
      const h = nodePointToCanvas({ x: n.inX, y: n.inY }, t)
      out.inX = h.x
      out.inY = h.y
    }
    if (n.outX !== undefined && n.outY !== undefined) {
      const h = nodePointToCanvas({ x: n.outX, y: n.outY }, t)
      out.outX = h.x
      out.outY = h.y
    }
    return out
  })
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

// Merge b's first anchor into a's last: one anchor at their midpoint keeping
// a's incoming handle and b's outgoing one.
function mergeEnds(a: PathNode, b: PathNode): PathNode {
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const n: PathNode = { x: m.x, y: m.y }
  if (a.inX !== undefined && a.inY !== undefined) {
    n.inX = a.inX + m.x - a.x
    n.inY = a.inY + m.y - a.y
  }
  if (b.outX !== undefined && b.outY !== undefined) {
    n.outX = b.outX + m.x - b.x
    n.outY = b.outY + m.y - b.y
  }
  const r = a.radius ?? b.radius
  if (r !== undefined) n.radius = r
  return n
}

// Join two open node paths (same space) at their nearest endpoints. When the
// other two ends then meet as well, the result is closed.
export function joinNodePaths(a: PathNode[], b: PathNode[], tol: number): { nodes: PathNode[]; closed: boolean; gap: number } {
  const options = [
    { gap: dist(a[a.length - 1]!, b[0]!), ra: false, rb: false },
    { gap: dist(a[a.length - 1]!, b[b.length - 1]!), ra: false, rb: true },
    { gap: dist(a[0]!, b[0]!), ra: true, rb: false },
    { gap: dist(a[0]!, b[b.length - 1]!), ra: true, rb: true },
  ]
  const best = options.reduce((m, o) => (o.gap < m.gap ? o : m))
  const first = best.ra ? reverseNodes(a) : a
  const second = best.rb ? reverseNodes(b) : b
  const joined: PathNode[] =
    best.gap <= tol
      ? [...first.slice(0, -1), mergeEnds(first[first.length - 1]!, second[0]!), ...second.slice(1)]
      : [...first, ...second]
  if (joined.length > 3 && dist(joined[0]!, joined[joined.length - 1]!) <= tol) {
    return { nodes: closeNodePath(joined, tol), closed: true, gap: best.gap }
  }
  return { nodes: joined, closed: false, gap: best.gap }
}

// Close one open node path, merging its ends when they meet.
export function closeNodePath(ns: PathNode[], tol: number): PathNode[] {
  if (ns.length > 2 && dist(ns[0]!, ns[ns.length - 1]!) <= tol) return [mergeEnds(ns[ns.length - 1]!, ns[0]!), ...ns.slice(1, -1)]
  return ns
}

// The selected paths Join can act on: open single-subpath paths.
export function joinablePaths(store: CanvasStore, ids: string[]): PathObject[] {
  return ids
    .map((id) => store.getObject(id))
    .filter((o): o is PathObject => !!o && o.type === 'path' && !o.locked && localPath(o).open && localPath(o).nodes.length >= 2)
}

// Can Join act on this selection (two open paths, or one to close)?
export function canJoin(store: CanvasStore, ids: string[]): boolean {
  const n = joinablePaths(store, ids).length
  return n === ids.length && (n === 1 || n === 2)
}

// Join the selection. Returns the new path's id, or null when it can't.
export function joinPaths(store: CanvasStore, ids: string[], tol: number): string | null {
  if (!canJoin(store, ids)) return null
  const paths = joinablePaths(store, ids)
  const canvas = paths.map((p) => openPathOnCanvas(store, p))
  if (canvas.some((c) => !c)) return null
  let nodes: PathNode[]
  let closed: boolean
  if (paths.length === 1) {
    nodes = closeNodePath(canvas[0]!, tol)
    closed = true
  } else {
    ;({ nodes, closed } = joinNodePaths(canvas[0]!, canvas[1]!, tol))
  }
  // The front path's appearance carries over.
  const front = [...paths].sort((p, q) => store.objectOrder.indexOf(q.id) - store.objectOrder.indexOf(p.id))[0]!
  const ab = front.artboardId ? store.getArtboard(front.artboardId) : null
  const built = buildPenNodesPayload(nodes, ab, closed)
  if (!built) return null
  const payload: AddObjectPayload = {
    ...built,
    fill: front.fill,
    fillGradient: front.fillGradient ? JSON.parse(JSON.stringify(front.fillGradient)) : undefined,
    stroke: front.stroke,
    strokeWidth: front.strokeWidth,
    strokeLinecap: front.strokeLinecap,
    strokeLinejoin: front.strokeLinejoin,
    opacity: front.opacity,
    semanticRole: front.semanticRole,
    name: front.name,
    artboardId: front.artboardId,
  }
  const [id] = replaceObjects(store, paths.map((p) => p.id), [payload])
  // Rounded corners come back from the nodes' radii.
  if (id && built.nodes.some((n) => n.radius)) store.updatePathNodes(id, built.nodes)
  return id ?? null
}

// ---------------------------------------------------------------------------
// Commands (menu, Control bar, agent tools): one undo step each.
// ---------------------------------------------------------------------------

// Endpoints closer than this many screen pixels merge when joined.
const JOIN_PX = 8

export function joinTolerance(): number {
  return JOIN_PX * (getViewportController()?.unitsPerPixel?.() ?? 1)
}

export function reflectSelection(store: CanvasStore, axis: ReflectAxis, ids: string[] = store.selectedIds): void {
  if (!ids.length) return
  store.snapshot(axis === 'horizontal' ? 'Reflect horizontal' : 'Reflect vertical')
  reflectObjects(store, [...ids], axis)
}

export function joinSelection(store: CanvasStore, ids: string[] = store.selectedIds, tol = joinTolerance()): string | null {
  if (!canJoin(store, ids)) return null
  store.snapshot('Join')
  const id = joinPaths(store, [...ids], tol)
  if (id) store.selectObjects([id])
  else store.undo()
  return id
}
