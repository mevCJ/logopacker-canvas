// SVG.js engine wiring. The store is the source of truth; this module renders
// the store's artboards + objects into an SVG.js drawing and keeps them in sync.
//
//   1. Pure helpers (no DOM) — compute attributes/geometry. Unit tested.
//   2. CanvasRenderer — mounts SVG.js and applies the store to the DOM.
//
// Note: the svg.js plugins (draggable/select/resize) augment elements with
// methods that aren't in the base type definitions, so plugin-augmented calls
// use loosely-typed element references.
import { SVG } from '@svgdotjs/svg.js'
import '@svgdotjs/svg.draggable.js'
import { splitPaint } from './color'
import { gradientId, gradientMarkup, type GradientFill } from './gradient'
import { layoutAreaText } from './textLayout'
import type { Guide } from './snapEngine'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

// Loose object shapes accepted by the pure helpers (they read a subset).
export interface RenderObject {
  id: string
  type: 'path' | 'text' | 'image'
  semanticRole?: string
  artboardId?: string | null
  x?: number
  y?: number
  width?: number
  height?: number
  baseWidth?: number
  baseHeight?: number
  rotation?: number
  opacity?: number
  d?: string
  shape?: string
  cornerRadius?: number
  fill?: string | null
  stroke?: string | null
  strokeWidth?: number
  nodes?: PathNode[]
  closed?: boolean
  subpaths?: number[]
  text?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  align?: string
  href?: string
  pathD?: string
  pathOffset?: number
  area?: boolean
  lineHeight?: number
  fillGradient?: GradientFill
  name?: string
  hidden?: boolean
  locked?: boolean
}

interface RenderArtboard {
  id: string
  name?: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor?: string
}

