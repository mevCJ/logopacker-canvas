// Runs the sketch cleanup pipeline off the main thread. The photo is loaded
// once ('load'); each 'process' only carries options, so slider tweaks don't
// re-copy a multi-megapixel image.
import { cleanupSketch, detectPaper, type CleanupOptions, type Rgba } from './sketchCleanup'

let source: Rgba | null = null

type Req =
  | { type: 'load'; id: number; image: Rgba }
  | { type: 'process'; id: number; options: Partial<CleanupOptions> }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null
  postMessage: (msg: unknown, transfer?: Transferable[]) => void
}

ctx.onmessage = (e) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      source = msg.image
      ctx.postMessage({ type: 'loaded', id: msg.id, corners: detectPaper(source) })
      return
    }
    if (!source) throw new Error('No photo loaded.')
    const t0 = performance.now()
    const out = cleanupSketch(source, msg.options)
    ctx.postMessage({ type: 'result', id: msg.id, image: out, ms: Math.round(performance.now() - t0) }, [out.data.buffer])
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: (err as Error).message })
  }
}
