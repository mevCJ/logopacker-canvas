// Browser-side export plumbing: turn an SVG string into a downloaded .svg file,
// or rasterize it to a .png (inlining remote images and waiting for fonts so
// the raster matches the canvas). Pure serialization lives in svgExport.ts.
import type { ExportScope } from './svgExport'

// ---------------------------------------------------------------------------
// Filenames + download
// ---------------------------------------------------------------------------

// A timestamped, scope-tagged filename, e.g. "nova-artboard-20260903-1330.svg".
export function exportFilename(scope: ExportScope, ext: 'svg' | 'png', date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `nova-${scope}-${stamp}.${ext}`
}

// Trigger a browser download for a blob via a transient anchor. Revokes the
// object URL on the next tick so the download has time to start.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// ---------------------------------------------------------------------------
// SVG export
// ---------------------------------------------------------------------------

// Blob seam: produce the export blob without downloading, so callers that write
// to disk (File System Access tools) reuse the exact same output as downloads.
export function svgToBlob(svgString: string): Blob {
  return new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
}

export function exportSvg({ svgString, filename }: { svgString: string; filename: string }): void {
  downloadBlob(svgToBlob(svgString), filename)
}

// ---------------------------------------------------------------------------
// Remote image inlining (avoids tainting the raster canvas)
// ---------------------------------------------------------------------------

// Extract href/xlink:href values from an SVG string.
function extractImageHrefs(svgString: string): string[] {
  const hrefs = new Set<string>()
  const re = /(?:xlink:)?href="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svgString)) !== null) {
    const v = m[1]
    if (v) hrefs.add(v)
  }
  return [...hrefs]
}

async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url, { mode: 'cors' })
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`)
  const blob = await res.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('Could not read image'))
    reader.readAsDataURL(blob)
  })
}

export interface InlineResult {
  svg: string
  // Hrefs that could not be inlined (CORS/network). PNG export of these would
  // taint the canvas, so callers surface this to the user.
  failed: string[]
}

// Replace every non-data: image href in the SVG with a fetched data URL. Data
// URLs (uploaded images) are left untouched. Failures are collected, not thrown.
export async function inlineRemoteImages(svgString: string): Promise<InlineResult> {
  const hrefs = extractImageHrefs(svgString).filter(
    (h) => h && !h.startsWith('data:') && !h.startsWith('#'),
  )
  if (hrefs.length === 0) return { svg: svgString, failed: [] }

  let out = svgString
  const failed: string[] = []
  await Promise.all(
    hrefs.map(async (href) => {
      try {
        const dataUrl = await fetchAsDataUrl(href)
        // Replace all occurrences of this exact href.
        out = out.split(`"${href}"`).join(`"${dataUrl}"`)
      } catch {
        failed.push(href)
      }
    }),
  )
  return { svg: out, failed }
}

// ---------------------------------------------------------------------------
// Rasterization
// ---------------------------------------------------------------------------

export interface RasterizeInput {
  svgString: string
  width: number
  height: number
  scale?: number
  // Solid background fill for the raster; omit/null for transparent PNG.
  background?: string | null
}

// Draw an SVG string onto an offscreen canvas and resolve a PNG blob. Waits for
// web fonts to be ready so text renders with the correct typeface. Rejects with
// a clear message if the canvas is tainted (usually a non-inlined remote image).
export async function rasterizeSvg({
  svgString,
  width,
  height,
  scale = 1,
  background = null,
}: RasterizeInput): Promise<Blob> {
  // Ensure fonts are loaded before drawing (best effort).
  if (typeof document !== 'undefined' && (document as Document).fonts) {
    try {
      await (document as Document).fonts.ready
    } catch {
      /* ignore font readiness failures */
    }
  }

  const pxW = Math.max(1, Math.round(width * scale))
  const pxH = Math.max(1, Math.round(height * scale))

  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)

  try {
    const img = await loadImage(svgUrl)
    const canvas = document.createElement('canvas')
    canvas.width = pxW
    canvas.height = pxH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    if (background) {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, pxW, pxH)
    }
    ctx.drawImage(img, 0, 0, pxW, pxH)

    return await new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error('Could not encode PNG'))
        }, 'image/png')
      } catch (err) {
        // toBlob throws a SecurityError when the canvas is tainted.
        reject(
          new Error(
            'Could not export PNG — an image could not be loaded for rasterization. ' +
              'Try SVG export instead.',
          ),
        )
        void err
      }
    })
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load the SVG for rasterization'))
    img.src = src
  })
}

// ---------------------------------------------------------------------------
// PNG export (inline -> rasterize -> download)
// ---------------------------------------------------------------------------

export interface ExportPngInput {
  svgString: string
  width: number
  height: number
  scale?: number
  background?: string | null
  filename: string
}

export interface ExportPngResult {
  // Hrefs that could not be inlined (surfaced as a soft warning by the dialog).
  failed: string[]
}

// Blob seam: inline remote images then rasterize to a PNG blob, without
// downloading. Shared by exportPng (download) and the disk-writing tools.
export async function renderPngBlob({
  svgString,
  width,
  height,
  scale = 1,
  background = null,
}: RasterizeInput): Promise<{ blob: Blob; failed: string[] }> {
  const { svg, failed } = await inlineRemoteImages(svgString)
  const blob = await rasterizeSvg({ svgString: svg, width, height, scale, background })
  return { blob, failed }
}

export async function exportPng({
  svgString,
  width,
  height,
  scale = 1,
  background = null,
  filename,
}: ExportPngInput): Promise<ExportPngResult> {
  const { blob, failed } = await renderPngBlob({ svgString, width, height, scale, background })
  downloadBlob(blob, filename)
  return { failed }
}
