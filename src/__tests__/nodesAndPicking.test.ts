import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore, type PathObject } from '@/stores/canvas'
import { gradientT } from '@/services/canvas/colorSampler'
import { canvasPickActive, deliverCanvasPick, registerCanvasPick } from '@/services/canvas/canvasPick'

describe('direct selection: anchors', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('derives editable nodes for a shape without changing its geometry', () => {
    const r = store.addObject({ type: 'path', shape: 'rect', d: 'M0 0H10V10H0Z', width: 10, height: 10 }) as PathObject
    store.ensurePathNodes(r.id)
    const o = store.getObject(r.id) as PathObject
    expect(o.nodes!.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    expect(o.closed).toBe(true)
    expect(o.shape).toBeUndefined()
  })

  it('deletes anchors and joins the neighbors', () => {
    const r = store.addObject({ type: 'path', d: 'M0 0H10V10H0Z', width: 10, height: 10 })
    store.deletePathNodes(r.id, [1])
    const o = store.getObject(r.id) as PathObject
    expect(o.nodes!.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [10, 10],
      [0, 10],
    ])
    expect(o.d).toBe('M0 0 L10 10 L0 10 Z')
  })

  it('drops a subpath left with one anchor, and the object when nothing is left', () => {
    const r = store.addObject({ type: 'path', d: 'M0 0H10V10Z M20 0H30V10Z', width: 30, height: 10 })
    store.deletePathNodes(r.id, [3, 4])
    const o = store.getObject(r.id) as PathObject
    expect(o.nodes).toHaveLength(3)
    expect(o.subpaths).toBeUndefined()
    store.deletePathNodes(r.id, [0, 1])
    expect(store.getObject(r.id)).toBeNull()
  })

  it('keeps a resized path its size when its nodes change', () => {
    const r = store.addObject({
      type: 'path',
      nodes: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      d: 'M0 0 L10 0',
      width: 20,
      height: 1,
      baseWidth: 10,
      baseHeight: 1,
    })
    store.updatePathNodes(r.id, [
      { x: 0, y: 0 },
      { x: 15, y: 0 },
    ])
    const o = store.getObject(r.id) as PathObject
    expect(o.baseWidth).toBe(15)
    expect(o.width).toBe(30) // still drawn at 2×
  })
})

describe('color picking', () => {
  it('finds the position along linear and radial gradients', () => {
    const lin = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [] }
    expect(gradientT(lin, { x: 0.25, y: 0.9 })).toBeCloseTo(0.25)
    expect(gradientT(lin, { x: 2, y: 0 })).toBe(1)
    const rad = { type: 'radial' as const, x1: 0.5, y1: 0.5, x2: 1, y2: 0.5, stops: [] }
    expect(gradientT(rad, { x: 0.5, y: 0.75 })).toBeCloseTo(0.5)
  })

  it('delivers canvas picks to the most recently opened picker', () => {
    const got: string[] = []
    expect(deliverCanvasPick('#000000')).toBe(false)
    const offA = registerCanvasPick((c) => got.push(`a${c}`))
    const offB = registerCanvasPick((c) => got.push(`b${c}`))
    expect(canvasPickActive.value).toBe(true)
    deliverCanvasPick('#111111')
    offB()
    deliverCanvasPick('#222222')
    offA()
    expect(canvasPickActive.value).toBe(false)
    expect(got).toEqual(['b#111111', 'a#222222'])
  })
})
