// Smart guides + snap to point (Illustrator-style), as pure geometry.
//
// A *scene* is built once when an interaction starts, from everything the
// moving thing can snap to: other objects' bounds (edges, centers, corners),
// path anchor points, and artboards. During the drag each pointer move asks
// the engine to adjust a delta / point / box:
//
//   • Snap to Point  — a reference point of the moving thing (box corner,
//     edge midpoint, center, or one of its anchors) lands exactly on a target
//     point within tolerance.
//   • Alignment      — a moving edge or center lines up with a target edge or
//     center (vertical / horizontal smart guide).
//   • Equal spacing  — the gap to the neighbor matches an existing gap between
//     other objects in the same row/column, or the object centers between its
//     two neighbors.
//
// Tolerances are in canvas units; callers convert from screen pixels so
// snapping feels the same at every zoom level.

export interface Pt {
  x: number
  y: number
}
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export type PointKind = 'anchor' | 'corner' | 'midpoint' | 'center' | 'artboard'

export interface SnapPt extends Pt {
  kind: PointKind
}

// A target alignment line: `pos` on its axis, spanning lo..hi on the other.
interface AxisLine {
  pos: number
  lo: number
  hi: number
}

export interface SnapScene {
  points: SnapPt[]
  cell: number
  grid: Map<string, SnapPt[]>
  vlines: AxisLine[] // x = pos
  hlines: AxisLine[] // y = pos
  boxes: Box[] // other objects, for spacing
}

export type Guide =
  | { kind: 'align'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'gap'; x1: number; y1: number; x2: number; y2: number; label: string }
  | { kind: 'point'; x: number; y: number; label: string }

export interface SnapOptions {
  points: boolean // snap to point
  guides: boolean // smart guides (alignment + spacing)
}

const EPS = 0.01

// The nine reference points of a box.
export function boxPoints(b: Box): SnapPt[] {
  const xs = [b.x, b.x + b.width / 2, b.x + b.width]
  const ys = [b.y, b.y + b.height / 2, b.y + b.height]
  const out: SnapPt[] = []
  xs.forEach((x, i) =>
    ys.forEach((y, j) => {
      const kind: PointKind = i === 1 && j === 1 ? 'center' : i === 1 || j === 1 ? 'midpoint' : 'corner'
      out.push({ x, y, kind })
    }),
  )
  return out
}

function key(cell: number, x: number, y: number): string {
  return `${Math.floor(x / cell)},${Math.floor(y / cell)}`
}

export function buildScene(
  input: { boxes: Box[]; anchors?: Pt[]; artboards?: Box[] },
  tolerance: number,
): SnapScene {
  const cell = Math.max(tolerance, 1e-6) * 2
  const points: SnapPt[] = []
  const vlines: AxisLine[] = []
  const hlines: AxisLine[] = []
  const addBox = (b: Box, artboard: boolean) => {
    for (const p of boxPoints(b)) points.push(artboard ? { ...p, kind: 'artboard' } : p)
    for (const x of [b.x, b.x + b.width / 2, b.x + b.width]) vlines.push({ pos: x, lo: b.y, hi: b.y + b.height })
    for (const y of [b.y, b.y + b.height / 2, b.y + b.height]) hlines.push({ pos: y, lo: b.x, hi: b.x + b.width })
  }
  input.boxes.forEach((b) => addBox(b, false))
  ;(input.artboards ?? []).forEach((b) => addBox(b, true))
  for (const a of input.anchors ?? []) {
    points.push({ x: a.x, y: a.y, kind: 'anchor' })
    // Anchors are alignment references too: a guide runs from the anchor to
    // whatever lines up with it horizontally or vertically.
    vlines.push({ pos: a.x, lo: a.y, hi: a.y })
    hlines.push({ pos: a.y, lo: a.x, hi: a.x })
  }
  const grid = new Map<string, SnapPt[]>()
  for (const p of points) {
    const k = key(cell, p.x, p.y)
    const list = grid.get(k)
    if (list) list.push(p)
    else grid.set(k, [p])
  }
  vlines.sort((a, b) => a.pos - b.pos)
  hlines.sort((a, b) => a.pos - b.pos)
  return { points, cell, grid, vlines, hlines, boxes: [...input.boxes] }
}

