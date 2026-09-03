// Clipboard paste helpers for the canvas.
//
// These functions are intentionally kept free of Pinia/DOM-renderer
// dependencies so the classification logic can be unit tested. The browser
// glue (reading a ClipboardEvent, converting blobs to data URLs) lives in
// CanvasStage.vue, which calls into `classifyClipboard` and the small builders
// below to decide what kind of object to place.

import { parseSvg, readViewBox } from './novaSeed'

// What we managed to pull off the clipboard, normalized into one of the three
// things the canvas can place. `none` means nothing usable was found.
export type ClipboardPaste =
  | { kind: 'image'; file: File }
  | { kind: 'svg'; markup: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' }

// Detect an SVG document from a raw string. Loose on leading whitespace / XML
// declarations so it recognizes typical copied-from-editor markup.
export function looksLikeSvg(raw: string): boolean {
  if (!raw) return false
  const s = raw.trim()
  if (!s) return false
  // Strip a leading XML prolog / doctype so we can peek at the first element.
  const body = s
    .replace(/^<\?xml[^>]*\?>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^<!doctype[^>]*>/i, '')
    .trim()
  return /^<svg[\s>]/i.test(body) && /<\/svg\s*>\s*$/i.test(s)
}

// Inspect a ClipboardEvent's data and decide what to place. Prefers a bitmap
// image file, then SVG markup, then plain text. The caller handles the async
// work (blob -> data URL) since that isn't purely synchronous.
export function classifyClipboard(data: DataTransfer | null): ClipboardPaste {
  if (!data) return { kind: 'none' }

  // 1) A pasted bitmap (screenshot, copied image) shows up as a file item.
  const items = data.items ? Array.from(data.items) : []
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/') && item.type !== 'image/svg+xml') {
      const file = item.getAsFile()
      if (file) return { kind: 'image', file }
    }
  }
  // Some browsers expose images only through `files`.
  const files = data.files ? Array.from(data.files) : []
  for (const file of files) {
    if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
      return { kind: 'image', file }
    }
  }

  // 2) SVG markup, either via the dedicated MIME type or as plain text that
  //    is clearly an <svg> document.
  const svgData = safeGet(data, 'image/svg+xml')
  if (svgData && looksLikeSvg(svgData)) return { kind: 'svg', markup: svgData }

  const text = safeGet(data, 'text/plain')
  if (text && looksLikeSvg(text)) return { kind: 'svg', markup: text }

  // 3) Plain text.
  if (text && text.trim()) return { kind: 'text', text }

  return { kind: 'none' }
}

function safeGet(data: DataTransfer, type: string): string {
  try {
    return data.getData(type) || ''
  } catch {
    return ''
  }
}

// Read the intrinsic (natural) size of pasted SVG markup from its viewBox or
// width/height attributes so the caller can place it at a sensible size and
// aspect ratio. Falls back to a reasonable default when the markup can't be
// parsed or declares no dimensions.
export function svgIntrinsicSize(markup: string): { width: number; height: number } {
  const fallback = { width: 300, height: 200 }
  let svgEl: Element
  try {
    svgEl = parseSvg(markup)
  } catch {
    return fallback
  }
  const vb = readViewBox(svgEl)
  const width = vb.width > 0 ? vb.width : fallback.width
  const height = vb.height > 0 ? vb.height : fallback.height
  return { width, height }
}

// Wrap raw SVG markup as a data URL so it can be dropped in as an image when we
// can't (or don't want to) convert it to native path objects. Uses UTF-8
// encoding so it survives non-ASCII characters.
export function svgToDataUrl(markup: string): string {
  const encoded = encodeURIComponent(markup)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22')
  return `data:image/svg+xml;charset=utf-8,${encoded}`
}
