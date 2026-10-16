// Sketch cleanup: phone photo of a drawing → clean black-on-white bitmap that
// Image Trace turns into tidy vectors. Pure functions over pixel buffers (no
// DOM) so they run in a Web Worker and are unit tested.
//
// Pipeline (each stage optional / tunable):
//   1. Perspective: warp the paper's four corners to an upright rectangle,
//      downscaling to `maxSize` on the way (phones shoot 12MP+).
//   2. Color filter → grayscale: pick the channel that makes unwanted colored
//      marks disappear (blue ruled lines, red margins) or keep only dark ink.
//   3. Screen moiré: FFT notch filter removes the periodic interference
//      pattern of photographed screens.
//   4. Shadow & glare: estimate the paper's illumination (max-pool to drop the
//      ink, then blur) and divide it out, so uneven light, soft shadows,
//      wrinkle shading and glare all flatten to white paper.
//   5. Texture: median filter suppresses paper grain while keeping edges.
//   6. Binarize: Sauvola adaptive threshold (local mean/stddev).
//   7. Clean: drop specks, fill pinholes, optionally thicken/thin strokes.

export interface Pt {
  x: number
  y: number
}

// Minimal ImageData-compatible shape (real ImageData isn't available in
// every worker/test environment).
export interface Rgba {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type ColorFilter = 'none' | 'darkInk' | 'removeBlue' | 'removeRed'

export interface CleanupOptions {
  // Paper corners in source pixels: top-left, top-right, bottom-right,
  // bottom-left. Null = use the whole photo.
  corners: [Pt, Pt, Pt, Pt] | null
  maxSize: number
  colorFilter: ColorFilter
  moire: boolean
  removeShadows: boolean
  // 0..1: paper texture / wrinkle smoothing.
  smoothing: number
  // 0..1: higher keeps fainter strokes (lower Sauvola k).
  sensitivity: number
  // 0..1: speck size to remove, relative to the image.
  despeckle: number
  // -2..2: erode (thin) / dilate (thicken) strokes by that many pixels.
  strokeAdjust: number
}

export const CLEANUP_DEFAULTS: CleanupOptions = {
  corners: null,
  maxSize: 1600,
  colorFilter: 'none',
  moire: false,
  removeShadows: true,
  smoothing: 0.4,
  sensitivity: 0.5,
  despeckle: 0.4,
  strokeAdjust: 0,
}

// ---------------------------------------------------------------------------
// 1. Perspective
// ---------------------------------------------------------------------------

// Solve the 3x3 homography mapping the unit square's corners (0,0) (1,0)
// (1,1) (0,1) to the four given points. Returns row-major [a..h] with i = 1.
export function squareToQuad(q: [Pt, Pt, Pt, Pt]): number[] {
  // Gaussian elimination on the standard 8x8 DLT system.
  const src = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!
    const { x: u, y: v } = q[i]!
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r
    ;[A[c], A[p]] = [A[p]!, A[c]!]
    const piv = A[c]![c]!
    if (Math.abs(piv) < 1e-12) throw new Error('Corners do not form a valid quadrilateral.')
    for (let k = c; k < 9; k++) A[c]![k]! /= piv
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r]![c]!
      if (!f) continue
      for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!
    }
  }
  return A.map((row) => row[8]!)
}

function applyH(h: number[], x: number, y: number): Pt {
  const w = h[6]! * x + h[7]! * y + 1
  return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

// Output size for a quad: the longer of each pair of opposite edges, scaled so
// the longest side is at most maxSize.
export function warpSize(q: [Pt, Pt, Pt, Pt], maxSize: number): { width: number; height: number } {
  const w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]))
  const h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]))
  const k = Math.min(1, maxSize / Math.max(w, h, 1))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

