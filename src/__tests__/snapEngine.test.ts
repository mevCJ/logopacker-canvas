import { describe, it, expect } from 'vitest'
import { buildScene, snapEdges, snapMove, snapPoint } from '@/services/canvas/snapEngine'

const ON = { points: true, guides: true }
const box = (x: number, y: number, width = 20, height = 20) => ({ x, y, width, height })

describe('snap engine', () => {
  it('snaps a corner onto another object corner (snap to point)', () => {
    const scene = buildScene({ boxes: [box(100, 100)] }, 5)
    // Moving box's top-left lands 3,2 away from the target's bottom-right.
    const r = snapMove(scene, box(0, 0), [], 123, 118, 5, ON)
    expect(r.dx).toBe(120)
    expect(r.dy).toBe(120)
    expect(r.guides.some((g) => g.kind === 'point' && g.label === 'corner')).toBe(true)
  })

  it('snaps a moving anchor onto a target anchor', () => {
    const scene = buildScene({ boxes: [], anchors: [{ x: 57, y: 33 }] }, 4)
    const r = snapMove(scene, box(0, 0, 100, 100), [{ x: 10, y: 10 }], 45, 21, 4, ON)
    expect([r.dx, r.dy]).toEqual([47, 23])
    expect(r.guides.find((g) => g.kind === 'point')).toMatchObject({ label: 'anchor' })
  })

  it('aligns centers with a vertical smart guide spanning both objects', () => {
    const scene = buildScene({ boxes: [box(100, 0, 40, 40)] }, 4)
    // Moving 20-wide box centered at x=118 → snaps to 120 (target center).
    const r = snapMove(scene, box(0, 200), [], 108, 0, 4, { points: false, guides: true })
    expect(r.dx).toBe(110)
    const g = r.guides.find((x) => x.kind === 'align' && x.x1 === 120)
    expect(g).toMatchObject({ y1: 0, y2: 220 })
  })

  it('ignores targets beyond the tolerance', () => {
    const scene = buildScene({ boxes: [box(100, 100)] }, 2)
    const r = snapMove(scene, box(0, 0), [], 50, 50, 2, ON)
    expect([r.dx, r.dy, r.guides.length]).toEqual([50, 50, 0])
  })

  it('matches an existing gap (equal spacing)', () => {
    // A [0..20], B [40..60] → gap 20. Moving C (20 wide) right of B should
    // settle at 80 so the B–C gap is also 20.
    const scene = buildScene({ boxes: [box(0, 0), box(40, 0)] }, 4)
    const r = snapMove(scene, box(0, 0), [], 83, 0, 4, { points: false, guides: true })
    expect(r.dx).toBe(80)
    const gaps = r.guides.filter((g) => g.kind === 'gap')
    expect(gaps).toHaveLength(2)
    expect(gaps.every((g) => g.kind === 'gap' && g.label === '20')).toBe(true)
  })

  it('centers between two neighbors', () => {
    const scene = buildScene({ boxes: [box(0, 0), box(100, 0)] }, 4)
    // Between 20 and 100 with width 20 → centered at x=50.
    const r = snapMove(scene, box(0, 0), [], 52, 0, 4, { points: false, guides: true })
    expect(r.dx).toBe(50)
    expect(r.guides.filter((g) => g.kind === 'gap').map((g) => g.kind === 'gap' && g.label)).toEqual(['30', '30'])
  })

  it('spaces vertically too', () => {
    const scene = buildScene({ boxes: [box(0, 0), box(0, 30)] }, 4)
    const r = snapMove(scene, box(0, 0), [], 0, 62, 4, { points: false, guides: true })
    expect(r.dy).toBe(60)
  })

  it('snaps a point to an intersection of guides', () => {
    const scene = buildScene({ boxes: [box(0, 0, 100, 10), box(200, 50, 10, 100)] }, 3)
    const r = snapPoint(scene, { x: 202, y: 9 }, 3, { points: false, guides: true })
    expect([r.x, r.y]).toEqual([200, 10])
    expect(r.guides.some((g) => g.kind === 'point' && g.label === 'intersect')).toBe(true)
  })

  it('snaps only the dragged edges when resizing', () => {
    const scene = buildScene({ boxes: [box(100, 100, 50, 50)] }, 4)
    const r = snapEdges(scene, box(0, 0, 98, 60), { right: true }, 4, ON)
    expect(r.box).toEqual({ x: 0, y: 0, width: 100, height: 60 })
  })

  it('does nothing with both toggles off', () => {
    const scene = buildScene({ boxes: [box(100, 100)] }, 5)
    const r = snapMove(scene, box(0, 0), [], 98, 99, 5, { points: false, guides: false })
    expect([r.dx, r.dy, r.guides.length]).toEqual([98, 99, 0])
  })
})

describe('anchor alignment', () => {
  it('aligns a point with an anchor and draws a guide from it', () => {
    const scene = buildScene({ boxes: [], anchors: [{ x: 50, y: 20 }] }, 6)
    const r = snapPoint(scene, { x: 53, y: 200 }, 6, { points: true, guides: true })
    expect(r.x).toBe(50)
    expect(r.y).toBe(200)
    expect(r.guides.some((g) => g.kind === 'align' && g.x1 === 50 && g.x2 === 50)).toBe(true)
  })
})
