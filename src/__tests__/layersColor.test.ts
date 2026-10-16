import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import { formatColor, hsvToRgb, parseColor, rgbToHsv, splitPaint } from '@/services/canvas/color'
import { pathAttrs } from '@/services/canvas/svgEngine'
import { buildExportSvg } from '@/services/canvas/svgExport'

describe('color utils', () => {
  it('parses hex, short hex, 8-digit hex and rgba', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('#00ff0080')!.a).toBeCloseTo(0.502, 2)
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseColor('none')).toBeNull()
    expect(parseColor('url(#g)')).toBeNull()
  })

  it('formats opaque as hex and translucent as rgba', () => {
    expect(formatColor({ r: 33, g: 26, b: 67, a: 1 })).toBe('#211A43')
    expect(formatColor({ r: 33, g: 26, b: 67, a: 0.4 })).toBe('rgba(33, 26, 67, 0.4)')
  })

  it('round-trips through HSV', () => {
    const rgb = { r: 69, g: 143, b: 213 }
    expect(hsvToRgb(rgbToHsv(rgb))).toEqual(rgb)
  })

  it('splits translucent paints into color + opacity attrs', () => {
    expect(splitPaint('rgba(255, 0, 0, 0.25)')).toEqual({ color: '#FF0000', opacity: 0.25 })
    const attrs = pathAttrs({ id: 'p', type: 'path', fill: 'rgba(255, 0, 0, 0.25)', stroke: '#000' })
    expect(attrs.fill).toBe('#FF0000')
    expect(attrs['fill-opacity']).toBe(0.25)
    expect(attrs.stroke).toBe('#000')
    expect(attrs['stroke-opacity']).toBe(1)
  })
})

describe('layers', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('reorders and shifts objects in paint order', () => {
    const a = store.addObject({ type: 'path' })
    const b = store.addObject({ type: 'path' })
    const c = store.addObject({ type: 'path' })
    store.reorderObject(c.id, 0)
    expect(store.objectOrder).toEqual([c.id, a.id, b.id])
    store.shiftObject(c.id, 1)
    expect(store.objectOrder).toEqual([a.id, c.id, b.id])
    store.shiftObject(b.id, 1) // already front: clamped
    expect(store.objectOrder).toEqual([a.id, c.id, b.id])
  })

  it('hidden and locked objects drop out of and cannot enter the selection', () => {
    const a = store.addObject({ type: 'path' })
    const b = store.addObject({ type: 'path' })
    store.selectObjects([a.id, b.id])
    store.setObjectHidden(a.id, true)
    expect(store.selectedIds).toEqual([b.id])
    store.setObjectLocked(b.id, true)
    expect(store.selectedIds).toEqual([])
    store.selectObjects([a.id, b.id])
    expect(store.selectedIds).toEqual([])
    store.setObjectHidden(a.id, false)
    store.selectObjects([a.id])
    expect(store.selectedIds).toEqual([a.id])
  })

  it('renames, and a blank name clears the override', () => {
    const a = store.addObject({ type: 'path' })
    store.renameObject(a.id, '  Mark  ')
    expect(store.getObject(a.id)!.name).toBe('Mark')
    store.renameObject(a.id, '  ')
    expect(store.getObject(a.id)!.name).toBeUndefined()
  })

  it('toggles outline view', () => {
    expect(store.viewMode).toBe('preview')
    store.toggleViewMode()
    expect(store.viewMode).toBe('outline')
  })

  it('export skips hidden objects and writes text on a path', () => {
    const { svg } = buildExportSvg({
      objects: [
        { id: 'h', type: 'path', d: 'M0 0H5', hidden: true },
        { id: 't', type: 'text', text: 'ROUND', pathD: 'M0 0C10 0 20 10 20 20', pathOffset: 25 },
      ],
      artboards: [],
    })
    expect(svg).not.toContain('M0 0H5')
    expect(svg).toContain('<path id="tp-t" d="M0 0C10 0 20 10 20 20" />')
    expect(svg).toContain('<textPath href="#tp-t" startOffset="25%">ROUND</textPath>')
  })
})
