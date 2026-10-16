// Main-thread side of the cleanup worker: decode a photo, hand it to the
// worker once, then request processed versions as options change. Only the
// latest request's result is delivered (older in-flight ones are dropped).
import type { CleanupOptions, Pt, Rgba } from './sketchCleanup'

// Longest side kept from the original photo. Cleanup itself works at
// CleanupOptions.maxSize; the extra headroom keeps perspective warps sharp.
export const SOURCE_MAX = 2400

export async function decodePhoto(blob: Blob, maxSize = SOURCE_MAX): Promise<Rgba> {
  // imageOrientation honors the phone's EXIF rotation.
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const k = Math.min(1, maxSize / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable.')
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const d = ctx.getImageData(0, 0, w, h)
  return { width: w, height: h, data: d.data }
}

export function rgbaToDataUrl(img: Rgba, type = 'image/png'): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return canvas.toDataURL(type)
}

export class CleanupSession {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private latest = 0

  constructor() {
    this.worker = new Worker(new URL('./sketchCleanup.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, type } = e.data as { id: number; type: string }
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      if (type === 'error') p.reject(new Error(e.data.message))
      else p.resolve(e.data)
    }
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...msg, id }, transfer)
    })
  }

  // Load a photo; resolves with auto-detected paper corners (or null).
  async load(image: Rgba): Promise<[Pt, Pt, Pt, Pt] | null> {
    const copy = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
    const r = await this.call<{ corners: [Pt, Pt, Pt, Pt] | null }>({ type: 'load', image: copy }, [copy.data.buffer])
    return r.corners
  }

  // Resolves with the cleaned image, or null if a newer request superseded it.
  async process(options: Partial<CleanupOptions>): Promise<{ image: Rgba; ms: number } | null> {
    const id = this.seq + 1
    this.latest = id
    const r = await this.call<{ image: Rgba; ms: number }>({ type: 'process', options: JSON.parse(JSON.stringify(options)) })
    return id === this.latest ? r : null
  }

  dispose(): void {
    this.worker.terminate()
    this.pending.clear()
  }
}
