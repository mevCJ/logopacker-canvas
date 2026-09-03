import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  exportFilename,
  downloadBlob,
  exportSvg,
  inlineRemoteImages,
  rasterizeSvg,
  exportPng,
} from '@/services/canvas/exportService'

describe('exportService — exportFilename', () => {
  it('builds a timestamped, scope-tagged filename', () => {
    const d = new Date(2026, 8, 3, 9, 5, 7) // 2026-09-03 09:05:07
    expect(exportFilename('artboard', 'svg', d)).toBe('nova-artboard-20260903-090507.svg')
    expect(exportFilename('all', 'png', d)).toBe('nova-all-20260903-090507.png')
  })
})

describe('exportService — downloadBlob / exportSvg', () => {
  let clickSpy: ReturnType<typeof vi.fn>
  let createUrl: ReturnType<typeof vi.spyOn>
  let revokeUrl: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clickSpy = vi.fn()
    // Intercept anchor clicks so no real navigation is attempted.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clickSpy)
    createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock')
    revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates and clicks an anchor with the given filename', () => {
    const blob = new Blob(['x'], { type: 'text/plain' })
    downloadBlob(blob, 'file.txt')
    expect(createUrl).toHaveBeenCalledWith(blob)
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('exportSvg produces an image/svg+xml blob and downloads it', () => {
    let captured: Blob | null = null
    createUrl.mockImplementation((b: Blob) => {
      captured = b
      return 'blob:mock'
    })
    exportSvg({ svgString: '<svg></svg>', filename: 'a.svg' })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(captured).not.toBeNull()
    expect((captured as unknown as Blob).type).toContain('image/svg+xml')
  })
})

describe('exportService — inlineRemoteImages', () => {
  afterEach(() => vi.restoreAllMocks())

  it('leaves data: URLs untouched and makes no network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const svg = '<svg><image href="data:image/png;base64,ABC" /></svg>'
    const { svg: out, failed } = await inlineRemoteImages(svg)
    expect(out).toBe(svg)
    expect(failed).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('replaces a remote href with a fetched data URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['bytes'], { type: 'image/png' }),
    } as unknown as Response)

    const svg = '<svg><image href="https://example.com/a.png" /></svg>'
    const { svg: out, failed } = await inlineRemoteImages(svg)
    expect(failed).toEqual([])
    expect(out).toContain('href="data:')
    expect(out).not.toContain('https://example.com/a.png')
  })

  it('collects failures without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'))
    const svg = '<svg><image href="https://example.com/bad.png" /></svg>'
    const { svg: out, failed } = await inlineRemoteImages(svg)
    expect(failed).toEqual(['https://example.com/bad.png'])
    expect(out).toContain('https://example.com/bad.png')
  })
})

describe('exportService — rasterizeSvg', () => {
  afterEach(() => vi.restoreAllMocks())

  function stubImageAutoLoad() {
    class StubImage {
      crossOrigin = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      private _src = ''
      set src(v: string) {
        this._src = v
        // Resolve on next microtask.
        queueMicrotask(() => this.onload && this.onload())
      }
      get src() {
        return this._src
      }
    }
    vi.stubGlobal('Image', StubImage as unknown as typeof Image)
  }

  it('sizes the canvas by width/height * scale and returns a PNG blob', async () => {
    stubImageAutoLoad()
    const toBlob = vi.fn((cb: (b: Blob | null) => void) =>
      cb(new Blob(['png'], { type: 'image/png' })),
    )
    const fillRect = vi.fn()
    const drawImage = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect, drawImage, fillStyle: '' }),
      toBlob,
    }
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'canvas') return canvas as unknown as HTMLCanvasElement
      return origCreate(tag)
    }) as typeof document.createElement)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:svg')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const blob = await rasterizeSvg({
      svgString: '<svg></svg>',
      width: 100,
      height: 50,
      scale: 2,
      background: '#fff',
    })
    expect(canvas.width).toBe(200)
    expect(canvas.height).toBe(100)
    expect(fillRect).toHaveBeenCalledWith(0, 0, 200, 100)
    expect(drawImage).toHaveBeenCalled()
    expect(blob.type).toContain('image/png')
  })
})

describe('exportService — exportPng', () => {
  afterEach(() => vi.restoreAllMocks())

  it('inlines images, rasterizes, downloads, and reports failures', async () => {
    // No remote images -> no fetch, no failures.
    class StubImage {
      crossOrigin = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) {
        queueMicrotask(() => this.onload && this.onload())
      }
    }
    vi.stubGlobal('Image', StubImage as unknown as typeof Image)
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
    }
    const origCreate2 = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'canvas') return canvas as unknown as HTMLCanvasElement
      return origCreate2(tag)
    }) as typeof document.createElement)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const res = await exportPng({
      svgString: '<svg><image href="data:image/png;base64,ABC" /></svg>',
      width: 10,
      height: 10,
      scale: 1,
      filename: 'x.png',
    })
    expect(res.failed).toEqual([])
  })
})