// Warp (and downscale) to grayscale-ready RGB, bilinear sampling. With no
// corners this is a plain area-ish downscale of the whole photo.
export function warp(src: Rgba, corners: [Pt, Pt, Pt, Pt] | null, maxSize: number): Rgba {
  const q: [Pt, Pt, Pt, Pt] = corners ?? [
    { x: 0, y: 0 },
    { x: src.width, y: 0 },
    { x: src.width, y: src.height },
    { x: 0, y: src.height },
  ]
  const { width, height } = warpSize(q, maxSize)
  const h = squareToQuad(q)
  const out = new Uint8ClampedArray(width * height * 4)
  // Supersample 2x2 when shrinking a lot, to avoid aliasing fine pencil lines.
  const shrink = Math.max(src.width / width, src.height / height)
  const ss = shrink > 1.5 ? 2 : 1
  const sw = src.width
  const sh = src.height
  const sd = src.data
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const p = applyH(h, (x + (sx + 0.5) / ss) / width, (y + (sy + 0.5) / ss) / height)
          const fx = Math.min(sw - 1.001, Math.max(0, p.x - 0.5))
          const fy = Math.min(sh - 1.001, Math.max(0, p.y - 0.5))
          const x0 = Math.floor(fx)
          const y0 = Math.floor(fy)
          const ax = fx - x0
          const ay = fy - y0
          const i00 = (y0 * sw + x0) * 4
          const i10 = i00 + 4
          const i01 = i00 + sw * 4
          const i11 = i01 + 4
          const w00 = (1 - ax) * (1 - ay)
          const w10 = ax * (1 - ay)
          const w01 = (1 - ax) * ay
          const w11 = ax * ay
          r += sd[i00]! * w00 + sd[i10]! * w10 + sd[i01]! * w01 + sd[i11]! * w11
          g += sd[i00 + 1]! * w00 + sd[i10 + 1]! * w10 + sd[i01 + 1]! * w01 + sd[i11 + 1]! * w11
          b += sd[i00 + 2]! * w00 + sd[i10 + 2]! * w10 + sd[i01 + 2]! * w01 + sd[i11 + 2]! * w11
        }
      }
      const n = ss * ss
      const o = (y * width + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

// ---------------------------------------------------------------------------
// 2. Color filter → grayscale (Float32, 0..255)
// ---------------------------------------------------------------------------

export function toGray(img: Rgba, filter: ColorFilter): Float32Array {
  const n = img.width * img.height
  const out = new Float32Array(n)
  const d = img.data
  for (let i = 0; i < n; i++) {
    const r = d[i * 4]!
    const g = d[i * 4 + 1]!
    const b = d[i * 4 + 2]!
    switch (filter) {
      // Colored marks are bright in at least one channel; only true dark ink
      // is dark in all three.
      case 'darkInk':
        out[i] = Math.max(r, g, b)
        break
      // Blue lines are bright in the blue channel, dark ink stays dark.
      case 'removeBlue':
        out[i] = b
        break
      case 'removeRed':
        out[i] = r
        break
      default:
        out[i] = 0.299 * r + 0.587 * g + 0.114 * b
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. Screen moiré: FFT notch filter
// ---------------------------------------------------------------------------

function fft1d(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b]! * cr - im[b]! * ci
        const ti = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i]! /= n
      im[i]! /= n
    }
  }
}

function fft2d(re: Float32Array, im: Float32Array, w: number, h: number, inverse: boolean): void {
  const rr = new Float32Array(w)
  const ri = new Float32Array(w)
  for (let y = 0; y < h; y++) {
    rr.set(re.subarray(y * w, y * w + w))
    ri.set(im.subarray(y * w, y * w + w))
    fft1d(rr, ri, inverse)
    re.set(rr, y * w)
    im.set(ri, y * w)
  }
  const cr = new Float32Array(h)
  const ci = new Float32Array(h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      cr[y] = re[y * w + x]!
      ci[y] = im[y * w + x]!
    }
    fft1d(cr, ci, inverse)
    for (let y = 0; y < h; y++) {
      re[y * w + x] = cr[y]!
      im[y * w + x] = ci[y]!
    }
  }
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(Math.max(2, n)))

