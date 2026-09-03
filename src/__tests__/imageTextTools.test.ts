import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import { buildImageTextTools, type ImageTextDeps } from '@/services/canvas/imageTextTools'
import type { WebMcpToolDefinition, WebMcpResult } from '@/services/canvas/webmcp'

function parse(result: WebMcpResult): any {
  const t = result.content[0]!.text
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

describe('WebMCP typography & image tools', () => {
  let store: ReturnType<typeof useCanvasStore>
  let steps: string[]
  let ab: any

  function build(deps?: ImageTextDeps) {
    const map: Record<string, WebMcpToolDefinition> = {}
    for (const t of buildImageTextTools(store, { step: (l) => steps.push(l) }, deps)) map[t.name] = t
    return map
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    steps = []
    ab = store.addArtboard({ name: 'Social Card', width: 600, height: 600 })
  })

  it('add_text creates a text object with role', async () => {
    const tools = build()
    const out = parse((await tools.add_text!.execute({ text: 'Built for what’s next', artboardId: ab.id, semanticRole: 'headline', fontSize: 32 })) as WebMcpResult)
    const obj = store.getObject(out.id)! as any
    expect(obj.type).toBe('text')
    expect(obj.text).toBe('Built for what’s next')
    expect(obj.semanticRole).toBe('headline')
    expect(obj.fontSize).toBe(32)
  })

  it('set_typography updates by role and only affects text', async () => {
    store.addObject({ type: 'text', artboardId: ab.id, semanticRole: 'headline', text: 'A' })
    store.addObject({ type: 'path', artboardId: ab.id, semanticRole: 'headline' })
    const tools = build()
    await tools.set_typography!.execute({ role: 'headline', fontWeight: 700, fill: '#fff' })
    const texts = store.findByRole('headline').filter((o) => o.type === 'text') as any[]
    expect(texts[0].fontWeight).toBe(700)
  })

  it('search_pexels returns normalized results via injected fetch', async () => {
    const fake = async (url: string) => {
      expect(url).toContain('/api/pexels/search')
      return { query: 'architecture', total: 2, results: [{ id: 1, alt: 'a', thumb: 't1', src: 's1', width: 100, height: 100 }, { id: 2, alt: 'b', thumb: 't2', src: 's2', width: 100, height: 100 }] }
    }
    const tools = build({ fetchJson: fake })
    const out = parse((await tools.search_pexels!.execute({ query: 'architecture', perPage: 5 })) as WebMcpResult)
    expect(out.results).toHaveLength(2)
    expect(steps.some((s) => s.includes('Found 2'))).toBe(true)
  })

  it('search_pexels reports failure gracefully', async () => {
    const failing = async () => {
      throw new Error('boom')
    }
    const tools = build({ fetchJson: failing })
    const out = parse((await tools.search_pexels!.execute({ query: 'x' })) as WebMcpResult)
    expect(out).toMatch(/failed/i)
    expect(steps).toContain('Pexels search failed')
  })

  it('add_image adds a chosen result; requires src', async () => {
    const tools = build()
    const out = parse((await tools.add_image!.execute({ artboardId: ab.id, src: 's1', alt: 'b', width: 600, height: 300 })) as WebMcpResult)
    expect((store.getObject(out.id) as any).href).toBe('s1')
    expect(parse((await tools.add_image!.execute({ artboardId: ab.id })) as WebMcpResult)).toMatch(/requires src/)
  })
})
