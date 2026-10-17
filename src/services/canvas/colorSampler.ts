// Sample the color under a point on the canvas (Eyedropper, and color pickers
// that pick from the canvas). Like Illustrator's eyedropper this reads the
// *object's* paint rather than a screenshot pixel, so it's exact:
//   path / text  → solid fill (or stroke when unfilled); for a gradient, the
//                  exact color at that spot, plus the gradient itself
//   image        → the image's own pixel at that spot
//   artboard     → its background color
import type { CanvasStore, CanvasObject } from '@/stores/canvas'
import type { CanvasRenderer } from './svgEngine'
import { isNonePaint, formatColor, parseColor } from './color'
import { sampleGradient, type GradientFill } from './gradient'

export interface ColorSample {
  color: string
  // Present when the sampled object is gradient-filled (Eyedropper copies it).
  gradient?: GradientFill
  sourceId?: string
}

// Position (0..1) of a bounding-box fraction along a gradient.
export function gradientT(g: GradientFill, f: { x: number; y: number }): number {
  const vx = g.x2 - g.x1
  const vy = g.y2 - g.y1
  const len2 = vx * vx + vy * vy || 1
  const t =
    g.type === 'radial'
      ? Math.hypot(f.x - g.x1, f.y - g.y1) / Math.sqrt(len2)
      : ((f.x - g.x1) * vx + (f.y - g.y1) * vy) / len2
  return Math.min(1, Math.max(0, t))
}

const imageCache = new Map<string, Promise<HTMLCanvasElement | null>>()
function imageCanvas(href: string): Promise<HTMLCanvasElement | null> {
  if (!imageCache.has(href)) {
    imageCache.set(
      href,
      new Promise((resolve) => {
        const img = new Image()
        if (!href.startsWith('data:')) img.crossOrigin = 'anonymous'
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          const ctx = c.getContext('2d')
          if (!ctx) return resolve(null)
          ctx.drawImage(img, 0, 0)
          resolve(c)
        }
        img.onerror = () => resolve(null)
        img.src = href
      }),
    )
  }
  return imageCache.get(href)!
}

async function samplePixel(el: SVGImageElement, href: string, clientX: number, clientY: number): Promise<string | null> {
  const canvas = await imageCanvas(href)
  const ctm = el.getScreenCTM()
  if (!canvas || !ctm) return null
  const local = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
  const w = Number(el.getAttribute('width')) || canvas.width
  const h = Number(el.getAttribute('height')) || canvas.height
  const px = Math.floor((local.x / w) * canvas.width)
  const py = Math.floor((local.y / h) * canvas.height)
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null
  try {
    const d = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data
    return formatColor({ r: d[0]!, g: d[1]!, b: d[2]!, a: Math.round((d[3]! / 255) * 100) / 100 })
  } catch {
    return null // cross-origin image without CORS
  }
}

function paintOf(o: CanvasObject, renderer: CanvasRenderer, at: { x: number; y: number }): ColorSample | null {
  if (o.type === 'image') return null
  if (o.fillGradient) {
    const f = renderer.canvasToObjectFraction(o as never, at)
    const color = f ? sampleGradient(o.fillGradient, gradientT(o.fillGradient, f)) : o.fillGradient.stops[0]!.color
    return { color, gradient: o.fillGradient, sourceId: o.id }
  }
  const paint = !isNonePaint(o.fill) ? o.fill : o.type === 'path' && !isNonePaint(o.stroke) ? o.stroke : null
  if (!paint) return null
  const c = parseColor(paint)
  return { color: c ? formatColor(c) : paint, sourceId: o.id }
}

// The topmost visible paint under a screen point, or null.
export async function sampleColorAt(
  store: CanvasStore,
  renderer: CanvasRenderer,
  clientX: number,
  clientY: number,
): Promise<ColorSample | null> {
  const at = renderer.screenToCanvas(clientX, clientY)
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const objEl = el.closest('.canvas-object')
    if (objEl && !objEl.classList.contains('is-editing')) {
      const o = store.getObject(objEl.id)
      if (!o || store.isHidden(o)) continue
      if (o.type === 'image') {
        const color = await samplePixel(objEl as SVGImageElement, o.href, clientX, clientY)
        if (color) return { color, sourceId: o.id }
        continue
      }
      const s = paintOf(o, renderer, at)
      if (s) return s
      continue
    }
    if (el.classList.contains('artboard-bg')) {
      const fill = el.getAttribute('fill')
      const c = fill ? parseColor(fill) : null
      if (c) return { color: formatColor(c) }
    }
  }
  return null
}