// Moiré is a strong, narrow peak at mid/high frequency in the spectrum. Any
// coefficient far above the typical magnitude at its radius (outside the
// low-frequency core that carries the drawing itself) is attenuated to that
// typical level.
export function removeMoire(gray: Float32Array, w: number, h: number): Float32Array {
  const W = nextPow2(w)
  const H = nextPow2(h)
  const re = new Float32Array(W * H)
  const im = new Float32Array(W * H)
  let mean = 0
  for (let i = 0; i < gray.length; i++) mean += gray[i]!
  mean /= gray.length || 1
  // Pad with the mean (not black) to avoid a hard edge in the spectrum.
  re.fill(mean)
  for (let y = 0; y < h; y++) re.set(gray.subarray(y * w, y * w + w), y * W)
  fft2d(re, im, W, H, false)

  const maxR = Math.ceil(Math.hypot(W / 2, H / 2)) + 1
  const sum = new Float64Array(maxR)
  const cnt = new Uint32Array(maxR)
  const radius = (x: number, y: number) => {
    const fx = x <= W / 2 ? x : x - W
    const fy = y <= H / 2 ? y : y - H
    return Math.round(Math.hypot((fx * H) / W, fy)) // isotropic in cycles/height
  }
  const mag = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      mag[i] = Math.hypot(re[i]!, im[i]!)
      const r = radius(x, y)
      sum[r] = sum[r]! + mag[i]!
      cnt[r] = cnt[r]! + 1
    }
  }
  const core = Math.max(6, Math.round(H * 0.03))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = radius(x, y)
      if (r < core) continue
      const typical = cnt[r] ? sum[r]! / cnt[r]! : 0
      const i = y * W + x
      if (typical > 0 && mag[i]! > typical * 6) {
        const k = typical / mag[i]!
        re[i]! *= k
        im[i]! *= k
      }
    }
  }
  fft2d(re, im, W, H, true)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = re[y * W + x]!
  return out
}

// ---------------------------------------------------------------------------
// 4. Shadow & glare: illumination flattening
// ---------------------------------------------------------------------------

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k))
        s += src[y * w + xx]!
        n++
      }
      tmp[y * w + x] = s / n
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k))
        s += tmp[yy * w + x]!
        n++
      }
      out[y * w + x] = s / n
    }
  }
  return out
}

// Estimate the paper brightness everywhere: max-pool into coarse cells (ink is
// darker than paper, so the max is paper), blur the cell grid, then bilinear
// upsample. Dividing by it makes the paper uniformly white.
export function estimateBackground(gray: Float32Array, w: number, h: number): Float32Array {
  const cell = Math.max(4, Math.round(Math.max(w, h) / 48))
  const gw = Math.ceil(w / cell)
  const gh = Math.ceil(h / cell)
  const grid = new Float32Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      // A high percentile rather than the strict max resists specular dots.
      const vals: number[] = []
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y++) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x++) vals.push(gray[y * w + x]!)
      }
      vals.sort((a, b) => a - b)
      grid[gy * gw + gx] = vals[Math.floor(vals.length * 0.9)] ?? 255
    }
  }
  // Cells fully covered by a big ink area read dark; a max filter over
  // neighbors fills them with surrounding paper before smoothing.
  const filled = new Float32Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let m = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(gw - 1, Math.max(0, x + dx))
          const yy = Math.min(gh - 1, Math.max(0, y + dy))
          m = Math.max(m, grid[yy * gw + xx]!)
        }
      }
      filled[y * gw + x] = m
    }
  }
  const smooth = boxBlur(boxBlur(filled, gw, gh, 1), gw, gh, 1)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1.001, Math.max(0, (y + 0.5) / cell - 0.5))
    const y0 = Math.floor(fy)
    const ay = fy - y0
    const y1 = Math.min(gh - 1, y0 + 1)
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1.001, Math.max(0, (x + 0.5) / cell - 0.5))
      const x0 = Math.floor(fx)
      const ax = fx - x0
      const x1 = Math.min(gw - 1, x0 + 1)
      out[y * w + x] =
        smooth[y0 * gw + x0]! * (1 - ax) * (1 - ay) +
        smooth[y0 * gw + x1]! * ax * (1 - ay) +
        smooth[y1 * gw + x0]! * (1 - ax) * ay +
        smooth[y1 * gw + x1]! * ax * ay
    }
  }
  return out
}

export function flattenIllumination(gray: Float32Array, w: number, h: number): Float32Array {
  const bg = estimateBackground(gray, w, h)
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, (gray[i]! / Math.max(8, bg[i]!)) * 255)
  return out
}

// ---------------------------------------------------------------------------
// 5. Texture: median filter
// ---------------------------------------------------------------------------

