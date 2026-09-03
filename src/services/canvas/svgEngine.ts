// SVG.js engine wiring. The store is the source of truth; this module renders
// the store's artboards + objects into an SVG.js drawing and keeps them in sync.
//
//   1. Pure helpers (no DOM) — compute attributes/geometry. Unit tested.
//   2. CanvasRenderer — mounts SVG.js and applies the store to the DOM.
//
// Note: the svg.js plugins (draggable/select/resize) augment elements with
// methods that aren't in the base type definitions, so plugin-augmented calls
// use loosely-typed element references.
import { SVG } from '@svgdotjs/svg.js'
import '@svgdotjs/svg.draggable.js'
import '@svgdotjs/svg.select.js'
import '@svgdotjs/svg.resize.js'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

// Loose object shapes accepted by the pure helpers (they read a subset).
export interface RenderObject {
  id: string
  type: 'path' | 'text' | 'image'
  semanticRole?: string
  artboardId?: string | null
  x?: number
  y?: number
  width?: number
  height?: number
  opacity?: number
  d?: string
  fill?: string | null
  stroke?: string | null
  strokeWidth?: number
  text?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  align?: string
  href?: string
}

interface RenderArtboard {
  id: string
  name?: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor?: string
}

export interface RenderSnapshot {
  artboards: RenderArtboard[]
  objects: Record<string, RenderObject>
  objectOrder: string[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type SvgEl = any

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

export function svgElementType(obj: Pick<RenderObject, 'type'>): 'path' | 'text' | 'image' {
  switch (obj.type) {
    case 'path':
      return 'path'
    case 'text':
      return 'text'
    case 'image':
      return 'image'
    default:
      throw new Error(`Cannot map object type to SVG element: ${(obj as RenderObject).type}`)
  }
}

export function commonAttrs(obj: RenderObject): Record<string, string> {
  return {
    id: obj.id,
    'data-role': obj.semanticRole || 'none',
    'data-type': obj.type,
    'data-artboard': obj.artboardId || '',
  }
}

export function absolutePosition(
  obj: Pick<RenderObject, 'x' | 'y'>,
  artboard: Pick<RenderArtboard, 'x' | 'y'> | null | undefined,
): { x: number; y: number } {
  const ax = artboard ? artboard.x : 0
  const ay = artboard ? artboard.y : 0
  return { x: ax + (obj.x || 0), y: ay + (obj.y || 0) }
}

export function pathAttrs(obj: RenderObject): Record<string, string | number> {
  return {
    d: obj.d || '',
    fill: obj.fill == null ? 'none' : obj.fill,
    stroke: obj.stroke == null ? 'none' : obj.stroke,
    'stroke-width': obj.strokeWidth || 0,
    opacity: obj.opacity == null ? 1 : obj.opacity,
  }
}

export function textAttrs(obj: RenderObject): Record<string, string | number> {
  return {
    'font-family': obj.fontFamily || 'Inter',
    'font-size': obj.fontSize || 24,
    'font-weight': obj.fontWeight || 400,
    fill: obj.fill == null ? '#000000' : obj.fill,
    'text-anchor': alignToAnchor(obj.align),
    opacity: obj.opacity == null ? 1 : obj.opacity,
  }
}

export function alignToAnchor(align: string | undefined): 'start' | 'middle' | 'end' {
  switch (align) {
    case 'center':
      return 'middle'
    case 'right':
      return 'end'
    default:
      return 'start'
  }
}

export function imageAttrs(obj: RenderObject): Record<string, string | number> {
  return {
    href: obj.href || '',
    width: obj.width || 0,
    height: obj.height || 0,
    opacity: obj.opacity == null ? 1 : obj.opacity,
    preserveAspectRatio: 'xMidYMid slice',
  }
}

export function zoomViewBox(box: Box, factor: number, focal?: { x: number; y: number }): Box {
  const newW = box.width / factor
  const newH = box.height / factor
  const fx = focal ? focal.x : box.x + box.width / 2
  const fy = focal ? focal.y : box.y + box.height / 2
  const relX = (fx - box.x) / box.width
  const relY = (fy - box.y) / box.height
  return {
    x: fx - newW * relX,
    y: fy - newH * relY,
    width: newW,
    height: newH,
  }
}

export function panViewBox(box: Box, dx: number, dy: number): Box {
  return { x: box.x - dx, y: box.y - dy, width: box.width, height: box.height }
}

export function clampZoom(box: Box, base: Box, min = 0.15, max = 8): Box {
  const currentZoom = base.width / box.width
  if (currentZoom < min) {
    return { x: box.x, y: box.y, width: base.width / min, height: base.height / min }
  }
  if (currentZoom > max) {
    return { x: box.x, y: box.y, width: base.width / max, height: base.height / max }
  }
  return box
}

export function documentBounds(artboards: RenderArtboard[] | undefined, padding = 200): Box {
  if (!artboards || artboards.length === 0) {
    return { x: 0, y: 0, width: 1000, height: 700 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ab of artboards) {
    minX = Math.min(minX, ab.x)
    minY = Math.min(minY, ab.y)
    maxX = Math.max(maxX, ab.x + ab.width)
    maxY = Math.max(maxY, ab.y + ab.height)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  }
}

// ---------------------------------------------------------------------------
// 2. CanvasRenderer — DOM-bound (used in the browser only)
// ---------------------------------------------------------------------------

export type ObjectMountedHook = (obj: RenderObject, el: SvgEl) => void
export type DragEndHook = (id: string, delta: { dx: number; dy: number }) => void
export type ResizeHook = (id: string, size: { width: number; height: number }) => void

export class CanvasRenderer {
  mountEl: HTMLElement
  draw: SvgEl
  artboardLayer: SvgEl
  objectLayer: SvgEl
  overlayLayer: SvgEl
  private _artboardEls = new Map<string, SvgEl>()
  private _objectEls = new Map<string, SvgEl>()

  onObjectMounted: ObjectMountedHook | null = null
  onObjectDragEnd: DragEndHook | null = null
  onObjectResized: ResizeHook | null = null

  constructor(mountEl: HTMLElement) {
    this.mountEl = mountEl
    this.draw = SVG().addTo(mountEl).size('100%', '100%')
    this.artboardLayer = this.draw.group().addClass('artboard-layer')
    this.objectLayer = this.draw.group().addClass('object-layer')
    this.overlayLayer = this.draw.group().addClass('overlay-layer')
  }

  render(snapshot: RenderSnapshot): void {
    this._renderArtboards(snapshot.artboards || [])
    this._renderObjects(snapshot)
  }

  setViewBox(box: Box): void {
    this.draw.viewbox(box.x, box.y, box.width, box.height)
  }

  getViewBox(): Box {
    const vb = this.draw.viewbox()
    return { x: vb.x, y: vb.y, width: vb.width, height: vb.height }
  }

  screenToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const rect = (this.draw.node as SVGSVGElement).getBoundingClientRect()
    const vb = this.getViewBox()
    const relX = (clientX - rect.left) / rect.width
    const relY = (clientY - rect.top) / rect.height
    return {
      x: vb.x + relX * vb.width,
      y: vb.y + relY * vb.height,
    }
  }

  setSelection(ids: string[] = []): void {
    const set = new Set(ids)
    for (const [id, el] of this._objectEls) {
      if (set.has(id)) el.addClass('is-selected')
      else el.removeClass('is-selected')
    }
    this._drawSelectionOverlays(ids)
  }

  private _drawSelectionOverlays(ids: string[]): void {
    this.overlayLayer.clear()
    const vb = this.getViewBox()
    const strokeW = Math.max(1, vb.width / 600)
    for (const id of ids) {
      const el = this._objectEls.get(id)
      if (!el) continue
      let bbox: { x: number; y: number; width: number; height: number } | undefined
      try {
        bbox = el.rbox(this.draw)
      } catch {
        try {
          bbox = el.bbox()
        } catch {
          continue
        }
      }
      if (!bbox) continue
      const pad = strokeW * 3
      this.overlayLayer
        .rect(bbox.width + pad * 2, bbox.height + pad * 2)
        .move(bbox.x - pad, bbox.y - pad)
        .fill('none')
        .stroke({ color: '#2563eb', width: strokeW })
        .attr({ 'pointer-events': 'none', 'data-selection': id })
    }
  }

  private _renderArtboards(artboards: RenderArtboard[]): void {
    const seen = new Set<string>()
    for (const ab of artboards) {
      seen.add(ab.id)
      let el = this._artboardEls.get(ab.id)
      if (!el) {
        el = this.artboardLayer.group().attr('data-artboard-id', ab.id)
        const rect = el.rect().addClass('artboard-bg')
        const label = el.text('').addClass('artboard-label')
        el.remember('rect', rect)
        el.remember('label', label)
        this._artboardEls.set(ab.id, el)
      }
      const rect = el.remember('rect')
      rect
        .size(ab.width, ab.height)
        .move(ab.x, ab.y)
        .fill(ab.backgroundColor || '#FFFFFF')
        .stroke({ color: '#e4e4e7', width: 1 })
      const label = el.remember('label')
      label
        .text(ab.name || '')
        .font({ family: 'Inter', size: 13, weight: 500 })
        .fill('#71717a')
        .move(ab.x, ab.y - 22)
    }
    for (const [id, el] of this._artboardEls) {
      if (!seen.has(id)) {
        el.remove()
        this._artboardEls.delete(id)
      }
    }
  }

  private _renderObjects(snapshot: RenderSnapshot): void {
    const order = snapshot.objectOrder || []
    const objects = snapshot.objects || {}
    const artboardMap = new Map((snapshot.artboards || []).map((a) => [a.id, a]))
    const seen = new Set<string>()

    for (const id of order) {
      const obj = objects[id]
      if (!obj) continue
      seen.add(id)
      const artboard = obj.artboardId ? artboardMap.get(obj.artboardId) : undefined
      this._renderObject(obj, artboard)
    }

    for (const [id, el] of this._objectEls) {
      if (!seen.has(id)) {
        el.remove()
        this._objectEls.delete(id)
      }
    }
  }

  private _renderObject(obj: RenderObject, artboard: RenderArtboard | undefined): SvgEl {
    let el = this._objectEls.get(obj.id)
    const pos = absolutePosition(obj, artboard)

    if (el && (el.node as Element).tagName.toLowerCase() !== svgElementType(obj)) {
      el.remove()
      el = undefined
      this._objectEls.delete(obj.id)
    }

    let isNew = false
    if (!el) {
      isNew = true
      if (obj.type === 'path') el = this.objectLayer.path()
      else if (obj.type === 'text') el = this.objectLayer.text('')
      else el = this.objectLayer.image()
      el.addClass('canvas-object')
      this._objectEls.set(obj.id, el)
    }

    el.attr(commonAttrs(obj))

    if (obj.type === 'path') {
      el.attr(pathAttrs(obj))
      el.transform({ translateX: pos.x, translateY: pos.y })
    } else if (obj.type === 'text') {
      el.text(obj.text || '')
      el.attr(textAttrs(obj))
      el.attr({ x: pos.x, y: pos.y + (obj.fontSize || 24) })
    } else if (obj.type === 'image') {
      el.attr(imageAttrs(obj))
      el.attr({ x: pos.x, y: pos.y })
    }

    if (isNew) {
      this._wireDrag(obj, el)
      if (typeof this.onObjectMounted === 'function') {
        this.onObjectMounted(obj, el)
      }
    }
    return el
  }

  setResizable(ids: string[] = [], objects: Record<string, RenderObject> = {}): void {
    const set = new Set(ids)
    for (const [id, el] of this._objectEls) {
      const obj = objects[id]
      const shouldResize = set.has(id) && obj && obj.type === 'image'
      const already = el.remember('resizable')
      if (shouldResize && !already) {
        try {
          el.selectize({ deepSelect: false }).resize()
          el.on('resizedone', () => {
            const b = el.bbox()
            if (typeof this.onObjectResized === 'function') {
              this.onObjectResized(id, { width: b.width, height: b.height })
            }
          })
          el.remember('resizable', true)
        } catch {
          /* plugin may not attach for detached nodes */
        }
      } else if (!shouldResize && already) {
        try {
          el.selectize(false).resize(false)
        } catch {
          /* noop */
        }
        el.forget('resizable')
      }
    }
  }

  private _wireDrag(obj: RenderObject, el: SvgEl): void {
    let startBox: { x: number; y: number } | null = null
    el.draggable()
    el.on('dragstart', (e: CustomEvent) => {
      startBox = (e.detail as { box: { x: number; y: number } }).box
    })
    el.on('dragend', (e: CustomEvent) => {
      const endBox = (e.detail as { box: { x: number; y: number } }).box
      if (!startBox) return
      const dx = endBox.x - startBox.x
      const dy = endBox.y - startBox.y
      startBox = null
      if ((dx === 0 && dy === 0) || typeof this.onObjectDragEnd !== 'function') {
        return
      }
      this.onObjectDragEnd(obj.id, { dx, dy })
    })
  }

  getObjectEl(id: string): SvgEl | null {
    return this._objectEls.get(id) || null
  }

  destroy(): void {
    try {
      this.draw.remove()
    } catch {
      /* noop */
    }
    this._artboardEls.clear()
    this._objectEls.clear()
  }
}