// Nearest target point to p within tolerance (Chebyshev), or null.
function nearestPoint(scene: SnapScene, p: Pt, tol: number): SnapPt | null {
  const cx = Math.floor(p.x / scene.cell)
  const cy = Math.floor(p.y / scene.cell)
  let best: SnapPt | null = null
  let bestD = Infinity
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (const t of scene.grid.get(`${cx + i},${cy + j}`) ?? []) {
        const dx = Math.abs(t.x - p.x)
        const dy = Math.abs(t.y - p.y)
        if (dx > tol || dy > tol) continue
        // Anchors win ties over box references (they're the "real" geometry).
        const d = Math.hypot(dx, dy) - (t.kind === 'anchor' ? tol * 0.25 : 0)
        if (d < bestD) {
          bestD = d
          best = t
        }
      }
    }
  }
  return best
}

// Nearest line to any of `values` within tolerance → the correction to apply.
function nearestLine(lines: AxisLine[], values: number[], tol: number): number | null {
  let best: number | null = null
  for (const v of values) {
    // Binary search for the first line ≥ v - tol.
    let lo = 0
    let hi = lines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lines[mid]!.pos < v - tol) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < lines.length && lines[i]!.pos <= v + tol; i++) {
      const d = lines[i]!.pos - v
      if (best === null || Math.abs(d) < Math.abs(best)) best = d
    }
  }
  return best
}

// One guide per aligned position, spanning the moving box and every target
// line that coincides with one of its edges/center.
function alignGuides(scene: SnapScene, moved: Box): Guide[] {
  const out: Guide[] = []
  const collect = (lines: AxisLine[], values: number[], mlo: number, mhi: number, vertical: boolean) => {
    const spans = new Map<number, { pos: number; lo: number; hi: number }>()
    for (const v of values) {
      for (const l of lines) {
        if (Math.abs(l.pos - v) > EPS) continue
        const k = Math.round(l.pos * 100)
        const cur = spans.get(k) ?? { pos: l.pos, lo: mlo, hi: mhi }
        cur.lo = Math.min(cur.lo, l.lo)
        cur.hi = Math.max(cur.hi, l.hi)
        spans.set(k, cur)
      }
    }
    for (const sp of spans.values()) {
      out.push(
        vertical
          ? { kind: 'align', x1: sp.pos, y1: sp.lo, x2: sp.pos, y2: sp.hi }
          : { kind: 'align', x1: sp.lo, y1: sp.pos, x2: sp.hi, y2: sp.pos },
      )
    }
  }
  collect(scene.vlines, [moved.x, moved.x + moved.width / 2, moved.x + moved.width], moved.y, moved.y + moved.height, true)
  collect(scene.hlines, [moved.y, moved.y + moved.height / 2, moved.y + moved.height], moved.x, moved.x + moved.width, false)
  return out
}

// ---------------------------------------------------------------------------
// Equal spacing
// ---------------------------------------------------------------------------

interface Span {
  lo: number
  hi: number
  clo: number // cross-axis extent
  chi: number
}

const toSpan = (b: Box, axis: 'x' | 'y'): Span =>
  axis === 'x'
    ? { lo: b.x, hi: b.x + b.width, clo: b.y, chi: b.y + b.height }
    : { lo: b.y, hi: b.y + b.height, clo: b.x, chi: b.x + b.width }

interface SpacingMatch {
  diff: number
  // Gaps to draw once snapped: [from, to, cross position] on this axis.
  gaps: [number, number, number][]
}

