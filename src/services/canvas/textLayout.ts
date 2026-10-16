// Text layout for area type (Illustrator's text box).
//
// Point type is a single run per line, placed where you click; resizing it
// scales the font. Area type flows inside a fixed box: resizing the box
// re-wraps the text and never changes the font size. Text that doesn't fit is
// hidden and the box shows an overflow marker.
//
// SVG has no automatic line wrapping, so lines are broken here (greedy word
// wrap using measured advance widths) and rendered as one <tspan> per line.
// The live renderer and SVG export share this so they wrap identically.

export const DEFAULT_LINE_HEIGHT = 1.2

export interface FontSpec {
  family: string
  size: number
  weight: number | string
}

export type MeasureText = (text: string, font: FontSpec) => number

// CSS font-family value: quote a bare family name that has spaces.
export function cssFontFamily(family: string): string {
  const f = (family || 'Inter').trim()
  if (/[,"']/.test(f) || !/\s/.test(f)) return f
  return `"${f}"`
}

let ctx: CanvasRenderingContext2D | null | undefined
// Canvas-based measurement in the browser; a rough per-character estimate
// where no 2D canvas exists (tests, workers).
export function measureText(text: string, font: FontSpec): number {
  if (ctx === undefined) {
    try {
      ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    } catch {
      ctx = null
    }
  }
  if (ctx && typeof ctx.measureText === 'function') {
    ctx.font = `${font.weight} ${font.size}px ${cssFontFamily(font.family)}`
    const w = ctx.measureText(text).width
    if (Number.isFinite(w)) return w
  }
  return text.length * font.size * 0.55
}

// Break text into lines no wider than `width`. Hard line breaks are kept;
// words wider than the box are split by character.
export function wrapText(text: string, width: number, font: FontSpec, measure: MeasureText = measureText): string[] {
  const lines: string[] = []
  const maxW = Math.max(1, width)
  for (const para of text.split('\n')) {
    if (para === '') {
      lines.push('')
      continue
    }
    // Keep the spaces attached to the preceding word so wrapping is stable.
    const words = para.match(/\S+\s*|\s+/g) ?? ['']
    let line = ''
    for (const word of words) {
      const candidate = line + word
      if (measure(candidate.trimEnd(), font) <= maxW) {
        line = candidate
        continue
      }
      // Doesn't fit: end the current line and start the word on a new one.
      if (line.trim() !== '') lines.push(line.trimEnd())
      line = ''
      if (word.trim() === '') continue // whitespace at a wrap point is dropped
      if (measure(word.trimEnd(), font) <= maxW) {
        line = word
        continue
      }
      // A single word wider than the box: break it by characters.
      for (const ch of word) {
        if (line && measure((line + ch).trimEnd(), font) > maxW) {
          lines.push(line)
          line = ''
        }
        line += ch
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

export interface AreaLine {
  text: string
  x: number
  y: number // baseline
}

export interface AreaLayout {
  lines: AreaLine[]
  overflow: boolean
}

export interface AreaTextInput {
  text?: string
  width?: number
  height?: number
  fontSize?: number
  fontFamily?: string
  fontWeight?: number | string
  align?: string
  lineHeight?: number
}

// Lines that fit in the box, with their positions in the box's local frame.
// The first baseline sits at one font size from the top (same as point type);
// a line is shown only if its descender fits.
export function layoutAreaText(obj: AreaTextInput, measure: MeasureText = measureText): AreaLayout {
  const size = obj.fontSize || 24
  const font: FontSpec = { family: obj.fontFamily || 'Inter', size, weight: obj.fontWeight ?? 400 }
  const width = obj.width || 0
  const height = obj.height || 0
  const lead = size * (obj.lineHeight || DEFAULT_LINE_HEIGHT)
  const all = wrapText(obj.text || '', width, font, measure)
  const x = obj.align === 'center' ? width / 2 : obj.align === 'right' ? width : 0
  const lines: AreaLine[] = []
  for (let i = 0; i < all.length; i++) {
    const y = size + i * lead
    if (y + size * 0.25 > height) break
    lines.push({ text: all[i]!, x, y })
  }
  // Trailing empty lines don't count as overflow.
  const overflow = all.slice(lines.length).some((l) => l.trim() !== '')
  return { lines, overflow }
}
