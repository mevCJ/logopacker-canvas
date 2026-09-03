import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import { seedNova } from '@/services/canvas/novaSeed'
import { buildCanvasTools } from '@/services/canvas/tools'
import { buildImageTextTools } from '@/services/canvas/imageTextTools'
import type { WebMcpToolDefinition, WebMcpResult } from '@/services/canvas/webmcp'

const SAMPLE_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="302" height="40" viewBox="0 0 302 40" id="Logo">
  <g id="logomark"><path d="M10 10 L20 20 Z" fill="#3754FA"/></g>
  <g id="logotype"><path d="M30 0 L40 0" fill="#211A43"/><path d="M50 0 L60 0" fill="#211A43"/></g>
</svg>`

function parse(result: WebMcpResult): any {
  const t = result.content[0]!.text
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

function makeTools(store: ReturnType<typeof useCanvasStore>) {
  const steps: string[] = []
  const logger = { step: (l: string, o?: any) => { steps.push(l); store.logStep(l, o) } }
  const map: Record<string, WebMcpToolDefinition> = {}
  for (const t of buildCanvasTools(store, logger)) map[t.name] = t
  const fakeFetch = async () => ({
    query: 'minimal architecture',
    total: 1,
    results: [{ id: 1, alt: 'minimal building', thumb: 't', src: 'https://img/hero.jpg', width: 1200, height: 800 }],
  })
  for (const t of buildImageTextTools(store, logger, { fetchJson: fakeFetch })) map[t.name] = t
  return { tools: map, steps }
}

describe('logo handoff — full orchestration integration', () => {
  let store: ReturnType<typeof useCanvasStore>
  let tools: Record<string, WebMcpToolDefinition>
  let primaryId: string

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    seedNova(store, { logoSvg: SAMPLE_LOGO })
    primaryId = store.artboards[0]!.id
    ;({ tools } = makeTools(store))
  })

  it('drives "Create a complete logo handoff package" end to end', async () => {
    expect(store.artboards).toHaveLength(1)
    expect(store.findByRole('logoSymbol')).toHaveLength(1)
    expect(store.findByRole('wordmark')).toHaveLength(1)

    await tools.begin_agent_request!.execute({ title: 'Create logo handoff package' })
    expect(store.currentGroup).not.toBeNull()

    await tools.inspect_canvas!.execute({})

    const black = parse((await tools.create_artboard!.execute({ name: 'Black Logo', width: 400, height: 300 })) as WebMcpResult).artboard
    await tools.copy_role_to_artboard!.execute({ role: 'logoSymbol', targetArtboardId: black.id, sourceArtboardId: primaryId, recolorFill: '#000000' })
    await tools.copy_role_to_artboard!.execute({ role: 'wordmark', targetArtboardId: black.id, sourceArtboardId: primaryId, recolorFill: '#000000' })

    const white = parse((await tools.create_artboard!.execute({ name: 'White Logo', width: 400, height: 300, backgroundColor: '#111111' })) as WebMcpResult).artboard
    await tools.copy_role_to_artboard!.execute({ role: 'logoSymbol', targetArtboardId: white.id, sourceArtboardId: primaryId, recolorFill: '#FFFFFF' })
    await tools.copy_role_to_artboard!.execute({ role: 'wordmark', targetArtboardId: white.id, sourceArtboardId: primaryId, recolorFill: '#FFFFFF' })

    const symbolOnly = parse((await tools.create_artboard!.execute({ name: 'Symbol Only', width: 300, height: 300 })) as WebMcpResult).artboard
    await tools.copy_role_to_artboard!.execute({ role: 'logoSymbol', targetArtboardId: symbolOnly.id, sourceArtboardId: primaryId })

    const social = parse((await tools.create_artboard!.execute({ name: 'Social Card', width: 600, height: 600, backgroundColor: '#F4F4F5' })) as WebMcpResult).artboard
    const search = parse((await tools.search_pexels!.execute({ query: 'minimal architecture', perPage: 3 })) as WebMcpResult)
    expect(search.results.length).toBeGreaterThan(0)
    const chosen = search.results[0]
    await tools.add_image!.execute({ artboardId: social.id, src: chosen.src, alt: chosen.alt, x: 0, y: 0, width: 600, height: 320, semanticRole: 'heroImage' })
    await tools.copy_role_to_artboard!.execute({ role: 'logoSymbol', targetArtboardId: social.id, sourceArtboardId: primaryId })
    await tools.add_text!.execute({ text: 'Built for what’s next', artboardId: social.id, x: 40, y: 420, fontSize: 40, fontWeight: 700, semanticRole: 'headline' })

    await tools.end_agent_request!.execute({ arrange: true, columns: 3 })

    const names = store.artboards.map((a) => a.name)
    expect(names).toEqual(['Primary Logo', 'Black Logo', 'White Logo', 'Symbol Only', 'Social Card'])

    const blackObjs = store.getArtboard(black.id)!.objectIds.map((id) => store.getObject(id)) as any[]
    expect(blackObjs).toHaveLength(2)
    expect(blackObjs.every((o) => o.fill === '#000000')).toBe(true)

    expect(store.getArtboard(symbolOnly.id)!.objectIds).toHaveLength(1)

    const socialObjs = store.getArtboard(social.id)!.objectIds.map((id) => store.getObject(id)) as any[]
    expect(socialObjs.some((o) => o.type === 'image')).toBe(true)
    expect(socialObjs.some((o) => o.type === 'text' && o.semanticRole === 'headline')).toBe(true)
    expect(socialObjs.some((o) => o.semanticRole === 'logoSymbol')).toBe(true)

    const group = store.activityLog[store.activityLog.length - 1]!
    expect(group.status).toBe('done')
    expect(group.steps.length).toBeGreaterThan(5)

    const label = store.undo()
    expect(label).toBe('Create logo handoff package')
    expect(store.artboards).toHaveLength(1)
    expect(store.artboards[0]!.name).toBe('Primary Logo')
    expect(store.findByRole('logoSymbol')).toHaveLength(1)
  })

  it('example prompt: make the logo monochrome (recolor_role) undoes as one action', async () => {
    await tools.begin_agent_request!.execute({ title: 'Make logo monochrome' })
    await tools.recolor_role!.execute({ roles: ['logoSymbol', 'wordmark'], fill: '#111111' })
    await tools.end_agent_request!.execute({})
    expect((store.findByRole('logoSymbol')[0] as any).fill).toBe('#111111')
    store.undo()
    expect((store.findByRole('logoSymbol')[0] as any).fill).toBe('#3754FA')
  })
})
