import { describe, it, expect } from 'vitest'
import {
  escapeXml,
  objectSvgMarkup,
  exportBounds,
  buildExportSvg,
  resolveExportSet,
  type ExportArtboard,
  type ExportStateSnapshot,
} from '@/services/canvas/svgExport'
import type { RenderObject } from '@/services/canvas/svgEngine'

const artboard: ExportArtboard = {
  id: 'ab1',
  name: 'Artboard 1',
  x: 100,
  y: 50,
  width: 400,
  height: 300,
  backgroundColor: '#FAFAFA',
  objectIds: ['p1', 't1'],
}

const pathObj: RenderObject = {
  id: 'p1',
  type: 'path',
  artboardId: 'ab1',
  x: 10,
  y: 20,
  width: 50,
  height: 50,
  baseWidth: 100,
  baseHeight: 100,
  rotation: 0,
  opacity: 1,
  d: 'M0 0 H100 V100 H0 Z',
  fill: '#211A43',
  stroke: 'none',
  strokeWidth: 0,
}

const textObj: RenderObject = {
  id: 't1',
  type: 'text',
  artboardId: 'ab1',
  x: 30,
  y: 40,
  width: 120,
  height: 30,
  baseWidth: 120,
  baseHeight: 30,
  rotation: 0,
  opacity: 1,
  text: 'A & B < "C"',
  fontFamily: 'Inter',
  fontSize: 24,
  fontWeight: 400,
  fill: '#000000',
  align: 'left',
}

const imageObj: RenderObject = {
  id: 'i1',
  type: 'image',
  artboardId: null,
  x: 5,
  y: 5,
  width: 200,
  height: 100,
  baseWidth: 400,
  baseHeight: 200,
  rotation: 0,
  opacity: 1,
  href: 'data:image/png;base64,ABC',
}

describe('svgExport — escapeXml', () => {
  it('escapes the five predefined entities', () => {
    expect(escapeXml('A & B < C > D " E \' F')).toBe(
      'A &amp; B &lt; C &gt; D &quot; E &apos; F',
    )
  })
  it('handles null/undefined as empty string', () => {
    expect(escapeXml(null)).toBe('')
    expect(escapeXml(undefined)).toBe('')
  })
})

describe('svgExport — objectSvgMarkup', () => {
  it('renders a path with base->display scale and absolute position', () => {
    const m = objectSvgMarkup(pathObj, artboard)
    expect(m.startsWith('<path')).toBe(true)
    expect(m).toContain('d="M0 0 H100 V100 H0 Z"')
    expect(m).toContain('fill="#211A43"')
    // abs position = artboard(100,50) + obj(10,20) = 110,70; scale = 50/100
    expect(m).toContain('translate(110 70)')
    expect(m).toContain('scale(0.5 0.5)')
  })

  it('renders text with escaped content and baseline at fontSize', () => {
    const m = objectSvgMarkup(textObj, artboard)
    expect(m.startsWith('<text')).toBe(true)
    expect(m).toContain('font-family="Inter"')
    expect(m).toContain('y="24"')
    expect(m).toContain('&amp;')
    expect(m).toContain('&lt;')
    expect(m).toContain('&quot;')
    // no raw special chars in the text body
    expect(m).not.toContain('A & B')
  })

  it('renders an image at intrinsic size scaled to display', () => {
    const m = objectSvgMarkup(imageObj, null)
    expect(m.startsWith('<image')).toBe(true)
    expect(m).toContain('href="data:image/png;base64,ABC"')
    // intrinsic size = base 400x200
    expect(m).toContain('width="400"')
    expect(m).toContain('height="200"')
    // scale = 200/400 = 0.5
    expect(m).toContain('scale(0.5 0.5)')
    expect(m).toContain('translate(5 5)')
  })
})

