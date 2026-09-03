import { describe, it, expect } from 'vitest'
import { fitImageSize, pexelsResultToPending } from '@/services/canvas/userTools'

describe('userTools — fitImageSize', () => {
  it('scales down to fit while preserving aspect ratio', () => {
    expect(fitImageSize({ width: 4000, height: 2000 }, 400, 400)).toEqual({ width: 400, height: 200 })
    expect(fitImageSize({ width: 2000, height: 4000 }, 400, 400)).toEqual({ width: 200, height: 400 })
  })

  it('never upscales beyond the natural size', () => {
    expect(fitImageSize({ width: 100, height: 80 }, 400, 400)).toEqual({ width: 100, height: 80 })
  })

  it('guards against zero/negative dimensions', () => {
    const s = fitImageSize({ width: 0, height: 0 }, 400, 400)
    expect(s.width).toBeGreaterThanOrEqual(1)
    expect(s.height).toBeGreaterThanOrEqual(1)
  })
})

describe('userTools — pexelsResultToPending', () => {
  it('maps a Pexels result to a pending-image payload', () => {
    const pending = pexelsResultToPending({
      id: 1,
      alt: 'A building',
      thumb: 't.jpg',
      src: 'large.jpg',
      width: 1200,
      height: 800,
      url: 'https://pexels.com/photo/1',
    })
    expect(pending).toEqual({
      href: 'large.jpg',
      sourceUrl: 'https://pexels.com/photo/1',
      alt: 'A building',
      width: 1200,
      height: 800,
    })
  })
})