export function median(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src
  const out = new Float32Array(w * h)
  const win: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      win.length = 0
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy))
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx))
          win.push(src[yy * w + xx]!)
        }
      }
      win.sort((a, b) => a - b)
      out[y * w + x] = win[win.length >> 1]!
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 6. Sauvola binarization (true = ink)
// ---------------------------------------------------------------------------

export function sauvola(gray: Float32Array, w: number, h: number, k: number, window: number): Uint8Array {
  // Integral images of value and value² for O(1) local mean/variance.
  const W = w + 1
  const s1 = new Float64Array(W * (h + 1))
  const s2 = new Float64Array(W * (h + 1))
  for (let y = 0; y < h; y++) {
    let r1 = 0
    let r2 = 0
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x]!
      r1 += v
      r2 += v * v
      s1[(y + 1) * W + x + 1] = s1[y * W + x + 1]! + r1
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1]! + r2
    }
  }
  const half = Math.max(1, window >> 1)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half)
    const y1 = Math.min(h, y + half + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half)
      const x1 = Math.min(w, x + half + 1)
      const n = (x1 - x0) * (y1 - y0)
      const a = s1[y1 * W + x1]! - s1[y0 * W + x1]! - s1[y1 * W + x0]! + s1[y0 * W + x0]!
      const b = s2[y1 * W + x1]! - s2[y0 * W + x1]! - s2[y1 * W + x0]! + s2[y0 * W + x0]!
      const m = a / n
      const sd = Math.sqrt(Math.max(0, b / n - m * m))
      const t = m * (1 + k * (sd / 128 - 1))
      out[y * w + x] = gray[y * w + x]! < t ? 1 : 0
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 7. Clean up the bitmap
// ---------------------------------------------------------------------------

// Flip connected regions of `value` smaller than `minArea` (4-connected). For
// ink (value 1) this drops specks; for paper (value 0) it fills pinholes —
// paper regions touching the border are never filled.
export function removeSmall(bits: Uint8Array, w: number, h: number, value: 0 | 1, minArea: number): void {
  if (minArea <= 1) return
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const comp: number[] = []
  for (let start = 0; start < bits.length; start++) {
    if (seen[start] || bits[start] !== value) continue
    stack.push(start)
    seen[start] = 1
    comp.length = 0
    let touchesBorder = false
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w
      const y = (i - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]
      for (const j of nb) {
        if (j >= 0 && !seen[j] && bits[j] === value) {
          seen[j] = 1
          stack.push(j)
        }
      }
      if (comp.length >= minArea) {
        // Large enough: finish marking it seen, but no need to record it.
        while (stack.length) {
          const k = stack.pop()!
          const kx = k % w
          const ky = (k - kx) / w
          const nb2 = [kx > 0 ? k - 1 : -1, kx < w - 1 ? k + 1 : -1, ky > 0 ? k - w : -1, ky < h - 1 ? k + w : -1]
          for (const j of nb2) {
            if (j >= 0 && !seen[j] && bits[j] === value) {
              seen[j] = 1
              stack.push(j)
            }
          }
        }
        break
      }
    }
    if (comp.length < minArea && !(value === 0 && touchesBorder)) {
      for (const i of comp) bits[i] = value ? 0 : 1
    }
  }
}

