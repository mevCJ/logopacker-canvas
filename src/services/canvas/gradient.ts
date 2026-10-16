// Gradient fills for paths and text.
//
// A gradient lives on the object as `fillGradient` and overrides `fill` while
// present. Geometry is in objectBoundingBox units (0..1 across the object's
// own geometry box), so the gradient follows the object through move, resize
// and rotation without being rewritten:
//   linear — runs from (x1, y1) to (x2, y2)
//   radial — centered on (x1, y1) with radius |(x2, y2) − (x1, y1)|
// The same markup builder feeds the live renderer's <defs> and SVG export.
import { formatColor, parseColor, splitPaint, type Rgba } from './color'

export interface GradientStop {
  offset: number // 0..1
  color: string // any stored paint string (hex or rgba)
}

export interface GradientFill {
  type: 'linear' | 'radial'
  x1: number
  y1: number
  x2: number
  y2: number
  stops: GradientStop[]
}

export const GRADIENT_TYPES = ['linear', 'radial'] as const

export function gradientId(objectId: string): string {
  return `grad-${objectId}`
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function esc(v: unknown): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
const r4 = (n: number) => Math.round(n * 10000) / 10000

// A starting gradient for an object currently painted `fill`: that color
// fading to white, left to right (Illustrator starts white→black; starting
// from the object's own color keeps the design recognizable).
export function defaultGradient(fill: string | undefined, type: GradientFill['type'] = 'linear'): GradientFill {
  const c = parseColor(fill ?? '')
  const from = c ? formatColor(c) : '#211A43'
  return type === 'radial'
    ? { type, x1: 0.5, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: from }] }
    : { type, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: from }, { offset: 1, color: '#FFFFFF' }] }
}

export function sortedStops(g: GradientFill): GradientStop[] {
  return [...g.stops].sort((a, b) => a.offset - b.offset)
}

export function gradientMarkup(id: string, g: GradientFill): string {
  const stops = sortedStops(g)
    .map((s) => {
      const { color, opacity } = splitPaint(s.color)
      return `<stop offset="${r4(clamp01(s.offset))}" stop-color="${esc(color)}" stop-opacity="${r4(opacity)}" />`
    })
    .join('')
  if (g.type === 'radial') {
    const r = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) || 0.5
    return (
      `<radialGradient id="${esc(id)}" gradientUnits="objectBoundingBox" ` +
      `cx="${r4(g.x1)}" cy="${r4(g.y1)}" fx="${r4(g.x1)}" fy="${r4(g.y1)}" r="${r4(r)}">${stops}</radialGradient>`
    )
  }
  return (
    `<linearGradient id="${esc(id)}" gradientUnits="objectBoundingBox" ` +
    `x1="${r4(g.x1)}" y1="${r4(g.y1)}" x2="${r4(g.x2)}" y2="${r4(g.y2)}">${stops}</linearGradient>`
  )
}

// CSS preview of the stops, left to right (for swatches and the stop bar).
export function gradientCss(g: GradientFill, direction = 'to right'): string {
  const stops = sortedStops(g).map((s) => `${s.color} ${r4(clamp01(s.offset) * 100)}%`)
  if (g.type === 'radial' && direction === 'swatch') return `radial-gradient(circle, ${stops.join(', ')})`
  return `linear-gradient(${direction === 'swatch' ? `${gradientAngle(g) + 90}deg` : direction}, ${stops.join(', ')})`
}

// Linear angle in degrees (0 = left→right, 90 = top→bottom).
export function gradientAngle(g: GradientFill): number {
  const a = (Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI
  return Math.round(((a % 360) + 360) % 360)
}

// Re-aim a linear gradient through the box center at `deg`, spanning the box.
export function withAngle(g: GradientFill, deg: number): GradientFill {
  const rad = (deg * Math.PI) / 180
  const dx = Math.cos(rad) / 2
  const dy = Math.sin(rad) / 2
  return { ...g, x1: r4(0.5 - dx), y1: r4(0.5 - dy), x2: r4(0.5 + dx), y2: r4(0.5 + dy) }
}

export function reverseStops(g: GradientFill): GradientFill {
  return { ...g, stops: g.stops.map((s) => ({ ...s, offset: r4(1 - s.offset) })) }
}

// The color at position t (0..1), interpolated in RGBA between neighbors.
export function sampleGradient(g: GradientFill, t: number): string {
  const stops = sortedStops(g)
  if (!stops.length) return '#000000'
  const rgba = (s: GradientStop): Rgba => parseColor(s.color) ?? { r: 0, g: 0, b: 0, a: 1 }
  if (t <= stops[0]!.offset) return formatColor(rgba(stops[0]!))
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!
    const b = stops[i]!
    if (t <= b.offset) {
      const k = b.offset === a.offset ? 0 : (t - a.offset) / (b.offset - a.offset)
      const ca = rgba(a)
      const cb = rgba(b)
      return formatColor({
        r: ca.r + (cb.r - ca.r) * k,
        g: ca.g + (cb.g - ca.g) * k,
        b: ca.b + (cb.b - ca.b) * k,
        a: ca.a + (cb.a - ca.a) * k,
      })
    }
  }
  return formatColor(rgba(stops[stops.length - 1]!))
}

// Validate untrusted input (agent tool args, loaded documents). Returns null
// when it can't form a usable gradient.
export function normalizeGradient(input: unknown): GradientFill | null {
  if (!input || typeof input !== 'object') return null
  const g = input as Record<string, unknown>
  const type = g.type === 'radial' ? 'radial' : 'linear'
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const stops = (Array.isArray(g.stops) ? g.stops : [])
    .map((s) => {
      const o = s as Record<string, unknown>
      const c = parseColor(o?.color)
      return c ? { offset: clamp01(num(o.offset, 0)), color: formatColor(c) } : null
    })
    .filter((s): s is GradientStop => !!s)
  if (stops.length < 2) return null
  const base = defaultGradient(stops[0]!.color, type)
  return {
    type,
    x1: num(g.x1, base.x1),
    y1: num(g.y1, base.y1),
    x2: num(g.x2, base.x2),
    y2: num(g.y2, base.y2),
    stops,
  }
}
