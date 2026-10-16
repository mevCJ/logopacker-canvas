import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import { cssFontFamily, layoutAreaText, wrapText, type MeasureText } from '@/services/canvas/textLayout'
import { weightFromStyle } from '@/services/canvas/fontLibrary'
import { buildExportSvg } from '@/services/canvas/svgExport'

// Monospace measure: every character is 10 units wide.
const mono: MeasureText = (t) => t.length * 10
const font = { family: 'Inter', size: 20, weight: 400 }

describe('area type layout', () => {
  it('wraps words to the box width and keeps hard breaks', () => {
    expect(wrapText('logo packer canvas', 120, font, mono)).toEqual(['logo packer', 'canvas'])
    expect(wrapText('one\n\ntwo', 200, font, mono)).toEqual(['one', '', 'two'])
  })

  it('breaks a word wider than the box', () => {
    expect(wrapText('abcdefghij', 40, font, mono)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('positions lines by alignment and hides what does not fit', () => {
    const base = { text: 'aa bb cc dd', width: 30, fontSize: 20, lineHeight: 1.5 }
    // Lines at baselines 20, 50, 80, 110; height 90 fits three (110+5 > 90).
    const l = layoutAreaText({ ...base, height: 90, align: 'center' }, mono)
    expect(l.lines.map((x) => x.text)).toEqual(['aa', 'bb', 'cc'])
    expect(l.lines.map((x) => x.y)).toEqual([20, 50, 80])
    expect(l.lines[0]!.x).toBe(15)
    expect(l.overflow).toBe(true)
    expect(layoutAreaText({ ...base, height: 200 }, mono).overflow).toBe(false)
  })

  it('quotes bare multi-word families for CSS', () => {
    expect(cssFontFamily('Helvetica Neue')).toBe('"Helvetica Neue"')
    expect(cssFontFamily('Georgia, serif')).toBe('Georgia, serif')
    expect(cssFontFamily('Inter')).toBe('Inter')
  })

  it('reads font weights from style names', () => {
    expect(weightFromStyle('SemiBold Italic')).toBe(600)
    expect(weightFromStyle('ExtraBold')).toBe(800)
    expect(weightFromStyle('Bold')).toBe(700)
    expect(weightFromStyle('Regular')).toBe(400)
    expect(weightFromStyle('Thin')).toBe(100)
  })

  it('exports area type as positioned lines', () => {
    const { svg } = buildExportSvg({
      objects: [{ id: 't', type: 'text', text: 'hello world', area: true, width: 2000, height: 100, fontSize: 20 }],
      artboards: [],
    })
    expect(svg).toContain('<tspan x="0" y="20">hello world</tspan>')
  })
})

describe('font size stepping', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('steps point type proportionally and leaves area boxes alone', () => {
    const store = useCanvasStore()
    const point = store.addObject({ type: 'text', text: 'A', fontSize: 20, width: 40, height: 20 })
    const area = store.addObject({ type: 'text', text: 'B', fontSize: 20, width: 200, height: 100, area: true } as never)
    const img = store.addObject({ type: 'image' })
    expect(store.bumpFontSize([point.id, area.id, img.id], 2)).toEqual([point.id, area.id])
    expect(store.getObject(point.id)).toMatchObject({ fontSize: 22, width: 44, height: 22 })
    expect(store.getObject(area.id)).toMatchObject({ fontSize: 22, width: 200, height: 100 })
    store.bumpFontSize([point.id], -100)
    expect((store.getObject(point.id) as { fontSize: number }).fontSize).toBe(1)
  })
})
