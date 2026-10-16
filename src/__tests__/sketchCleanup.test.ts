import { describe, it, expect } from 'vitest'
import {
  cleanupSketch,
  detectPaper,
  removeSmall,
  squareToQuad,
  type Rgba,
} from '@/services/capture/sketchCleanup'
import { ChunkAssembler } from '@/services/capture/captureLink'

// Synthetic photo builder: paint(x, y) returns [r, g, b].
function photo(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y)
      const i = (y * w + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { width: w, height: h, data }
}
const isInk = (img: Rgba, x: number, y: number) => img.data[(y * img.width + x) * 4] === 0
const inkRatio = (img: Rgba) => {
  let n = 0
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0) n++
  return n / (img.width * img.height)
}

// A thick ring "logo" centered at (100, 100), radius 50, stroke 8.
const ring = (x: number, y: number) => Math.abs(Math.hypot(x - 100, y - 100) - 50) < 4

describe('sketch cleanup', () => {
  it('flattens a heavy shadow gradient and keeps the ink', () => {
    // Paper fades from 240 (left) to 90 (right) — a strong shadow; ink is 40%
    // of local paper brightness so it is darker than paper everywhere.
    const img = photo(200, 200, (x, y) => {
      const paper = 240 - (150 * x) / 200
      const v = ring(x, y) ? paper * 0.4 : paper
      return [v, v, v]
    })
    const out = cleanupSketch(img, { maxSize: 200, despeckle: 0 })
    expect(out.width).toBe(200)
    expect(isInk(out, 150, 100)).toBe(true) // ring, in the shadow
    expect(isInk(out, 50, 100)).toBe(true) // ring, in the light
    expect(isInk(out, 190, 190)).toBe(false) // shadowed paper → white
    expect(isInk(out, 100, 100)).toBe(false) // inside the ring
    // Ring area ≈ 2π·50·8 ≈ 2513 px of 40000 ≈ 6%.
    expect(inkRatio(out)).toBeGreaterThan(0.04)
    expect(inkRatio(out)).toBeLessThan(0.09)
  })

  it('drops blue ruled lines with the blue-line filter', () => {
    const img = photo(200, 200, (x, y) => {
      if (ring(x, y)) return [30, 30, 40]
      if (y % 20 < 2) return [90, 140, 230] // ruled line
      return [245, 245, 240]
    })
    const kept = cleanupSketch(img, { maxSize: 200, colorFilter: 'none', despeckle: 0 })
    const filtered = cleanupSketch(img, { maxSize: 200, colorFilter: 'removeBlue', despeckle: 0 })
    expect(isInk(kept, 10, 0)).toBe(true)
    expect(isInk(filtered, 10, 0)).toBe(false)
    expect(isInk(filtered, 150, 100)).toBe(true)
  })

  it('removes specks and fills pinholes', () => {
    const w = 20
    const bits = new Uint8Array(w * w)
    bits[5 * w + 5] = 1 // speck
    for (let y = 10; y < 16; y++) for (let x = 10; x < 16; x++) bits[y * w + x] = 1
    bits[12 * w + 12] = 0 // pinhole
    removeSmall(bits, w, w, 1, 4)
    removeSmall(bits, w, w, 0, 4)
    expect(bits[5 * w + 5]).toBe(0)
    expect(bits[12 * w + 12]).toBe(1)
    expect(bits[0]).toBe(0) // border paper untouched
  })

  it('suppresses a screen moiré pattern', () => {
    const img = photo(128, 128, (x, y) => {
      const m = 60 * Math.sin((x * 2 * Math.PI) / 4) * Math.sin((y * 2 * Math.PI) / 4)
      const v = (Math.abs(Math.hypot(x - 64, y - 64) - 30) < 4 ? 40 : 195) + m
      return [v, v, v]
    })
    const without = cleanupSketch(img, { maxSize: 128, moire: false, smoothing: 0, despeckle: 0 })
    const withFilter = cleanupSketch(img, { maxSize: 128, moire: true, smoothing: 0, despeckle: 0 })
    // Moiré troughs read as ink without the filter; with it, paper is clean.
    expect(inkRatio(without)).toBeGreaterThan(0.15)
    // Ring area ≈ 2π·30·8 / 128² ≈ 9.2%: only the ring remains.
    expect(inkRatio(withFilter)).toBeGreaterThan(0.07)
    expect(inkRatio(withFilter)).toBeLessThan(0.11)
    expect(isInk(withFilter, 10, 10)).toBe(false)
    expect(isInk(withFilter, 94, 64)).toBe(true)
  })

  it('maps the unit square onto a quad', () => {
    const h = squareToQuad([
      { x: 10, y: 20 },
      { x: 110, y: 30 },
      { x: 120, y: 140 },
      { x: 5, y: 130 },
    ])
    const at = (x: number, y: number) => {
      const w = h[6]! * x + h[7]! * y + 1
      return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w]
    }
    expect(at(1, 1)[0]).toBeCloseTo(120)
    expect(at(1, 1)[1]).toBeCloseTo(140)
    expect(at(0, 1)[0]).toBeCloseTo(5)
  })

  it('finds a sheet of paper on a dark table and straightens it', () => {
    // A tilted bright sheet on a dark background.
    const quad = [
      { x: 60, y: 40 },
      { x: 250, y: 60 },
      { x: 240, y: 230 },
      { x: 40, y: 210 },
    ]
    const inside = (x: number, y: number) => {
      let s = 0
      for (let i = 0; i < 4; i++) {
        const a = quad[i]!
        const b = quad[(i + 1) % 4]!
        const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
        s += c > 0 ? 1 : -1
      }
      return Math.abs(s) === 4
    }
    const img = photo(300, 260, (x, y) => (inside(x, y) ? [235, 235, 230] : [50, 45, 40]))
    const corners = detectPaper(img)
    expect(corners).not.toBeNull()
    quad.forEach((q, i) => {
      expect(Math.abs(corners![i]!.x - q.x)).toBeLessThan(8)
      expect(Math.abs(corners![i]!.y - q.y)).toBeLessThan(8)
    })
    // Straightened output is all paper (no dark table at the edges).
    const out = cleanupSketch(img, { corners, maxSize: 300 })
    expect(inkRatio(out)).toBeLessThan(0.01)
  })
})

describe('photo chunk assembly', () => {
  it('reassembles chunks and validates the header', () => {
    const asm = new ChunkAssembler()
    expect(() => asm.push(new ArrayBuffer(4))).toThrow(/header/)
    expect(() => asm.push(JSON.stringify({ type: 'meta', id: 'a', mime: 'text/html', size: 4 }))).toThrow(/images/)
    asm.push(JSON.stringify({ type: 'meta', id: 'a', name: 's.jpg', mime: 'image/jpeg', size: 6 }))
    asm.push(new Uint8Array([1, 2, 3]).buffer)
    asm.push(new Uint8Array([4, 5, 6]).buffer)
    const done = asm.push(JSON.stringify({ type: 'end', id: 'a' }))
    expect(done!.blob.size).toBe(6)
    expect(done!.meta.name).toBe('s.jpg')
    asm.push(JSON.stringify({ type: 'meta', id: 'b', name: 's', mime: 'image/png', size: 2 }))
    expect(() => asm.push(new Uint8Array([1, 2, 3]).buffer)).toThrow(/larger/)
  })
})