// Best equal-spacing correction for `moved` along one axis, or null.
function spacing1D(scene: SnapScene, moved: Box, axis: 'x' | 'y', tol: number): SpacingMatch | null {
  const m = toSpan(moved, axis)
  const size = m.hi - m.lo
  const crossOverlap = (s: Span) => Math.min(s.chi, m.chi) - Math.max(s.clo, m.clo) > 0
  const row = scene.boxes.map((b) => toSpan(b, axis)).filter(crossOverlap)
  if (!row.length) return null
  const mid = (a: Span, b: Span) => (Math.max(a.clo, b.clo) + Math.min(a.chi, b.chi)) / 2

  // Nearest neighbors before/after the moving span.
  let before: Span | null = null
  let after: Span | null = null
  for (const s of row) {
    if (s.hi <= m.lo + tol && (!before || s.hi > before.hi)) before = s
    if (s.lo >= m.hi - tol && (!after || s.lo < after.lo)) after = s
  }

  // Existing gaps between consecutive non-overlapping row members.
  const sorted = [...row].sort((a, b) => a.lo - b.lo)
  const gaps: { a: Span; b: Span; g: number }[] = []
  for (let i = 0; i < sorted.length; i++) {
    // Pair each span with the nearest span that starts after it ends.
    let next: Span | null = null
    for (const s of sorted) if (s.lo >= sorted[i]!.hi && (!next || s.lo < next.lo)) next = s
    if (next) gaps.push({ a: sorted[i]!, b: next, g: next.lo - sorted[i]!.hi })
  }

  let best: SpacingMatch | null = null
  const consider = (diff: number, draw: () => [number, number, number][]) => {
    if (Math.abs(diff) > tol) return
    if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { diff, gaps: draw() }
  }
  if (before && after && after.lo - before.hi > size) {
    // Centered between both neighbors.
    const target = (before.hi + after.lo - size) / 2
    const b = before
    const a = after
    consider(target - m.lo, () => [
      [b.hi, target, mid(b, m)],
      [target + size, a.lo, mid(a, m)],
    ])
  }
  for (const gap of gaps) {
    if (gap.g <= 0) continue
    const matched: [number, number, number] = [gap.a.hi, gap.b.lo, mid(gap.a, gap.b)]
    if (before) {
      const target = before.hi + gap.g
      const b = before
      consider(target - m.lo, () => [[b.hi, target, mid(b, m)], matched])
    }
    if (after) {
      const target = after.lo - gap.g - size
      const a = after
      consider(target - m.lo, () => [[target + size, a.lo, mid(a, m)], matched])
    }
  }
  return best
}

