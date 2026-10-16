// Create Outlines: convert text objects into vector paths (Illustrator's
// Type > Create Outlines), so a wordmark no longer depends on the font being
// installed and its letters can be reshaped with the node tool.
//
// Layout comes from the browser's own rendering of the text: for every
// character we read its start position and rotation from the live <text>
// element (getStartPositionOfChar / getRotationOfChar). That captures
// alignment, wrapping in area type and placement along a path exactly as
// drawn. Glyph shapes come from the real font file (opentype.js), placed at
// those positions; the text element's transform then takes them to the
// canvas. The result is one compound path that keeps the text's fill.
import svgpath from 'svgpath'
import type { CanvasStore, TextObject, AddObjectPayload } from '@/stores/canvas'
import { fontFile, familyKey } from './fontLibrary'
import { flattenSubpaths, parsePathData } from './svgToPaths'
import { nodesBounds, nodesToPathData, translateNodes } from './svgEngine'
import { replaceObjects } from './pathBoolean'

type OpenTypeFont = import('opentype.js').Font

const fontCache = new Map<string, Promise<OpenTypeFont | null>>()

async function loadFont(family: string, weight: number): Promise<OpenTypeFont | null> {
  const key = `${familyKey(family)}|${weight}`
  if (!fontCache.has(key)) {
    fontCache.set(
      key,
      (async () => {
        const buf = await fontFile(family, weight)
        if (!buf) return null
        const { parse } = await import('opentype.js')
        return parse(buf)
      })().catch(() => null),
    )
  }
  return fontCache.get(key)!
}

export class MissingFontError extends Error {}

// Path data (in the text element's local frame) for every visible glyph.
export function glyphPathData(el: SVGTextElement, font: OpenTypeFont, fontSize: number): string {
  const content = el.textContent ?? ''
  const parts: string[] = []
  // The DOM indexes characters by UTF-16 unit; astral characters span two.
  const n = Math.min(el.getNumberOfChars(), content.length)
  for (let i = 0; i < n; ) {
    const idx = i
    const code = content.codePointAt(i)!
    i += code > 0xffff ? 2 : 1
    const ch = String.fromCodePoint(code)
    if (/\s/.test(ch)) continue
    let pos: DOMPoint
    let rot = 0
    try {
      pos = el.getStartPositionOfChar(idx)
      rot = el.getRotationOfChar(idx) || 0
    } catch {
      continue // not rendered (e.g. hidden overflow)
    }
    const glyph = font.charToGlyph(ch)
    if (!glyph || glyph.index === 0) continue // .notdef: font lacks the glyph
    const d = glyph.getPath(0, 0, fontSize).toPathData(3)
    if (!d) continue
    let sp = svgpath(d)
    if (rot) sp = sp.rotate(rot, 0, 0)
    parts.push(sp.translate(pos.x, pos.y).toString())
  }
  return parts.join(' ')
}

// Convert text objects to paths in place. Returns the new path ids. Throws
// MissingFontError naming fonts whose files aren't available.
export async function createOutlines(store: CanvasStore, ids: string[]): Promise<string[]> {
  const texts = ids
    .map((id) => store.getObject(id))
    .filter((o): o is TextObject => !!o && o.type === 'text' && !!(o.text || '').trim())
  if (!texts.length) throw new Error('Select text to convert to outlines.')

  const created: string[] = []
  const missing = new Set<string>()
  for (const t of texts) {
    const el = document.getElementById(t.id) as SVGTextElement | null
    if (!el || typeof el.getStartPositionOfChar !== 'function') continue
    const weight = Number(t.fontWeight) || 400
    const font = await loadFont(t.fontFamily, weight)
    if (!font) {
      missing.add(familyKey(t.fontFamily))
      continue
    }
    const local = glyphPathData(el, font, t.fontSize || 24)
    if (!local) continue
    // Through the element's own transform (translate + rotation) to canvas
    // space, then into the artboard's frame.
    const ab = t.artboardId ? store.getArtboard(t.artboardId) : null
    let sp = svgpath(local)
    const transform = el.getAttribute('transform')
    if (transform) sp = sp.transform(transform)
    const canvasD = sp.translate(-(ab?.x ?? 0), -(ab?.y ?? 0)).toString()

    const { nodes, subpaths, closed } = flattenSubpaths(parsePathData(canvasD))
    if (nodes.length < 2) continue
    const b = nodesBounds(nodes)
    const rel = translateNodes(nodes, -b.x, -b.y)
    const payload: AddObjectPayload = {
      type: 'path',
      d: nodesToPathData(rel, closed, subpaths),
      nodes: rel,
      subpaths,
      closed,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      fill: t.fill,
      fillGradient: t.fillGradient ? JSON.parse(JSON.stringify(t.fillGradient)) : undefined,
      stroke: 'none',
      strokeWidth: 0,
      opacity: t.opacity,
      semanticRole: t.semanticRole,
      artboardId: t.artboardId,
      name: `${(t.name || t.text).trim().slice(0, 40)} (outlines)`,
    }
    created.push(...replaceObjects(store, [t.id], [payload]))
  }
  if (missing.size && !created.length) {
    throw new MissingFontError(
      `The font file for ${[...missing].join(', ')} isn’t available. Load local fonts (Type menu) or add the font file, then try again.`,
    )
  }
  return created
}
