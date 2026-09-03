import { describe, it, expect } from 'vitest'
import {
  svgElementType,
  commonAttrs,
  absolutePosition,
  pathAttrs,
  textAttrs,
  imageAttrs,
  alignToAnchor,
  documentBounds,
  zoomViewBox,
  panViewBox,
  clampZoom,
  resizeArtboardBox,
  rectPathData,
  ellipsePathData,
  linePathData,
  normalizeDragBox,
  boxIntersects,
  resolveArtboardAtPoint,
  artboardAtPoint,
  mergeMarqueeSelection,
  buildShapePayload,
  pointsBounds,
  nodesToPathData,
  nodesBounds,
  translateNodes,
  applyNodeDrag,
  nodePointToCanvas,
  canvasPointToNode,
  buildPenNodesPayload,
  canvasPointToScreenRect,
  rotatePoint,
  boxCenter,
  handlePositions,
  resizeBoxFromHandle,
  rotationFromPointer,
  objectTransform,
  invertResizeBox,
} from '@/services/canvas/svgEngine'

describe('svgEngine — pure helpers', () => {
  it('maps object types to svg element tags', () => {
    expect(svgElementType({ type: 'path' })).toBe('path')
    expect(svgElementType({ type: 'text' })).toBe('text')
    expect(svgElementType({ type: 'image' })).toBe('image')
    expect(() => svgElementType({ type: 'nope' as any })).toThrow()
  })

  it('emits common attrs including id and data-role', () => {
    const a = commonAttrs({ id: 'p1', semanticRole: 'logoSymbol', type: 'path', artboardId: 'ab1' })
    expect(a.id).toBe('p1')
    expect(a['data-role']).toBe('logoSymbol')
    expect(a['data-type']).toBe('path')
  })

  it('computes absolute position from artboard origin + local xy', () => {
    expect(absolutePosition({ x: 10, y: 20 }, { x: 100, y: 200 })).toEqual({ x: 110, y: 220 })
    expect(absolutePosition({ x: 5, y: 6 }, null)).toEqual({ x: 5, y: 6 })
  })

  it('round-trips path d and treats null fill/stroke as none', () => {
    const attrs = pathAttrs({ id: 'x', type: 'path', d: 'M0 0 L10 10', fill: null, stroke: null })
    expect(attrs.d).toBe('M0 0 L10 10')
    expect(attrs.fill).toBe('none')
    expect(attrs.stroke).toBe('none')
  })

  it('maps text align to anchor', () => {
    expect(alignToAnchor('left')).toBe('start')
    expect(alignToAnchor('center')).toBe('middle')
    expect(alignToAnchor('right')).toBe('end')
    expect(alignToAnchor(undefined)).toBe('start')
  })

  it('emits text + image attrs', () => {
    const t = textAttrs({ id: 'x', type: 'text', fontSize: 32, fontWeight: 700, align: 'center' })
    expect(t['font-size']).toBe(32)
    expect(t['text-anchor']).toBe('middle')
    const i = imageAttrs({ id: 'y', type: 'image', href: 'x.png', width: 200, height: 100 })
    expect(i.href).toBe('x.png')
    // Images stretch to fill the (transform-scaled) box; aspect lock is opt-in
    // via Shift during resize, so preserveAspectRatio is 'none'.
    expect(i.preserveAspectRatio).toBe('none')
  })

  it('computes document bounds union with padding', () => {
    const b = documentBounds(
      [
        { id: 'a', x: 0, y: 0, width: 400, height: 300 },
        { id: 'b', x: 500, y: 0, width: 400, height: 300 },
      ],
      100,
    )
    expect(b.x).toBe(-100)
    expect(b.width).toBe(900 + 200)
  })

  it('viewport math: zoom keeps focal stationary, pan + clamp', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 }
    const z = zoomViewBox(box, 2, { x: 25, y: 25 })
    expect(z.width).toBe(50)
    expect((25 - z.x) / z.width).toBeCloseTo(0.25, 5)
    expect(panViewBox(box, 10, 20)).toEqual({ x: -10, y: -20, width: 100, height: 100 })
    const base = { x: 0, y: 0, width: 1000, height: 1000 }
    expect(clampZoom({ x: 0, y: 0, width: 10, height: 10 }, base, 0.15, 8).width).toBeCloseTo(125, 5)
  })

  it('resizes an artboard by dragging an edge, anchoring the opposite side', () => {
    const box = { x: 100, y: 100, width: 400, height: 300 }
    // East/south edges only grow width/height; origin unchanged.
    expect(resizeArtboardBox(box, 'e', 50, 0)).toEqual({ x: 100, y: 100, width: 450, height: 300 })
    expect(resizeArtboardBox(box, 's', 0, 40)).toEqual({ x: 100, y: 100, width: 400, height: 340 })
    // West/north edges move the origin so the opposite edge stays put.
    expect(resizeArtboardBox(box, 'w', 30, 0)).toEqual({ x: 130, y: 100, width: 370, height: 300 })
    expect(resizeArtboardBox(box, 'n', 0, 20)).toEqual({ x: 100, y: 120, width: 400, height: 280 })
    // Minimum size is enforced and keeps the anchored edge fixed.
    const shrunk = resizeArtboardBox(box, 'w', 1000, 0, 20)
    expect(shrunk.width).toBe(20)
    expect(shrunk.x + shrunk.width).toBe(500) // right edge (100 + 400) preserved
  })
})

