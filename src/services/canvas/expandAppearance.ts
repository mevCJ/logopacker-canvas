// Expand Appearance (Object ▸ Expand Appearance): turns a path's stroke into a
// filled shape, as Illustrator does, so it can be booleaned, shape-built or
// node-edited like any other artwork.
//
// The stroke is outlined around the geometry at its display size — where the
// renderer draws it at exactly strokeWidth — and then rotated and placed like
// the object, so the outline matches the stroke it showed, including its cap
// (butt, round, projecting) and corner (miter with SVG's limit of 4, round,
// bevel): each segment becomes a quad, each corner a wedge or disc, each open
// end a cap, and the pieces are united. Curves are flattened first, so the
// outline of a curve is a fine polyline.
//
// A path with a fill keeps its fill and loses its stroke; the outline is a new
// object directly above it. A path with only a stroke is replaced.
import type {} from 'paper/dist/paper-core'
import type { CanvasStore, PathObject } from '@/stores/canvas'
import { isNonePaint } from './color'
import { displayPathData } from './svgEngine'
import { itemToPayload, loadPaper, replaceObjects, styleOf } from './pathBoolean'

type Pt = { x: number; y: number }

export function hasVisibleStroke(obj: { type: string; stroke?: string; strokeWidth?: number }): boolean {
  return obj.type === 'path' && !isNonePaint(obj.stroke) && (obj.strokeWidth || 0) > 0
}

const MITER_LIMIT = 4

export type Cap = 'butt' | 'round' | 'square'
export type Join = 'miter' | 'round' | 'bevel'

// A circle as a polygon fine enough to read as round at stroke sizes.
function disc(c: Pt, r: number, steps = 48): Pt[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2
    return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }
  })
}

// Polygons (clockwise) whose union is the stroke of a polyline.
export function strokePieces(pts: Pt[], closed: boolean, width: number, cap: Cap = 'butt', join: Join = 'miter'): Pt[][] {
  const h = width / 2
  // Drop repeated points (and a closing point equal to the first).
  const p: Pt[] = []
  for (const q of pts) {
    const last = p[p.length - 1]
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-9) p.push(q)
  }
  if (closed && p.length > 1) {
    const a = p[0]!
    const b = p[p.length - 1]!
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9) p.pop()
  }
  if (p.length < 2 || h <= 0) return []
  const n = p.length
  const segCount = closed && n > 2 ? n : n - 1
  const dir = (i: number) => {
    const a = p[i % n]!
    const b = p[(i + 1) % n]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
  }
  const off = (q: Pt, nx: number, ny: number, s: number) => ({ x: q.x + nx * h * s, y: q.y + ny * h * s })

  const pieces: Pt[][] = []
  for (let i = 0; i < segCount; i++) {
    const a = p[i]!
    const b = p[(i + 1) % n]!
    const u = dir(i)
    // Left normal.
    const nx = -u.y
    const ny = u.x
    pieces.push([off(a, nx, ny, 1), off(b, nx, ny, 1), off(b, nx, ny, -1), off(a, nx, ny, -1)])
  }
  // Caps at the two ends of an open path.
  if (!(closed && n > 2)) {
    const u0 = dir(0)
    // Each end with the direction pointing out of the path.
    const ends: [Pt, { x: number; y: number }][] = [
      [p[0]!, { x: -u0.x, y: -u0.y }],
      [p[n - 1]!, dir(n - 2)],
    ]
    for (const [e, out] of ends) {
      if (cap === 'round') pieces.push(disc(e, h))
      else if (cap === 'square') {
        // Projecting: the stroke runs on by half its width.
        const nx = -out.y
        const ny = out.x
        const f = { x: e.x + out.x * h, y: e.y + out.y * h }
        pieces.push([off(e, nx, ny, 1), off(f, nx, ny, 1), off(f, nx, ny, -1), off(e, nx, ny, -1)])
      }
    }
  }
  // Joins at every vertex where two segments meet.
  const first = closed && n > 2 ? 0 : 1
  const last = closed && n > 2 ? n - 1 : n - 2
  for (let i = first; i <= last; i++) {
    const u1 = dir((i - 1 + n) % n)
    const u2 = dir(i)
    const cross = u1.x * u2.y - u1.y * u2.x
    if (Math.abs(cross) < 1e-9 && u1.x * u2.x + u1.y * u2.y > 0) continue // straight on
    // The gap opens on the outside of the turn.
    const s = cross > 0 ? -1 : 1
    const n1 = { x: -u1.y, y: u1.x }
    const n2 = { x: -u2.y, y: u2.x }
    const v = p[i]!
    const dot = n1.x * n2.x + n1.y * n2.y
    // A round join is a disc; at the slight bends of a flattened curve a
    // miter wedge is indistinguishable and far cheaper to unite.
    if (join === 'round' && dot < Math.cos(Math.PI / 18)) {
      pieces.push(disc(v, h))
      continue
    }
    const a = off(v, n1.x, n1.y, s)
    const b = off(v, n2.x, n2.y, s)
    // Miter length over stroke width is 1/cos(φ/2), φ the angle between normals.
    const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2))
    if (join !== 'bevel' && cosHalf > 1e-9 && 1 / cosHalf <= MITER_LIMIT) {
      const k = (h * s) / (1 + dot)
      const m = { x: v.x + (n1.x + n2.x) * k, y: v.y + (n1.y + n2.y) * k }
      pieces.push([v, a, m, b])
    } else {
      pieces.push([v, a, b])
    }
  }
  return pieces
}

