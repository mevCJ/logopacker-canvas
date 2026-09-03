import { describe, it, expect } from 'vitest'
import { normalizePexelsResponse, buildPexelsQuery } from '../../server/pexels'

describe('pexels helpers', () => {
  it('normalizes a raw pexels response', () => {
    const raw = {
      total_results: 1,
      photos: [
        {
          id: 123,
          alt: 'A minimal building',
          width: 4000,
          height: 3000,
          photographer: 'Jane',
          url: 'https://pexels.com/photo/123',
          src: { tiny: 't.jpg', small: 's.jpg', medium: 'm.jpg', large: 'l.jpg', large2x: 'l2.jpg', original: 'o.jpg' },
        },
      ],
    }
    const first = normalizePexelsResponse(raw)[0]!
    expect(first.id).toBe(123)
    expect(first.thumb).toBe('m.jpg')
    expect(first.src).toBe('l.jpg')
    expect(first.photographer).toBe('Jane')
  })

  it('handles empty/missing photos', () => {
    expect(normalizePexelsResponse({})).toEqual([])
    expect(normalizePexelsResponse(null)).toEqual([])
  })

  it('builds a clamped query', () => {
    const p = buildPexelsQuery({ query: '  architecture ', perPage: 100, page: 0 })
    expect(p.get('query')).toBe('architecture')
    expect(Number(p.get('per_page'))).toBeLessThanOrEqual(24)
    expect(Number(p.get('page'))).toBeGreaterThanOrEqual(1)
  })

  it('includes valid orientation only', () => {
    expect(buildPexelsQuery({ query: 'x', orientation: 'landscape' }).get('orientation')).toBe('landscape')
    expect(buildPexelsQuery({ query: 'x', orientation: 'bogus' }).get('orientation')).toBeNull()
  })
})
