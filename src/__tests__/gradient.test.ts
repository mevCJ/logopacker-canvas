import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import {
  defaultGradient,
  gradientAngle,
  gradientMarkup,
  normalizeGradient,
  sampleGradient,
  withAngle,
  type GradientFill,
} from '@/services/canvas/gradient'
import { pathAttrs } from '@/services/canvas/svgEngine'
import { buildExportSvg } from '@/services/canvas/svgExport'

const g: GradientFill = {
  type: 'linear',
  x1: 0,
  y1: 0.5,
  x2: 1,
  y2: 0.5,
  stops: [
    { offset: 0, color: '#FF0000' },
    { offset: 1, color: 'rgba(0, 0, 255, 0.5)' },
  ],
}

describe('gradient fills', () => {
  it('builds linear and radial markup with stop opacity', () => {
    const m = gradientMarkup('grad-a', g)
    expect(m).toContain('<linearGradient id="grad-a" gradientUnits="objectBoundingBox" x1="0" y1="0.5" x2="1" y2="0.5">')
    expect(m).toContain('<stop offset="1" stop-color="#0000FF" stop-opacity="0.5" />')
    const r = gradientMarkup('grad-b', { ...g, type: 'radial', x1: 0.5, y1: 0.5, x2: 1, y2: 0.5 })
    expect(r).toContain('<radialGradient id="grad-b" gradientUnits="objectBoundingBox" cx="0.5" cy="0.5" fx="0.5" fy="0.5" r="0.5">')
  })

  it('angles and samples', () => {
    expect(gradientAngle(g)).toBe(0)
    const down = withAngle(g, 90)
    expect(down).toMatchObject({ x1: 0.5, y1: 0, x2: 0.5, y2: 1 })
    expect(gradientAngle(down)).toBe(90)
    expect(sampleGradient(g, 0.5)).toBe('rgba(128, 0, 128, 0.75)')
  })

  it('validates untrusted input', () => {
    expect(normalizeGradient({ stops: [{ offset: 0, color: 'red' }] })).toBeNull()
    const n = normalizeGradient({ type: 'radial', stops: [{ offset: 2, color: '#000' }, { offset: 0, color: '#fff' }] })
    expect(n!.type).toBe('radial')
    expect(n!.stops[0]!.offset).toBe(1)
  })

  it('points the fill at the object gradient and exports its defs', () => {
    const attrs = pathAttrs({ id: 'p1', type: 'path', fill: '#000', fillGradient: g })
    expect(attrs.fill).toBe('url(#grad-p1)')
    const { svg } = buildExportSvg({ objects: [{ id: 'p1', type: 'path', d: 'M0 0H10V10Z', fillGradient: g }], artboards: [] })
    expect(svg).toContain('<defs><linearGradient id="grad-p1"')
    expect(svg).toContain('fill="url(#grad-p1)"')
  })

  describe('store', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('a solid fill replaces the gradient; images take none', () => {
      const store = useCanvasStore()
      const p = store.addObject({ type: 'path', fill: '#123456' })
      store.setFillGradient(p.id, defaultGradient('#123456'))
      expect((store.getObject(p.id) as any).fillGradient.stops[0].color).toBe('#123456')
      store.setFill(p.id, '#FFFFFF')
      expect((store.getObject(p.id) as any).fillGradient).toBeUndefined()
      const img = store.addObject({ type: 'image' })
      expect(store.setFillGradient(img.id, g)).toBeNull()
    })

    it('aligns a selection to its union bounds', () => {
      const store = useCanvasStore()
      const a = store.addObject({ type: 'path', x: 0, y: 0, width: 10, height: 10 })
      const b = store.addObject({ type: 'path', x: 50, y: 20, width: 20, height: 10 })
      store.alignObjects([a.id, b.id], 'right')
      expect(store.getObject(a.id)!.x).toBe(60)
      expect(store.getObject(b.id)!.x).toBe(50)
      store.alignObjects([a.id, b.id], 'vcenter')
      expect(store.getObject(a.id)!.y).toBe(10)
    })
  })
})