describe('svgEngine — shape + tool geometry helpers', () => {
  it('builds rectangle path data closed around the origin', () => {
    expect(rectPathData(100, 50)).toBe('M0 0 H100 V50 H0 Z')
    // Negative sizes are clamped to 0.
    expect(rectPathData(-10, 20)).toBe('M0 0 H0 V20 H0 Z')
    // radius 0 keeps the sharp-corner form.
    expect(rectPathData(100, 50, 0)).toBe('M0 0 H100 V50 H0 Z')
  })

  it('builds a rounded rectangle with clamped corner radius', () => {
    const d = rectPathData(100, 50, 10)
    expect(d).toBe(
      'M10 0 H90 A10 10 0 0 1 100 10 V40 A10 10 0 0 1 90 50 H10 A10 10 0 0 1 0 40 V10 A10 10 0 0 1 10 0 Z',
    )
    // Radius is clamped to half the shorter side (25 here), never exceeding it.
    const clamped = rectPathData(100, 50, 999)
    expect(clamped).toContain('A25 25')
  })

  it('builds ellipse path data using two arcs', () => {
    const d = ellipsePathData(100, 60)
    expect(d.startsWith('M0 30')).toBe(true)
    expect(d).toContain('A50 30')
    expect(d.endsWith('Z')).toBe(true)
  })

  it('builds line path data between two points', () => {
    expect(linePathData(0, 0, 40, 10)).toBe('M0 0 L40 10')
  })

  it('normalizeDragBox handles all four drag directions', () => {
    const a = normalizeDragBox({ x: 10, y: 10 }, { x: 40, y: 30 })
    expect(a).toEqual({ x: 10, y: 10, width: 30, height: 20 })
    const b = normalizeDragBox({ x: 40, y: 30 }, { x: 10, y: 10 })
    expect(b).toEqual({ x: 10, y: 10, width: 30, height: 20 })
    const c = normalizeDragBox({ x: 40, y: 10 }, { x: 10, y: 30 })
    expect(c).toEqual({ x: 10, y: 10, width: 30, height: 20 })
    const d = normalizeDragBox({ x: 10, y: 30 }, { x: 40, y: 10 })
    expect(d).toEqual({ x: 10, y: 10, width: 30, height: 20 })
  })

  it('boxIntersects detects overlap and separation', () => {
    const base = { x: 0, y: 0, width: 100, height: 100 }
    expect(boxIntersects(base, { x: 50, y: 50, width: 100, height: 100 })).toBe(true)
    expect(boxIntersects(base, { x: 200, y: 0, width: 10, height: 10 })).toBe(false)
    // Edge-touching only (no area overlap) is not an intersection.
    expect(boxIntersects(base, { x: 100, y: 0, width: 10, height: 10 })).toBe(false)
  })

  it('resolveArtboardAtPoint returns the artboard under the point', () => {
    const a = { id: 'a', x: 0, y: 0, width: 100, height: 100 }
    const b = { id: 'b', x: 200, y: 0, width: 100, height: 100 }
    expect(resolveArtboardAtPoint([a, b], { x: 50, y: 50 })!.id).toBe('a')
    expect(resolveArtboardAtPoint([a, b], { x: 250, y: 50 })!.id).toBe('b')
  })

  it('resolveArtboardAtPoint falls back to the first artboard when over none', () => {
    const a = { id: 'a', x: 0, y: 0, width: 100, height: 100 }
    const b = { id: 'b', x: 200, y: 0, width: 100, height: 100 }
    expect(resolveArtboardAtPoint([a, b], { x: 999, y: 999 })!.id).toBe('a')
    expect(resolveArtboardAtPoint([], { x: 0, y: 0 })).toBeNull()
    expect(resolveArtboardAtPoint(undefined, { x: 0, y: 0 })).toBeNull()
  })

  it('artboardAtPoint returns null over empty canvas (no fallback)', () => {
    const a = { id: 'a', x: 0, y: 0, width: 100, height: 100 }
    const b = { id: 'b', x: 200, y: 0, width: 100, height: 100 }
    expect(artboardAtPoint([a, b], { x: 50, y: 50 })!.id).toBe('a')
    expect(artboardAtPoint([a, b], { x: 999, y: 999 })).toBeNull()
    expect(artboardAtPoint([], { x: 0, y: 0 })).toBeNull()
    expect(artboardAtPoint(undefined, { x: 0, y: 0 })).toBeNull()
  })

  it('artboardAtPoint prefers the last (topmost) overlapping artboard', () => {
    const a = { id: 'a', x: 0, y: 0, width: 100, height: 100 }
    const b = { id: 'b', x: 50, y: 50, width: 100, height: 100 }
    expect(artboardAtPoint([a, b], { x: 75, y: 75 })!.id).toBe('b')
  })

  it('resolveArtboardAtPoint prefers the last (topmost) overlapping artboard', () => {
    const a = { id: 'a', x: 0, y: 0, width: 100, height: 100 }
    const b = { id: 'b', x: 50, y: 50, width: 100, height: 100 }
    expect(resolveArtboardAtPoint([a, b], { x: 75, y: 75 })!.id).toBe('b')
  })

  it('mergeMarqueeSelection replaces when not additive', () => {
    expect(mergeMarqueeSelection(['a', 'b'], ['c', 'd'], false)).toEqual(['c', 'd'])
    // De-duplicates hits.
    expect(mergeMarqueeSelection([], ['c', 'c', 'd'], false)).toEqual(['c', 'd'])
  })

  it('mergeMarqueeSelection unions when additive', () => {
    expect(mergeMarqueeSelection(['a', 'b'], ['b', 'c'], true)).toEqual(['a', 'b', 'c'])
  })

  it('buildShapePayload builds a rect in artboard-local coordinates', () => {
    const p = buildShapePayload('rect', { x: 120, y: 130 }, { x: 220, y: 190 }, { x: 100, y: 100 })!
    expect(p.type).toBe('path')
    expect(p.d).toBe('M0 0 H100 V60 H0 Z')
    expect(p).toMatchObject({ x: 20, y: 30, width: 100, height: 60, fill: '#211A43', stroke: 'none' })
    // Rectangles carry the shape discriminator and a default (0) corner radius.
    expect(p.shape).toBe('rect')
    expect(p.cornerRadius).toBe(0)
  })

  it('buildShapePayload builds an ellipse path', () => {
    const p = buildShapePayload('ellipse', { x: 0, y: 0 }, { x: 100, y: 60 }, null)!
    expect(p.shape).toBe('ellipse')
    expect(p.cornerRadius).toBeUndefined()
    expect(p.d).toContain('A50 30')
    expect(p).toMatchObject({ width: 100, height: 60 })
  })

  it('buildShapePayload builds a line with stroke and no fill', () => {
    const p = buildShapePayload('line', { x: 110, y: 110 }, { x: 150, y: 130 }, { x: 100, y: 100 })!
    expect(p.fill).toBe('none')
    expect(p.stroke).toBe('#211A43')
    expect(p.strokeWidth).toBe(2)
    // Local origin normalized; d starts at the top-left corner of the bbox.
    expect(p.x).toBe(10)
    expect(p.y).toBe(10)
    expect(p.d).toBe('M0 0 L40 20')
  })

  it('buildShapePayload rejects degenerate drags', () => {
    expect(buildShapePayload('rect', { x: 10, y: 10 }, { x: 10, y: 10 }, null)).toBeNull()
    expect(buildShapePayload('line', { x: 10, y: 10 }, { x: 10, y: 10 }, null)).toBeNull()
  })

  it('pointsBounds spans the min/max of all points', () => {
    expect(pointsBounds([{ x: 5, y: 8 }, { x: 20, y: 3 }, { x: 12, y: 30 }])).toEqual({
      x: 5,
      y: 3,
      width: 15,
      height: 27,
    })
  })

  it('nodesToPathData emits L for corners and C for smooth anchors', () => {
    // All corners -> straight lines.
    const corners = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    expect(nodesToPathData(corners)).toBe('M0 0 L10 0 L10 10')
    expect(nodesToPathData(corners, true)).toBe('M0 0 L10 0 L10 10 Z')
    // A smooth middle anchor curves the segments into/out of it.
    const smooth = [
      { x: 0, y: 0 },
      { x: 10, y: 10, inX: 5, inY: 10, outX: 15, outY: 10 },
      { x: 20, y: 0 },
    ]
    expect(nodesToPathData(smooth)).toBe('M0 0 C0 0 5 10 10 10 C15 10 20 0 20 0')
  })

  it('nodesToPathData emits one M...Z run per subpath for compound paths', () => {
    // Two triangles in one flat node list, split 3 + 3.
    const nodes = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 },
    ]
    expect(nodesToPathData(nodes, true, [3, 3])).toBe(
      'M0 0 L10 0 L10 10 Z M20 0 L30 0 L30 10 Z',
    )
    // A single-entry subpaths list behaves like no subpaths.
    expect(nodesToPathData(nodes.slice(0, 3), true, [3])).toBe('M0 0 L10 0 L10 10 Z')
  })

  it('nodesBounds includes tangent handles, translateNodes shifts everything', () => {
    const nodes = [{ x: 0, y: 0, outX: -5, outY: 8 }, { x: 10, y: 2 }]
    // Bounds must reach the out handle at (-5, 8).
    expect(nodesBounds(nodes)).toEqual({ x: -5, y: 0, width: 15, height: 8 })
    const moved = translateNodes(nodes, 100, 50)
    expect(moved[0]).toEqual({ x: 100, y: 50, inX: undefined, inY: undefined, outX: 95, outY: 58 })
  })

  it('buildPenNodesPayload normalizes to bounds origin and keeps nodes/d in sync', () => {
    const nodes = [
      { x: 120, y: 130 },
      { x: 180, y: 130 },
      { x: 150, y: 180 },
    ]
    const p = buildPenNodesPayload(nodes, { x: 100, y: 100 }, true)!
    expect(p.type).toBe('path')
    // Local origin = bbox top-left (120-100, 130-100) = (20, 30); nodes relative.
    expect(p).toMatchObject({ x: 20, y: 30, width: 60, height: 50, fill: '#211A43', stroke: 'none' })
    expect(p.nodes[0]).toMatchObject({ x: 0, y: 0 })
    expect(p.d).toBe('M0 0 L60 0 L30 50 Z')
  })

  it('buildPenNodesPayload builds an open stroked path and rejects < 2 anchors', () => {
    const p = buildPenNodesPayload([{ x: 0, y: 0 }, { x: 40, y: 20 }], null, false)!
    expect(p.fill).toBe('none')
    expect(p.stroke).toBe('#211A43')
    expect(p.strokeWidth).toBe(2)
    expect(p.d).toBe('M0 0 L40 20')
    expect(buildPenNodesPayload([{ x: 10, y: 10 }], null)).toBeNull()
  })

  it('applyNodeDrag moves an anchor with its handles', () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 10, y: 10, inX: 5, inY: 10, outX: 15, outY: 10 },
    ]
    const out = applyNodeDrag(nodes, 1, 'anchor', 4, -2)
    expect(out[1]).toEqual({ x: 14, y: 8, inX: 9, inY: 8, outX: 19, outY: 8 })
    // Other nodes are untouched (but cloned).
    expect(out[0]).toEqual({ x: 0, y: 0 })
  })

  it('applyNodeDrag moves a handle and mirrors its opposite about the anchor', () => {
    const nodes = [{ x: 10, y: 10, inX: 5, inY: 10, outX: 15, outY: 10 }]
    // Drag the out handle from (15,10) by (+3,-4) -> (18,6); in mirrors to (2,14).
    const out = applyNodeDrag(nodes, 0, 'out', 3, -4)
    expect(out[0]).toMatchObject({ outX: 18, outY: 6, inX: 2, inY: 14 })
  })

  it('nodePointToCanvas matches the render transform (translate/scale/rotate) and round-trips', () => {
    // No rotation, unit scale: a local node just shifts by the object origin —
    // exactly where translate(absX,absY) + local d renders it. This is the
    // regression the node-overlay offset bug was about.
    const plain = { absX: 100, absY: 50, rotationDeg: 0, scaleX: 1, scaleY: 1, cx: 10, cy: 10 }
    expect(nodePointToCanvas({ x: 6, y: 8 }, plain)).toEqual({ x: 106, y: 58 })

    // With scale about the origin and rotation about the post-scale pivot.
    const t = { absX: 100, absY: 50, rotationDeg: 90, scaleX: 2, scaleY: 2, cx: 20, cy: 20 }
    const p = { x: 5, y: 0 }
    const canvas = nodePointToCanvas(p, t)
    // Round-trip back to local within float tolerance.
    const back = canvasPointToNode(canvas, t)
    expect(back.x).toBeCloseTo(p.x, 6)
    expect(back.y).toBeCloseTo(p.y, 6)
  })

  it('canvasPointToScreenRect maps canvas coords to host-relative screen coords', () => {
    const r = canvasPointToScreenRect(
      { x: 50, y: 50 },
      { x: 0, y: 0, width: 100, height: 100 },
      { left: 10, top: 20, width: 200, height: 200 },
    )
    // scale = 200/100 = 2; left = 10 + 50*2 = 110; top = 20 + 50*2 = 120
    expect(r.scale).toBe(2)
    expect(r.left).toBe(110)
    expect(r.top).toBe(120)
  })
})

