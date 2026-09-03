// Client-side helpers for the user-facing canvas tools (text/image sidebar).
// Kept free of DOM/store dependencies where possible so they can be unit
// tested. Browser-only helpers (file reading, image probing) are isolated at
// the bottom and guard against non-browser environments.

export interface Size {
  width: number
  height: number
}

// Scale a natural image size down to fit within maxW x maxH while preserving
// aspect ratio. Never upscales beyond the natural size.
export function fitImageSize(natural: Size, maxW: number, maxH: number): Size {
  const w = natural.width > 0 ? natural.width : 1
  const h = natural.height > 0 ? natural.height : 1
  const scale = Math.min(1, maxW / w, maxH / h)
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

// A Pexels search result as normalized by the Worker proxy.
export interface PexelsResult {
  id: number
  alt: string
  thumb: string
  src: string
  width: number
  height: number
  photographer?: string
  url?: string
}

// Map a Pexels result to a pending-image payload for the store.
export function pexelsResultToPending(r: PexelsResult): {
  href: string
  sourceUrl: string
  alt: string
  width: number
  height: number
} {
  return {
    href: r.src,
    sourceUrl: r.url || r.src,
    alt: r.alt || '',
    width: r.width || 0,
    height: r.height || 0,
  }
}

// ---- Browser-only helpers -------------------------------------------------

// Read a File into a data URL. Rejects in non-browser environments.
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader unavailable'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('File read failed'))
    reader.readAsDataURL(file)
  })
}

// Read a File into a UTF-8 string. Rejects in non-browser environments. Used
// for SVG uploads, whose markup we parse for dimensions rather than probing.
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader unavailable'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('File read failed'))
    reader.readAsText(file)
  })
}

// Probe an image data URL / URL for its natural dimensions.
export function probeImageSize(src: string): Promise<Size> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve({ width: 0, height: 0 })
      return
    }
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = src
  })
}
