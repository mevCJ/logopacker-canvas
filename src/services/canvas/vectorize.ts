// Image Trace: turn a raster image object into editable vector paths.
//
// The image is drawn to an offscreen canvas (downsampled for speed), traced
// with imagetracerjs (color quantization → contour tracing → line/curve
// fitting), and the resulting SVG goes through the same svgToPathObjects →
// placeImportedPaths pipeline as pasted SVGs, so every traced shape is a
// node-editable path laid exactly over the source image. The source image is
// hidden (not deleted) so it can be compared or restored from the layers panel.
import ImageTracer from 'imagetracerjs'
import type { CanvasStore, ImageObject } from '@/stores/canvas'
import { parseColor, toHex } from './color'
import { svgToPathObjects, placeImportedPaths } from './svgToPaths'
import { rotatePoint } from './svgEngine'

export interface VectorizeOptions {
  // Palette size: fewer colors = flatter, logo-like result.
  colors?: number
  // 0 (loose, smooth) .. 1 (tight, detailed).
  detail?: number
  // Drop near-white shapes (a white logo background).
  removeWhite?: boolean
  // Longest side the image is downsampled to before tracing.
  maxSize?: number
}

export const VECTORIZE_DEFAULTS: Required<VectorizeOptions> = {
  colors: 4,
  detail: 0.5,
  removeWhite: true,
  maxSize: 600,
}

interface PaletteColor {
  r: number
  g: number
  b: number
  a: number
}

// Distance from color c to the RGB segment between a and b. Anti-aliased
// edge pixels are linear blends of two real colors, so they sit on (or very
// near) such a segment.
function distToSegment(c: PaletteColor, a: PaletteColor, b: PaletteColor): number {
  const ab = [b.r - a.r, b.g - a.g, b.b - a.b]
  const ac = [c.r - a.r, c.g - a.g, c.b - a.b]
  const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2
  const t = len2 ? Math.min(1, Math.max(0, (ac[0]! * ab[0]! + ac[1]! * ab[1]! + ac[2]! * ab[2]!) / len2)) : 0
  return Math.hypot(ac[0]! - t * ab[0]!, ac[1]! - t * ab[1]!, ac[2]! - t * ab[2]!)
}

// Dominant, visually distinct colors of an image. Logos are flat colors plus
// anti-aliased edges, and the tracer's own sampling tends to merge flat colors
// or promote edge blends into palette entries. Instead: histogram pixels into
// 4-bit-per-channel buckets, then greedily take the most populous bucket that
// is far enough from every color already picked. Edge blends are rare and sit
// between real colors, so they are skipped outright. Mostly-transparent pixels form
// their own (alpha 0) entry, which filterTracedSvg later drops.
export function dominantPalette(imgd: ImageData, count: number): PaletteColor[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  let transparent = 0
  const d = imgd.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 128) {
      transparent++
      continue
    }
    const key = ((d[i]! >> 4) << 8) | ((d[i + 1]! >> 4) << 4) | (d[i + 2]! >> 4)
    const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    bk.n++
    bk.r += d[i]!
    bk.g += d[i + 1]!
    bk.b += d[i + 2]!
    buckets.set(key, bk)
  }
  const ranked = [...buckets.values()]
    .map((bk) => ({ n: bk.n, r: bk.r / bk.n, g: bk.g / bk.n, b: bk.b / bk.n }))
    .sort((a, b) => b.n - a.n)

  const palette: PaletteColor[] = []
  const pixels = imgd.width * imgd.height
  if (transparent / pixels > 0.01) palette.push({ r: 0, g: 0, b: 0, a: 0 })
  const minDist = 56
  for (const c of ranked) {
    if (palette.filter((p) => p.a).length >= count) break
    // Ignore specks: buckets under 0.05% of the image.
    if (c.n / pixels < 0.0005) break
    const solid = palette.filter((p) => p.a)
    const cand = { r: c.r, g: c.g, b: c.b, a: 255 }
    const far = solid.every((p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) >= minDist)
    const blend = solid.some((p, i) => solid.slice(i + 1).some((q) => distToSegment(cand, p, q) < 24))
    if (far && !blend) palette.push({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: 255 })
  }
  return palette
}

// Snap every pixel to a palette color before tracing. Plain nearest-color
// assignment misreads anti-aliased edges: a navy/white blend can sit closer to
// an unrelated green than to either real color, leaving green slivers around
// every navy edge. A pixel lying near the blend line between two palette
// colors is instead snapped to whichever endpoint it is closer to along it.
export function snapToPalette(imgd: ImageData, palette: PaletteColor[]): ImageData {
  const solid = palette.filter((p) => p.a)
  const clear = palette.find((p) => !p.a)
  const memo = new Map<number, PaletteColor>()
  const pick = (r: number, g: number, b: number): PaletteColor => {
    const key = (r << 16) | (g << 8) | b
    const hit = memo.get(key)
    if (hit) return hit
    const c = { r, g, b, a: 255 }
    let best = solid[0]!
    let bestD = Infinity
    for (const p of solid) {
      const dd = Math.hypot(p.r - r, p.g - g, p.b - b)
      if (dd < bestD) {
        bestD = dd
        best = p
      }
    }
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i]!
        const z = solid[j]!
        const seg = distToSegment(c, a, z)
        if (seg < bestD) {
          bestD = seg
          const da = Math.hypot(a.r - r, a.g - g, a.b - b)
          const dz = Math.hypot(z.r - r, z.g - g, z.b - b)
          best = da <= dz ? a : z
        }
      }
    }
    memo.set(key, best)
    return best
  }
  const src = imgd.data
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const p = clear && src[i + 3]! < 128 ? clear : pick(src[i]!, src[i + 1]!, src[i + 2]!)
    out[i] = p.r
    out[i + 1] = p.g
    out[i + 2] = p.b
    out[i + 3] = p.a
  }
  return { width: imgd.width, height: imgd.height, data: out, colorSpace: 'srgb' } as ImageData
}

