// Put a cleaned sketch on the canvas: as an image (optionally replacing the
// image it was made from) and, if asked, traced straight into black vector
// paths with Image Trace.
import type { CanvasStore } from '@/stores/canvas'
import { fitImageSize } from '@/services/canvas/userTools'
import { vectorizeImageObject } from '@/services/canvas/vectorize'

export interface PlaceSketchOptions {
  dataUrl: string
  width: number
  height: number
  vectorize: boolean
  // Existing image to sit on top of and hide (the "clean up this image" flow).
  replaceImageId?: string | null
}

export async function placeSketch(store: CanvasStore, o: PlaceSketchOptions): Promise<string[]> {
  const replaced = o.replaceImageId ? store.getObject(o.replaceImageId) : null
  store.snapshot(o.vectorize ? 'Add traced sketch' : 'Add sketch')

  let box: { x: number; y: number; width: number; height: number; artboardId: string | null }
  if (replaced) {
    // Same footprint as the original, keeping the cleaned image's aspect.
    const size = fitImageSize({ width: o.width, height: o.height }, replaced.width, replaced.height)
    box = {
      x: replaced.x + (replaced.width - size.width) / 2,
      y: replaced.y + (replaced.height - size.height) / 2,
      ...size,
      artboardId: replaced.artboardId,
    }
  } else {
    let ab = store.selectedArtboard ?? store.artboards[0] ?? null
    if (!ab) ab = store.addArtboardAuto({ name: 'Sketch', width: 800, height: 600 })
    const size = fitImageSize({ width: o.width, height: o.height }, ab.width * 0.8, ab.height * 0.8)
    box = { x: (ab.width - size.width) / 2, y: (ab.height - size.height) / 2, ...size, artboardId: ab.id }
  }

  const img = store.addObject({
    type: 'image',
    href: o.dataUrl,
    sourceUrl: '',
    alt: 'Cleaned sketch',
    name: 'Sketch',
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    baseWidth: o.width,
    baseHeight: o.height,
    artboardId: box.artboardId,
    semanticRole: 'logoSymbol',
  })
  if (replaced) {
    store.reorderObject(img.id, store.objectOrder.indexOf(replaced.id) + 1)
    store.setObjectHidden(replaced.id, true)
  }
  if (!o.vectorize) {
    store.selectObjects([img.id])
    return [img.id]
  }
  // Black-on-white input: two colors, white dropped, fairly detailed.
  const ids = await vectorizeImageObject(store, img.id, { colors: 2, detail: 0.65, removeWhite: true })
  ids.forEach((id) => store.updateObject(id, { semanticRole: 'logoSymbol' }))
  store.selectObjects(ids)
  return ids
}
