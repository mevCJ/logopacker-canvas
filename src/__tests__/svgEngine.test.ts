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
    expect(i.preserveAspectRatio).toBe('xMidYMid slice')
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
})