// imagetracer options for a given detail level: lower error thresholds and a
// smaller minimum path size keep more detail.
export function tracerOptions(opts: VectorizeOptions = {}): Record<string, number | boolean> {
  const o = { ...VECTORIZE_DEFAULTS, ...opts }
  const detail = Math.min(1, Math.max(0, o.detail))
  return {
    numberofcolors: Math.max(2, Math.min(64, Math.round(o.colors))),
    ltres: 2 - detail * 1.8,
    qtres: 2 - detail * 1.8,
    pathomit: Math.round(24 - detail * 22),
    colorsampling: 2,
    colorquantcycles: 3,
    blurradius: detail < 0.3 ? 2 : 0,
    rightangleenhance: true,
    // Same-color hairline strokes hide the anti-aliasing seams between
    // adjacent traced shapes.
    strokewidth: 1,
    roundcoords: 2,
    viewbox: true,
  }
}

// Remove traced paths that shouldn't become objects: fully transparent layers
// and (optionally) near-white background shapes.
export function filterTracedSvg(svg: string, { removeWhite = true }: { removeWhite?: boolean } = {}): string {
  return svg.replace(/<path\b[^>]*>/g, (tag) => {
    const opacity = /opacity="([\d.]+)"/.exec(tag)
    if (opacity && Number(opacity[1]) < 0.5) return ''
    if (removeWhite) {
      const fill = /fill="([^"]+)"/.exec(tag)
      const c = fill ? parseColor(fill[1]) : null
      if (c && c.r > 235 && c.g > 235 && c.b > 235) return ''
    }
    // The tracer's opacity attr is 1 for kept paths; drop it so nothing reads
    // it as object opacity. Paints become canonical hex.
    return tag
      .replace(/\sopacity="[^"]*"/, '')
      .replace(/(fill|stroke)="(rgba?\([^"]+\))"/g, (m, k: string, v: string) => {
        const c = parseColor(v)
        return c ? `${k}="${toHex(c)}"` : m
      })
  })
}

export function traceImageData(imgd: ImageData, opts: VectorizeOptions = {}): string {
  const options: Record<string, unknown> = tracerOptions(opts)
  const pal = dominantPalette(imgd, Number(options.numberofcolors))
  let source = imgd
  if (pal.length >= 2) {
    // A fixed palette over pre-snapped pixels, with one quantization pass,
    // keeps the colors exact and edges clean.
    source = snapToPalette(imgd, pal)
    options.pal = pal
    options.colorquantcycles = 1
    options.blurradius = 0
  }
  const svg = ImageTracer.imagedataToSVG(source, options) as string
  return filterTracedSvg(svg, { removeWhite: opts.removeWhite ?? VECTORIZE_DEFAULTS.removeWhite })
}

// Rasterize an image URL to ImageData, downsampled so its longest side is at
// most `maxSize`. Remote images need CORS; data: URLs always work.
export function loadImageData(href: string, maxSize: number): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (!href.startsWith('data:')) img.crossOrigin = 'anonymous'
    img.onload = () => {
      const w0 = img.naturalWidth || img.width
      const h0 = img.naturalHeight || img.height
      if (!w0 || !h0) return reject(new Error('Image has no size.'))
      const k = Math.min(1, maxSize / Math.max(w0, h0))
      const w = Math.max(1, Math.round(w0 * k))
      const h = Math.max(1, Math.round(h0 * k))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('Canvas 2D is unavailable.'))
      ctx.drawImage(img, 0, 0, w, h)
      try {
        resolve(ctx.getImageData(0, 0, w, h))
      } catch {
        reject(new Error('This image blocks pixel access (cross-origin). Upload it as a file to vectorize it.'))
      }
    }
    img.onerror = () => reject(new Error('Could not load the image.'))
    img.src = href
  })
}

// Trace an image object and place the paths over it. Returns the new path ids.
export async function vectorizeImageObject(
  store: CanvasStore,
  id: string,
  opts: VectorizeOptions = {},
): Promise<string[]> {
  const img = store.getObject(id)
  if (!img || img.type !== 'image') throw new Error('Select an image to vectorize.')
  const o = { ...VECTORIZE_DEFAULTS, ...opts }
  const imgd = await loadImageData((img as ImageObject).href, o.maxSize)
  const parsed = svgToPathObjects(traceImageData(imgd, o))
  if (!parsed) throw new Error('Nothing to trace — try more colors or turn off "Remove white".')

  // Traced coords span the downsampled pixel grid; stretch them onto the image
  // object's displayed box, then apply its rotation about the box center.
  const sx = img.width / imgd.width
  const sy = img.height / imgd.height
  const center = { x: img.x + img.width / 2, y: img.y + img.height / 2 }
  const map = (x: number, y: number) => {
    const p = { x: img.x + x * sx, y: img.y + y * sy }
    return img.rotation ? rotatePoint(center, p, img.rotation) : p
  }

  // Place right above the image in paint order, then hide the image.
  const at = store.objectOrder.indexOf(id) + 1
  const ids = placeImportedPaths(store, parsed.paths, {
    map,
    scale: Math.sqrt(sx * sy),
    artboardId: img.artboardId,
    semanticRole: img.semanticRole === 'heroImage' ? 'decorative' : String(img.semanticRole || 'decorative'),
  })
  ids.forEach((pid, i) => store.reorderObject(pid, at + i))
  store.setObjectHidden(id, true)
  return ids
}