export interface RenderSnapshot {
  artboards: RenderArtboard[]
  objects: Record<string, RenderObject>
  objectOrder: string[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type SvgEl = any

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

export function svgElementType(obj: Pick<RenderObject, 'type'>): 'path' | 'text' | 'image' {
  switch (obj.type) {
    case 'path':
      return 'path'
    case 'text':
      return 'text'
    case 'image':
      return 'image'
    default:
      throw new Error(`Cannot map object type to SVG element: ${(obj as RenderObject).type}`)
  }
}

export function commonAttrs(obj: RenderObject): Record<string, string> {
  return {
    id: obj.id,
    'data-role': obj.semanticRole || 'none',
    'data-type': obj.type,
    'data-artboard': obj.artboardId || '',
  }
}

export function absolutePosition(
  obj: Pick<RenderObject, 'x' | 'y'>,
  artboard: Pick<RenderArtboard, 'x' | 'y'> | null | undefined,
): { x: number; y: number } {
  const ax = artboard ? artboard.x : 0
  const ay = artboard ? artboard.y : 0
  return { x: ax + (obj.x || 0), y: ay + (obj.y || 0) }
}

// Paint attrs for a stored color string. A translucent rgba() paint is split
// into an opaque color + *-opacity so exported SVG stays portable. Opaque
// colors pass through verbatim. The *-opacity key is always emitted so a
// reused DOM element never keeps a stale alpha after the color turns opaque.
function paintAttrs(kind: 'fill' | 'stroke', value: string | null | undefined, fallback: string) {
  if (value == null) return { [kind]: fallback, [`${kind}-opacity`]: 1 }
  const { color, opacity } = splitPaint(value)
  return { [kind]: opacity < 1 ? color : value, [`${kind}-opacity`]: opacity }
}

// Fill attrs, pointing at the object's <defs> gradient when it has one.
function fillAttrs(obj: RenderObject, fallback: string) {
  if (obj.fillGradient) return { fill: `url(#${gradientId(obj.id)})`, 'fill-opacity': 1 }
  return paintAttrs('fill', obj.fill, fallback)
}

export function pathAttrs(obj: RenderObject): Record<string, string | number> {
  return {
    d: obj.d || '',
    ...fillAttrs(obj, 'none'),
    ...paintAttrs('stroke', obj.stroke, 'none'),
    'stroke-width': obj.strokeWidth || 0,
    opacity: obj.opacity == null ? 1 : obj.opacity,
  }
}

// Coerce a font-weight into a value the CSS/SVG engine honors. Accepts numbers
// (400), numeric strings ("700"), and the CSS keywords "normal"/"bold". Unknown
// values fall back to 400 so text never renders weightless.
export function normalizeFontWeight(weight: unknown): number | string {
  if (typeof weight === 'number' && Number.isFinite(weight)) return weight
  if (typeof weight === 'string') {
    const s = weight.trim().toLowerCase()
    if (s === 'bold') return 700
    if (s === 'normal') return 400
    const n = Number(s)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 400
}

export function textAttrs(obj: RenderObject): Record<string, string | number> {
  return {
    'font-family': obj.fontFamily || 'Inter',
    'font-size': obj.fontSize || 24,
    'font-weight': normalizeFontWeight(obj.fontWeight),
    ...fillAttrs(obj, '#000000'),
    'text-anchor': alignToAnchor(obj.align),
    opacity: obj.opacity == null ? 1 : obj.opacity,
  }
}

export function alignToAnchor(align: string | undefined): 'start' | 'middle' | 'end' {
  switch (align) {
    case 'center':
      return 'middle'
    case 'right':
      return 'end'
    default:
      return 'start'
  }
}

export function imageAttrs(obj: RenderObject): Record<string, string | number> {
  // Render at the intrinsic (base) size; the object transform scales it to the
  // displayed width/height. Falls back to display size when base is absent.
  const w = obj.baseWidth ?? obj.width ?? 0
  const h = obj.baseHeight ?? obj.height ?? 0
  return {
    href: obj.href || '',
    width: w,
    height: h,
    opacity: obj.opacity == null ? 1 : obj.opacity,
    preserveAspectRatio: 'none',
  }
}

export function zoomViewBox(box: Box, factor: number, focal?: { x: number; y: number }): Box {
  const newW = box.width / factor
  const newH = box.height / factor
  const fx = focal ? focal.x : box.x + box.width / 2
  const fy = focal ? focal.y : box.y + box.height / 2
  const relX = (fx - box.x) / box.width
  const relY = (fy - box.y) / box.height
  return {
    x: fx - newW * relX,
    y: fy - newH * relY,
    width: newW,
    height: newH,
  }
}

export function panViewBox(box: Box, dx: number, dy: number): Box {
  return { x: box.x - dx, y: box.y - dy, width: box.width, height: box.height }
}

export function clampZoom(box: Box, base: Box, min = 0.15, max = 8): Box {
  const currentZoom = base.width / box.width
  if (currentZoom < min) {
    return { x: box.x, y: box.y, width: base.width / min, height: base.height / min }
  }
  if (currentZoom > max) {
    return { x: box.x, y: box.y, width: base.width / max, height: base.height / max }
  }
  return box
}

// ---------------------------------------------------------------------------
// Shape path-data builders. Shapes are stored as `path` objects; the object's
// (x, y) carries position, so these produce geometry local to the object's
// own origin (0, 0).
// ---------------------------------------------------------------------------

export function rectPathData(width: number, height: number, radius = 0): string {
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  // Clamp the corner radius so it never exceeds half the shorter side.
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  if (r === 0) return `M0 0 H${w} V${h} H0 Z`
  // Rounded rect: straight edges joined by quarter-circle arcs at each corner.
  return (
    `M${r} 0 H${w - r} A${r} ${r} 0 0 1 ${w} ${r} ` +
    `V${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} ` +
    `H${r} A${r} ${r} 0 0 1 0 ${h - r} ` +
    `V${r} A${r} ${r} 0 0 1 ${r} 0 Z`
  )
}

export function ellipsePathData(width: number, height: number): string {
  const rx = Math.max(0, width) / 2
  const ry = Math.max(0, height) / 2
  // Two arc halves from the left-middle point around to itself.
  return `M0 ${ry} A${rx} ${ry} 0 1 0 ${rx * 2} ${ry} A${rx} ${ry} 0 1 0 0 ${ry} Z`
}

export function linePathData(x1: number, y1: number, x2: number, y2: number): string {
  return `M${x1} ${y1} L${x2} ${y2}`
}

// A single anchor on a Bézier pen path, in the path object's local/base frame.
// `in`/`out` are the absolute positions of the incoming/outgoing tangent
// control points. When a handle is absent the segment on that side is straight
// (a corner point). Illustrator-style smooth points keep in/out mirrored, but
// the model allows independent handles for later broken-handle editing.
export interface PathNode {
  x: number
  y: number
  inX?: number
  inY?: number
  outX?: number
  outY?: number
}

// Serialize an ordered list of anchors into SVG path data. A segment uses a
// cubic curve (C) when either endpoint contributes a handle, else a straight
// line (L). `closed` connects the last anchor back to the first and appends Z.
//
// `subpaths` (optional) is the node count of each subpath, letting one flat
// node list serialize as a compound path (multiple M...Z runs) — e.g. a glyph
// with a hole, or several letters in one object. When omitted, `nodes` is a
// single subpath (the original behavior). All subpaths share the `closed` flag.
export function nodesToPathData(nodes: PathNode[], closed = false, subpaths?: number[]): string {
  if (!nodes.length) return ''
  if (!subpaths || subpaths.length <= 1) return subpathToData(nodes, closed)
  // Slice the flat node list into runs and serialize each as its own subpath.
  const parts: string[] = []
  let offset = 0
  for (const count of subpaths) {
    if (count <= 0) continue
    const run = nodes.slice(offset, offset + count)
    offset += count
    if (run.length) parts.push(subpathToData(run, closed))
  }
  // Any trailing nodes not covered by `subpaths` form a final subpath.
  if (offset < nodes.length) parts.push(subpathToData(nodes.slice(offset), closed))
  return parts.join(' ')
}

// Serialize a single subpath (one M...[segments]...[Z]) from its anchors.
function subpathToData(nodes: PathNode[], closed: boolean): string {
  const first = nodes[0]
  if (!first) return ''
  let d = `M${num(first.x)} ${num(first.y)}`
  const seg = (a: PathNode, b: PathNode) => {
    const c1x = a.outX ?? a.x
    const c1y = a.outY ?? a.y
    const c2x = b.inX ?? b.x
    const c2y = b.inY ?? b.y
    const straight = a.outX === undefined && b.inX === undefined
    return straight
      ? ` L${num(b.x)} ${num(b.y)}`
      : ` C${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(b.x)} ${num(b.y)}`
  }
  for (let i = 1; i < nodes.length; i++) d += seg(nodes[i - 1]!, nodes[i]!)
  if (closed && nodes.length > 2) {
    const last = nodes[nodes.length - 1]!
    // The closing segment only needs an explicit command when it's a curve;
    // for a straight closing edge, Z draws the line back to the start.
    if (last.outX !== undefined || first.inX !== undefined) d += seg(last, first)
    d += ' Z'
  }
  return d
}

// Round to a stable 3 decimals so serialized path data stays compact and
// deterministic (avoids float noise like 40.000000001 in tests + diffs).
function num(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Live corners: a corner is an anchor where two straight segments meet at an
// angle. Rounding replaces it with a circular arc (one cubic) of radius r,
// tangent to both edges, while the sharp anchors stay the editable source.
// ---------------------------------------------------------------------------

export interface PathCorner {
  index: number // into the flat node list
  x: number
  y: number
  // Unit directions of the incoming and outgoing edges.
  u1: { x: number; y: number }
  u2: { x: number; y: number }
  // Interior angle between the edges, in radians (π = straight).
  angle: number
  // Largest radius whose arc fits in half of each adjacent edge.
  maxRadius: number
}

// Node runs (start, count) of a flat node list split by `subpaths`.
function nodeRuns(total: number, subpaths?: number[]): [number, number][] {
  if (!subpaths || subpaths.length <= 1) return [[0, total]]
  const runs: [number, number][] = []
  let start = 0
  for (const c of subpaths) {
    if (c > 0) runs.push([start, c])
    start += c
  }
  if (start < total) runs.push([start, total - start])
  return runs
}

export function pathCorners(nodes: PathNode[], closed: boolean, subpaths?: number[]): PathCorner[] {
  const out: PathCorner[] = []
  for (const [start, count] of nodeRuns(nodes.length, subpaths)) {
    if (count < 3) continue
    for (let k = 0; k < count; k++) {
      if (!closed && (k === 0 || k === count - 1)) continue
      const n = nodes[start + k]!
      const prev = nodes[start + ((k - 1 + count) % count)]!
      const next = nodes[start + ((k + 1) % count)]!
      if (n.inX !== undefined || n.outX !== undefined || prev.outX !== undefined || next.inX !== undefined) continue
      const l1 = Math.hypot(n.x - prev.x, n.y - prev.y)
      const l2 = Math.hypot(next.x - n.x, next.y - n.y)
      if (l1 < 1e-9 || l2 < 1e-9) continue
      const u1 = { x: (n.x - prev.x) / l1, y: (n.y - prev.y) / l1 }
      const u2 = { x: (next.x - n.x) / l2, y: (next.y - n.y) / l2 }
      const angle = Math.acos(Math.max(-1, Math.min(1, -(u1.x * u2.x + u1.y * u2.y))))
      if (angle > Math.PI - 0.01 || angle < 0.01) continue
      out.push({ index: start + k, x: n.x, y: n.y, u1, u2, angle, maxRadius: (Math.min(l1, l2) / 2) * Math.tan(angle / 2) })
    }
  }
  return out
}

// The nodes with every corner rounded to radius r (clamped per corner).
export function roundCorners(
  nodes: PathNode[],
  closed: boolean,
  subpaths: number[] | undefined,
  r: number,
): { nodes: PathNode[]; subpaths?: number[] } {
  if (!(r > 0)) return { nodes, subpaths }
  const corners = new Map(pathCorners(nodes, closed, subpaths).map((c) => [c.index, c]))
  if (!corners.size) return { nodes, subpaths }
  const outNodes: PathNode[] = []
  const counts: number[] = []
  for (const [start, count] of nodeRuns(nodes.length, subpaths)) {
    let added = 0
    for (let k = 0; k < count; k++) {
      const c = corners.get(start + k)
      if (!c) {
        outNodes.push(nodes[start + k]!)
        added++
        continue
      }
      const rr = Math.min(r, c.maxRadius)
      const t = rr / Math.tan(c.angle / 2)
      // A circular arc through a turn of φ = π − angle: handle length
      // 4/3·tan(φ/4)·r.
      const h = (4 / 3) * Math.tan((Math.PI - c.angle) / 4) * rr
      const a = { x: c.x - c.u1.x * t, y: c.y - c.u1.y * t }
      const b = { x: c.x + c.u2.x * t, y: c.y + c.u2.y * t }
      outNodes.push({ x: a.x, y: a.y, outX: a.x + c.u1.x * h, outY: a.y + c.u1.y * h })
      outNodes.push({ x: b.x, y: b.y, inX: b.x - c.u2.x * h, inY: b.y - c.u2.y * h })
      added += 2
    }
    counts.push(added)
  }
  return { nodes: outNodes, subpaths: counts.length > 1 ? counts : undefined }
}

// Path data for a node path with its live corners applied.
export function roundedPathData(nodes: PathNode[], closed: boolean, subpaths: number[] | undefined, r = 0): string {
  const out = roundCorners(nodes, closed, subpaths, r)
  return nodesToPathData(out.nodes, closed, out.subpaths)
}

// Shift-drag constraint for shapes: a square box from `from` toward `to`.
export function constrainSquare(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: from.x + (dx < 0 ? -side : side), y: from.y + (dy < 0 ? -side : side) }
}

// Axis-aligned bounds of a set of anchors, including their tangent handles so
// the object box encloses the visible curve, not just the anchor points.
export function nodesBounds(nodes: PathNode[]): Box {
  const pts: { x: number; y: number }[] = []
  for (const n of nodes) {
    pts.push({ x: n.x, y: n.y })
    if (n.inX !== undefined && n.inY !== undefined) pts.push({ x: n.inX, y: n.inY })
    if (n.outX !== undefined && n.outY !== undefined) pts.push({ x: n.outX, y: n.outY })
  }
  return pointsBounds(pts)
}

// Shift every anchor + handle by (dx, dy). Returns new node objects.
export function translateNodes(nodes: PathNode[], dx: number, dy: number): PathNode[] {
  return nodes.map((n) => ({
    x: n.x + dx,
    y: n.y + dy,
    inX: n.inX === undefined ? undefined : n.inX + dx,
    inY: n.inY === undefined ? undefined : n.inY + dy,
    outX: n.outX === undefined ? undefined : n.outX + dx,
    outY: n.outY === undefined ? undefined : n.outY + dy,
  }))
}

// Apply a drag delta (dx, dy in the path's local frame) to one node's anchor or
// a tangent handle, returning a new node list. Dragging the anchor moves the
// anchor and both handles together. Dragging a handle moves that control point
// and mirrors its opposite handle about the anchor (smooth-point behavior).
export function applyNodeDrag(
  nodes: PathNode[],
  index: number,
  kind: 'anchor' | 'in' | 'out',
  dx: number,
  dy: number,
): PathNode[] {
  return nodes.map((n, i) => {
    if (i !== index) return { ...n }
    if (kind === 'anchor') {
      return {
        x: n.x + dx,
        y: n.y + dy,
        inX: n.inX === undefined ? undefined : n.inX + dx,
        inY: n.inY === undefined ? undefined : n.inY + dy,
        outX: n.outX === undefined ? undefined : n.outX + dx,
        outY: n.outY === undefined ? undefined : n.outY + dy,
      }
    }
    const next: PathNode = { ...n }
    if (kind === 'out') {
      next.outX = (n.outX ?? n.x) + dx
      next.outY = (n.outY ?? n.y) + dy
      // Mirror the in handle about the anchor to keep the point smooth.
      next.inX = n.x - (next.outX - n.x)
      next.inY = n.y - (next.outY - n.y)
    } else {
      next.inX = (n.inX ?? n.x) + dx
      next.inY = (n.inY ?? n.y) + dy
      next.outX = n.x - (next.inX - n.x)
      next.outY = n.y - (next.inY - n.y)
    }
    return next
  })
}

// Axis-aligned bounds of a set of points. Returns a zero-size box at the point
// (or origin) when there aren't enough points to span an area.
export function pointsBounds(points: { x: number; y: number }[]): Box {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// Normalize a drag defined by two points into an axis-aligned box with a
// non-negative width/height, regardless of drag direction.
export function normalizeDragBox(
  start: { x: number; y: number },
  current: { x: number; y: number },
): Box {
  const x = Math.min(start.x, current.x)
  const y = Math.min(start.y, current.y)
  const width = Math.abs(current.x - start.x)
  const height = Math.abs(current.y - start.y)
  return { x, y, width, height }
}

// Axis-aligned box overlap test (used for marquee hit-testing).
export function boxIntersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

// Merge marquee hit-test results into a selection. Additive (shift) unions the
// hits with the current selection; otherwise the hits replace it. Preserves
// order (current first) and de-duplicates.
export function mergeMarqueeSelection(
  current: string[],
  hits: string[],
  additive: boolean,
): string[] {
  if (!additive) return [...new Set(hits)]
  return [...new Set([...current, ...hits])]
}

// Point-in-box test.
function pointInArtboard(p: { x: number; y: number }, a: RenderArtboard): boolean {
  return p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height
}

// Return the artboard under a canvas-space point. If the point is over several
// (overlapping) artboards, the last one in paint order wins. Falls back to the
// first artboard when the point is over none, and null when there are none.
export function resolveArtboardAtPoint(
  artboards: RenderArtboard[] | undefined,
  point: { x: number; y: number },
): RenderArtboard | null {
  if (!artboards || artboards.length === 0) return null
  let hit: RenderArtboard | null = null
  for (const a of artboards) {
    if (pointInArtboard(point, a)) hit = a
  }
  return hit || artboards[0] || null
}

// Strict variant of resolveArtboardAtPoint: returns the topmost artboard the
// point actually falls inside, or null when it's over none. Unlike
// resolveArtboardAtPoint there is no first-artboard fallback, which is what
// drag-to-reparent needs — dragging into empty canvas should detach, not snap
// the object into an unrelated artboard.
export function artboardAtPoint(
  artboards: RenderArtboard[] | undefined,
  point: { x: number; y: number },
): RenderArtboard | null {
  if (!artboards || artboards.length === 0) return null
  let hit: RenderArtboard | null = null
  for (const a of artboards) {
    if (pointInArtboard(point, a)) hit = a
  }
  return hit
}

// ---------------------------------------------------------------------------
// Resize + rotation geometry. All operate in canvas coordinates. `box` is the
// object's axis-aligned bounds { x, y, width, height } in the UN-rotated frame;
// rotation is applied about the box center.
// ---------------------------------------------------------------------------

// The 8 resize handles plus the rotation handle above the top edge.
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type HandleId = ResizeHandle | 'rotate'

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}
export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

// Rotate point p around center by `deg` degrees (clockwise in screen space,
// where +y points down).
export function rotatePoint(
  center: { x: number; y: number },
  p: { x: number; y: number },
  deg: number,
): { x: number; y: number } {
  const a = degToRad(deg)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}

export function boxCenter(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Display/base scale of a path or image (its geometry is authored at base
// size). An axis with no extent — a straight horizontal or vertical line — has
// nothing to scale, so it stays 1 instead of collapsing the shape to nothing.
export function axisScale(display: number | undefined, base: number | undefined): number {
  const d = display || 0
  const b = base ?? d
  return b && d ? d / b : 1
}

// Build the SVG transform string for an object placed at absolute (absX, absY)
// with the given scale and rotation. Order (SVG applies right-to-left):
//   translate → rotate about the pivot → scale about the origin.
// The rotate pivot is in POST-SCALE local space. It defaults to the nominal box
// center (displayWidth/2, displayHeight/2), but pass cx/cy for the geometry's
// true center when the content is offset from its origin (e.g. an imported path
// whose `d` doesn't start at 0,0) so rotation anchors on the visible center.
// `scaleX`/`scaleY` default to 1 (e.g. text, which carries size via fontSize).
export function objectTransform(
  absX: number,
  absY: number,
  displayWidth: number,
  displayHeight: number,
  rotationDeg = 0,
  scaleX = 1,
  scaleY = 1,
  cx = displayWidth / 2,
  cy = displayHeight / 2,
): string {
  const parts = [`translate(${absX} ${absY})`]
  if (rotationDeg) parts.push(`rotate(${rotationDeg} ${cx} ${cy})`)
  if (scaleX !== 1 || scaleY !== 1) parts.push(`scale(${scaleX} ${scaleY})`)
  return parts.join(' ')
}

// The affine transform a path/image object applies to its local geometry,
// mirroring objectTransform's order: scale (about local origin), then rotate
// about the post-scale pivot (cx, cy), then translate by (absX, absY). Kept as
// explicit params so the node-edit overlay maps points with the exact same math
// the renderer uses — instead of the browser's getCTM, whose reference frame
// (viewBox units vs CSS pixels) is engine-dependent and drifts the overlay off
// the shape.
export interface ObjectTransformParams {
  absX: number
  absY: number
  rotationDeg: number
  scaleX: number
  scaleY: number
  cx: number
  cy: number
}

// Map a point from an object's local/base frame to canvas (viewBox) space.
export function nodePointToCanvas(
  p: { x: number; y: number },
  t: ObjectTransformParams,
): { x: number; y: number } {
  const scaled = { x: p.x * t.scaleX, y: p.y * t.scaleY }
  const rotated = t.rotationDeg ? rotatePoint({ x: t.cx, y: t.cy }, scaled, t.rotationDeg) : scaled
  return { x: rotated.x + t.absX, y: rotated.y + t.absY }
}

// Inverse of nodePointToCanvas: canvas point -> object local/base frame.
export function canvasPointToNode(
  p: { x: number; y: number },
  t: ObjectTransformParams,
): { x: number; y: number } {
  const translated = { x: p.x - t.absX, y: p.y - t.absY }
  const unrotated = t.rotationDeg
    ? rotatePoint({ x: t.cx, y: t.cy }, translated, -t.rotationDeg)
    : translated
  return { x: t.scaleX ? unrotated.x / t.scaleX : 0, y: t.scaleY ? unrotated.y / t.scaleY : 0 }
}

// Local (un-rotated) positions of every handle for a box. The rotation handle
// sits `rotateOffset` canvas units above the top-middle handle.
export function handlePositions(
  box: Box,
  rotateOffset = 24,
): Record<HandleId, { x: number; y: number }> {
  const { x, y, width: w, height: h } = box
  const cx = x + w / 2
  const cy = y + h / 2
  return {
    nw: { x, y },
    n: { x: cx, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: cy },
    se: { x: x + w, y: y + h },
    s: { x: cx, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: cy },
    rotate: { x: cx, y: y - rotateOffset },
  }
}

// Which corner/edge stays anchored while dragging a given handle (its opposite).
const OPPOSITE: Record<ResizeHandle, ResizeHandle> = {
  nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e',
}

// Compute the new box when a resize handle is dragged by (dx, dy) in CANVAS
// space. Rotation is accounted for by projecting the pointer delta onto the
// object's local axes so a rotated object resizes along its own edges. The
// anchor (opposite handle) is kept fixed in canvas space, so the box position
// shifts as needed. When keepAspect is true, corner handles preserve the box's
// original aspect ratio.
export function resizeBoxFromHandle(
  box: Box,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  rotationDeg = 0,
  keepAspect = false,
  min = 4,
): Box {
  const center = boxCenter(box)
  const positions = handlePositions(box)
  const anchorLocal = positions[OPPOSITE[handle]]
  const anchorCanvas = rotatePoint(center, anchorLocal, rotationDeg)

  // Project the canvas-space delta into the object's local frame.
  const a = degToRad(-rotationDeg)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const localDx = dx * cos - dy * sin
  const localDy = dx * sin + dy * cos

  const affectsX = handle === 'e' || handle === 'w' || handle.length === 2
  const affectsY = handle === 'n' || handle === 's' || handle.length === 2
  const west = handle === 'nw' || handle === 'w' || handle === 'sw'
  const north = handle === 'nw' || handle === 'n' || handle === 'ne'

  let newW = box.width + (affectsX ? (west ? -localDx : localDx) : 0)
  let newH = box.height + (affectsY ? (north ? -localDy : localDy) : 0)
  // A zero-extent axis (a straight horizontal/vertical line) stays flat: only
  // its length scales.
  newW = box.width ? Math.max(min, newW) : 0
  newH = box.height ? Math.max(min, newH) : 0

  if (keepAspect && handle.length === 2 && box.width && box.height) {
    const ratio = box.width / box.height || 1
    // Drive both dims off the larger relative change to feel natural.
    if (newW / box.width > newH / box.height) newH = newW / ratio
    else newW = newH * ratio
  }

  // Rebuild the box so the anchor corner stays put in canvas space. The anchor's
  // local position within the NEW box mirrors the dragged handle.
  const newBoxLocalAnchor = handlePositions({ x: 0, y: 0, width: newW, height: newH })[
    OPPOSITE[handle]
  ]
  // New center in canvas space: anchorCanvas is the rotated anchor; the center
  // is anchorCanvas minus the rotated offset from box-center to that anchor.
  const offset = { x: newBoxLocalAnchor.x - newW / 2, y: newBoxLocalAnchor.y - newH / 2 }
  const rotatedOffset = {
    x: offset.x * Math.cos(degToRad(rotationDeg)) - offset.y * Math.sin(degToRad(rotationDeg)),
    y: offset.x * Math.sin(degToRad(rotationDeg)) + offset.y * Math.cos(degToRad(rotationDeg)),
  }
  const newCenter = { x: anchorCanvas.x - rotatedOffset.x, y: anchorCanvas.y - rotatedOffset.y }
  return { x: newCenter.x - newW / 2, y: newCenter.y - newH / 2, width: newW, height: newH }
}

// Invert a resize: given the object's current local origin (ox, oy) and stored
// size, plus the visual box it occupied before (startBox) and the target box
// after (newBox) in the SAME space, return the new local origin + size. Keeps
// the geometry aligned under the outline regardless of the object's bbox offset
// or a base/geometry mismatch (e.g. seeded paths whose d ≠ stored dims).
export function invertResizeBox(
  origin: { x: number; y: number },
  size: { width: number; height: number },
  startBox: Box,
  newBox: Box,
): { x: number; y: number; width: number; height: number } {
  const rx = startBox.width ? newBox.width / startBox.width : 1
  const ry = startBox.height ? newBox.height / startBox.height : 1
  const offsetX = origin.x - startBox.x
  const offsetY = origin.y - startBox.y
  return {
    x: newBox.x + offsetX * rx,
    y: newBox.y + offsetY * ry,
    width: Math.max(1, size.width * rx),
    height: Math.max(1, size.height * ry),
  }
}

// Angle in degrees from a center to a pointer, measured so that 0° means the
// pointer is directly above the center (the rotation handle's rest position).
export function rotationFromPointer(
  center: { x: number; y: number },
  pointer: { x: number; y: number },
): number {
  const angle = radToDeg(Math.atan2(pointer.y - center.y, pointer.x - center.x))
  // atan2 gives 0° at east; the handle rests north, so add 90°.
  return ((angle + 90) % 360 + 360) % 360
}

// Corners of a box rotated `deg` about its center, clockwise from top-left.
export function rotatedCorners(box: Box, deg: number): { x: number; y: number }[] {
  const c = boxCenter(box)
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((p) => rotatePoint(c, p, deg))
}

// Axis-aligned box around a set of points.
export function boundsOfPoints(pts: { x: number; y: number }[]): Box | null {
  if (!pts.length) return null
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

// A transform applied to a whole multi-selection: its bounding box scaled
// from one box to another, or everything turned `deg` about a center.
export type GroupOp =
  | { kind: 'scale'; from: Box; to: Box }
  | { kind: 'rotate'; center: { x: number; y: number }; deg: number }

export function mapGroupPoint(op: GroupOp, p: { x: number; y: number }): { x: number; y: number } {
  if (op.kind === 'rotate') return rotatePoint(op.center, p, op.deg)
  const fx = axisScale(op.to.width, op.from.width)
  const fy = axisScale(op.to.height, op.from.height)
  return { x: op.to.x + (p.x - op.from.x) * fx, y: op.to.y + (p.y - op.from.y) * fy }
}

// The same op as an SVG transform, for previewing it on the live elements.
export function groupOpTransform(op: GroupOp): string {
  if (op.kind === 'rotate') return `rotate(${op.deg} ${op.center.x} ${op.center.y})`
  const fx = axisScale(op.to.width, op.from.width)
  const fy = axisScale(op.to.height, op.from.height)
  return `matrix(${fx} 0 0 ${fy} ${op.to.x - op.from.x * fx} ${op.to.y - op.from.y * fy})`
}

// How one object of a multi-selection changes under a group op. `origin` is
// the object's canvas-space translate and `center` its rotation pivot. Its
// center follows the op exactly; a rotate adds to its angle, and a scale
// stretches it along its own axes by how much the op lengthens each axis
// (exact for uniform scales and right-angle rotations). `uniform` scales both
// axes alike, for text whose size is a single font size.
export function transformInGroup(
  item: { origin: { x: number; y: number }; center: { x: number; y: number }; rotation: number },
  op: GroupOp,
  uniform = false,
): { origin: { x: number; y: number }; rotation: number; lx: number; ly: number } {
  const c = mapGroupPoint(op, item.center)
  const ox = item.center.x - item.origin.x
  const oy = item.center.y - item.origin.y
  if (op.kind === 'rotate') {
    const rotation = (((item.rotation + op.deg) % 360) + 360) % 360
    return { origin: { x: c.x - ox, y: c.y - oy }, rotation, lx: 1, ly: 1 }
  }
  const fx = axisScale(op.to.width, op.from.width)
  const fy = axisScale(op.to.height, op.from.height)
  const a = degToRad(item.rotation)
  let lx = Math.hypot(fx * Math.cos(a), fy * Math.sin(a))
  let ly = Math.hypot(fx * Math.sin(a), fy * Math.cos(a))
  if (uniform) lx = ly = Math.sqrt(lx * ly)
  // The pivot sits at the post-scale geometry center, so its offset from the
  // origin scales with the object.
  return { origin: { x: c.x - ox * lx, y: c.y - oy * ly }, rotation: item.rotation, lx, ly }
}

// Build the store payload for a shape drawn from `start` to `current` (both in
// canvas coordinates) over the given artboard. Position is converted to the
// artboard's local space. Returns null for a degenerate (zero-size) drag.
// Map a canvas-space point to a screen-space position within the host element,
// given the current viewBox and the host's bounding rect. Used to overlay HTML
// (e.g. the inline text editor) on top of the SVG canvas. Also returns the
// pixels-per-canvas-unit scale so callers can size overlays to match zoom.
export function canvasPointToScreenRect(
  point: { x: number; y: number },
  viewBox: Box,
  hostRect: { left: number; top: number; width: number; height: number },
): { left: number; top: number; scale: number } {
  const scaleX = hostRect.width / viewBox.width
  const scaleY = hostRect.height / viewBox.height
  return {
    left: hostRect.left + (point.x - viewBox.x) * scaleX,
    top: hostRect.top + (point.y - viewBox.y) * scaleY,
    // Uniform scale (viewBox preserves aspect via the SVG); use X.
    scale: scaleX,
  }
}

export function buildShapePayload(
  type: 'rect' | 'ellipse' | 'line',
  start: { x: number; y: number },
  current: { x: number; y: number },
  artboard: { x: number; y: number } | null,
): {
  type: 'path'
  shape: 'rect' | 'ellipse' | 'line'
  d: string
  x: number
  y: number
  width: number
  height: number
  cornerRadius?: number
  fill: string
  stroke: string
  strokeWidth: number
  semanticRole: string
} | null {
  const ax = artboard ? artboard.x : 0
  const ay = artboard ? artboard.y : 0

  if (type === 'line') {
    if (start.x === current.x && start.y === current.y) return null
    const localX1 = start.x - ax
    const localY1 = start.y - ay
    const localX2 = current.x - ax
    const localY2 = current.y - ay
    const x = Math.min(localX1, localX2)
    const y = Math.min(localY1, localY2)
    return {
      type: 'path',
      shape: 'line',
      // Path data is stored relative to the object origin (x, y).
      d: linePathData(localX1 - x, localY1 - y, localX2 - x, localY2 - y),
      x,
      y,
      width: Math.abs(localX2 - localX1),
      height: Math.abs(localY2 - localY1),
      fill: 'none',
      stroke: '#211A43',
      strokeWidth: 2,
      semanticRole: 'decorative',
    }
  }

  const box = normalizeDragBox(start, current)
  if (box.width < 1 || box.height < 1) return null
  const d = type === 'ellipse' ? ellipsePathData(box.width, box.height) : rectPathData(box.width, box.height)
  return {
    type: 'path',
    shape: type,
    d,
    x: box.x - ax,
    y: box.y - ay,
    width: box.width,
    height: box.height,
    ...(type === 'rect' ? { cornerRadius: 0 } : {}),
    fill: '#211A43',
    stroke: 'none',
    strokeWidth: 0,
    semanticRole: 'decorative',
  }
}

// Build the store payload for a Bézier pen path from anchors given in CANVAS
// coordinates. Anchors (and their handles) are converted to the artboard's
// local space, then normalized so the object origin (x, y) is the geometry's
// bounding-box top-left and the stored `nodes`/`d` are relative to it. A closed
// path is filled; an open one is stroked. Returns null for < 2 anchors.
export function buildPenNodesPayload(
  nodes: PathNode[],
  artboard: { x: number; y: number } | null,
  closed = false,
): {
  type: 'path'
  d: string
  nodes: PathNode[]
  closed: boolean
  x: number
  y: number
  width: number
  height: number
  fill: string
  stroke: string
  strokeWidth: number
  semanticRole: string
} | null {
  if (!nodes || nodes.length < 2) return null
  const ax = artboard ? artboard.x : 0
  const ay = artboard ? artboard.y : 0
  const local = translateNodes(nodes, -ax, -ay)
  const bounds = nodesBounds(local)
  const rel = translateNodes(local, -bounds.x, -bounds.y)
  return {
    type: 'path',
    d: nodesToPathData(rel, closed),
    nodes: rel,
    closed,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fill: closed ? '#211A43' : 'none',
    stroke: closed ? 'none' : '#211A43',
    strokeWidth: closed ? 0 : 2,
    semanticRole: 'decorative',
  }
}

// Shift-constrain a point to the nearest 45° direction from `from` (Illustrator
// pen/line behavior: horizontal, vertical or diagonal), keeping the distance
// measured along that direction.
export function constrainAngle(
  from: { x: number; y: number },
  to: { x: number; y: number },
  stepDeg = 45,
): { x: number; y: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (!dx && !dy) return { ...to }
  const step = (stepDeg * Math.PI) / 180
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const len = dx * cos + dy * sin
  const r = (n: number) => (Math.abs(n) < 1e-9 ? 0 : n)
  return { x: from.x + r(len * cos), y: from.y + r(len * sin) }
}

// Reverse a run of anchors (so its last anchor becomes its first), swapping
// each anchor's in/out handles so the curve is unchanged.
export function reverseNodes(nodes: PathNode[]): PathNode[] {
  return [...nodes].reverse().map((n) => ({ x: n.x, y: n.y, inX: n.outX, inY: n.outY, outX: n.inX, outY: n.inY }))
}

export function documentBounds(artboards: RenderArtboard[] | undefined, padding = 200): Box {
  if (!artboards || artboards.length === 0) {
    return { x: 0, y: 0, width: 1000, height: 700 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ab of artboards) {
    minX = Math.min(minX, ab.x)
    minY = Math.min(minY, ab.y)
    maxX = Math.max(maxX, ab.x + ab.width)
    maxY = Math.max(maxY, ab.y + ab.height)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  }
}

// ---------------------------------------------------------------------------
// 2. CanvasRenderer — DOM-bound (used in the browser only)
// ---------------------------------------------------------------------------

export type ObjectMountedHook = (obj: RenderObject, el: SvgEl) => void
export type DragEndHook = (
  id: string,
  delta: { dx: number; dy: number; alt: boolean },
) => void
export type ResizeHook = (
  id: string,
  box: { x: number; y: number; width: number; height: number },
) => void
export type RotateHook = (id: string, degrees: number) => void
// One object's new geometry after a multi-selection scale or rotate.
export interface GroupTransformPatch {
  id: string
  // Artboard-local origin and display size, as stored on the object.
  x: number
  y: number
  width: number
  height: number
  rotation: number
  // Uniform factor for sizes the transform doesn't carry (font size).
  scale: number
}
export type GroupTransformHook = (patches: GroupTransformPatch[], kind: GroupOp['kind']) => void
export type ArtboardMountedHook = (artboard: RenderArtboard, els: { group: SvgEl; label: SvgEl }) => void
export type ArtboardResizeHook = (
  id: string,
  box: { x: number; y: number; width: number; height: number },
) => void

// Edge identifiers for artboard resizing.
export type ArtboardEdge = 'n' | 's' | 'e' | 'w'

// Compute a new artboard box when one edge is dragged by (dx, dy) in canvas
// units. Keeps the opposite edge anchored and enforces a minimum size. Pure so
// it can be unit tested without the DOM.
export function resizeArtboardBox(
  box: { x: number; y: number; width: number; height: number },
  edge: ArtboardEdge,
  dx: number,
  dy: number,
  min = 20,
): { x: number; y: number; width: number; height: number } {
  let { x, y, width, height } = box
  switch (edge) {
    case 'e':
      width = Math.max(min, box.width + dx)
      break
    case 's':
      height = Math.max(min, box.height + dy)
      break
    case 'w': {
      const w = Math.max(min, box.width - dx)
      x = box.x + (box.width - w)
      width = w
      break
    }
    case 'n': {
      const h = Math.max(min, box.height - dy)
      y = box.y + (box.height - h)
      height = h
      break
    }
  }
  return { x, y, width, height }
}

export class CanvasRenderer {
  mountEl: HTMLElement
  draw: SvgEl
  artboardLayer: SvgEl
  objectLayer: SvgEl
  overlayLayer: SvgEl
  handleLayer: SvgEl
  hoverLayer: SvgEl
  artboardOverlayLayer: SvgEl
  ghostLayer: SvgEl
  toolLayer: SvgEl
  guideLayer: SvgEl
  private _artboardEls = new Map<string, SvgEl>()
  private _objectEls = new Map<string, SvgEl>()
  // <defs> guide paths for text-on-path objects, keyed by text object id.
  private _textPathDefs = new Map<string, SVGPathElement>()
  // <defs> gradients keyed by object id, with the markup they were built from
  // so unchanged gradients aren't rebuilt on every render.
  private _gradientDefs = new Map<string, { el: Element; markup: string }>()

  onObjectMounted: ObjectMountedHook | null = null
  onObjectDragEnd: DragEndHook | null = null
  onObjectResized: ResizeHook | null = null
  onObjectRotated: RotateHook | null = null
  onObjectsTransformed: GroupTransformHook | null = null
  onArtboardMounted: ArtboardMountedHook | null = null
  onArtboardResized: ArtboardResizeHook | null = null
  // Fired when the node-edit tool commits a reshape (drag of an anchor/handle).
  // Nodes are in the object's local/base frame, ready for store.updatePathNodes.
  onPathNodesChanged: ((id: string, nodes: PathNode[]) => void) | null = null
  // Whether pressing an object may start an object drag. svg.draggable stops
  // propagation on press, so when another tool is active (pen, shape builder,
  // space-pan…) the drag must be vetoed for the stage to receive the press.
  canDragObjects: () => boolean = () => true
  // Snapping hooks (smart guides / snap to point), supplied by the host. Each
  // returns the adjusted value; the host also draws guides via showGuides.
  snapMove: ((ids: string[], dx: number, dy: number, ev?: MouseEvent) => { dx: number; dy: number }) | null = null
  snapResize: ((id: string, handle: ResizeHandle, box: Box, ev: MouseEvent) => Box) | null = null
  snapNodePoint: ((id: string, p: { x: number; y: number }, ev: MouseEvent) => { x: number; y: number }) | null = null
  onSnapEnd: (() => void) | null = null

  // The currently selected objects (geometry needed to draw handles). Kept in
  // sync by setSelection so handle overlays can be redrawn after any render.
  private _selectedObjects: RenderObject[] = []
  private _liveBox: Box | null = null // live-preview box during a handle drag
  // When true, a single selected path is drawn with editable Bézier nodes
  // (anchors + handles) instead of the transform handles. Set by the node tool.
  private _nodeEditMode = false
  // Live node override during an anchor/handle drag (local frame), so the
  // overlay + path preview follow the pointer before the store commit.
  private _liveNodes: PathNode[] | null = null

  private _selectedArtboardId: string | null = null
  private _artboardBoxes = new Map<string, { x: number; y: number; width: number; height: number }>()

  constructor(mountEl: HTMLElement) {
    this.mountEl = mountEl
    this.draw = SVG().addTo(mountEl).size('100%', '100%')
    this.artboardLayer = this.draw.group().addClass('artboard-layer')
    this.objectLayer = this.draw.group().addClass('object-layer')
    this.overlayLayer = this.draw.group().addClass('overlay-layer')
    // Interactive resize/rotate handles for the selected object. Separate from
    // overlayLayer because those outlines are pointer-events:none.
    this.handleLayer = this.draw.group().addClass('handle-layer')
    // Direct Selection hover preview (outline + anchors), never interactive.
    this.hoverLayer = this.draw.group().addClass('hover-layer').attr({ 'pointer-events': 'none' })
    // Overlay dedicated to artboard selection outline + resize handles. Kept
    // above the object overlay so its handles stay clickable.
    this.artboardOverlayLayer = this.draw.group().addClass('artboard-overlay-layer')
    // Dedicated layer for the drag ghost. Kept separate from the overlay layer
    // because selection redraws call overlayLayer.clear(), which would wipe the
    // ghost the moment the drag also selects the object.
    this.ghostLayer = this.draw.group().addClass('ghost-layer')
    // Transient overlays for the user tools (marquee selection, shape-draw
    // preview). Kept on their own top layer so store re-renders and selection
    // redraws never clear them.
    this.toolLayer = this.draw.group().addClass('tool-layer')
    // Smart guides draw above everything and never take pointer events.
    this.guideLayer = this.draw.group().addClass('guide-layer').attr({ 'pointer-events': 'none' })
  }

  // Outline view: a class on the root <svg>; CanvasStage styles it into a
  // wireframe so no object attributes have to change.
  setViewMode(mode: 'preview' | 'outline'): void {
    if (mode === 'outline') this.draw.addClass('outline-mode')
    else this.draw.removeClass('outline-mode')
  }

  // The rendered element for an object (null when not rendered). Used by tools
  // that need the live geometry, e.g. the shape builder's canvas-space paths.
  getObjectElement(id: string): SVGGraphicsElement | null {
    const el = this._objectEls.get(id)
    return el ? (el.node as SVGGraphicsElement) : null
  }

  render(snapshot: RenderSnapshot): void {
    this._renderArtboards(snapshot.artboards || [])
    this._renderObjects(snapshot)
  }

  setViewBox(box: Box): void {
    this.draw.viewbox(box.x, box.y, box.width, box.height)
  }

  getViewBox(): Box {
    const vb = this.draw.viewbox()
    return { x: vb.x, y: vb.y, width: vb.width, height: vb.height }
  }

  screenToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const svg = this.draw.node as SVGSVGElement
    // Use the browser's own screen->user-space transform, which correctly
    // accounts for preserveAspectRatio letterboxing (the root SVG defaults to
    // xMidYMid meet). The naive rect-ratio mapping stretches each axis
    // independently and drifts off the cursor whenever the element and viewBox
    // aspect ratios differ.
    const ctm = svg.getScreenCTM?.()
    if (ctm) {
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const local = pt.matrixTransform(ctm.inverse())
      return { x: local.x, y: local.y }
    }
    // Fallback for non-DOM/test environments without getScreenCTM.
    const rect = svg.getBoundingClientRect()
    const vb = this.getViewBox()
    const relX = (clientX - rect.left) / rect.width
    const relY = (clientY - rect.top) / rect.height
    return {
      x: vb.x + relX * vb.width,
      y: vb.y + relY * vb.height,
    }
  }

  // Update the selection. Pass the selected objects (geometry) so single
  // selection can draw rotate-aware resize handles. When only ids are known,
  // handles fall back to the axis-aligned bounding box.
  setSelection(ids: string[] = [], objects: RenderObject[] = []): void {
    const set = new Set(ids)
    for (const [id, el] of this._objectEls) {
      if (set.has(id)) el.addClass('is-selected')
      else el.removeClass('is-selected')
    }
    this._selectedObjects = objects.filter((o) => set.has(o.id))
    // Selecting a different object drops the anchor selection.
    if (this._nodeSelId && !(ids.length === 1 && ids[0] === this._nodeSelId)) {
      this._nodeSelId = null
      this._nodeSel = new Set()
    }
    this._liveBox = null
    this._liveNodes = null
    this._redrawSelection()
  }

  // Toggle node-edit rendering. When enabled and a single node-based path is
  // selected, the selection shows draggable anchors + tangent handles.
  setNodeEditMode(on: boolean): void {
    if (this._nodeEditMode === on) return
    this._nodeEditMode = on
    this._liveNodes = null
    this._redrawSelection()
  }

  // Approximate the box a text object occupies when the platform can't measure
  // it (empty string / not yet laid out). The renderer places the text baseline
  // at y = fontSize, so the glyph box starts ~one fontSize above the baseline;
  // `ascent` shifts the box up to sit over the visible glyphs.
  private _textFallbackBox(obj: RenderObject): { width: number; height: number; ascent: number } {
    const fontSize = obj.fontSize || 24
    const chars = Math.max((obj.text || '').length, 1)
    // Rough monospace-ish estimate; good enough for an editing outline.
    const width = Math.max(obj.width || 0, chars * fontSize * 0.6, fontSize)
    const height = fontSize * 1.2
    return { width, height, ascent: fontSize }
  }

  // Absolute (canvas-space) bounding box of an object, in its un-rotated frame.
  private _objectBox(obj: RenderObject): Box | null {
    const ab = obj.artboardId ? this._artboardBoxes.get(obj.artboardId) : null
    const ax = ab ? ab.x : 0
    const ay = ab ? ab.y : 0
    const originX = ax + (obj.x || 0)
    const originY = ay + (obj.y || 0)

    // Geometry-driven types (path, text) may have stored width/height that
    // don't match their actual rendered extent — seeded/imported paths default
    // to 100×100, and a path's `d` can start off-origin. Measure the element's
    // local bbox (the platform already knows the exact geometry bounds) and map
    // it through the object's translate + scale so the outline hugs the shape.
    // Area type: the box itself is the bounds (text inside may be shorter).
    if (obj.type === 'text' && obj.area && !obj.pathD) {
      return { x: originX, y: originY, width: obj.width || 0, height: obj.height || 0 }
    }
    if (obj.type === 'path' || obj.type === 'text') {
      const el = this._objectEls.get(obj.id)
      if (el) {
        try {
          const b = el.bbox()
          // An empty (or still-being-typed) text element measures 0×0, which
          // would collapse the selection outline + handles to a point. Fall
          // back to a fontSize-derived box so the boundary is visible and the
          // handles remain usable.
          if (obj.type === 'text' && (!b.width || !b.height)) {
            const fallback = this._textFallbackBox(obj)
            return { x: originX, y: originY - fallback.ascent, width: fallback.width, height: fallback.height }
          }
          const dispW = obj.width || 0
          const dispH = obj.height || 0
          const sx = obj.type === 'text' ? 1 : axisScale(dispW, obj.baseWidth)
          const sy = obj.type === 'text' ? 1 : axisScale(dispH, obj.baseHeight)
          return {
            x: originX + b.x * sx,
            y: originY + b.y * sy,
            width: b.width * sx,
            height: b.height * sy,
          }
        } catch {
          /* fall through to stored dims */
        }
      }
    }
    return { x: originX, y: originY, width: obj.width || 0, height: obj.height || 0 }
  }

  // Public accessor for an object's measured, canvas-space bounds in its
  // un-rotated frame. Uses the same measurement as the selection outline (real
  // SVG bbox for paths/text), so callers get the true rendered extent rather
  // than the object's possibly-stale stored width/height. Returns null when the
  // object isn't currently rendered.
  measureObjectBox(obj: RenderObject): Box | null {
    return this._objectBox(obj)
  }

  // Hide the selection's transform box and handles (e.g. while the Pen tool
  // is active, as in Illustrator); the selection itself is unchanged.
  private _chromeHidden = false
  setSelectionChromeHidden(on: boolean): void {
    if (this._chromeHidden === on) return
    this._chromeHidden = on
    this._redrawSelection()
  }

  private _redrawSelection(): void {
    this.overlayLayer.clear()
    this.handleLayer.clear()
    if (this._selectedObjects.length === 0 || this._chromeHidden) return

    const vb = this.getViewBox()
    const strokeW = Math.max(1, vb.width / 600)

    if (this._selectedObjects.length > 1) {
      // Multi-selection: each object's own outline, plus one bounding box
      // around them all whose handles scale and rotate the whole selection.
      for (const obj of this._selectedObjects) {
        const box = this._objectBox(obj)
        if (!box) continue
        this._framePolygon(box, obj.rotation || 0, strokeW * 0.6)
      }
      const group = this._groupBox()
      if (group) {
        this._drawTransformFrame(group, 0, strokeW, {
          resize: (h) => this._wireGroupResize(h),
          rotate: () => this._wireGroupRotate(),
        })
      }
      return
    }

    const obj = this._selectedObjects[0]!
    // Node-edit mode: a node-based path shows anchors + handles instead of the
    // transform box. Falls through to normal handles for other objects.
    if (this._nodeEditMode && obj.type === 'path' && this._editNodes(obj).length) {
      this._drawNodeEditor(obj, strokeW)
      this._drawCornerWidgets(obj)
      return
    }
    const box = this._liveBox || this._objectBox(obj)
    if (!box) return
    this._drawSingleSelection(obj, box, strokeW)
    if (!this._liveBox) this._drawCornerWidgets(obj)
  }

  // ---- Live corners --------------------------------------------------------

  // A path's corners (local frame) and its current corner radius, supplied by
  // the host. Null/empty for paths with no sharp corners.
  resolveCorners: ((obj: RenderObject) => { corners: PathCorner[]; radius: number } | null) | null = null
  // Fired while a corner widget is dragged, with the new radius in the
  // object's base frame.
  onCornerRadiusDrag: ((id: string, radius: number, phase: 'start' | 'move' | 'end') => void) | null = null

  // Illustrator's corner widgets: a small double circle inside each sharp
  // corner, on the corner's bisector. Dragging one inward rounds every corner.
  private _drawCornerWidgets(obj: RenderObject): void {
    if (obj.type !== 'path' || obj.locked) return
    const info = this.resolveCorners?.(obj)
    if (!info?.corners.length) return
    const px = this.canvasUnitsPerPixel()
    const box = this._objectBox(obj)
    const minOff = 14 * px
    // Too small on screen to hold widgets without crowding the handles.
    if (!box || Math.min(box.width, box.height) < minOff * 4) return
    const t = this._objectTransformParams(obj)
    const s = Math.sqrt(Math.abs(t.scaleX * t.scaleY)) || 1
    for (const c of info.corners) {
      const p = nodePointToCanvas(c, t)
      const bx0 = c.u2.x - c.u1.x
      const by0 = c.u2.y - c.u1.y
      const bl0 = Math.hypot(bx0, by0)
      if (bl0 < 1e-9) continue
      const q = nodePointToCanvas({ x: c.x + bx0 / bl0, y: c.y + by0 / bl0 }, t)
      const bl = Math.hypot(q.x - p.x, q.y - p.y)
      if (bl < 1e-9) continue
      const b = { x: (q.x - p.x) / bl, y: (q.y - p.y) / bl }
      const sinH = Math.sin(c.angle / 2)
      const r0 = Math.min(info.radius, c.maxRadius) * s
      // The widget sits at the arc's center once that is clear of the corner.
      const dist = Math.max(minOff, r0 / sinH)
      const w = { x: p.x + b.x * dist, y: p.y + b.y * dist }
      const g = this.handleLayer.group().attr({ 'data-corner': c.index }).css('cursor', 'pointer')
      g.circle(9 * px).center(w.x, w.y).fill('#ffffff').stroke({ color: '#2563eb', width: px })
      g.circle(3.5 * px).center(w.x, w.y).fill('#2563eb')
      // Generous invisible hit area.
      g.circle(16 * px).center(w.x, w.y).fill('transparent')
      ;(g.node as SVGElement).addEventListener('mousedown', (e: MouseEvent) => {
        e.stopPropagation()
        e.preventDefault()
        const start = this.screenToCanvas(e.clientX, e.clientY)
        const radius0 = Math.min(info.radius, c.maxRadius)
        this.onCornerRadiusDrag?.(obj.id, radius0, 'start')
        const onMove = (ev: MouseEvent) => {
          const cur = this.screenToCanvas(ev.clientX, ev.clientY)
          // Movement along the bisector, inward positive.
          const along = (cur.x - start.x) * b.x + (cur.y - start.y) * b.y
          const r = Math.max(0, (r0 + along * sinH) / s)
          this.onCornerRadiusDrag?.(obj.id, r, 'move')
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          this.onCornerRadiusDrag?.(obj.id, NaN, 'end')
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      })
    }
  }

  // Recreate the exact transform the renderer applied to this path (see
  // _renderObject): scale = display/base, rotate about the post-scale geometry
  // center, translate to the object's absolute origin. Using the same math as
  // rendering (rather than the browser's getCTM) keeps the node overlay glued
  // to the shape regardless of engine CTM quirks.
  // Map a canvas point into an object's geometry box as 0..1 fractions (the
  // objectBoundingBox space gradients use), and back. Rotation/scale aware.
  private _bboxFrame(obj: RenderObject): { t: ObjectTransformParams; b: Box } | null {
    const el = this._objectEls.get(obj.id)
    if (!el) return null
    let b: Box
    try {
      b = el.bbox()
    } catch {
      return null
    }
    if (!b.width || !b.height) return null
    const t = this._objectTransformParams(obj)
    // Text carries its size in fontSize and is never scaled (see _renderObject).
    if (obj.type === 'text') {
      t.scaleX = 1
      t.scaleY = 1
    }
    return { t, b }
  }

  canvasToObjectFraction(obj: RenderObject, p: { x: number; y: number }): { x: number; y: number } | null {
    const f = this._bboxFrame(obj)
    if (!f) return null
    const local = canvasPointToNode(p, f.t)
    return { x: (local.x - f.b.x) / f.b.width, y: (local.y - f.b.y) / f.b.height }
  }

  objectFractionToCanvas(obj: RenderObject, fr: { x: number; y: number }): { x: number; y: number } | null {
    const f = this._bboxFrame(obj)
    if (!f) return null
    return nodePointToCanvas({ x: f.b.x + fr.x * f.b.width, y: f.b.y + fr.y * f.b.height }, f.t)
  }

  // Gradient annotator: the gradient vector drawn over its object, a circle at
  // the start and a square at the end (Illustrator's gradient annotator).
  private _gradientEl: SvgEl | null = null
  showGradientAnnotator(start: { x: number; y: number }, end: { x: number; y: number }): void {
    this.hideGradientAnnotator()
    const vb = this.getViewBox()
    const w = Math.max(0.5, vb.width / 600)
    const g = this.toolLayer.group().attr({ 'pointer-events': 'none' })
    g.line(start.x, start.y, end.x, end.y).stroke({ color: '#ffffff', width: w * 3, linecap: 'round' })
    g.line(start.x, start.y, end.x, end.y).stroke({ color: '#211A43', width: w, linecap: 'round' })
    g.circle(w * 9).center(start.x, start.y).fill('#ffffff').stroke({ color: '#211A43', width: w })
    g.rect(w * 8, w * 8).center(end.x, end.y).fill('#211A43').stroke({ color: '#ffffff', width: w })
    this._gradientEl = g
  }

  // Smart guides: magenta alignment lines, equal-spacing markers with their
  // distance, a label on the snapped point, and an optional measurement
  // readout (e.g. "X 120  Y 48") near the pointer. All sizes are in screen
  // pixels converted to canvas units so they stay crisp at any zoom.
  showGuides(guides: Guide[], readout?: { x: number; y: number; text: string }): void {
    this.guideLayer.clear()
    if (!guides.length && !readout) return
    // Canvas units per screen pixel (the SVG letterboxes, so use the larger).
    const px = this.canvasUnitsPerPixel()
    const color = '#d6249f'
    const w = px
    const label = (x: number, y: number, text: string, bg: string) => {
      const fs = 10 * px
      const tw = text.length * fs * 0.62 + fs
      this.guideLayer
        .rect(tw, fs * 1.7)
        .radius(fs * 0.4)
        .move(x, y)
        .fill(bg)
      this.guideLayer
        .plain(text)
        .font({ family: 'Inter, sans-serif', size: fs, weight: 600 })
        .fill('#ffffff')
        .attr({ x: x + tw / 2, y: y + fs * 1.2, 'text-anchor': 'middle' })
    }
    for (const g of guides) {
      if (g.kind === 'align') {
        this.guideLayer.line(g.x1, g.y1, g.x2, g.y2).stroke({ color, width: w })
      } else if (g.kind === 'gap') {
        const vertical = g.x1 === g.x2
        const t = 4 * px
        this.guideLayer.line(g.x1, g.y1, g.x2, g.y2).stroke({ color, width: w })
        if (vertical) {
          this.guideLayer.line(g.x1 - t, g.y1, g.x1 + t, g.y1).stroke({ color, width: w })
          this.guideLayer.line(g.x2 - t, g.y2, g.x2 + t, g.y2).stroke({ color, width: w })
        } else {
          this.guideLayer.line(g.x1, g.y1 - t, g.x1, g.y1 + t).stroke({ color, width: w })
          this.guideLayer.line(g.x2, g.y2 - t, g.x2, g.y2 + t).stroke({ color, width: w })
        }
        const mx = (g.x1 + g.x2) / 2
        const my = (g.y1 + g.y2) / 2
        label(mx + (vertical ? 4 * px : -8 * px), my + (vertical ? -8 * px : 4 * px), g.label, color)
      } else {
        const c = 4 * px
        this.guideLayer.path(`M${g.x - c} ${g.y - c}L${g.x + c} ${g.y + c}M${g.x + c} ${g.y - c}L${g.x - c} ${g.y + c}`).stroke({ color, width: w * 1.5 })
        label(g.x + 6 * px, g.y + 6 * px, g.label, color)
      }
    }
    if (readout) label(readout.x + 12 * px, readout.y + 12 * px, readout.text, '#3f3f46')
  }

  hideGuides(): void {
    this.guideLayer.clear()
  }

  hideGradientAnnotator(): void {
    if (this._gradientEl) {
      try {
        this._gradientEl.remove()
      } catch {
        /* noop */
      }
      this._gradientEl = null
    }
  }

  // Canvas units per screen pixel at the current zoom.
  canvasUnitsPerPixel(): number {
    const sc = this._canvasScale()
    const v = Math.max(sc.sx, sc.sy)
    // Unmeasurable canvas (hidden pane, test DOM): assume ~800px across.
    return Number.isFinite(v) && v > 0 ? v : this.getViewBox().width / 800
  }

  // Map points in an object's local/base frame (e.g. path anchors) to canvas
  // space, with the exact transform the renderer applies.
  objectLocalToCanvas(obj: RenderObject, pts: { x: number; y: number }[]): { x: number; y: number }[] {
    const t = this._objectTransformParams(obj)
    return pts.map((p) => nodePointToCanvas(p, t))
  }

  private _objectTransformParams(obj: RenderObject): ObjectTransformParams {
    const ab = obj.artboardId ? this._artboardBoxes.get(obj.artboardId) : null
    const absX = (ab ? ab.x : 0) + (obj.x || 0)
    const absY = (ab ? ab.y : 0) + (obj.y || 0)
    const dispW = obj.width || 0
    const dispH = obj.height || 0
    const scaleX = axisScale(dispW, obj.baseWidth)
    const scaleY = axisScale(dispH, obj.baseHeight)
    const el = this._objectEls.get(obj.id)
    const c = el
      ? this._geometryCenter(el, dispW, dispH, scaleX, scaleY)
      : { cx: dispW / 2, cy: dispH / 2 }
    return { absX, absY, rotationDeg: obj.rotation || 0, scaleX, scaleY, cx: c.cx, cy: c.cy }
  }

  // Draw the editable-node overlay (anchors + tangent handles) for a path, and
  // wire pointer drags that reshape it. Node coords are local; every drawn
  // point is mapped to canvas space via the element CTM so the overlay tracks
  // the path through any rotation/scale.
  // Editable anchors for a path: its node model, or one derived from its
  // path data by the host (shapes and imported paths without nodes).
  resolveNodes: ((obj: RenderObject) => PathNode[] | null) | null = null
  private _editNodes(obj: RenderObject): PathNode[] {
    return this._liveNodes || obj.nodes || this.resolveNodes?.(obj) || []
  }

  // Direct Selection state: which anchors of which path are selected.
  private _nodeSelId: string | null = null
  private _nodeSel = new Set<number>()

  getNodeSelection(): { id: string; indices: number[] } | null {
    if (!this._nodeSelId || !this._nodeSel.size) return null
    return { id: this._nodeSelId, indices: [...this._nodeSel].sort((a, b) => a - b) }
  }

  setNodeSelection(id: string | null, indices: number[] = []): void {
    this._nodeSelId = id
    this._nodeSel = new Set(indices)
    this._redrawSelection()
  }

  // Anchor positions of a path in canvas space (for marquee hit-testing).
  pathAnchorsOnCanvas(obj: RenderObject): { x: number; y: number }[] {
    const t = this._objectTransformParams(obj)
    return this._editNodes(obj).map((n) => nodePointToCanvas(n, t))
  }

  // A path's anchors with their Bézier handles, in canvas space.
  pathNodesOnCanvas(obj: RenderObject): PathNode[] {
    const t = this._objectTransformParams(obj)
    return this._editNodes(obj).map((n) => {
      const a = nodePointToCanvas(n, t)
      const out: PathNode = { x: a.x, y: a.y }
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

  // Thin highlight of a path's outline, drawn with the object's own transform.
  private _outline(layer: SvgEl, obj: RenderObject, strokeW: number, d?: string): void {
    const el = this._objectEls.get(obj.id)
    if (!el) return
    layer
      .path(d ?? (el.attr('d') as string))
      .attr({ transform: el.attr('transform'), 'pointer-events': 'none', 'vector-effect': 'non-scaling-stroke' })
      .fill('none')
      .stroke({ color: '#2563eb', width: strokeW / (this.canvasUnitsPerPixel() || 1) })
  }

  // Hover preview (Direct Selection): outline + hollow anchors of the path
  // under the pointer, without selecting it.
  // `openEnds`: for the pen, mark the two endpoints of an open path (where
  // clicking continues it) as larger solid squares.
  setHoverObject(obj: RenderObject | null, opts: { openEnds?: boolean } = {}): void {
    this.hoverLayer.clear()
    if (!obj || obj.type !== 'path') return
    const nodes = this._editNodes(obj)
    if (!nodes.length) return
    const px = this.canvasUnitsPerPixel()
    this._outline(this.hoverLayer, obj, px)
    const t = this._objectTransformParams(obj)
    const r = 3 * px
    nodes.forEach((n, i) => {
      const a = nodePointToCanvas(n, t)
      const end = opts.openEnds && (i === 0 || i === nodes.length - 1)
      const rr = end ? r * 1.4 : r
      this.hoverLayer
        .rect(rr * 2, rr * 2)
        .center(a.x, a.y)
        .fill(end ? '#2563eb' : '#ffffff')
        .stroke({ color: '#2563eb', width: px })
    })
  }

  private _drawNodeEditor(obj: RenderObject, _strokeW: number): void {
    const el = this._objectEls.get(obj.id)
    const nodes = this._editNodes(obj)
    if (!el || !nodes.length) return
    // Anchor selection only applies to the path it was made on.
    const sel = this._nodeSelId === obj.id ? this._nodeSel : new Set<number>()
    // Sizes in screen pixels so handles stay small and constant at any zoom.
    const perPx = this.canvasUnitsPerPixel()
    const r = 3.5 * perPx // anchor square half-size (~7px on screen)
    const hr = 2.5 * perPx // tangent-handle dot half-size (~5px on screen)
    const strokeW = perPx
    const t = this._objectTransformParams(obj)

    this._outline(this.overlayLayer, obj, strokeW)

    nodes.forEach((n, i) => {
      const a = nodePointToCanvas({ x: n.x, y: n.y }, t)
      const selected = sel.has(i)
      // Illustrator shows Bézier handles only for selected anchors.
      if (selected) {
        const drawHandle = (kind: 'in' | 'out', hx?: number, hy?: number) => {
          if (hx === undefined || hy === undefined) return
          const hp = nodePointToCanvas({ x: hx, y: hy }, t)
          this.overlayLayer
            .line(a.x, a.y, hp.x, hp.y)
            .stroke({ color: '#2563eb', width: strokeW })
            .attr({ 'pointer-events': 'none' })
          const dot = this.handleLayer
            .circle(hr * 2)
            .center(hp.x, hp.y)
            .fill('#2563eb')
            .stroke({ color: '#ffffff', width: strokeW })
            .css('cursor', 'move')
          this._wireNodeDrag(obj.id, i, kind)(dot)
        }
        drawHandle('in', n.inX, n.inY)
        drawHandle('out', n.outX, n.outY)
      }
      // Anchor square: hollow when unselected, solid when selected.
      const sq = this.handleLayer
        .rect(r * 2, r * 2)
        .center(a.x, a.y)
        .fill(selected ? '#2563eb' : '#ffffff')
        .stroke({ color: '#2563eb', width: strokeW })
        .css('cursor', 'move')
      this._wireNodeDrag(obj.id, i, 'anchor')(sq)
    })
  }

  // Wire a drag on an anchor square or a tangent-handle dot. Pressing an
  // anchor selects it (Shift toggles it in/out of the selection); dragging
  // moves every selected anchor together. Dragging a handle moves just that
  // control point (its mirror stays symmetric). Commits via
  // onPathNodesChanged on release.
  private _wireNodeDrag(id: string, index: number, kind: 'anchor' | 'in' | 'out') {
    return (el: SvgEl) => {
      const node = el.node as SVGElement
      const onDown = (e: MouseEvent) => {
        e.stopPropagation()
        e.preventDefault()
        const obj = this._selectedObjects.find((o) => o.id === id)
        const objEl = this._objectEls.get(id)
        if (!obj || obj.type !== 'path' || !objEl) return
        const base = this._editNodes(obj).map((n) => ({ ...n }))

        // Selection on press.
        let collapseOnClick = false
        if (this._nodeSelId !== id) {
          this._nodeSelId = id
          this._nodeSel = new Set()
        }
        if (kind === 'anchor') {
          if (e.shiftKey) {
            if (this._nodeSel.has(index)) this._nodeSel.delete(index)
            else this._nodeSel.add(index)
          } else if (!this._nodeSel.has(index)) {
            this._nodeSel = new Set([index])
          } else {
            // Pressing an already-selected anchor keeps the group for a drag;
            // a click without movement narrows to just this anchor.
            collapseOnClick = this._nodeSel.size > 1
          }
          this._nodeSelId = id
          this._redrawSelection()
          if (e.shiftKey && !this._nodeSel.has(index)) return
        }
        const moving = kind === 'anchor' ? [...this._nodeSel] : [index]

        const t = this._objectTransformParams(obj)
        const startCanvas = this.screenToCanvas(e.clientX, e.clientY)
        const startLocal = canvasPointToNode(startCanvas, t)
        const anchorCanvas = base[index] ? nodePointToCanvas(base[index]!, t) : null
        let moved = false
        const onMove = (ev: MouseEvent) => {
          const cur = this.screenToCanvas(ev.clientX, ev.clientY)
          let curLocal = canvasPointToNode(cur, t)
          let dx = curLocal.x - startLocal.x
          let dy = curLocal.y - startLocal.y
          // The grabbed anchor snaps where it would land; the rest follow.
          if (kind === 'anchor' && anchorCanvas && this.snapNodePoint) {
            const target = { x: anchorCanvas.x + cur.x - startCanvas.x, y: anchorCanvas.y + cur.y - startCanvas.y }
            curLocal = canvasPointToNode(this.snapNodePoint(id, target, ev), t)
            dx = curLocal.x - base[index]!.x
            dy = curLocal.y - base[index]!.y
          }
          if (Math.abs(dx) + Math.abs(dy) > 0) moved = true
          let next = base
          for (const i of moving) next = applyNodeDrag(next, i, kind, dx, dy)
          this._liveNodes = next
          this._applyLivePath(objEl, obj)
          this._redrawSelection()
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          this.onSnapEnd?.()
          const next = this._liveNodes
          this._liveNodes = null
          if (moved && next && typeof this.onPathNodesChanged === 'function') {
            this.onPathNodesChanged(id, next)
          } else {
            if (collapseOnClick) this._nodeSel = new Set([index])
            this._redrawSelection()
          }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
      node.addEventListener('mousedown', onDown)
    }
  }

  // Preview the reshaped path live during a node drag by rewriting the object
  // element's `d` (base frame) without going through the store.
  private _applyLivePath(el: SvgEl, obj: RenderObject): void {
    if (!this._liveNodes) return
    el.attr('d', nodesToPathData(this._liveNodes, !!obj.closed, obj.subpaths))
  }

  private _drawSingleSelection(obj: RenderObject, box: Box, strokeW: number): void {
    const rot = obj.rotation || 0
    // Overflowing area type: Illustrator's red "+" in the bottom-right port.
    if (obj.type === 'text' && obj.area && this._objectEls.get(obj.id)?.node.getAttribute('data-overflow')) {
      const center = boxCenter(box)
      const hs = this._handleSize()
      const s = hs * 1.4
      // Just outside the bottom-right corner, clear of the text and handles.
      const p = rotatePoint(center, { x: box.x + box.width - s * 1.6, y: box.y + box.height + s * 1.3 }, rot)
      const g = this.overlayLayer.group().attr({ 'pointer-events': 'none' })
      g.rect(s, s).center(p.x, p.y).fill('#ffffff').stroke({ color: '#dc2626', width: strokeW * 1.5 })
      g.path(`M${p.x - s * 0.3} ${p.y}H${p.x + s * 0.3}M${p.x} ${p.y - s * 0.3}V${p.y + s * 0.3}`).stroke({ color: '#dc2626', width: strokeW * 1.5 })
    }
    this._drawTransformFrame(box, rot, strokeW, {
      resize: (h) => this._wireResizeHandle(obj.id, h),
      rotate: () => this._wireRotateHandle(obj.id),
    })
  }

  private _handleSize(): number {
    return Math.max(6, this.getViewBox().width / 90) // handle square size in canvas units
  }

  // A box outline turned `rot` degrees about its center.
  private _framePolygon(box: Box, rot: number, strokeW: number): void {
    this.overlayLayer
      .polygon(rotatedCorners(box, rot).map((p) => `${p.x},${p.y}`).join(' '))
      .fill('none')
      .stroke({ color: '#2563eb', width: strokeW })
      .attr({ 'pointer-events': 'none' })
  }

  // The transform box: rotated outline, eight resize handles and the rotate
  // handle above the top edge, each wired by `wire`.
  private _drawTransformFrame(
    box: Box,
    rot: number,
    strokeW: number,
    wire: { resize: (h: ResizeHandle) => (el: SvgEl) => void; rotate: () => (el: SvgEl) => void },
  ): void {
    const center = boxCenter(box)
    const rp = (p: { x: number; y: number }) => rotatePoint(center, p, rot)
    this._framePolygon(box, rot, strokeW)

    const hs = this._handleSize()
    const local = handlePositions(box, hs * 2.2)

    // Line from top-middle to the rotation handle.
    const topMid = rp(local.n)
    const rotPos = rp(local.rotate)
    this.overlayLayer
      .line(topMid.x, topMid.y, rotPos.x, rotPos.y)
      .stroke({ color: '#2563eb', width: strokeW })
      .attr({ 'pointer-events': 'none' })

    const cursorFor: Record<ResizeHandle, string> = {
      nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    }
    const resizeHandles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
    for (const h of resizeHandles) {
      const p = rp(local[h])
      const sq = this.handleLayer
        .rect(hs, hs)
        .move(p.x - hs / 2, p.y - hs / 2)
        .fill('#ffffff')
        .stroke({ color: '#2563eb', width: strokeW })
        .attr({ 'data-handle': h })
        .css('cursor', cursorFor[h])
      wire.resize(h)(sq)
    }

    // Rotation handle (a circle).
    const rc = this.handleLayer
      .circle(hs * 1.1)
      .center(rotPos.x, rotPos.y)
      .fill('#ffffff')
      .stroke({ color: '#2563eb', width: strokeW })
      .attr({ 'data-handle': 'rotate' })
      .css('cursor', 'grab')
    wire.rotate()(rc)
  }

  // ---- Multi-selection transform ------------------------------------------

  // Canvas-space box around every selected object (rotated ones included).
  private _groupBox(): Box | null {
    const pts: { x: number; y: number }[] = []
    for (const obj of this._selectedObjects) {
      const box = this._objectBox(obj)
      if (box) pts.push(...rotatedCorners(box, obj.rotation || 0))
    }
    return boundsOfPoints(pts)
  }

  // Elements' own transforms at the start of a group drag, restored after.
  private _groupStart: Map<string, string | null> | null = null

  // Show a group op live: prefix it onto each selected element's transform
  // and draw the frame where it is going.
  private _previewGroup(op: GroupOp, frame: Box, frameRot: number): void {
    if (!this._groupStart) {
      this._groupStart = new Map()
      for (const obj of this._selectedObjects) {
        const el = this._objectEls.get(obj.id)
        if (el) this._groupStart.set(obj.id, el.node.getAttribute('transform'))
      }
    }
    const t = groupOpTransform(op)
    for (const [id, own] of this._groupStart) {
      this._objectEls.get(id)?.attr('transform', own ? `${t} ${own}` : t)
    }
    this.overlayLayer.clear()
    this.handleLayer.clear()
    this._framePolygon(frame, frameRot, Math.max(1, this.getViewBox().width / 600))
  }

  private _endGroupPreview(): void {
    for (const [id, own] of this._groupStart ?? []) this._objectEls.get(id)?.attr('transform', own)
    this._groupStart = null
  }

  // Track a group drag on the window; `step` returns the op for a pointer
  // event, which is committed through onObjectsTransformed on release.
  private _trackGroupDrag(step: (ev: MouseEvent) => GroupOp | null): void {
    let op: GroupOp | null = null
    const onMove = (ev: MouseEvent) => {
      op = step(ev)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      this._endGroupPreview()
      if (!op || !this.onObjectsTransformed) {
        this._redrawSelection()
        return
      }
      const patches = this._selectedObjects
        .map((obj) => this._groupPatch(obj, op!))
        .filter((p): p is GroupTransformPatch => !!p)
      this.onObjectsTransformed(patches, op.kind)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  private _groupPatch(obj: RenderObject, op: GroupOp): GroupTransformPatch | null {
    const box = this._objectBox(obj)
    if (!box) return null
    const ab = obj.artboardId ? this._artboardBoxes.get(obj.artboardId) : null
    const ax = ab ? ab.x : 0
    const ay = ab ? ab.y : 0
    // Point type has one size (its font size), so it scales uniformly.
    const uniform = obj.type === 'text' && !obj.area
    const r = transformInGroup(
      { origin: { x: ax + (obj.x || 0), y: ay + (obj.y || 0) }, center: boxCenter(box), rotation: obj.rotation || 0 },
      op,
      uniform,
    )
    return {
      id: obj.id,
      x: r.origin.x - ax,
      y: r.origin.y - ay,
      width: (obj.width || 0) * r.lx,
      height: (obj.height || 0) * r.ly,
      rotation: r.rotation,
      scale: Math.sqrt(r.lx * r.ly),
    }
  }

  private _wireGroupResize(handle: ResizeHandle) {
    return (el: SvgEl) => {
      el.node.addEventListener('mousedown', (e: MouseEvent) => {
        e.stopPropagation()
        e.preventDefault()
        const from = this._groupBox()
        if (!from || (from.width < 1 && from.height < 1)) return
        const origin = { x: e.clientX, y: e.clientY }
        this._trackGroupDrag((ev) => {
          const { sx, sy } = this._canvasScale()
          const dx = (ev.clientX - origin.x) * sx
          const dy = (ev.clientY - origin.y) * sy
          const to = resizeBoxFromHandle(from, handle, dx, dy, 0, ev.shiftKey)
          const op: GroupOp = { kind: 'scale', from, to }
          this._previewGroup(op, to, 0)
          return op
        })
      })
    }
  }

  private _wireGroupRotate() {
    return (el: SvgEl) => {
      el.node.addEventListener('mousedown', (e: MouseEvent) => {
        e.stopPropagation()
        e.preventDefault()
        const frame = this._groupBox()
        if (!frame) return
        const center = boxCenter(frame)
        const start = rotationFromPointer(center, this.screenToCanvas(e.clientX, e.clientY))
        this._trackGroupDrag((ev) => {
          let deg = rotationFromPointer(center, this.screenToCanvas(ev.clientX, ev.clientY)) - start
          // Snap to 15° increments while Shift is held.
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15
          const op: GroupOp = { kind: 'rotate', center, deg }
          this._previewGroup(op, frame, deg)
          return op
        })
      })
    }
  }

  private _canvasScale(): { sx: number; sy: number } {
    const rect = (this.draw.node as SVGSVGElement).getBoundingClientRect()
    const vb = this.getViewBox()
    return { sx: vb.width / rect.width, sy: vb.height / rect.height }
  }

  // Convert a target visual box (canvas space) into a store patch. The visual
  // box and the stored x/y/width/height differ because a path's geometry (d)
  // can be offset from its origin and its base size may not equal its bbox.
  // We map through the applied scale so position + size round-trip exactly.
  private _resizePatch(
    obj: RenderObject,
    startBox: Box,
    newBox: Box,
  ): { x: number; y: number; width: number; height: number } {
    const ab = obj.artboardId ? this._artboardBoxes.get(obj.artboardId) : null
    const ax = ab ? ab.x : 0
    const ay = ab ? ab.y : 0
    const inv = invertResizeBox(
      { x: ax + (obj.x || 0), y: ay + (obj.y || 0) },
      { width: obj.width || 0, height: obj.height || 0 },
      startBox,
      newBox,
    )
    return { x: inv.x - ax, y: inv.y - ay, width: inv.width, height: inv.height }
  }

  private _wireResizeHandle(id: string, handle: ResizeHandle) {
    return (el: SvgEl) => {
      const node = el.node as SVGElement
      const onDown = (e: MouseEvent) => {
        e.stopPropagation()
        e.preventDefault()
        const obj = this._selectedObjects.find((o) => o.id === id)
        if (!obj) return
        const startBox = this._objectBox(obj)
        // A straight line is flat on one axis; it still resizes along the other.
        if (!startBox || (startBox.width < 1 && startBox.height < 1)) return
        const rot = obj.rotation || 0
        const origin = { x: e.clientX, y: e.clientY }
        const onMove = (ev: MouseEvent) => {
          const { sx, sy } = this._canvasScale()
          const dx = (ev.clientX - origin.x) * sx
          const dy = (ev.clientY - origin.y) * sy
          let next = resizeBoxFromHandle(startBox, handle, dx, dy, rot, ev.shiftKey)
          // Edge snapping for unrotated, free (non-proportional) resizes.
          if (this.snapResize && !rot && !ev.shiftKey) next = this.snapResize(id, handle, next, ev)
          this._liveBox = next
          this._redrawSelection()
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          this.onSnapEnd?.()
          const box = this._liveBox
          this._liveBox = null
          if (box && typeof this.onObjectResized === 'function') {
            this.onObjectResized(id, this._resizePatch(obj, startBox, box))
          } else {
            this._redrawSelection()
          }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
      node.addEventListener('mousedown', onDown)
    }
  }

  private _wireRotateHandle(id: string) {
    return (el: SvgEl) => {
      const node = el.node as SVGElement
      const onDown = (e: MouseEvent) => {
        e.stopPropagation()
        e.preventDefault()
        const obj = this._selectedObjects.find((o) => o.id === id)
        if (!obj) return
        const box = this._objectBox(obj)
        if (!box) return
        const center = boxCenter(box)
        let last = obj.rotation || 0
        const onMove = (ev: MouseEvent) => {
          const p = this.screenToCanvas(ev.clientX, ev.clientY)
          let deg = rotationFromPointer(center, p)
          // Snap to 15° increments while Shift is held.
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15
          last = deg
          // Live preview: rotate the actual element + redraw handles.
          const objEl = this._objectEls.get(id)
          if (objEl) {
            const dispW = obj.width || 0
            const dispH = obj.height || 0
            const sx = obj.type === 'text' ? 1 : axisScale(dispW, obj.baseWidth)
            const sy = obj.type === 'text' ? 1 : axisScale(dispH, obj.baseHeight)
            const ab = obj.artboardId ? this._artboardBoxes.get(obj.artboardId) : null
            const ax = ab ? ab.x : 0
            const ay = ab ? ab.y : 0
            const c = this._geometryCenter(objEl, dispW, dispH, sx, sy)
            objEl.attr(
              'transform',
              objectTransform(ax + (obj.x || 0), ay + (obj.y || 0), dispW, dispH, deg, sx, sy, c.cx, c.cy),
            )
          }
          this._selectedObjects = this._selectedObjects.map((o) =>
            o.id === id ? { ...o, rotation: deg } : o,
          )
          this._redrawSelection()
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          if (typeof this.onObjectRotated === 'function') this.onObjectRotated(id, last)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
      node.addEventListener('mousedown', onDown)
    }
  }

  private _renderArtboards(artboards: RenderArtboard[]): void {
    const seen = new Set<string>()
    this._artboardBoxes.clear()
    for (const ab of artboards) {
      seen.add(ab.id)
      this._artboardBoxes.set(ab.id, {
        x: ab.x,
        y: ab.y,
        width: ab.width,
        height: ab.height,
      })
      let el = this._artboardEls.get(ab.id)
      let isNew = false
      if (!el) {
        isNew = true
        el = this.artboardLayer.group().attr('data-artboard-id', ab.id)
        const rect = el.rect().addClass('artboard-bg')
        const label = el.text('').addClass('artboard-label')
        el.remember('rect', rect)
        el.remember('label', label)
        this._artboardEls.set(ab.id, el)
      }
      const rect = el.remember('rect')
      rect
        .size(ab.width, ab.height)
        .move(ab.x, ab.y)
        .fill(ab.backgroundColor || '#FFFFFF')
        .stroke({ color: '#e4e4e7', width: 1 })
      const label = el.remember('label')
      label
        .text(ab.name || '')
        .font({ family: 'Inter', size: 13, weight: 500 })
        .fill('#71717a')
        .move(ab.x, ab.y - 22)

      if (isNew && typeof this.onArtboardMounted === 'function') {
        this.onArtboardMounted(ab, { group: el, label })
      }
    }
    for (const [id, el] of this._artboardEls) {
      if (!seen.has(id)) {
        el.remove()
        this._artboardEls.delete(id)
      }
    }
    // Re-apply the artboard selection overlay so it tracks size/position changes
    // after each render.
    this.setArtboardSelection(this._selectedArtboardId)
  }

  // Draw the artboard selection outline plus draggable edge handles. Passing
  // null clears the overlay.
  setArtboardSelection(id: string | null): void {
    this._selectedArtboardId = id && this._artboardBoxes.has(id) ? id : null
    this.artboardOverlayLayer.clear()
    // Reflect selection on the artboard name label.
    for (const [abId, group] of this._artboardEls) {
      const label = group.remember('label')
      if (!label) continue
      if (abId === this._selectedArtboardId) label.addClass('is-selected')
      else label.removeClass('is-selected')
    }
    if (!this._selectedArtboardId) return
    const box = this._artboardBoxes.get(this._selectedArtboardId)
    if (!box) return
    const vb = this.getViewBox()
    const strokeW = Math.max(1, vb.width / 500)
    const handleLen = strokeW * 2

    // Selection outline.
    this.artboardOverlayLayer
      .rect(box.width, box.height)
      .move(box.x, box.y)
      .fill('none')
      .stroke({ color: '#2563eb', width: strokeW })
      .attr({ 'pointer-events': 'none' })

    // Edge handles: thin rectangles laid over each edge that capture drags.
    const edges: {
      edge: ArtboardEdge
      x: number
      y: number
      w: number
      h: number
      cursor: string
    }[] = [
      { edge: 'n', x: box.x, y: box.y - handleLen / 2, w: box.width, h: handleLen, cursor: 'ns-resize' },
      { edge: 's', x: box.x, y: box.y + box.height - handleLen / 2, w: box.width, h: handleLen, cursor: 'ns-resize' },
      { edge: 'w', x: box.x - handleLen / 2, y: box.y, w: handleLen, h: box.height, cursor: 'ew-resize' },
      { edge: 'e', x: box.x + box.width - handleLen / 2, y: box.y, w: handleLen, h: box.height, cursor: 'ew-resize' },
    ]
    for (const e of edges) {
      const handle = this.artboardOverlayLayer
        .rect(e.w, e.h)
        .move(e.x, e.y)
        .fill('#2563eb')
        .opacity(0.001) // effectively invisible but still hit-testable
        .attr({ 'data-artboard-edge': e.edge })
        .css('cursor', e.cursor)
      this._wireArtboardEdge(this._selectedArtboardId, e.edge, handle)
    }
  }

  private _wireArtboardEdge(id: string, edge: ArtboardEdge, handle: SvgEl): void {
    const el = handle.node as SVGElement
    const onDown = (e: MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      const start = this._artboardBoxes.get(id)
      if (!start) return
      const origin = { x: e.clientX, y: e.clientY }
      const scale = () => {
        const rect = (this.draw.node as SVGSVGElement).getBoundingClientRect()
        const vb = this.getViewBox()
        return { sx: vb.width / rect.width, sy: vb.height / rect.height }
      }
      const onMove = (ev: MouseEvent) => {
        const { sx, sy } = scale()
        const dx = (ev.clientX - origin.x) * sx
        const dy = (ev.clientY - origin.y) * sy
        const next = resizeArtboardBox(start, edge, dx, dy)
        // Live preview of the outline/handles while dragging.
        this._artboardBoxes.set(id, next)
        this.setArtboardSelection(id)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        const finalBox = this._artboardBoxes.get(id)
        if (finalBox && typeof this.onArtboardResized === 'function') {
          this.onArtboardResized(id, finalBox)
        }
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
    el.addEventListener('mousedown', onDown)
  }

  private _renderObjects(snapshot: RenderSnapshot): void {
    const order = snapshot.objectOrder || []
    const objects = snapshot.objects || {}
    const artboardMap = new Map((snapshot.artboards || []).map((a) => [a.id, a]))
    const seen = new Set<string>()

    for (const id of order) {
      const obj = objects[id]
      if (!obj) continue
      seen.add(id)
      const artboard = obj.artboardId ? artboardMap.get(obj.artboardId) : undefined
      const el = this._renderObject(obj, artboard)
      // _renderObject reuses the cached element and never re-appends it, so DOM
      // paint order otherwise stays frozen at creation order. Re-assert it here:
      // walking `order` and sending each to front leaves the layer in exactly
      // objectOrder's sequence, so layering (send to front/back) takes effect.
      el.front()
    }

    for (const [id, el] of this._objectEls) {
      if (!seen.has(id)) {
        el.remove()
        this._objectEls.delete(id)
      }
    }
    for (const [id, def] of this._gradientDefs) {
      const o = objects[id]
      if (!o || !o.fillGradient) {
        def.el.remove()
        this._gradientDefs.delete(id)
      }
    }
    for (const [id, def] of this._textPathDefs) {
      const o = objects[id]
      if (!o || o.type !== 'text' || !o.pathD) {
        def.remove()
        this._textPathDefs.delete(id)
      }
    }
  }

  // Create/refresh the <defs> gradient an object's fill points at.
  private _applyGradient(obj: RenderObject): void {
    if (!obj.fillGradient) return
    const markup = gradientMarkup(gradientId(obj.id), obj.fillGradient)
    const cached = this._gradientDefs.get(obj.id)
    if (cached && cached.markup === markup) return
    const NS = 'http://www.w3.org/2000/svg'
    const holder = document.createElementNS(NS, 'svg')
    holder.innerHTML = markup
    const el = holder.firstElementChild
    if (!el) return
    const defs = this.draw.defs().node as Element
    if (cached) cached.el.replaceWith(el)
    else defs.appendChild(el)
    this._gradientDefs.set(obj.id, { el, markup })
  }

  // Area type: one <tspan> per wrapped line that fits the box. Overflow is
  // flagged on the element for the selection overlay's marker.
  private _applyAreaText(obj: RenderObject, el: SvgEl): void {
    const NS = 'http://www.w3.org/2000/svg'
    const node = el.node as SVGTextElement
    const { lines, overflow } = layoutAreaText(obj)
    node.textContent = ''
    for (const line of lines) {
      const t = document.createElementNS(NS, 'tspan')
      t.setAttribute('x', String(line.x))
      t.setAttribute('y', String(line.y))
      t.textContent = line.text
      node.appendChild(t)
    }
    node.removeAttribute('x')
    node.removeAttribute('y')
    node.style.whiteSpace = 'pre'
    if (overflow) node.setAttribute('data-overflow', '1')
    else node.removeAttribute('data-overflow')
  }

  // Hide a text object while it's being edited in place (the editor overlay
  // draws the live text instead).
  private _editingId: string | null = null
  setEditingObject(id: string | null): void {
    if (this._editingId) this._objectEls.get(this._editingId)?.removeClass('is-editing')
    this._editingId = id
    if (id) this._objectEls.get(id)?.addClass('is-editing')
  }

  // Lay text out along its guide path: a <defs> path (in the text's local
  // frame) referenced by a <textPath> child. Returns false for plain text.
  private _applyTextPath(obj: RenderObject, el: SvgEl): boolean {
    if (!obj.pathD) return false
    const NS = 'http://www.w3.org/2000/svg'
    const defId = `tp-${obj.id}`
    let def = this._textPathDefs.get(obj.id)
    if (!def) {
      def = document.createElementNS(NS, 'path') as SVGPathElement
      def.setAttribute('id', defId)
      ;(this.draw.defs().node as Element).appendChild(def)
      this._textPathDefs.set(obj.id, def)
    }
    def.setAttribute('d', obj.pathD)
    const node = el.node as SVGTextElement
    let tp = node.firstElementChild
    if (!tp || tp.tagName.toLowerCase() !== 'textpath' || node.childNodes.length !== 1) {
      node.textContent = ''
      tp = document.createElementNS(NS, 'textPath')
      node.appendChild(tp)
    }
    tp.setAttribute('href', `#${defId}`)
    tp.setAttribute('startOffset', `${obj.pathOffset ?? 0}%`)
    if (tp.textContent !== (obj.text || '')) tp.textContent = obj.text || ''
    // Positioning comes from the path; a baseline x/y would offset the glyphs.
    node.removeAttribute('x')
    node.removeAttribute('y')
    return true
  }

  // Post-scale local center of an element's actual geometry, used as the
  // rotation pivot so rotation anchors on the visible center even when the
  // content is offset from its origin. Falls back to the nominal box center.
  private _geometryCenter = (el: SvgEl, dispW: number, dispH: number, sx: number, sy: number) => {
    try {
      const b = el.bbox()
      if (b && (b.width || b.height)) {
        return { cx: (b.x + b.width / 2) * sx, cy: (b.y + b.height / 2) * sy }
      }
    } catch {
      /* fall through */
    }
    return { cx: dispW / 2, cy: dispH / 2 }
  }

  private _renderObject(obj: RenderObject, artboard: RenderArtboard | undefined): SvgEl {
    let el = this._objectEls.get(obj.id)
    const pos = absolutePosition(obj, artboard)

    if (el && (el.node as Element).tagName.toLowerCase() !== svgElementType(obj)) {
      el.remove()
      el = undefined
      this._objectEls.delete(obj.id)
    }

    let isNew = false
    if (!el) {
      isNew = true
      if (obj.type === 'path') el = this.objectLayer.path()
      else if (obj.type === 'text') el = this.objectLayer.text('')
      else el = this.objectLayer.image()
      el.addClass('canvas-object')
      this._objectEls.set(obj.id, el)
    }

    el.attr(commonAttrs(obj))
    this._applyGradient(obj)
    // Layers panel state: hidden objects don't paint; locked ones ignore the
    // pointer (so they can't be clicked, dragged or picked by tools).
    el.attr('display', obj.hidden ? 'none' : null)
    el.attr('pointer-events', obj.locked ? 'none' : null)

    const rot = obj.rotation || 0
    const dispW = obj.width || 0
    const dispH = obj.height || 0

    if (obj.type === 'path') {
      el.attr(pathAttrs(obj))
      // Path geometry (d) is authored at base size; scale to the display size.
      const sx = axisScale(dispW, obj.baseWidth)
      const sy = axisScale(dispH, obj.baseHeight)
      const c = this._geometryCenter(el, dispW, dispH, sx, sy)
      el.attr('transform', objectTransform(pos.x, pos.y, dispW, dispH, rot, sx, sy, c.cx, c.cy))
    } else if (obj.type === 'text') {
      const onPath = this._applyTextPath(obj, el)
      const isArea = !onPath && !!obj.area
      if (isArea) this._applyAreaText(obj, el)
      else if (!onPath) el.text(obj.text || '')
      el.attr(textAttrs(obj))
      // Area type is clickable anywhere over its text block, not just glyphs.
      if (isArea && !obj.locked) el.attr('pointer-events', 'bounding-box')
      // Apply typography as INLINE STYLE, not just presentation attributes.
      // The global reset (`*, *::before, *::after { font-weight: normal }` in
      // base.css) sets font-weight via a CSS selector, which beats an SVG
      // presentation attribute (`font-weight="700"`). Inline style has higher
      // priority than that selector, so the requested weight/family/size win.
      // `fontWeight` may arrive as a keyword ("bold") or number; normalize it.
      if (typeof (el as any).css === 'function') {
        ;(el as any).css({
          'font-family': obj.fontFamily || 'Inter',
          'font-size': `${obj.fontSize || 24}px`,
          'font-weight': normalizeFontWeight(obj.fontWeight),
        })
      }
      // Text carries its size via fontSize (no scale distortion); only rotate.
      // Rotate about the glyph bbox center so rotation anchors on the visible text.
      if (!onPath && !isArea) el.attr({ x: 0, y: obj.fontSize || 24 })
      // Area type rotates about its box center; others about their glyphs.
      const c = isArea ? { cx: dispW / 2, cy: dispH / 2 } : this._geometryCenter(el, dispW, dispH, 1, 1)
      el.attr('transform', objectTransform(pos.x, pos.y, dispW, dispH, rot, 1, 1, c.cx, c.cy))
    } else if (obj.type === 'image') {
      el.attr(imageAttrs(obj))
      el.attr({ x: 0, y: 0 })
      const sx = axisScale(dispW, obj.baseWidth)
      const sy = axisScale(dispH, obj.baseHeight)
      el.attr('transform', objectTransform(pos.x, pos.y, dispW, dispH, rot, sx, sy))
    }

    if (isNew) {
      this._wireDrag(obj, el)
      if (typeof this.onObjectMounted === 'function') {
        this.onObjectMounted(obj, el)
      }
    }
    return el
  }

  private _wireDrag(obj: RenderObject, el: SvgEl): void {
    // Pointer position at drag start, in canvas space. svg.draggable reports
    // its box/deltas in the element's own coordinate frame, which a rotated or
    // scaled object turns and stretches, so the delta is measured here instead.
    let startPt: { x: number; y: number } | null = null
    const pointerDelta = (ev: MouseEvent | TouchEvent | undefined) => {
      if (!startPt || !ev) return null
      const p = 'changedTouches' in ev ? ev.changedTouches[0] : ev
      if (!p) return null
      const c = this.screenToCanvas(p.clientX, p.clientY)
      return { dx: c.x - startPt.x, dy: c.y - startPt.y }
    }
    // Ghost: a translucent clone that follows the cursor during the drag. The
    // real element stays put until the user drops, at which point we commit the
    // final delta to the store.
    // A container group holding a translucent clone of every element being
    // dragged: the whole selection when the grabbed object is part of it, else
    // just that one. Each clone keeps its own transform (which, for text and
    // paths, carries its position); translating the container moves them all,
    // so a single group transform tracks the cursor for every element type.
    let ghost: SvgEl | null = null

    const clearGhost = () => {
      if (ghost) {
        try {
          ghost.remove()
        } catch {
          /* noop */
        }
        ghost = null
      }
    }

    el.draggable()
    el.on('beforedrag', (e: CustomEvent) => {
      if (!this.canDragObjects()) e.preventDefault()
    })
    // Ids being moved and the last (possibly snapped) delta shown.
    let dragIds: string[] = []
    let lastDelta: { dx: number; dy: number } | null = null
    el.on('dragstart', (e: CustomEvent) => {
      const startEv = (e.detail as { event?: MouseEvent | TouchEvent }).event
      const sp = startEv && ('changedTouches' in startEv ? startEv.changedTouches[0] : startEv)
      startPt = sp ? this.screenToCanvas(sp.clientX, sp.clientY) : null
      clearGhost()
      lastDelta = null
      const selectedIds0 = this._selectedObjects.map((o) => o.id)
      dragIds = selectedIds0.includes(obj.id) ? selectedIds0 : [obj.id]
      try {
        const ghostIds = dragIds
        const group = this.ghostLayer.group().attr({ 'pointer-events': 'none' }).opacity(0.5)
        for (const gid of ghostIds) {
          const src = gid === obj.id ? el : this._objectEls.get(gid)
          if (!src) continue
          const clone = src.clone()
          group.add(clone)
          clone
            .attr({ id: null, 'pointer-events': 'none', 'data-ghost': gid })
            .removeClass('canvas-object')
            .removeClass('is-selected')
        }
        ghost = group
      } catch {
        ghost = null
      }
    })
    el.on('dragmove', (e: CustomEvent) => {
      // Stop the plugin from moving the real element; move the ghost instead so
      // the original stays fixed while the preview tracks the cursor.
      e.preventDefault()
      const detail = e.detail as { event?: MouseEvent }
      const raw = pointerDelta(detail.event)
      if (ghost && raw) {
        let { dx, dy } = raw
        if (this.snapMove) ({ dx, dy } = this.snapMove(dragIds, dx, dy, detail.event))
        lastDelta = { dx, dy }
        try {
          ghost.attr('transform', `translate(${dx} ${dy})`)
        } catch {
          /* noop */
        }
      }
    })
    el.on('dragend', (e: CustomEvent) => {
      clearGhost()
      const detail = e.detail as { event?: MouseEvent }
      this.onSnapEnd?.()
      const raw = pointerDelta(detail.event)
      if (!raw) return
      // Commit what the ghost showed (the snapped delta), not the raw pointer.
      const dx = lastDelta ? lastDelta.dx : raw.dx
      const dy = lastDelta ? lastDelta.dy : raw.dy
      startPt = null
      lastDelta = null
      if ((dx === 0 && dy === 0) || typeof this.onObjectDragEnd !== 'function') {
        return
      }
      this.onObjectDragEnd(obj.id, { dx, dy, alt: !!detail.event?.altKey })
    })
  }

  getObjectEl(id: string): SvgEl | null {
    return this._objectEls.get(id) || null
  }

  // ---- Tool overlays (marquee + shape preview) --------------------------
  private _marqueeEl: SvgEl | null = null
  private _previewEl: SvgEl | null = null
  private _penEl: SvgEl | null = null

  // Draw/update the marquee selection rectangle. Box is in canvas coordinates.
  showMarquee(box: Box): void {
    const vb = this.getViewBox()
    const strokeW = Math.max(0.5, vb.width / 900)
    if (!this._marqueeEl) {
      this._marqueeEl = this.toolLayer
        .rect(box.width, box.height)
        .fill({ color: '#2563eb', opacity: 0.08 })
        .stroke({ color: '#2563eb', width: strokeW, dasharray: `${strokeW * 3},${strokeW * 2}` })
        .attr({ 'pointer-events': 'none' })
    }
    this._marqueeEl
      .size(Math.max(0, box.width), Math.max(0, box.height))
      .move(box.x, box.y)
      .stroke({ color: '#2563eb', width: strokeW, dasharray: `${strokeW * 3},${strokeW * 2}` })
  }

  hideMarquee(): void {
    if (this._marqueeEl) {
      try {
        this._marqueeEl.remove()
      } catch {
        /* noop */
      }
      this._marqueeEl = null
    }
  }

  // Draw/update a live preview of the shape being drawn. Box in canvas coords.
  showShapePreview(type: 'rect' | 'ellipse' | 'line', box: Box): void {
    const vb = this.getViewBox()
    const strokeW = Math.max(0.5, vb.width / 700)
    this.hideShapePreview()
    if (type === 'line') {
      this._previewEl = this.toolLayer
        .line(box.x, box.y, box.x + box.width, box.y + box.height)
        .stroke({ color: '#211A43', width: strokeW * 2 })
        .attr({ 'pointer-events': 'none' })
      return
    }
    if (type === 'ellipse') {
      this._previewEl = this.toolLayer
        .ellipse(Math.max(0, box.width), Math.max(0, box.height))
        .move(box.x, box.y)
    } else {
      this._previewEl = this.toolLayer.rect(Math.max(0, box.width), Math.max(0, box.height)).move(box.x, box.y)
    }
    this._previewEl
      .fill({ color: '#211A43', opacity: 0.15 })
      .stroke({ color: '#211A43', width: strokeW })
      .attr({ 'pointer-events': 'none' })
  }

  // Shape Builder overlay: every region outlined (dashed), the hovered one
  // tinted, and the regions swept by the current drag filled blue (merge) or
  // red (erase). Paths are canvas-space path data.
  private _regionsEl: SvgEl | null = null
  showShapeRegions(regions: { d: string; state: 'idle' | 'hover' | 'merge' | 'erase' }[]): void {
    this.hideShapeRegions()
    const vb = this.getViewBox()
    const strokeW = Math.max(0.5, vb.width / 700)
    const g = this.toolLayer.group().attr({ 'pointer-events': 'none' })
    const styles = {
      idle: { fill: 'none', opacity: 0 },
      hover: { fill: '#2563eb', opacity: 0.18 },
      merge: { fill: '#2563eb', opacity: 0.35 },
      erase: { fill: '#ef4444', opacity: 0.35 },
    } as const
    for (const r of regions) {
      const st = styles[r.state]
      g.path(r.d)
        .fill({ color: st.fill === 'none' ? '#000' : st.fill, opacity: st.opacity })
        .stroke({ color: r.state === 'erase' ? '#ef4444' : '#2563eb', width: strokeW, dasharray: r.state === 'idle' ? `${strokeW * 4} ${strokeW * 3}` : undefined })
    }
    this._regionsEl = g
  }

  hideShapeRegions(): void {
    if (this._regionsEl) {
      try {
        this._regionsEl.remove()
      } catch {
        /* noop */
      }
      this._regionsEl = null
    }
  }

  hideShapePreview(): void {
    if (this._previewEl) {
      try {
        this._previewEl.remove()
      } catch {
        /* noop */
      }
      this._previewEl = null
    }
  }

  // Draw/update the in-progress pen path: committed anchors + segments, plus a
  // rubber-band segment to the cursor. `nearStart` highlights the first anchor
  // to signal that clicking will close the path. All points in canvas coords.
  showPenPreview(nodes: PathNode[], nearStart = false): void {
    this.hidePenPreview()
    if (!nodes.length) return
    const vb = this.getViewBox()
    const strokeW = Math.max(0.5, vb.width / 700)
    const g = this.toolLayer.group().attr({ 'pointer-events': 'none' })

    // The Bézier curve through all anchors (nodes are already in canvas coords
    // for the preview).
    if (nodes.length > 1) {
      g.path(nodesToPathData(nodes, false)).fill('none').stroke({ color: '#2563eb', width: strokeW })
    }

    const r = Math.max(2, vb.width / 240)
    const hr = Math.max(1.5, vb.width / 320)
    nodes.forEach((n, i) => {
      // Tangent handles (in/out) for smooth anchors: a line to a small dot.
      const drawHandle = (hx?: number, hy?: number) => {
        if (hx === undefined || hy === undefined) return
        g.line(n.x, n.y, hx, hy).stroke({ color: '#2563eb', width: strokeW })
        g.circle(hr * 2).center(hx, hy).fill('#2563eb').stroke({ color: '#ffffff', width: strokeW })
      }
      drawHandle(n.inX, n.inY)
      drawHandle(n.outX, n.outY)
      // Anchor square; the first anchor fills solid when the cursor is near it
      // to signal that clicking will close the path.
      const first = i === 0
      g.rect(r * 2, r * 2)
        .center(n.x, n.y)
        .fill(first && nearStart ? '#2563eb' : '#ffffff')
        .stroke({ color: '#2563eb', width: strokeW })
    })
    this._penEl = g
  }

  hidePenPreview(): void {
    if (this._penEl) {
      try {
        this._penEl.remove()
      } catch {
        /* noop */
      }
      this._penEl = null
    }
  }

  // Return the ids of object elements whose rendered box intersects the given
  // canvas-space box. Used for marquee selection.
  hitTestBox(box: Box): string[] {
    const hits: string[] = []
    for (const [id, el] of this._objectEls) {
      let bbox: Box | undefined
      try {
        bbox = el.rbox(this.draw)
      } catch {
        try {
          bbox = el.bbox()
        } catch {
          continue
        }
      }
      if (!bbox) continue
      if (boxIntersects(box, { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height })) {
        hits.push(id)
      }
    }
    return hits
  }

  destroy(): void {
    this.hideMarquee()
    this.hideGradientAnnotator()
    this.hideShapeRegions()
    this.hideShapePreview()
    this.hidePenPreview()
    try {
      this.draw.remove()
    } catch {
      /* noop */
    }
    this._artboardEls.clear()
    this._objectEls.clear()
    this._artboardBoxes.clear()
    this._textPathDefs.clear()
    this._gradientDefs.clear()
  }
}
