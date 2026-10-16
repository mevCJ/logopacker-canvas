// Opaque colors already used in the document (fills, strokes, gradient stops,
// artboard backgrounds), offered as quick swatches in color pickers.
import type { CanvasStore } from '@/stores/canvas'
import { isNonePaint, parseColor, toHex } from './color'

export function documentColors(store: CanvasStore, limit = 15): string[] {
  const seen = new Set<string>()
  const add = (v: unknown) => {
    if (isNonePaint(v)) return
    const c = parseColor(v)
    if (c) seen.add(toHex(c))
  }
  for (const o of store.orderedObjects) {
    if (o.type === 'image') continue
    add(o.fill)
    o.fillGradient?.stops.forEach((s) => add(s.color))
    if (o.type === 'path') add(o.stroke)
  }
  for (const ab of store.artboards) add(ab.backgroundColor)
  return [...seen].slice(0, limit)
}