describe('svgEngine — resize + rotation geometry', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 }

  it('rotatePoint rotates about a center', () => {
    const p = rotatePoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 90)
    expect(Math.round(p.x)).toBe(0)
    expect(Math.round(p.y)).toBe(10)
  })

  it('boxCenter returns the geometric center', () => {
    expect(boxCenter(box)).toEqual({ x: 200, y: 150 })
  })

  it('handlePositions places 8 handles plus rotate above the top-middle', () => {
    const h = handlePositions(box, 24)
    expect(h.nw).toEqual({ x: 100, y: 100 })
    expect(h.se).toEqual({ x: 300, y: 200 })
    expect(h.n).toEqual({ x: 200, y: 100 })
    expect(h.rotate).toEqual({ x: 200, y: 76 })
  })

  it('resizeBoxFromHandle (unrotated) grows from the east edge, anchoring west', () => {
    const out = resizeBoxFromHandle(box, 'e', 50, 0, 0, false)
    expect(out.x).toBe(100) // west edge anchored
    expect(Math.round(out.width)).toBe(250)
    expect(out.height).toBe(100)
  })

  it('resizeBoxFromHandle (unrotated) drags the nw corner, anchoring se', () => {
    const out = resizeBoxFromHandle(box, 'nw', -20, -10, 0, false)
    // se corner (300,200) stays fixed.
    expect(Math.round(out.x + out.width)).toBe(300)
    expect(Math.round(out.y + out.height)).toBe(200)
    expect(Math.round(out.width)).toBe(220)
    expect(Math.round(out.height)).toBe(110)
  })

  it('resizeBoxFromHandle keeps aspect ratio on corners when requested', () => {
    const out = resizeBoxFromHandle(box, 'se', 100, 0, 0, true)
    expect(out.width / out.height).toBeCloseTo(box.width / box.height, 5)
  })

  it('resizeBoxFromHandle enforces a minimum size', () => {
    const out = resizeBoxFromHandle(box, 'e', -1000, 0, 0, false, 4)
    expect(out.width).toBe(4)
  })

  it('resizeBoxFromHandle respects rotation by resizing along local axes', () => {
    // Rotated 90°, dragging the east handle east should change local width and
    // keep the box centered consistently; the result stays finite and >= min.
    const out = resizeBoxFromHandle(box, 'e', 0, 50, 90, false)
    expect(Number.isFinite(out.width)).toBe(true)
    expect(Number.isFinite(out.height)).toBe(true)
    expect(out.width).toBeGreaterThan(0)
  })

  it('rotationFromPointer measures 0 at north, 90 at east', () => {
    const c = { x: 0, y: 0 }
    expect(Math.round(rotationFromPointer(c, { x: 0, y: -10 }))).toBe(0)
    expect(Math.round(rotationFromPointer(c, { x: 10, y: 0 }))).toBe(90)
    expect(Math.round(rotationFromPointer(c, { x: 0, y: 10 }))).toBe(180)
    expect(Math.round(rotationFromPointer(c, { x: -10, y: 0 }))).toBe(270)
  })

  it('invertResizeBox round-trips origin+size when box is unchanged', () => {
    const start = { x: 100, y: 100, width: 200, height: 80 }
    const out = invertResizeBox({ x: 90, y: 95 }, { width: 100, height: 100 }, start, { ...start })
    expect(out).toEqual({ x: 90, y: 95, width: 100, height: 100 })
  })

  it('invertResizeBox scales size and keeps geometry aligned under an offset box', () => {
    // Object origin (10,10) but its visual bbox starts at (60,30) — a path whose
    // d is offset from the origin, with stored size 100x100 that differs from
    // the visual box. Double the box width; the stored size and the origin
    // offset both scale so the shape stays under the outline.
    const startBox = { x: 60, y: 30, width: 100, height: 40 }
    const newBox = { x: 60, y: 30, width: 200, height: 40 } // grew east, width x2
    const out = invertResizeBox({ x: 10, y: 10 }, { width: 100, height: 100 }, startBox, newBox)
    expect(out.width).toBe(200) // 100 * 2
    expect(out.height).toBe(100) // unchanged
    // origin offset from box-left was (10-60)=-50; scaled x2 => -100; new x = 60-100 = -40
    expect(out.x).toBe(-40)
    expect(out.y).toBe(10)
  })

  it('invertResizeBox clamps size to a minimum of 1', () => {
    const start = { x: 0, y: 0, width: 100, height: 100 }
    const out = invertResizeBox({ x: 0, y: 0 }, { width: 100, height: 100 }, start, { x: 0, y: 0, width: 0, height: 0 })
    expect(out.width).toBe(1)
    expect(out.height).toBe(1)
  })

  it('objectTransform composes translate, rotate (center), and scale', () => {
    expect(objectTransform(10, 20, 100, 50)).toBe('translate(10 20)')
    expect(objectTransform(10, 20, 100, 50, 30)).toBe('translate(10 20) rotate(30 50 25)')
    expect(objectTransform(10, 20, 100, 50, 0, 2, 3)).toBe('translate(10 20) scale(2 3)')
    expect(objectTransform(0, 0, 200, 100, 45, 2, 2)).toBe('translate(0 0) rotate(45 100 50) scale(2 2)')
  })

  it('objectTransform rotates about an explicit geometry center when given', () => {
    // Path whose geometry center (100,40) differs from the nominal box center
    // (50,25): rotation must pivot on the geometry center, not the box center.
    expect(objectTransform(10, 20, 100, 50, 30, 1, 1, 100, 40)).toBe(
      'translate(10 20) rotate(30 100 40)',
    )
  })
})
