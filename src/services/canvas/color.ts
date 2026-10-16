// Color parsing/formatting shared by the color picker and the renderer.
//
// Object paints are stored as plain CSS color strings. Opaque colors stay
// `#rrggbb`; translucent ones are stored as `rgba(r, g, b, a)` and "no paint"
// as `none`. The renderer/exporter split a translucent paint into an opaque
// hex color + `fill-opacity`/`stroke-opacity`, which every SVG consumer
// (including desktop vector tools that reject rgba()) understands.

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export interface Hsv {
  h: number // 0..360
  s: number // 0..1
  v: number // 0..1
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// True for the paint values that mean "draw nothing".
export function isNonePaint(value: unknown): boolean {
  if (value == null) return true
  const s = String(value).trim().toLowerCase()
  return s === '' || s === 'none' || s === 'transparent'
}

// Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba(). Returns null for
// `none`/`transparent` and anything unparseable.
export function parseColor(value: unknown): Rgba | null {
  if (typeof value !== 'string' || isNonePaint(value)) return null
  const s = value.trim().toLowerCase()

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    let h = hex[1]!
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 }
  }

  const fn = /^rgba?\(\s*([^)]+)\)$/.exec(s)
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p))
    const [r, g, b] = parts.slice(0, 3).map(channel) as [number, number, number]
    let a = 1
    if (parts[3] !== undefined) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
    if ([r, g, b, a].some((x) => Number.isNaN(x))) return null
    return {
      r: Math.round(clamp(r, 0, 255)),
      g: Math.round(clamp(g, 0, 255)),
      b: Math.round(clamp(b, 0, 255)),
      a: clamp(a, 0, 1),
    }
  }
  return null
}

export function toHex({ r, g, b }: Pick<Rgba, 'r' | 'g' | 'b'>): string {
  const h = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

// Canonical stored form: `#RRGGBB` when opaque, `rgba(...)` when translucent.
export function formatColor(c: Rgba): string {
  const a = Math.round(clamp(c.a, 0, 1) * 100) / 100
  if (a >= 1) return toHex(c)
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`
}

// Split a stored paint into an SVG-friendly opaque color plus its alpha.
// Unparseable strings (e.g. named colors, url(#grad)) pass through untouched.
export function splitPaint(value: unknown): { color: string; opacity: number } {
  if (isNonePaint(value)) return { color: 'none', opacity: 1 }
  const c = parseColor(value)
  if (!c) return { color: String(value), opacity: 1 }
  return { color: toHex(c), opacity: c.a }
}

export function rgbToHsv({ r, g, b }: Pick<Rgba, 'r' | 'g' | 'b'>): Hsv {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max ? d / max : 0, v: max }
}

export function hsvToRgb({ h, s, v }: Hsv): Pick<Rgba, 'r' | 'g' | 'b'> {
  const c = v * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rgb: [number, number, number] = [0, 0, 0]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const m = v - c
  return { r: Math.round((rgb[0] + m) * 255), g: Math.round((rgb[1] + m) * 255), b: Math.round((rgb[2] + m) * 255) }
}
