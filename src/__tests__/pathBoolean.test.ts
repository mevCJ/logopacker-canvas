import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore, type PathObject } from '@/stores/canvas'
import {
  applyPathfinder,
  commitShapeBuilder,
  computeShapeRegions,
  loadPaper,
  objectCanvasPathData,
  regionAtPoint,
} from '@/services/canvas/pathBoolean'

// paper-core grabs a 2D context at import; happy-dom has none, so hand it a
// do-nothing context. Boolean geometry never draws.
beforeAll(async () => {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (...a: unknown[]) => unknown }
  const orig = proto.getContext
  proto.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    return orig.apply(this, args) || new Proxy({}, { get: (_t, k) => (k === 'canvas' ? this : () => ({})) })
  }
  await loadPaper()
})

function square(store: ReturnType<typeof useCanvasStore>, x: number, y: number, fill: string, artboardId: string) {
  return store.addObject({ type: 'path', d: 'M0 0 H10 V10 H0 Z', x, y, width: 10, height: 10, fill, artboardId }) as PathObject
}

describe('path booleans', () => {
  let store: ReturnType<typeof useCanvasStore>
  let ab: string
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    ab = store.addArtboard({ x: 100, y: 100 }).id
  })

  it('maps a scaled, artboard-placed path into canvas space', async () => {
    const o = store.addObject({ type: 'path', d: 'M0 0 H10 V10 H0 Z', x: 5, y: 5, width: 20, height: 10, baseWidth: 10, baseHeight: 10, artboardId: ab }) as PathObject
    const d = await objectCanvasPathData(store, o)
    expect(d).toMatch(/^M105,105/)
    expect(d).toContain('h20')
  })

  it('unites two overlapping squares into one object with the front style', async () => {
    const a = square(store, 0, 0, '#111111', ab)
    const b = square(store, 5, 5, '#222222', ab)
    const ids = await applyPathfinder(store, [a.id, b.id], 'unite')
    expect(ids).toHaveLength(1)
    const out = store.getObject(ids[0]!) as PathObject
    expect(out.fill).toBe('#222222')
    expect(out.x).toBe(0)
    expect(out.width).toBe(15)
    expect(store.getObject(a.id)).toBeNull()
    expect(store.getArtboard(ab)!.objectIds).toEqual(ids)
  })

  it('minus front keeps the back object style', async () => {
    const a = square(store, 0, 0, '#111111', ab)
    const b = square(store, 5, 0, '#222222', ab)
    const [id] = await applyPathfinder(store, [a.id, b.id], 'minusFront')
    const out = store.getObject(id!) as PathObject
    expect(out.fill).toBe('#111111')
    expect(out.width).toBe(5)
  })

  it('splits overlapping shapes into regions and merges picked ones', async () => {
    const a = square(store, 0, 0, '#111111', ab)
    const b = square(store, 5, 5, '#222222', ab)
    const regions = await computeShapeRegions(store, [a.id, b.id])
    // a-only, overlap, b-only
    expect(regions).toHaveLength(3)
    const aOnly = regionAtPoint(regions, { x: 101, y: 101 })
    const overlap = regionAtPoint(regions, { x: 107, y: 107 })
    expect(aOnly).toBeGreaterThanOrEqual(0)
    expect(regions[overlap]!.ownerId).toBe(b.id)

    const ids = commitShapeBuilder(store, [a.id, b.id], regions, [aOnly, overlap], false)
    // merged (a-only + overlap) + leftover b-only
    expect(ids).toHaveLength(2)
    const fills = ids.map((id) => (store.getObject(id) as PathObject).fill).sort()
    expect(fills).toEqual(['#111111', '#222222'])
  })

  it('erases picked regions', async () => {
    const a = square(store, 0, 0, '#111111', ab)
    const b = square(store, 5, 5, '#222222', ab)
    const regions = await computeShapeRegions(store, [a.id, b.id])
    const overlap = regionAtPoint(regions, { x: 107, y: 107 })
    const ids = commitShapeBuilder(store, [a.id, b.id], regions, [overlap], true)
    expect(ids).toHaveLength(2)
    expect(store.objectOrder).toHaveLength(2)
  })
})
