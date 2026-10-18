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

import { charTrackingPx, type CharStyles } from './textStyle'

export const DEFAULT_LINE_HEIGHT = 1.2
// Line spacing of point type (multi-line text you click to place).
export const POINT_LEADING = 1.3

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

// A wrapped line and where it starts in the source text.
export interface WrappedLine {
  text: string
  start: number
}

// Break text into lines no wider than `width`. Hard line breaks are kept;
// words wider than the box are split by character. `extra(i)` adds width
// after character i (letter spacing).
export function wrapTextRanges(
  text: string,
  width: number,
  font: FontSpec,
  measure: MeasureText = measureText,
  extra?: (index: number) => number,
): WrappedLine[] {
  const lines: WrappedLine[] = []
  const maxW = Math.max(1, width)
  const widthAt = (start: number, s: string) => {
    let w = measure(s, font)
    if (extra) for (let k = 0; k < s.length; k++) w += extra(start + k)
    return w
  }
  let paraStart = 0
  for (const para of text.split('\n')) {
    const base = paraStart
    paraStart += para.length + 1
    if (para === '') {
      lines.push({ text: '', start: base })
      continue
    }
    // Keep the spaces attached to the preceding word so wrapping is stable.
    const re = /\S+\s*|\s+/g
    let line = ''
    let lineStart = base
    let m: RegExpExecArray | null
    while ((m = re.exec(para))) {
      const word = m[0]
      const wordStart = base + m.index
      if (!line) lineStart = wordStart
      const candidate = line + word
      if (widthAt(lineStart, candidate.trimEnd()) <= maxW) {
        line = candidate
        continue
      }
      // Doesn't fit: end the current line and start the word on a new one.
      if (line.trim() !== '') lines.push({ text: line.trimEnd(), start: lineStart })
      line = ''
      if (word.trim() === '') continue // whitespace at a wrap point is dropped
      lineStart = wordStart
      if (widthAt(wordStart, word.trimEnd()) <= maxW) {
        line = word
        continue
      }
      // A single word wider than the box: break it by characters.
      for (let k = 0; k < word.length; k++) {
        const ch = word[k]!
        if (line && widthAt(lineStart, (line + ch).trimEnd()) > maxW) {
          lines.push({ text: line, start: lineStart })
          line = ''
          lineStart = wordStart + k
        }
        line += ch
      }
    }
    lines.push({ text: line.trimEnd(), start: line ? lineStart : base + para.length })
  }
  return lines
}

export function wrapText(text: string, width: number, font: FontSpec, measure: MeasureText = measureText): string[] {
  return wrapTextRanges(text, width, font, measure).map((l) => l.text)
}

export interface AreaLine {
  text: string
  start: number // index of the line's first character in the text
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
  tracking?: number
  charStyles?: CharStyles
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
  const spaced = !!obj.tracking || !!obj.charStyles
  const extra = spaced ? (i: number) => charTrackingPx(i, obj.charStyles, obj.tracking, size) : undefined
  const all = wrapTextRanges(obj.text || '', width, font, measure, extra)
  const x = obj.align === 'center' ? width / 2 : obj.align === 'right' ? width : 0
  const lines: AreaLine[] = []
  for (let i = 0; i < all.length; i++) {
    const y = size + i * lead
    if (y + size * 0.25 > height) break
    lines.push({ text: all[i]!.text, start: all[i]!.start, x, y })
  }
  // Trailing empty lines don't count as overflow.
  const overflow = all.slice(lines.length).some((l) => l.text.trim() !== '')
  return { lines, overflow }
}
