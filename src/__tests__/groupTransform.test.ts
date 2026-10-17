import { describe, it, expect } from 'vitest'
import {
  axisScale,
  constrainSquare,
  pathCorners,
  roundCorners,
  mapGroupPoint,
  resizeBoxFromHandle,
  transformInGroup,
  type GroupOp,
} from '@/services/canvas/svgEngine'
import { objectSvgMarkup } from '@/services/canvas/svgExport'

describe('axisScale', () => {
  it('is display / base', () => {
    expect(axisScale(200, 100)).toBe(2)
  })
  it('stays 1 on a zero-extent axis instead of collapsing a straight line', () => {
    expect(axisScale(0, 0)).toBe(1)
    expect(axisScale(0, undefined)).toBe(1)
    expect(axisScale(1, 0)).toBe(1)
  })
})

describe('straight lines', () => {
  it('export without a zero scale', () => {
    const line = { id: 'l', type: 'path' as const, x: 10, y: 20, width: 100, height: 0, baseWidth: 100, baseHeight: 0, d: 'M0 0 L100 0', stroke: '#000', strokeWidth: 2, fill: 'none' }
    const svg = objectSvgMarkup(line, null)
    expect(svg).not.toMatch(/scale\(1 0\)/)
    expect(svg).toContain('translate(10 20)')
  })

  it('resize along their length and stay flat', () => {
    const next = resizeBoxFromHandle({ x: 0, y: 50, width: 100, height: 0 }, 'e', 50, 10)
    expect(next).toEqual({ x: 0, y: 50, width: 150, height: 0 })
  })
})

describe('transformInGroup', () => {
  const item = { origin: { x: 10, y: 10 }, center: { x: 30, y: 20 }, rotation: 0 }

  it('rotates the center about the group center and adds the angle', () => {
    const op: GroupOp = { kind: 'rotate', center: { x: 0, y: 0 }, deg: 90 }
    const r = transformInGroup({ ...item, rotation: 350 }, op)
    // (30, 20) turned 90° clockwise about the origin → (-20, 30)
    expect(r.origin.x + 20).toBeCloseTo(-20)
    expect(r.origin.y + 10).toBeCloseTo(30)
    expect(r.rotation).toBeCloseTo(80)
    expect([r.lx, r.ly]).toEqual([1, 1])
  })

  it('scales position and size with the group box', () => {
    const op: GroupOp = { kind: 'scale', from: { x: 0, y: 0, width: 100, height: 100 }, to: { x: 0, y: 0, width: 200, height: 100 } }
    const r = transformInGroup(item, op)
    expect(mapGroupPoint(op, item.center)).toEqual({ x: 60, y: 20 })
    expect(r.lx).toBeCloseTo(2)
    expect(r.ly).toBeCloseTo(1)
    // Pivot offset (20, 10) scales with the object: origin = center - offset·l
    expect(r.origin.x).toBeCloseTo(60 - 40)
    expect(r.origin.y).toBeCloseTo(20 - 10)
  })

  it('stretches a quarter-turned object along its own axes', () => {
    const op: GroupOp = { kind: 'scale', from: { x: 0, y: 0, width: 100, height: 100 }, to: { x: 0, y: 0, width: 200, height: 100 } }
    const r = transformInGroup({ ...item, rotation: 90 }, op)
    // Its local x-axis points down the canvas, so the canvas stretch is its height.
    expect(r.lx).toBeCloseTo(1)
    expect(r.ly).toBeCloseTo(2)
  })

  it('scales text uniformly', () => {
    const op: GroupOp = { kind: 'scale', from: { x: 0, y: 0, width: 100, height: 100 }, to: { x: 0, y: 0, width: 400, height: 100 } }
    const r = transformInGroup(item, op, true)
    expect(r.lx).toBeCloseTo(2)
    expect(r.ly).toBeCloseTo(2)
  })
})

describe('live corners', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]

  it('finds right-angle corners with the radius limit of half an edge', () => {
    const cs = pathCorners(square, true)
    expect(cs).toHaveLength(4)
    expect(cs[0]!.angle).toBeCloseTo(Math.PI / 2)
    expect(cs[0]!.maxRadius).toBeCloseTo(5)
    // An open path's ends aren't corners.
    expect(pathCorners(square, false)).toHaveLength(2)
  })

  it('rounds each corner into two anchors tangent to its edges', () => {
    const { nodes } = roundCorners(square, true, undefined, 2)
    expect(nodes).toHaveLength(8)
    expect(nodes[0]!.x).toBeCloseTo(0)
    expect(nodes[0]!.y).toBeCloseTo(2)
    expect(nodes[1]!.x).toBeCloseTo(2)
    expect(nodes[1]!.y).toBeCloseTo(0)
    // Circular-arc handle length: 4/3·tan(π/8)·r ≈ 0.552·r.
    expect(nodes[0]!.outY).toBeCloseTo(2 - 0.5523 * 2, 3)
  })

  it('uses an anchor\'s own radius over the path radius', () => {
    const nodes = square.map((n, i) => (i === 0 ? { ...n, radius: 3 } : n))
    const out = roundCorners(nodes, true, undefined, 0)
    // Only the first corner rounds: 3 sharp corners + 2 arc ends.
    expect(out.nodes).toHaveLength(5)
    expect(out.nodes[0]!.y).toBeCloseTo(3)
  })

  it('clamps the radius per corner', () => {
    const { nodes } = roundCorners(square, true, undefined, 50)
    expect(nodes[0]!.y).toBeCloseTo(5)
  })
})

describe('constrainSquare', () => {
  it('makes the drag box square in the drag direction', () => {
    expect(constrainSquare({ x: 0, y: 0 }, { x: 30, y: -10 })).toEqual({ x: 30, y: -30 })
  })
})
