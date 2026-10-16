import { describe, it, expect } from 'vitest'
import { dominantPalette, filterTracedSvg, snapToPalette, traceImageData } from '@/services/canvas/vectorize'
import { svgToPathObjects } from '@/services/canvas/svgToPaths'

// A 40x40 white image with a solid black 20x20 square in the middle.
function squareImage(): ImageData {
  const w = 40
  const h = 40
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const ink = x >= 10 && x < 30 && y >= 10 && y < 30
      data[i] = data[i + 1] = data[i + 2] = ink ? 0 : 255
      data[i + 3] = 255
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

describe('vectorize', () => {
  it('drops transparent and near-white traced paths', () => {
    const svg =
      '<svg><path fill="rgb(255,255,255)" opacity="1" d="M0 0"/>' +
      '<path fill="rgb(0,0,0)" opacity="0" d="M1 1"/>' +
      '<path fill="rgb(10,20,30)" opacity="1" d="M2 2"/></svg>'
    const out = filterTracedSvg(svg)
    expect(out).not.toContain('M0 0')
    expect(out).not.toContain('M1 1')
    expect(out).toContain('fill="#0A141E"')
    expect(out).not.toContain('opacity')
    expect(filterTracedSvg(svg, { removeWhite: false })).toContain('M0 0')
  })

  it('traces a black square into one dark path', () => {
    const parsed = svgToPathObjects(traceImageData(squareImage(), { colors: 2, detail: 0.8 }))
    expect(parsed).not.toBeNull()
    expect(parsed!.paths).toHaveLength(1)
    expect(parsed!.paths[0]!.fill).toBe('#000000')
    const xs = parsed!.paths[0]!.nodes.map((n) => n.x)
    expect(Math.min(...xs)).toBeCloseTo(10, 0)
    expect(Math.max(...xs)).toBeCloseTo(30, 0)
  })

  it('picks flat logo colors and ignores anti-alias blends', () => {
    // Navy square on white with a 1px blended rim, plus a small green bar.
    const w = 60
    const h = 60
    const data = new Uint8ClampedArray(w * h * 4)
    const set = (i: number, r: number, g: number, b: number) => {
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const inSq = x >= 10 && x < 40 && y >= 10 && y < 40
        const rim = x >= 9 && x < 41 && y >= 9 && y < 41 && !inSq
        if (inSq) set(i, 33, 26, 67)
        else if (rim) set(i, 144, 140, 161) // navy/white blend, nearer to green
        else if (y >= 48 && y < 56 && x >= 10 && x < 50) set(i, 58, 167, 109)
        else set(i, 255, 255, 255)
      }
    }
    const imgd = { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
    const pal = dominantPalette(imgd, 8)
    expect(pal).toHaveLength(3)
    const snapped = snapToPalette(imgd, pal)
    // The rim pixel snaps to navy or white, never green.
    const rimI = (9 * w + 20) * 4
    expect(snapped.data[rimI + 1]).not.toBe(167)
    const parsed = svgToPathObjects(traceImageData(imgd, { colors: 8 }))
    expect(parsed!.paths.map((p) => p.fill).sort()).toEqual(['#211A43', '#3AA76D'])
  })
})
