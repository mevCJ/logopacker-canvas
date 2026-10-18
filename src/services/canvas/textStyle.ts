// Character styles: per-letter color and letter spacing on text objects.
//
// A text object has an object-wide `tracking` (letter spacing in 1/1000 em,
// as in Illustrator) and optionally `charStyles`, one entry per character of
// its text (UTF-16 index, like the DOM): null for "as the object", or a style
// overriding the fill and/or tracking of that letter. Consecutive letters with
// the same style render as one <tspan> run.

export interface CharStyle {
  fill?: string
  // Letter spacing after this letter, in 1/1000 em.
  tracking?: number
}

export type CharStyles = (CharStyle | null)[]

// Tracking (1/1000 em) in user units at a font size.
export function trackingPx(tracking: number | undefined, fontSize: number): number {
  return ((tracking || 0) / 1000) * fontSize
}

const same = (a: CharStyle | null | undefined, b: CharStyle | null | undefined) =>
  (a?.fill ?? null) === (b?.fill ?? null) && (a?.tracking ?? null) === (b?.tracking ?? null)

const isEmpty = (s: CharStyle | null | undefined) => !s || (s.fill === undefined && s.tracking === undefined)

// Normalize: one entry per character, nulls for plain letters; undefined
// when no letter has a style of its own.
export function normalizeCharStyles(styles: CharStyles | undefined, length: number): CharStyles | undefined {
  if (!styles?.length) return undefined
  const out: CharStyles = Array.from({ length }, (_, i) => (isEmpty(styles[i]) ? null : { ...styles[i]! }))
  return out.some((s) => s) ? out : undefined
}

// Keep letter styles attached to their letters when the text is edited:
// the unchanged start and end keep theirs, and typed letters take the style
// of the letter before them (as typing does in Illustrator).
export function remapCharStyles(oldText: string, newText: string, styles: CharStyles | undefined): CharStyles | undefined {
  if (!styles?.length) return undefined
  let pre = 0
  const max = Math.min(oldText.length, newText.length)
  while (pre < max && oldText[pre] === newText[pre]) pre++
  let suf = 0
  while (suf < max - pre && oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]) suf++
  const inserted = newText.length - pre - suf
  const carry = pre > 0 ? styles[pre - 1] ?? null : null
  const out: CharStyles = [
    ...styles.slice(0, pre),
    ...Array.from({ length: inserted }, () => (carry ? { ...carry } : null)),
    ...styles.slice(oldText.length - suf),
  ]
  return normalizeCharStyles(out, newText.length)
}

// Merge a style patch into letters [start, end); keys the patch leaves out
// keep their value. clearCharStyles removes styles.
export function setCharStyle(
  styles: CharStyles | undefined,
  length: number,
  start: number,
  end: number,
  patch: CharStyle,
): CharStyles | undefined {
  const out: CharStyles = Array.from({ length }, (_, i) => (styles?.[i] ? { ...styles[i]! } : null))
  for (let i = Math.max(0, start); i < Math.min(length, end); i++) out[i] = { ...(out[i] ?? {}), ...patch }
  return normalizeCharStyles(out, length)
}

// Drop the letter styles of [start, end) (all letters by default).
export function clearCharStyles(styles: CharStyles | undefined, length: number, start = 0, end = length): CharStyles | undefined {
  if (!styles) return undefined
  const out = styles.slice(0, length).map((s, i) => (i >= start && i < end ? null : s))
  return normalizeCharStyles(out, length)
}

export interface TextRun {
  start: number
  text: string
  style: CharStyle | null
}

// Split text[start, start + text.length) into runs of equal style.
export function textRuns(text: string, start: number, styles: CharStyles | undefined): TextRun[] {
  if (!text) return []
  if (!styles) return [{ start, text, style: null }]
  const runs: TextRun[] = []
  let runStart = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || !same(styles[start + i], styles[start + runStart])) {
      runs.push({ start: start + runStart, text: text.slice(runStart, i), style: styles[start + runStart] ?? null })
      runStart = i
    }
  }
  return runs
}

// The letter spacing (user units) after character i.
export function charTrackingPx(i: number, styles: CharStyles | undefined, tracking: number | undefined, fontSize: number): number {
  return trackingPx(styles?.[i]?.tracking ?? tracking, fontSize)
}
