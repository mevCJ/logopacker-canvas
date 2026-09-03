// Pure SVG serialization for export. The store is the source of truth; these
// helpers turn a set of objects (+ optional artboard backgrounds) into a
// standalone SVG document string, reusing the same attribute/transform helpers
// the live renderer uses so exported output matches the canvas exactly.
//
// Everything here is DOM-free and unit tested. Rasterization to PNG and the
// actual file download live in exportService.ts.
import {
  absolutePosition,
  pathAttrs,
  textAttrs,
  imageAttrs,
  objectTransform,
  type Box,
  type RenderObject,
} from './svgEngine'

// Loose artboard shape (a subset of the store's Artboard) needed for export.
export interface ExportArtboard {
  id: string
  name?: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor?: string
  objectIds?: string[]
}

export type ExportScope = 'selection' | 'artboard' | 'all'

export interface ExportSet {
  // Objects to draw, already in paint order.
  objects: RenderObject[]
  // Artboards used both for coordinate resolution and (optionally) backgrounds.
  artboards: ExportArtboard[]
  // Whether to paint the artboard background rectangles.
  includeArtboardBackgrounds: boolean
}

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

// Escape a string for safe inclusion in XML text content or a double-quoted
// attribute value. Handles the five predefined XML entities.
export function escapeXml(value: unknown): string {
  const s = value == null ? '' : String(value)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Serialize an attribute map into a ` k="v"` string, escaping values.
function serializeAttrs(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join('')
}

// ---------------------------------------------------------------------------
// Per-object markup
// ---------------------------------------------------------------------------

// Build the SVG element markup for a single object, matching how CanvasRenderer
// renders it: absolute position via the object's artboard origin, base->display
// scale for path/image, and text baseline placed at y = fontSize.
export function objectSvgMarkup(
  obj: RenderObject,
  artboard: Pick<ExportArtboard, 'x' | 'y'> | null | undefined,
): string {
  const pos = absolutePosition(obj, artboard ?? null)
  const rot = obj.rotation || 0
  const dispW = obj.width || 0
  const dispH = obj.height || 0
  const baseW = obj.baseWidth || dispW || 1
  const baseH = obj.baseHeight || dispH || 1

  if (obj.type === 'path') {
    const sx = baseW ? dispW / baseW : 1
    const sy = baseH ? dispH / baseH : 1
    const transform = objectTransform(pos.x, pos.y, dispW, dispH, rot, sx, sy)
    const attrs = serializeAttrs({ ...pathAttrs(obj), transform })
    return `<path${attrs} />`
  }

  if (obj.type === 'text') {
    // Text carries its size via fontSize (no scale); baseline at y = fontSize.
    const transform = objectTransform(pos.x, pos.y, dispW, dispH, rot, 1, 1)
    const attrs = serializeAttrs({
      ...textAttrs(obj),
      x: 0,
      y: obj.fontSize || 24,
      transform,
    })
    return `<text${attrs}>${escapeXml(obj.text || '')}</text>`
  }

  // image
  const sx = baseW ? dispW / baseW : 1
  const sy = baseH ? dispH / baseH : 1
  const transform = objectTransform(pos.x, pos.y, dispW, dispH, rot, sx, sy)
  const attrs = serializeAttrs({ ...imageAttrs(obj), x: 0, y: 0, transform })
  return `<image${attrs} />`
}

// ---------------------------------------------------------------------------
// Bounding box
// ---------------------------------------------------------------------------

// Tight union box (in canvas space) of the given objects and — when
// includeArtboardBg is set — the artboard rectangles. No padding. Returns a
// sensible fallback when the set is empty so callers never divide by zero.
export function exportBounds(
  objects: RenderObject[],
  artboards: ExportArtboard[],
  { includeArtboardBg = false }: { includeArtboardBg?: boolean } = {},
): Box {
  const abById = new Map(artboards.map((a) => [a.id, a]))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const extend = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }

  if (includeArtboardBg) {
    for (const ab of artboards) extend(ab.x, ab.y, ab.width, ab.height)
  }

  for (const obj of objects) {
    const ab = obj.artboardId ? abById.get(obj.artboardId) : null
    const pos = absolutePosition(obj, ab ?? null)
    extend(pos.x, pos.y, obj.width || 0, obj.height || 0)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

// ---------------------------------------------------------------------------
// Standalone SVG document
// ---------------------------------------------------------------------------

export interface BuildExportSvgInput {
  objects: RenderObject[]
  artboards: ExportArtboard[]
  includeArtboardBackgrounds?: boolean
  // Optional solid fill painted behind everything (opaque export). When absent
  // the SVG background is transparent.
  background?: string | null
}

export interface BuildExportSvgResult {
  svg: string
  bounds: Box
}

// Assemble a complete, standalone SVG string. Objects are drawn in the order
// given (callers pass them in paint order). Optional artboard background rects
// are drawn first, then an optional solid background covering the whole viewBox
// (drawn on top of nothing/behind objects — see ordering below).
export function buildExportSvg(input: BuildExportSvgInput): BuildExportSvgResult {
  const { objects, artboards } = input
  const includeArtboardBackgrounds = input.includeArtboardBackgrounds ?? false
  const background = input.background ?? null

  const bounds = exportBounds(objects, artboards, {
    includeArtboardBg: includeArtboardBackgrounds,
  })
  const abById = new Map(artboards.map((a) => [a.id, a]))

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${bounds.width}" height="${bounds.height}" ` +
      `viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}">`,
  )

  // Solid background first so it sits behind everything.
  if (background) {
    parts.push(
      `<rect${serializeAttrs({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        fill: background,
      })} />`,
    )
  }

  // Artboard background rectangles (behind their objects).
  if (includeArtboardBackgrounds) {
    for (const ab of artboards) {
      parts.push(
        `<rect${serializeAttrs({
          x: ab.x,
          y: ab.y,
          width: ab.width,
          height: ab.height,
          fill: ab.backgroundColor || '#FFFFFF',
        })} />`,
      )
    }
  }

  for (const obj of objects) {
    const ab = obj.artboardId ? abById.get(obj.artboardId) : null
    parts.push(objectSvgMarkup(obj, ab ?? null))
  }

  parts.push('</svg>')
  return { svg: parts.join('\n'), bounds }
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

// Plain snapshot of the parts of store state export needs. Kept as loose data
// (not the live store) so resolution stays pure and unit testable.
export interface ExportStateSnapshot {
  artboards: ExportArtboard[]
  objects: Record<string, RenderObject>
  objectOrder: string[]
  selectedIds: string[]
  selectedArtboardId: string | null
}

// Resolve the object/artboard set for a given export scope:
//   selection — the currently selected objects, no artboard backgrounds.
//   artboard  — one artboard + its objects (paint order), with its background.
//   all       — every artboard + every object (paint order), with backgrounds.
// Objects are always returned in global paint order (objectOrder).
export function resolveExportSet(
  state: ExportStateSnapshot,
  scope: ExportScope,
  artboardId?: string | null,
): ExportSet {
  const orderIndex = new Map(state.objectOrder.map((id, i) => [id, i]))
  const byPaintOrder = (a: RenderObject, b: RenderObject) =>
    (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)

  if (scope === 'selection') {
    const objects = state.selectedIds
      .map((id) => state.objects[id])
      .filter((o): o is RenderObject => !!o)
      .sort(byPaintOrder)
    // Include the artboards the selected objects belong to for coordinate
    // resolution, but do not paint their backgrounds.
    const abIds = new Set(objects.map((o) => o.artboardId).filter(Boolean) as string[])
    const artboards = state.artboards.filter((a) => abIds.has(a.id))
    return { objects, artboards, includeArtboardBackgrounds: false }
  }

  if (scope === 'artboard') {
    const target = state.artboards.find((a) => a.id === artboardId) || null
    if (!target) {
      return { objects: [], artboards: [], includeArtboardBackgrounds: true }
    }
    const objects = state.objectOrder
      .map((id) => state.objects[id])
      .filter((o): o is RenderObject => !!o && o.artboardId === target.id)
    return { objects, artboards: [target], includeArtboardBackgrounds: true }
  }

  // all
  const objects = state.objectOrder
    .map((id) => state.objects[id])
    .filter((o): o is RenderObject => !!o)
  return { objects, artboards: [...state.artboards], includeArtboardBackgrounds: true }
}
