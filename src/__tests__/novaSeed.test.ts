import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import {
  parseSvg,
  readViewBox,
  collectGroup,
  buildNovaObjects,
  seedNova,
  PLACEHOLDER_LOGO,
} from '@/services/canvas/novaSeed'

const SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" width="302" height="40" viewBox="0 0 302 40" id="Logo">
  <g id="logomark"><path d="M10 10 L20 20 Z" fill="#3754FA"/></g>
  <g id="logotype">
    <path d="M30 0 L40 0" fill="#211A43"/>
    <path d="M50 0 L60 0" fill="#211A43"/>
  </g>
</svg>`

describe('nova-seed — parsing', () => {
  it('reads viewBox', () => {
    expect(readViewBox(parseSvg(SAMPLE))).toEqual({ x: 0, y: 0, width: 302, height: 40 })
  })

  it('collects a group into a combined path + first fill', () => {
    const type = collectGroup(parseSvg(SAMPLE), 'logotype')!
    expect(type.count).toBe(2)
    expect(type.d).toBe('M30 0 L40 0 M50 0 L60 0')
    expect(type.fill).toBe('#211A43')
  })

  it('builds logoSymbol + wordmark objects with roles', () => {
    const { objects } = buildNovaObjects(SAMPLE)
    const roles = objects.map((o) => o.semanticRole)
    expect(roles).toContain('logoSymbol')
    expect(roles).toContain('wordmark')
  })

  it('placeholder has both roles', () => {
    const roles = PLACEHOLDER_LOGO.objects.map((o) => o.semanticRole)
    expect(roles).toContain('logoSymbol')
    expect(roles).toContain('wordmark')
  })
})

describe('nova-seed — seeding the store', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('seeds a Primary Logo artboard with tagged objects', () => {
    const ab = seedNova(store, { logoSvg: SAMPLE })
    expect(ab.name).toBe('Primary Logo')
    expect(store.findByRole('logoSymbol')).toHaveLength(1)
    expect(store.findByRole('wordmark')).toHaveLength(1)
    for (const o of store.orderedObjects) expect(o.artboardId).toBe(ab.id)
  })

  it('falls back to placeholder on unparseable svg', () => {
    seedNova(store, { logoSvg: '<not svg' })
    expect(store.findByRole('logoSymbol').length).toBeGreaterThanOrEqual(1)
    expect(store.findByRole('wordmark').length).toBeGreaterThanOrEqual(1)
  })
})