// Dilate (n > 0) or erode (n < 0) ink by |n| pixels (3x3 cross).
export function morph(bits: Uint8Array, w: number, h: number, n: number): Uint8Array {
  let cur = bits
  const grow = n > 0
  for (let it = 0; it < Math.abs(n); it++) {
    const next = new Uint8Array(cur)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const nb = [
          x > 0 ? cur[i - 1] : cur[i],
          x < w - 1 ? cur[i + 1] : cur[i],
          y > 0 ? cur[i - w] : cur[i],
          y < h - 1 ? cur[i + w] : cur[i],
        ]
        if (grow ? nb.some((v) => v) : nb.some((v) => !v)) next[i] = grow ? 1 : 0
      }
    }
    cur = next
  }
  return cur
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function cleanupSketch(src: Rgba, options: Partial<CleanupOptions> = {}): Rgba {
  const o = { ...CLEANUP_DEFAULTS, ...options }
  const img = warp(src, o.corners, o.maxSize)
  const { width: w, height: h } = img
  let gray = toGray(img, o.colorFilter)
  if (o.moire) gray = removeMoire(gray, w, h)
  if (o.removeShadows) gray = flattenIllumination(gray, w, h)
  const s = Math.min(1, Math.max(0, o.smoothing))
  gray = median(gray, w, h, s > 0.66 ? 2 : s > 0.05 ? 1 : 0)

  // Sauvola k: 0.5 (strict) … 0.08 (keeps faint pencil). Window ≈ 1/20 of the
  // image so it spans a few stroke widths but not whole shapes.
  const k = 0.5 - Math.min(1, Math.max(0, o.sensitivity)) * 0.42
  const win = Math.max(15, Math.round(Math.max(w, h) / 20) | 1)
  let bits = sauvola(gray, w, h, k, win)
  // Sauvola alone flags faint paper noise in flat areas; require pixels to be
  // meaningfully darker than white paper too.
  const floor = 255 - 20 - (1 - o.sensitivity) * 40
  for (let i = 0; i < bits.length; i++) if (bits[i] && gray[i]! > floor) bits[i] = 0

  const minArea = Math.round(Math.pow(Math.max(w, h) / 400, 2) * (2 + o.despeckle * 60))
  removeSmall(bits, w, h, 1, minArea)
  removeSmall(bits, w, h, 0, Math.round(minArea / 2))
  if (o.strokeAdjust) bits = morph(bits, w, h, Math.round(o.strokeAdjust))

  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] ? 0 : 255
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  }
  return { width: w, height: h, data: out }
}

// ---------------------------------------------------------------------------
// Paper detection (default corners)
// ---------------------------------------------------------------------------

// Find the sheet of paper: the largest bright region (Otsu threshold on a
// small copy), then its extreme points as corners. Returns null when no clear
// sheet stands out (e.g. the photo is already cropped to the paper).
export function detectPaper(src: Rgba): [Pt, Pt, Pt, Pt] | null {
  const small = warp(src, null, 320)
  const { width: w, height: h } = small
  const gray = toGray(small, 'none')
  const hist = new Uint32Array(256)
  for (const v of gray) {
    const b = Math.round(v)
    hist[b] = hist[b]! + 1
  }
  // Otsu.
  const total = gray.length
  let sumAll = 0
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!
  let sumB = 0
  let wB = 0
  let best = 0
  let thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > best) {
      best = between
      thr = t
    }
  }
  const bright = new Uint8Array(total)
  for (let i = 0; i < total; i++) bright[i] = gray[i]! > thr ? 1 : 0
  // Largest bright component.
  const label = new Int32Array(total).fill(-1)
  let bestComp: number[] = []
  for (let s = 0; s < total; s++) {
    if (!bright[s] || label[s] !== -1) continue
    const comp: number[] = []
    const stack = [s]
    label[s] = s
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w
      const y = (i - x) / w
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && bright[j] && label[j] === -1) {
          label[j] = s
          stack.push(j)
        }
      }
    }
    if (comp.length > bestComp.length) bestComp = comp
  }
  const frac = bestComp.length / total
  if (frac < 0.15 || frac > 0.97) return null
  let tl = bestComp[0]!
  let tr = tl
  let br = tl
  let bl = tl
  const xy = (i: number) => ({ x: i % w, y: Math.floor(i / w) })
  for (const i of bestComp) {
    const p = xy(i)
    const s = p.x + p.y
    const d = p.x - p.y
    if (s < xy(tl).x + xy(tl).y) tl = i
    if (s > xy(br).x + xy(br).y) br = i
    if (d > xy(tr).x - xy(tr).y) tr = i
    if (d < xy(bl).x - xy(bl).y) bl = i
  }
  const sx = src.width / w
  const sy = src.height / h
  const toSrc = (i: number): Pt => {
    const p = xy(i)
    return { x: (p.x + 0.5) * sx, y: (p.y + 0.5) * sy }
  }
  const quad: [Pt, Pt, Pt, Pt] = [toSrc(tl), toSrc(tr), toSrc(br), toSrc(bl)]
  // Reject degenerate picks (e.g. a triangle-shaped blob).
  const { width: qw, height: qh } = warpSize(quad, 1e9)
  if (qw < src.width * 0.2 || qh < src.height * 0.2) return null
  return quad
}
