import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore, type TextObject } from '@/stores/canvas'
import { remapCharStyles, setCharStyle, textRuns, trackingPx } from '@/services/canvas/textStyle'
import { layoutAreaText, wrapTextRanges } from '@/services/canvas/textLayout'
import { objectSvgMarkup } from '@/services/canvas/svgExport'

const mono = (s: string, f: { size: number }) => s.length * f.size * 0.5

describe('letter styles', () => {
  it('splits text into runs of equal style', () => {
    const styles = setCharStyle(undefined, 5, 1, 3, { fill: '#ff0000' })
    expect(textRuns('LOGOS', 0, styles).map((r) => [r.text, r.style?.fill ?? null])).toEqual([
      ['L', null],
      ['OG', '#ff0000'],
      ['OS', null],
    ])
    // A slice of the text (a wrapped line) keeps its offsets.
    expect(textRuns('GOS', 2, styles).map((r) => [r.start, r.text])).toEqual([
      [2, 'G'],
      [3, 'OS'],
    ])
  })

  it('keeps styles on their letters through edits; typed letters inherit', () => {
    const styles = setCharStyle(undefined, 4, 1, 2, { fill: '#00f' }) // "LOGO", O blue
    const ins = remapCharStyles('LOGO', 'LOOGO', styles)!
    expect(ins.map((s) => s?.fill ?? null)).toEqual([null, '#00f', '#00f', null, null])
    const del = remapCharStyles('LOGO', 'GO', styles)
    expect(del).toBeUndefined()
  })

  it('converts tracking to user units', () => {
    expect(trackingPx(100, 40)).toBe(4)
  })
})

describe('layout with letter spacing', () => {
  it('reports where wrapped lines start', () => {
    const lines = wrapTextRanges('aa bb cc', 20, { family: 'x', size: 10, weight: 400 }, mono)
    expect(lines).toEqual([
      { text: 'aa', start: 0 },
      { text: 'bb', start: 3 },
      { text: 'cc', start: 6 },
    ])
  })

  it('wraps sooner when letters are spaced out', () => {
    const base = { text: 'aaaa bbbb', width: 50, height: 200, fontSize: 10 }
    expect(layoutAreaText(base, mono).lines).toHaveLength(1)
    expect(layoutAreaText({ ...base, tracking: 200 }, mono).lines).toHaveLength(2)
  })
})

describe('store + export', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('styles letters, keeps them through text edits, and resets', () => {
    const t = store.addObject({ type: 'text', text: 'LOGO', fontSize: 40 }) as TextObject
    store.setLetterStyle(t.id, 1, 2, { fill: '#ff0000', tracking: 200 })
    store.updateObject(t.id, { text: 'xLOGO' })
    const st = (store.getObject(t.id) as TextObject).charStyles!
    expect(st[2]).toEqual({ fill: '#ff0000', tracking: 200 })
    // Recoloring the whole text replaces letter colors but keeps spacing.
    store.setFill(t.id, '#000000')
    expect((store.getObject(t.id) as TextObject).charStyles![2]).toEqual({ tracking: 200 })
    // Whole-text tracking replaces letter spacing too.
    store.setTracking(t.id, 50)
    const after = store.getObject(t.id) as TextObject
    expect(after.charStyles).toBeUndefined()
    expect(after.tracking).toBe(50)
  })

  it('exports letter runs and tracking', () => {
    const t = store.addObject({ type: 'text', text: 'AB', fontSize: 20, tracking: 100 }) as TextObject
    store.setLetterStyle(t.id, 1, 2, { fill: '#ff0000' })
    const svg = objectSvgMarkup(store.getObject(t.id) as never, null)
    expect(svg).toContain('letter-spacing="2"')
    expect(svg).toMatch(/A<tspan[^>]*fill="#FF0000"[^>]*>B<\/tspan>/i)
  })
})
