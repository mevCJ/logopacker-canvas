import { describe, it, expect } from 'vitest'
import { parsePathData, svgToPathObjects, flattenSubpaths } from '@/services/canvas/svgToPaths'
import { nodesToPathData } from '@/services/canvas/svgEngine'

describe('parsePathData', () => {
  it('parses a line-only closed triangle into corner anchors (no handles)', () => {
    const sub = parsePathData('M0 0 L10 0 L10 10 Z')
    expect(sub).toHaveLength(1)
    expect(sub[0].closed).toBe(true)
    expect(sub[0].nodes).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ])
    // Straight-only path round-trips to L segments.
    expect(nodesToPathData(sub[0].nodes, sub[0].closed)).toBe('M0 0 L10 0 L10 10 Z')
  })

  it('splits multiple subpaths on repeated M', () => {
    const sub = parsePathData('M0 0 L1 0 M5 5 L6 5')
    expect(sub).toHaveLength(2)
    expect(sub[0].nodes).toHaveLength(2)
    expect(sub[1].nodes[0]).toEqual({ x: 5, y: 5 })
  })

  it('stores cubic handles as out on the start anchor and in on the end anchor', () => {
    // A single cubic from (0,0) to (10,0), controls (0,5) and (10,5).
    const sub = parsePathData('M0 0 C0 5 10 5 10 0')
    const [a, b] = sub[0].nodes
    expect(a).toMatchObject({ x: 0, y: 0, outX: 0, outY: 5 })
    expect(b).toMatchObject({ x: 10, y: 0, inX: 10, inY: 5 })
    // Round-trips back to the same cubic.
    expect(nodesToPathData(sub[0].nodes)).toBe('M0 0 C0 5 10 5 10 0')
  })

  it('handles relative commands and H/V', () => {
    const sub = parsePathData('m0 0 h10 v10 z')
    expect(sub[0].nodes).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ])
  })

  it('elevates a quadratic to a cubic (via svgpath normalization)', () => {
    const sub = parsePathData('M0 0 Q5 10 10 0')
    const [a, b] = sub[0].nodes
    // Elevated control points: c1 = start + 2/3(q-start), c2 = end + 2/3(q-end)
    expect(a.outX).toBeCloseTo(10 / 3)
    expect(a.outY).toBeCloseTo(20 / 3)
    expect(b.inX).toBeCloseTo(10 - 10 / 3)
    expect(b.inY).toBeCloseTo(20 / 3)
  })

  it('applies transform strings to coordinates', () => {
    const sub = parsePathData('M0 0 L10 0', ['translate(100 50)'])
    expect(sub[0].nodes[0]).toEqual({ x: 100, y: 50 })
    expect(sub[0].nodes[1]).toEqual({ x: 110, y: 50 })
  })
})

describe('flattenSubpaths', () => {
  it('folds subpaths into one node list + per-subpath counts', () => {
    const subs = parsePathData('M0 0 L10 0 L10 10 Z M20 0 L30 0 L30 10 Z')
    const flat = flattenSubpaths(subs)
    expect(flat.nodes).toHaveLength(6)
    expect(flat.subpaths).toEqual([3, 3])
    expect(flat.closed).toBe(true)
    // Round-trips back to two closed runs.
    expect(nodesToPathData(flat.nodes, flat.closed, flat.subpaths)).toBe(
      'M0 0 L10 0 L10 10 Z M20 0 L30 0 L30 10 Z',
    )
  })
})

describe('svgToPathObjects', () => {
  it('returns null for markup with no <path>', () => {
    expect(svgToPathObjects('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>')).toBeNull()
  })

  it('keeps a compound <path> (with a hole) as one object with subpaths', () => {
    // One path element, two subpaths (outer + inner hole).
    const svg =
      '<svg viewBox="0 0 40 40"><path d="M0 0 L20 0 L20 20 Z M5 5 L10 5 L10 10 Z" fill="#000"/></svg>'
    const res = svgToPathObjects(svg)
    expect(res).not.toBeNull()
    // Not split into two objects — one compound path.
    expect(res!.paths).toHaveLength(1)
    expect(res!.paths[0].subpaths).toEqual([3, 3])
    expect(res!.paths[0].nodes).toHaveLength(6)
    expect(res!.paths[0].closed).toBe(true)
  })

  it('extracts each path and bakes ancestor group transforms into geometry', () => {
    const svg = `
      <svg viewBox="0 0 200 100">
        <path d="M0 0 L10 0 L10 10 Z" fill="#ff0000"/>
        <g transform="translate(100 0)">
          <path d="M0 0 L10 0 L10 10 Z" fill="#00ff00"/>
        </g>
      </svg>`
    const res = svgToPathObjects(svg)
    expect(res).not.toBeNull()
    expect(res!.viewBox).toEqual({ x: 0, y: 0, width: 200, height: 100 })
    expect(res!.paths).toHaveLength(2)
    // First path untouched.
    expect(res!.paths[0].nodes[0]).toEqual({ x: 0, y: 0 })
    expect(res!.paths[0].fill).toBe('#ff0000')
    // Second path shifted right by 100 by the group transform.
    expect(res!.paths[1].nodes[0]).toEqual({ x: 100, y: 0 })
    expect(res!.paths[1].nodes[1]).toEqual({ x: 110, y: 0 })
    expect(res!.paths[1].fill).toBe('#00ff00')
  })
})