// The stroke of path data `d` at `width`, as one filled paper item.
export function strokeOutline(
  scope: paper.PaperScope,
  d: string,
  width: number,
  cap: Cap = 'butt',
  join: Join = 'miter',
): paper.PathItem | null {
  const src = new scope.CompoundPath({ pathData: d, insert: false })
  const children = (src.children as paper.Path[]).length ? (src.children as paper.Path[]) : []
  // Flatten finely relative to the stroke so curves stay smooth.
  const flatness = Math.max(0.01, Math.min(0.25, width / 16))
  const pieces: paper.Path[] = []
  for (const child of children) {
    const c = child.clone({ insert: false }) as paper.Path
    c.flatten(flatness)
    const pts = c.segments.map((s) => ({ x: s.point.x, y: s.point.y }))
    for (const poly of strokePieces(pts, c.closed, width, cap, join)) {
      const path = new scope.Path({ segments: poly.map((q) => [q.x, q.y]), closed: true, insert: false })
      if (Math.abs(path.area) < 1e-12) continue
      path.clockwise = true
      pieces.push(path)
    }
  }
  if (!pieces.length) return null
  // Unite in a balanced tree: far fewer large intermediate shapes than a
  // running fold, which keeps long curves fast.
  let level: paper.PathItem[] = pieces
  while (level.length > 1) {
    const next: paper.PathItem[] = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!
      const b = level[i + 1]
      next.push(b ? a.unite(b, { insert: false }) : a)
    }
    level = next
  }
  return level[0]!
}

// The object's display geometry (base geometry scaled to its size) and the
// transform that places it on the canvas, mirroring the renderer: rotate about
// the geometry center, then translate.
function displayGeometry(scope: paper.PaperScope, store: CanvasStore, obj: PathObject): { d: string; matrix: paper.Matrix } {
  const sx = obj.baseWidth ? obj.width / obj.baseWidth : 1
  const sy = obj.baseHeight ? obj.height / obj.baseHeight : 1
  const d = displayPathData(obj.d || '', sx, sy)
  const b = new scope.CompoundPath({ pathData: d, insert: false }).bounds
  const ab = obj.artboardId ? store.getArtboard(obj.artboardId) : null
  const m = new scope.Matrix()
  m.translate(new scope.Point((ab?.x ?? 0) + (obj.x || 0), (ab?.y ?? 0) + (obj.y || 0)))
  if (obj.rotation) m.rotate(obj.rotation, b.center)
  return { d, matrix: m }
}

// Expand the appearance of the given objects. Returns the ids to select: each
// expanded object's fill (when kept) and outline, plus anything left as is.
export async function expandAppearance(store: CanvasStore, ids: string[]): Promise<string[]> {
  const scope = await loadPaper()
  const result: string[] = []
  for (const id of ids) {
    const obj = store.getObject(id)
    if (!obj || obj.type !== 'path' || !hasVisibleStroke(obj)) {
      if (obj) result.push(id)
      continue
    }
    const geo = displayGeometry(scope, store, obj)
    const outline = strokeOutline(scope, geo.d, obj.strokeWidth, obj.strokeLinecap, obj.strokeLinejoin)
    if (!outline) {
      result.push(id)
      continue
    }
    outline.transform(geo.matrix)
    const style = styleOf(obj)
    const payload = itemToPayload(store, outline, {
      ...style,
      fill: obj.stroke,
      fillGradient: undefined,
      stroke: 'none',
      strokeWidth: 0,
    })
    if (!payload) {
      result.push(id)
      continue
    }
    if (obj.name) payload.name = `${obj.name} stroke`
    const keepsFill = !!obj.fillGradient || !isNonePaint(obj.fill)
    if (keepsFill) {
      store.updateObject(id, { stroke: 'none', strokeWidth: 0 })
      const added = store.addObject(payload)
      store.reorderObject(added.id, store.objectOrder.indexOf(id) + 1)
      result.push(id, added.id)
    } else {
      result.push(...replaceObjects(store, [id], [payload]))
    }
  }
  return result
}
