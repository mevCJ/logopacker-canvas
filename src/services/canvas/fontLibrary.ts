// The fonts a designer can pick from, and where each font's file comes from.
//
//   builtin  — bundled (Inter) or near-universal system fonts
//   local    — installed on this computer, via the Local Font Access API
//              (Chromium only; asks for permission once)
//   uploaded — .ttf/.otf/.woff files the designer adds, registered with the
//              FontFace API (works in every browser, for this session)
//
// Text renders by CSS family name, so a local font works as soon as it's
// listed. Create Outlines needs the actual font file to read glyph shapes;
// fontFile() finds it from whichever source provides the family.
import { reactive } from 'vue'
import inter300 from '@fontsource/inter/files/inter-latin-300-normal.woff?url'
import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff?url'
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff?url'
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff?url'
import inter700 from '@fontsource/inter/files/inter-latin-700-normal.woff?url'
import type { FontData } from './webmcp'

export type FontSource = 'builtin' | 'local' | 'uploaded'

export interface FontFaceRef {
  weight: number
  italic: boolean
  style: string
  postscriptName?: string
  // One of these yields the font file.
  url?: string
  local?: FontData
  buffer?: ArrayBuffer
}

export interface FontEntry {
  // The CSS font-family value stored on text objects.
  family: string
  label: string
  source: FontSource
  faces: FontFaceRef[]
}

const BUILTIN: FontEntry[] = [
  {
    family: 'Inter',
    label: 'Inter',
    source: 'builtin',
    faces: [
      { weight: 300, italic: false, style: 'Light', url: inter300 },
      { weight: 400, italic: false, style: 'Regular', url: inter400 },
      { weight: 500, italic: false, style: 'Medium', url: inter500 },
      { weight: 600, italic: false, style: 'Semibold', url: inter600 },
      { weight: 700, italic: false, style: 'Bold', url: inter700 },
    ],
  },
  // System fonts: their files are only reachable through local font access.
  { family: 'Georgia, serif', label: 'Georgia', source: 'builtin', faces: [] },
  { family: '"Courier New", monospace', label: 'Courier New', source: 'builtin', faces: [] },
]

export type LocalFontStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unsupported'

export const fontLibrary = reactive<{ fonts: FontEntry[]; localStatus: LocalFontStatus }>({
  fonts: [...BUILTIN],
  localStatus: typeof window !== 'undefined' && window.queryLocalFonts ? 'idle' : 'unsupported',
})

// Weight from a style name ("SemiBold Italic" → 600).
export function weightFromStyle(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, '')
  const table: [RegExp, number][] = [
    [/thin|hairline/, 100],
    [/extralight|ultralight/, 200],
    [/light/, 300],
    [/medium/, 500],
    [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800],
    [/black|heavy/, 900],
    [/bold/, 700],
  ]
  for (const [re, w] of table) if (re.test(s)) return w
  return 400
}

// The family name as text objects store it (bare names with spaces are fine;
// rendering quotes them via cssFontFamily).
export function familyKey(family: string): string {
  return family.split(',')[0]!.trim().replace(/^["']|["']$/g, '')
}

export function findFont(family: string): FontEntry | undefined {
  const key = familyKey(family).toLowerCase()
  return fontLibrary.fonts.find((f) => familyKey(f.family).toLowerCase() === key)
}

// Available weights for a family (falls back to the standard set).
export function weightsFor(family: string): number[] {
  const f = findFont(family)
  const ws = [...new Set((f?.faces ?? []).filter((x) => !x.italic).map((x) => x.weight))].sort((a, b) => a - b)
  return ws.length ? ws : [300, 400, 500, 600, 700]
}

function upsert(entry: FontEntry): void {
  const existing = findFont(entry.family)
  if (!existing) {
    fontLibrary.fonts.push(entry)
    return
  }
  // Merge faces (a builtin system font gains files once local access is on).
  for (const face of entry.faces) {
    if (!existing.faces.some((f) => f.weight === face.weight && f.italic === face.italic)) existing.faces.push(face)
  }
}

// Ask for local font access and add every installed family. Must be called
// from a user gesture (a click).
export async function loadLocalFonts(): Promise<number> {
  if (!window.queryLocalFonts) {
    fontLibrary.localStatus = 'unsupported'
    throw new Error('This browser can’t list installed fonts. Use Chrome or Edge, or add font files instead.')
  }
  fontLibrary.localStatus = 'loading'
  let list: FontData[]
  try {
    list = await window.queryLocalFonts()
  } catch (err) {
    fontLibrary.localStatus = 'denied'
    throw new Error(`Font access was blocked: ${(err as Error).message || 'permission denied'}`)
  }
  const byFamily = new Map<string, FontFaceRef[]>()
  for (const f of list) {
    const faces = byFamily.get(f.family) ?? []
    faces.push({
      weight: weightFromStyle(f.style),
      italic: /italic|oblique/i.test(f.style),
      style: f.style,
      postscriptName: f.postscriptName,
      local: f,
    })
    byFamily.set(f.family, faces)
  }
  for (const [family, faces] of [...byFamily].sort((a, b) => a[0].localeCompare(b[0]))) {
    upsert({ family, label: family, source: 'local', faces })
  }
  fontLibrary.localStatus = 'granted'
  return byFamily.size
}

// Register uploaded font files with the FontFace API so text can use them.
// The family name comes from the font's own name table.
export async function addFontFiles(files: File[]): Promise<FontEntry[]> {
  const { parse } = await import('opentype.js')
  const added: FontEntry[] = []
  for (const file of files) {
    const buffer = await file.arrayBuffer()
    let family = file.name.replace(/\.(ttf|otf|woff2?)$/i, '')
    let style = 'Regular'
    try {
      const font = parse(buffer.slice(0))
      const names = font.names as unknown as Record<string, Record<string, string>>
      family = names.preferredFamily?.en || names.fontFamily?.en || family
      style = names.preferredSubfamily?.en || names.fontSubfamily?.en || style
    } catch {
      // WOFF2 (and anything opentype.js can't read) still renders; it just
      // can't be outlined.
    }
    const weight = weightFromStyle(style)
    const italic = /italic|oblique/i.test(style)
    const face = new FontFace(family, buffer.slice(0), { weight: String(weight), style: italic ? 'italic' : 'normal' })
    await face.load()
    document.fonts.add(face)
    const entry: FontEntry = { family, label: family, source: 'uploaded', faces: [{ weight, italic, style, buffer }] }
    upsert(entry)
    added.push(findFont(family)!)
  }
  return added
}

// The font file for a family/weight: nearest weight, upright preferred.
export async function fontFile(family: string, weight: number): Promise<ArrayBuffer | null> {
  const f = findFont(family)
  const faces = (f?.faces ?? []).filter((x) => x.url || x.local || x.buffer)
  if (!faces.length) return null
  const pick = [...faces].sort(
    (a, b) => Number(a.italic) - Number(b.italic) || Math.abs(a.weight - weight) - Math.abs(b.weight - weight),
  )[0]!
  if (pick.buffer) return pick.buffer.slice(0)
  if (pick.local?.blob) return (await pick.local.blob()).arrayBuffer()
  if (pick.url) return (await fetch(pick.url)).arrayBuffer()
  return null
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
}

// Weight options for a family's weight menu.
export function weightOptions(family: string): { value: number; label: string }[] {
  return weightsFor(family).map((w) => ({ value: w, label: WEIGHT_NAMES[w] ?? String(w) }))
}
