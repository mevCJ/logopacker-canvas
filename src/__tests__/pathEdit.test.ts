import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore, type PathObject } from '@/stores/canvas'
import { canJoin, joinNodePaths, joinPaths, reflectObjects } from '@/services/canvas/pathEdit'
import { objectTransform } from '@/services/canvas/svgEngine'

describe('reflect', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('mirrors a path\'s nodes in place for a single object', () => {
    const p = store.addObject({ type: 'path', d: 'M0 0 L100 0 L0 50', nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 50 }], x: 10, y: 10, width: 100, height: 50 }) as PathObject
    reflectObjects(store, [p.id], 'horizontal')
    const out = store.getObject(p.id) as PathObject
    expect(out.nodes!.map((n) => n.x)).toEqual([100, 0, 100])
    expect(out.x).toBe(10)
    reflectObjects(store, [p.id], 'vertical')
    expect((store.getObject(p.id) as PathObject).nodes!.map((n) => n.y)).toEqual([50, 50, 0])
  })

  it('moves objects to their mirror positions across the selection center', () => {
    const a = store.addObject({ type: 'path', d: 'M0 0 H10 V10 H0 Z', x: 0, y: 0, width: 10, height: 10, rotation: 30 })
    const b = store.addObject({ type: 'path', d: 'M0 0 H10 V10 H0 Z', x: 90, y: 0, width: 10, height: 10 })
    reflectObjects(store, [a.id, b.id], 'horizontal')
    // The rotated square widens the selection to x −1.83…100 (center ≈ 49.08);
    // each center moves to its mirror image and the rotation reverses.
    const g = (-1.8301270189 + 100) / 2
    const ra = store.getObject(a.id)!
    expect(ra.x + 5).toBeCloseTo(2 * g - 5)
    expect(ra.rotation).toBe(330)
    expect(store.getObject(b.id)!.x + 5).toBeCloseTo(2 * g - 95)
  })

  it('flips text and images with a flag the transform applies', () => {
    const t = store.addObject({ type: 'text', text: 'Hi', x: 0, y: 0, width: 40, height: 20 })
    reflectObjects(store, [t.id], 'horizontal')
    expect(store.getObject(t.id)!.flipX).toBe(true)
    expect(objectTransform(0, 0, 40, 20, 0, 1, 1, 20, 10, { x: true })).toContain('scale(-1 1)')
  })

  it('mirrors gradients with the shape', () => {
    const p = store.addObject({ type: 'path', shape: 'rect', d: 'M0 0 H10 V10 H0 Z', width: 10, height: 10, fillGradient: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [] } }) as PathObject
    reflectObjects(store, [p.id], 'horizontal')
    expect((store.getObject(p.id) as PathObject).fillGradient).toMatchObject({ x1: 1, x2: 0 })
  })
})

describe('join', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('merges nearly-touching endpoints into one anchor', () => {
    const { nodes, closed } = joinNodePaths(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 30, y: 10 }, { x: 10.5, y: 0.5 }],
      2,
    )
    expect(closed).toBe(false)
    expect(nodes).toHaveLength(3)
    expect(nodes[1]).toMatchObject({ x: 10.25, y: 0.25 })
    expect(nodes[2]).toMatchObject({ x: 30, y: 10 })
  })

  it('bridges distant endpoints and closes when both ends meet', () => {
    const bridged = joinNodePaths([{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 20, y: 0 }, { x: 30, y: 0 }], 2)
    expect(bridged.nodes).toHaveLength(4)
    const loop = joinNodePaths(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }],
      1,
    )
    expect(loop.closed).toBe(true)
    expect(loop.nodes).toHaveLength(4)
  })

  it('joins two path objects into one with the front style', () => {
    const a = store.addObject({ type: 'path', d: 'M0 0 L50 0', nodes: [{ x: 0, y: 0 }, { x: 50, y: 0 }], x: 0, y: 0, width: 50, height: 0, stroke: '#111111', strokeWidth: 2, fill: 'none' })
    const b = store.addObject({ type: 'path', d: 'M0 0 L0 40', nodes: [{ x: 0, y: 0 }, { x: 0, y: 40 }], x: 51, y: 0, width: 0, height: 40, stroke: '#222222', strokeWidth: 4, fill: 'none' })
    expect(canJoin(store, [a.id, b.id])).toBe(true)
    const id = joinPaths(store, [a.id, b.id], 2)!
    const out = store.getObject(id) as PathObject
    expect(store.getObject(a.id)).toBeNull()
    expect(out.nodes).toHaveLength(3)
    expect(out.stroke).toBe('#222222')
    expect(out.strokeWidth).toBe(4)
    expect(out.closed).toBe(false)
  })

  it('refuses closed shapes', () => {
    const r = store.addObject({ type: 'path', shape: 'rect', d: 'M0 0 H10 V10 H0 Z', width: 10, height: 10 })
    const l = store.addObject({ type: 'path', d: 'M0 0 L5 5', width: 5, height: 5 })
    expect(canJoin(store, [r.id, l.id])).toBe(false)
    expect(canJoin(store, [l.id])).toBe(true)
  })
})
