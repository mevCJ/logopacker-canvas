import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore, type PathObject } from '@/stores/canvas'
import { loadPaper } from '@/services/canvas/pathBoolean'
import { expandAppearance, strokePieces } from '@/services/canvas/expandAppearance'

beforeAll(async () => {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (...a: unknown[]) => unknown }
  const orig = proto.getContext
  proto.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    return orig.apply(this, args) || new Proxy({}, { get: (_t, k) => (k === 'canvas' ? this : () => ({})) })
  }
  await loadPaper()
})

describe('strokePieces', () => {
  it('builds one quad per segment and a miter wedge per corner', () => {
    const pieces = strokePieces([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, 2)
    expect(pieces).toHaveLength(3)
    // The right-angle corner's miter tip sits at (11, -1).
    const wedge = pieces[2]!
    expect(wedge.some((p) => Math.abs(p.x - 11) < 1e-9 && Math.abs(p.y + 1) < 1e-9)).toBe(true)
  })

  it('bevels joins sharper than the miter limit', () => {
    const pieces = strokePieces([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }], false, 2)
    expect(pieces[2]).toHaveLength(3)
  })
})

describe('expandAppearance', () => {
  let store: ReturnType<typeof useCanvasStore>
  let ab: string
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    ab = store.addArtboard({ x: 100, y: 100 }).id
  })

  it('replaces a stroke-only line with its filled outline', async () => {
    const line = store.addObject({ type: 'path', shape: 'line', d: 'M0 0 L100 0', x: 10, y: 20, width: 100, height: 0, fill: 'none', stroke: '#ff0000', strokeWidth: 4, artboardId: ab }) as PathObject
    const ids = await expandAppearance(store, [line.id])
    expect(ids).toHaveLength(1)
    expect(store.getObject(line.id)).toBeNull()
    const out = store.getObject(ids[0]!) as PathObject
    expect(out.fill).toBe('#ff0000')
    expect(out.stroke).toBe('none')
    expect(out.x).toBeCloseTo(10)
    expect(out.y).toBeCloseTo(18)
    expect(out.width).toBeCloseTo(100)
    expect(out.height).toBeCloseTo(4)
  })

  it('keeps the fill and adds a ring above it for a filled, stroked square', async () => {
    const sq = store.addObject({ type: 'path', d: 'M0 0 H10 V10 H0 Z', x: 0, y: 0, width: 20, height: 20, baseWidth: 10, baseHeight: 10, fill: '#00ff00', stroke: '#0000ff', strokeWidth: 2, artboardId: ab }) as PathObject
    const ids = await expandAppearance(store, [sq.id])
    expect(ids).toHaveLength(2)
    expect(store.getObject(sq.id)!.stroke).toBe('none')
    const ring = store.getObject(ids[1]!) as PathObject
    expect(ring.fill).toBe('#0000ff')
    // Scaled 2×, the 2-unit stroke is 4 canvas units: 20 + 4 across.
    expect(ring.width).toBeCloseTo(24)
    expect(ring.x).toBeCloseTo(-2)
    // A ring: outer contour plus the hole.
    expect(ring.subpaths).toHaveLength(2)
    expect(store.objectOrder.indexOf(ring.id)).toBe(store.objectOrder.indexOf(sq.id) + 1)
  })

  it('outlines a curve', async () => {
    const c = store.addObject({ type: 'path', d: 'M0 50 C0 0 100 0 100 50', x: 0, y: 0, width: 100, height: 50, fill: 'none', stroke: '#000000', strokeWidth: 6, artboardId: ab }) as PathObject
    const [id] = await expandAppearance(store, [c.id])
    const out = store.getObject(id!) as PathObject
    expect(out.nodes!.length).toBeGreaterThan(10)
    expect(out.width).toBeCloseTo(106, 0)
  })
})