describe('svgExport — exportBounds', () => {
  it('unions objects only (no artboard bg)', () => {
    const b = exportBounds([pathObj, textObj], [artboard])
    // path abs (110,70) 50x50 -> right 160, bottom 120
    // text abs (130,90) 120x30 -> right 250, bottom 120
    expect(b.x).toBe(110)
    expect(b.y).toBe(70)
    expect(b.width).toBe(140) // 250 - 110
    expect(b.height).toBe(50) // 120 - 70
  })

  it('includes artboard rect when includeArtboardBg is set', () => {
    const b = exportBounds([pathObj], [artboard], { includeArtboardBg: true })
    expect(b.x).toBe(100)
    expect(b.y).toBe(50)
    expect(b.width).toBe(400)
    expect(b.height).toBe(300)
  })

  it('returns a zero box for an empty set', () => {
    const b = exportBounds([], [])
    expect(b).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('svgExport — buildExportSvg', () => {
  it('produces a well-formed, parseable document with correct viewBox', () => {
    const { svg, bounds } = buildExportSvg({
      objects: [pathObj, textObj],
      artboards: [artboard],
      includeArtboardBackgrounds: true,
    })
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain(`viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"`)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('svg')).not.toBeNull()
  })

  it('includes artboard background rect only when flagged', () => {
    const withBg = buildExportSvg({
      objects: [pathObj],
      artboards: [artboard],
      includeArtboardBackgrounds: true,
    })
    expect(withBg.svg).toContain('fill="#FAFAFA"')

    const noBg = buildExportSvg({
      objects: [pathObj],
      artboards: [artboard],
      includeArtboardBackgrounds: false,
    })
    expect(noBg.svg).not.toContain('fill="#FAFAFA"')
  })

  it('paints an optional solid background behind content', () => {
    const { svg } = buildExportSvg({
      objects: [pathObj],
      artboards: [artboard],
      background: '#FFFFFF',
    })
    const firstRectIdx = svg.indexOf('<rect')
    const pathIdx = svg.indexOf('<path')
    expect(firstRectIdx).toBeGreaterThan(-1)
    expect(firstRectIdx).toBeLessThan(pathIdx)
    expect(svg).toContain('fill="#FFFFFF"')
  })

  it('draws objects in the order provided (paint order)', () => {
    const { svg } = buildExportSvg({
      objects: [pathObj, textObj],
      artboards: [artboard],
    })
    expect(svg.indexOf('<path')).toBeLessThan(svg.indexOf('<text'))
  })
})

describe('svgExport — resolveExportSet', () => {
  const state: ExportStateSnapshot = {
    artboards: [artboard, { id: 'ab2', name: 'Two', x: 600, y: 50, width: 200, height: 200 }],
    objects: {
      p1: pathObj,
      t1: textObj,
      i1: { ...imageObj, artboardId: 'ab2' },
    },
    objectOrder: ['p1', 't1', 'i1'],
    selectedIds: ['t1'],
    selectedArtboardId: null,
  }

  it('selection scope returns selected objects, no backgrounds', () => {
    const set = resolveExportSet(state, 'selection')
    expect(set.objects.map((o) => o.id)).toEqual(['t1'])
    expect(set.includeArtboardBackgrounds).toBe(false)
    expect(set.artboards.map((a) => a.id)).toEqual(['ab1'])
  })

  it('empty selection yields an empty set', () => {
    const set = resolveExportSet({ ...state, selectedIds: [] }, 'selection')
    expect(set.objects).toEqual([])
  })

  it('artboard scope returns that artboard and its objects with backgrounds', () => {
    const set = resolveExportSet(state, 'artboard', 'ab1')
    expect(set.objects.map((o) => o.id)).toEqual(['p1', 't1'])
    expect(set.artboards.map((a) => a.id)).toEqual(['ab1'])
    expect(set.includeArtboardBackgrounds).toBe(true)
  })

  it('artboard scope with unknown id returns an empty artboard set', () => {
    const set = resolveExportSet(state, 'artboard', 'nope')
    expect(set.objects).toEqual([])
    expect(set.artboards).toEqual([])
  })

  it('all scope returns every object in paint order with backgrounds', () => {
    const set = resolveExportSet(state, 'all')
    expect(set.objects.map((o) => o.id)).toEqual(['p1', 't1', 'i1'])
    expect(set.artboards.map((a) => a.id)).toEqual(['ab1', 'ab2'])
    expect(set.includeArtboardBackgrounds).toBe(true)
  })
})
