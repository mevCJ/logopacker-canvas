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
// canvas. The result is one compound path per letter color (grouped when
// letters have colors of their own), keeping the text's fill.
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

// Path data (in the text element's local frame) for every visible glyph,
// bucketed by letter color: `colorOf(i)` gives character i's own fill, or
// null for the object's. Letters are read run by run (the renderer tags each
// <tspan> run with where it starts in the text) so per-letter styles map back
// to their characters; text without runs is read as one.
export function glyphPathsByColor(
  el: SVGTextElement,
  font: OpenTypeFont,
  fontSize: number,
  colorOf: (index: number) => string | null = () => null,
): Map<string | null, string> {
  const runs = [...el.querySelectorAll('tspan[data-start]')] as SVGTextContentElement[]
  const sources: { node: SVGTextContentElement; start: number }[] = runs.length
    ? runs.map((node) => ({ node, start: Number(node.getAttribute('data-start')) || 0 }))
    : [{ node: el, start: 0 }]
  const parts = new Map<string | null, string[]>()
  for (const { node, start } of sources) {
    const content = node.textContent ?? ''
    // The DOM indexes characters by UTF-16 unit; astral characters span two.
    const n = Math.min(node.getNumberOfChars(), content.length)
    for (let i = 0; i < n; ) {
      const idx = i
      const code = content.codePointAt(i)!
      i += code > 0xffff ? 2 : 1
      const ch = String.fromCodePoint(code)
      if (/\s/.test(ch)) continue
      let pos: DOMPoint
      let rot = 0
      try {
        pos = node.getStartPositionOfChar(idx)
        rot = node.getRotationOfChar(idx) || 0
      } catch {
        continue // not rendered (e.g. hidden overflow)
      }
      const glyph = font.charToGlyph(ch)
      if (!glyph || glyph.index === 0) continue // .notdef: font lacks the glyph
      const d = glyph.getPath(0, 0, fontSize).toPathData(3)
      if (!d) continue
      let sp = svgpath(d)
      if (rot) sp = sp.rotate(rot, 0, 0)
      const color = colorOf(start + idx)
      if (!parts.has(color)) parts.set(color, [])
      parts.get(color)!.push(sp.translate(pos.x, pos.y).toString())
    }
  }
  return new Map([...parts].map(([c, ps]) => [c, ps.join(' ')]))
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
    // One compound path per letter color: the object's own color, plus one
    // for each color given to individual letters.
    const byColor = glyphPathsByColor(el, font, t.fontSize || 24, (i) => t.charStyles?.[i]?.fill ?? null)
    const ab = t.artboardId ? store.getArtboard(t.artboardId) : null
    const transform = el.getAttribute('transform')
    const baseName = `${(t.name || t.text).trim().slice(0, 40)} (outlines)`
    const payloads: AddObjectPayload[] = []
    for (const [color, local] of byColor) {
      if (!local) continue
      // Through the element's own transform (translate + rotation) to canvas
      // space, then into the artboard's frame.
      let sp = svgpath(local)
      if (transform) sp = sp.transform(transform)
      const canvasD = sp.translate(-(ab?.x ?? 0), -(ab?.y ?? 0)).toString()
      const { nodes, subpaths, closed } = flattenSubpaths(parsePathData(canvasD))
      if (nodes.length < 2) continue
      const b = nodesBounds(nodes)
      const rel = translateNodes(nodes, -b.x, -b.y)
      payloads.push({
        type: 'path',
        d: nodesToPathData(rel, closed, subpaths),
        nodes: rel,
        subpaths,
        closed,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        fill: color ?? t.fill,
        fillGradient: color === null && t.fillGradient ? JSON.parse(JSON.stringify(t.fillGradient)) : undefined,
        stroke: 'none',
        strokeWidth: 0,
        opacity: t.opacity,
        semanticRole: t.semanticRole,
        artboardId: t.artboardId,
        layerId: t.layerId,
        groupId: t.groupId,
        name: color === null ? baseName : `${baseName} ${color}`,
      })
    }
    if (!payloads.length) continue
    const ids = replaceObjects(store, [t.id], payloads)
    // Several colors: keep the word together as a group.
    if (ids.length > 1) store.groupObjects(ids, baseName)
    created.push(...ids)
  }
  if (missing.size && !created.length) {
    throw new MissingFontError(
      `The font file for ${[...missing].join(', ')} isn’t available. Load local fonts (Type menu) or add the font file, then try again.`,
    )
  }
  return created
}
