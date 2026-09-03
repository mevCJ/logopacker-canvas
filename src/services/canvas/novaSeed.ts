// NOVA demo seed loader.
//
// Imports the logo at src/assets/logoipsum.svg (bundled as a raw string via
// ?raw) and tags its parts with semantic roles:
//   - #logomark group  -> logoSymbol  (single combined path)
//   - #logotype group  -> wordmark    (single combined path)
//
// A placeholder fallback keeps the demo working if the file is missing.
import rawLogo from '@/assets/logoipsum.svg?raw'
import type { CanvasStore } from '@/stores/canvas'

export interface SeedViewBox {
  x: number
  y: number
  width: number
  height: number
}

export interface SeedObject {
  type: 'path' | 'text'
  semanticRole: string
  x: number
  y: number
  d?: string
  fill: string
  stroke?: string
  strokeWidth?: number
  text?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  align?: string
}

export interface ParsedLogo {
  viewBox: SeedViewBox
  objects: SeedObject[]
}

// Parse an SVG string into the root <svg> element. Works across real browsers
// and happy-dom (whose documentElement can be null for image/svg+xml).
export function parseSvg(svgString: string): Element {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgString, 'image/svg+xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error('Failed to parse SVG')
  const root =
    doc.documentElement && doc.documentElement.tagName
      ? doc.documentElement
      : doc.querySelector('svg')
  if (!root) throw new Error('No <svg> root found')
  if (!root.ownerDocument) {
    try {
      Object.defineProperty(root, 'ownerDocument', { value: doc, configurable: true })
    } catch {
      /* noop */
    }
  }
  return root
}

function queryWithin(root: Element, selector: string): Element | null {
  let found: Element | null = null
  try {
    found = root.querySelector(selector)
  } catch {
    /* noop */
  }
  if (found) return found
  const doc = root.ownerDocument
  if (doc && doc.querySelector) {
    try {
      return doc.querySelector(selector)
    } catch {
      /* noop */
    }
  }
  return null
}

export function readViewBox(svgEl: Element): SeedViewBox {
  const vb = svgEl.getAttribute('viewBox')
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number)
    const [x = 0, y = 0, width = 300, height = 100] = parts
    return { x, y, width, height }
  }
  const width = Number(svgEl.getAttribute('width')) || 300
  const height = Number(svgEl.getAttribute('height')) || 100
  return { x: 0, y: 0, width, height }
}

function cssEscape(id: string): string {
  return id.replace(/([^\w-])/g, '\\$1')
}

export function collectGroup(
  svgEl: Element,
  groupId: string,
): { d: string; fill: string; count: number } | null {
  const group = queryWithin(svgEl, `#${cssEscape(groupId)}`)
  if (!group) return null
  const paths = Array.from(group.querySelectorAll('path'))
  if (paths.length === 0) return null
  const d = paths
    .map((p) => (p.getAttribute('d') || '').trim())
    .filter(Boolean)
    .join(' ')
  const first = paths[0]
  const fill = (first && first.getAttribute('fill')) || '#000000'
  return { d, fill, count: paths.length }
}

export function buildNovaObjects(svgString: string): ParsedLogo {
  const svgEl = parseSvg(svgString)
  const vb = readViewBox(svgEl)

  const symbol = collectGroup(svgEl, 'logomark')
  const type = collectGroup(svgEl, 'logotype')

  const objects: SeedObject[] = []
  if (symbol) {
    objects.push({
      type: 'path',
      semanticRole: 'logoSymbol',
      x: 0,
      y: 0,
      d: symbol.d,
      fill: symbol.fill,
      stroke: 'none',
      strokeWidth: 0,
    })
  }
  if (type) {
    objects.push({
      type: 'path',
      semanticRole: 'wordmark',
      x: 0,
      y: 0,
      d: type.d,
      fill: type.fill,
      stroke: 'none',
      strokeWidth: 0,
    })
  }

  if (objects.length === 0) {
    let allPaths: Element[] = []
    try {
      allPaths = Array.from(svgEl.querySelectorAll('path'))
    } catch {
      allPaths = []
    }
    if (allPaths.length === 0 && svgEl.ownerDocument) {
      allPaths = Array.from(svgEl.ownerDocument.querySelectorAll('path'))
    }
    if (allPaths.length) {
      const first = allPaths[0]
      objects.push({
        type: 'path',
        semanticRole: 'logoSymbol',
        x: 0,
        y: 0,
        d: allPaths.map((p) => p.getAttribute('d') || '').join(' '),
        fill: (first && first.getAttribute('fill')) || '#000000',
        stroke: 'none',
        strokeWidth: 0,
      })
    }
  }

  return { viewBox: vb, objects }
}

export const PLACEHOLDER_LOGO: ParsedLogo = {
  viewBox: { x: 0, y: 0, width: 302, height: 40 },
  objects: [
    {
      type: 'path',
      semanticRole: 'logoSymbol',
      x: 0,
      y: 0,
      d: 'M20 0 L40 34 L0 34 Z',
      fill: '#3754FA',
      stroke: 'none',
      strokeWidth: 0,
    },
    {
      type: 'text',
      semanticRole: 'wordmark',
      x: 56,
      y: 8,
      text: 'NOVA',
      fontFamily: 'Inter',
      fontSize: 28,
      fontWeight: 700,
      fill: '#211A43',
      align: 'left',
    },
  ],
}

export function seedNova(store: CanvasStore, opts: { logoSvg?: string } = {}) {
  const logoSvg = opts.logoSvg ?? rawLogo
  let parsed: ParsedLogo
  try {
    parsed = buildNovaObjects(logoSvg)
    if (!parsed.objects.length) throw new Error('No objects parsed from logo')
  } catch (e) {
    console.warn('[nova-seed] falling back to placeholder logo:', (e as Error)?.message)
    parsed = PLACEHOLDER_LOGO
  }

  const nativeW = parsed.viewBox.width
  const nativeH = parsed.viewBox.height
  const padX = Math.max(120, nativeW * 0.4)
  const padY = Math.max(120, nativeH * 2)

  const artboard = store.addArtboard({
    name: 'Primary Logo',
    x: 0,
    y: 0,
    width: nativeW + padX * 2,
    height: nativeH + padY * 2,
    backgroundColor: '#FFFFFF',
  })

  const originX = padX - parsed.viewBox.x
  const originY = padY - parsed.viewBox.y

  for (const desc of parsed.objects) {
    store.addObject({
      ...desc,
      artboardId: artboard.id,
      x: (desc.x || 0) + originX,
      y: (desc.y || 0) + originY,
    })
  }

  return artboard
}