function gapGuides(match: SpacingMatch, axis: 'x' | 'y'): Guide[] {
  return match.gaps.map(([from, to, cross]) => {
    const label = String(Math.round(Math.abs(to - from)))
    return axis === 'x'
      ? { kind: 'gap' as const, x1: from, y1: cross, x2: to, y2: cross, label }
      : { kind: 'gap' as const, x1: cross, y1: from, x2: cross, y2: to, label }
  })
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export interface MoveResult {
  dx: number
  dy: number
  guides: Guide[]
}

// Adjust a move of `box` (plus its own anchor points) by (dx, dy).
export function snapMove(
  scene: SnapScene,
  box: Box,
  anchors: Pt[],
  dx: number,
  dy: number,
  tol: number,
  opts: SnapOptions,
): MoveResult {
  let sx: number | null = null
  let sy: number | null = null
  let pointGuide: Guide | null = null

  if (opts.points) {
    // Every reference point of the moving thing, translated.
    const refs: Pt[] = [...boxPoints(box), ...anchors]
    let bestD = Infinity
    for (const r of refs) {
      const p = { x: r.x + dx, y: r.y + dy }
      const t = nearestPoint(scene, p, tol)
      if (!t) continue
      const d = Math.hypot(t.x - p.x, t.y - p.y)
      if (d < bestD) {
        bestD = d
        sx = t.x - p.x
        sy = t.y - p.y
        pointGuide = { kind: 'point', x: t.x, y: t.y, label: t.kind === 'artboard' ? 'artboard' : t.kind }
      }
    }
  }

  let spacingX: SpacingMatch | null = null
  let spacingY: SpacingMatch | null = null
  if (opts.guides) {
    const moved = { ...box, x: box.x + dx, y: box.y + dy }
    if (sx === null) {
      const xs = [moved.x, moved.x + moved.width / 2, moved.x + moved.width]
      const align = nearestLine(scene.vlines, xs, tol)
      const sp = spacing1D(scene, moved, 'x', tol)
      if (sp && (align === null || Math.abs(sp.diff) < Math.abs(align) - EPS)) {
        sx = sp.diff
        spacingX = sp
      } else sx = align
    }
    if (sy === null) {
      const ys = [moved.y, moved.y + moved.height / 2, moved.y + moved.height]
      const align = nearestLine(scene.hlines, ys, tol)
      const sp = spacing1D(scene, { ...moved, x: moved.x + (sx ?? 0) }, 'y', tol)
      if (sp && (align === null || Math.abs(sp.diff) < Math.abs(align) - EPS)) {
        sy = sp.diff
        spacingY = sp
      } else sy = align
    }
  }

  const ndx = dx + (sx ?? 0)
  const ndy = dy + (sy ?? 0)
  const guides: Guide[] = []
  if (opts.guides) {
    const final = { ...box, x: box.x + ndx, y: box.y + ndy }
    guides.push(...alignGuides(scene, final))
    if (spacingX) guides.push(...gapGuides(spacingX, 'x'))
    if (spacingY) guides.push(...gapGuides(spacingY, 'y'))
  }
  if (pointGuide) guides.push(pointGuide)
  return { dx: ndx, dy: ndy, guides }
}

// Snap a single point (pen anchor, node drag, shape corner).
export function snapPoint(scene: SnapScene, p: Pt, tol: number, opts: SnapOptions): { x: number; y: number; guides: Guide[] } {
  if (opts.points) {
    const t = nearestPoint(scene, p, tol)
    if (t) {
      const guides: Guide[] = [{ kind: 'point', x: t.x, y: t.y, label: t.kind }]
      if (opts.guides) guides.push(...alignGuides(scene, { x: t.x, y: t.y, width: 0, height: 0 }))
      return { x: t.x, y: t.y, guides }
    }
  }
  if (!opts.guides) return { x: p.x, y: p.y, guides: [] }
  const ax = nearestLine(scene.vlines, [p.x], tol)
  const ay = nearestLine(scene.hlines, [p.y], tol)
  const q = { x: p.x + (ax ?? 0), y: p.y + (ay ?? 0) }
  const guides = alignGuides(scene, { ...q, width: 0, height: 0 })
  if (ax !== null && ay !== null) guides.push({ kind: 'point', x: q.x, y: q.y, label: 'intersect' })
  return { ...q, guides }
}

export type Edges = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }

// Snap the moving edges of a box being resized.
export function snapEdges(scene: SnapScene, box: Box, edges: Edges, tol: number, opts: SnapOptions): { box: Box; guides: Guide[] } {
  let { x, y, width, height } = box
  let right = x + width
  let bottom = y + height
  const pointsAsLines = (axis: 'x' | 'y'): AxisLine[] =>
    opts.points ? scene.points.map((p) => ({ pos: p[axis], lo: p[axis === 'x' ? 'y' : 'x'], hi: p[axis === 'x' ? 'y' : 'x'] })) : []
  const vl = opts.guides ? scene.vlines : []
  const hl = opts.guides ? scene.hlines : []
  const vAll = [...vl, ...pointsAsLines('x')].sort((a, b) => a.pos - b.pos)
  const hAll = [...hl, ...pointsAsLines('y')].sort((a, b) => a.pos - b.pos)
  if (edges.left) x += nearestLine(vAll, [x], tol) ?? 0
  if (edges.right) right += nearestLine(vAll, [right], tol) ?? 0
  if (edges.top) y += nearestLine(hAll, [y], tol) ?? 0
  if (edges.bottom) bottom += nearestLine(hAll, [bottom], tol) ?? 0
  const out = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
  const guides = opts.guides || opts.points ? alignGuides({ ...scene, vlines: vAll, hlines: hAll }, out) : []
  return { box: out, guides }
}
