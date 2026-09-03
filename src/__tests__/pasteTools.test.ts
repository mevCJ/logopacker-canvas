import { describe, it, expect } from 'vitest'
import {
  looksLikeSvg,
  classifyClipboard,
  svgIntrinsicSize,
  svgToDataUrl,
} from '@/services/canvas/pasteTools'

// Minimal DataTransfer-like stub. Only the surface classifyClipboard touches.
function makeData(opts: {
  items?: { kind: string; type: string; file?: File }[]
  files?: File[]
  data?: Record<string, string>
}): DataTransfer {
  const items = (opts.items || []).map((it) => ({
    kind: it.kind,
    type: it.type,
    getAsFile: () => it.file ?? null,
  }))
  const data = opts.data || {}
  return {
    items,
    files: opts.files || [],
    getData: (type: string) => data[type] || '',
  } as unknown as DataTransfer
}

const PNG_FILE = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })

const SVG_PATHS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <path d="M0 0 L10 10 Z" fill="#3754FA"/>
  <path d="M20 20 L30 30" stroke="#000" stroke-width="2"/>
</svg>`

const SVG_NO_PATHS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40"/></svg>`

describe('pasteTools — looksLikeSvg', () => {
  it('accepts a plain svg document', () => {
    expect(looksLikeSvg(SVG_PATHS)).toBe(true)
  })
  it('accepts svg with an xml prolog and leading whitespace', () => {
    expect(looksLikeSvg(`\n  <?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>`)).toBe(true)
  })
  it('rejects plain text and html', () => {
    expect(looksLikeSvg('hello world')).toBe(false)
    expect(looksLikeSvg('<div>not svg</div>')).toBe(false)
    expect(looksLikeSvg('')).toBe(false)
  })
})

describe('pasteTools — classifyClipboard', () => {
  it('returns none for null data', () => {
    expect(classifyClipboard(null).kind).toBe('none')
  })

  it('prefers a bitmap image item', () => {
    const result = classifyClipboard(
      makeData({
        items: [{ kind: 'file', type: 'image/png', file: PNG_FILE }],
        data: { 'text/plain': 'ignored' },
      }),
    )
    expect(result.kind).toBe('image')
    if (result.kind === 'image') expect(result.file.name).toBe('shot.png')
  })

  it('falls back to files when items are empty', () => {
    const result = classifyClipboard(makeData({ files: [PNG_FILE] }))
    expect(result.kind).toBe('image')
  })

  it('does not treat image/svg+xml files as bitmap images', () => {
    const svgFile = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    const result = classifyClipboard(
      makeData({
        items: [{ kind: 'file', type: 'image/svg+xml', file: svgFile }],
        data: { 'image/svg+xml': SVG_PATHS },
      }),
    )
    expect(result.kind).toBe('svg')
  })

  it('detects svg markup via the svg mime type', () => {
    const result = classifyClipboard(makeData({ data: { 'image/svg+xml': SVG_PATHS } }))
    expect(result.kind).toBe('svg')
  })

  it('detects svg markup pasted as plain text', () => {
    const result = classifyClipboard(makeData({ data: { 'text/plain': SVG_PATHS } }))
    expect(result.kind).toBe('svg')
  })

  it('falls back to plain text', () => {
    const result = classifyClipboard(makeData({ data: { 'text/plain': 'hello there' } }))
    expect(result.kind).toBe('text')
    if (result.kind === 'text') expect(result.text).toBe('hello there')
  })

  it('returns none when nothing usable is present', () => {
    expect(classifyClipboard(makeData({ data: { 'text/plain': '   ' } })).kind).toBe('none')
  })
})

describe('pasteTools — svgIntrinsicSize', () => {
  it('reads dimensions from the viewBox', () => {
    expect(svgIntrinsicSize(SVG_PATHS)).toEqual({ width: 100, height: 50 })
  })

  it('reads dimensions from a viewBox with no paths', () => {
    expect(svgIntrinsicSize(SVG_NO_PATHS)).toEqual({ width: 40, height: 40 })
  })

  it('falls back to a default size for unparseable markup', () => {
    expect(svgIntrinsicSize('not svg at all')).toEqual({ width: 300, height: 200 })
  })
})

describe('pasteTools — svgToDataUrl', () => {
  it('produces a utf-8 svg data url', () => {
    const url = svgToDataUrl('<svg><path d="M0 0"/></svg>')
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(url.split(',')[1]!)).toContain('<svg>')
  })
})
