import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import { buildCanvasTools, registerCanvasTools } from '@/services/canvas/tools'
import type { WebMcpToolDefinition, WebMcpResult } from '@/services/canvas/webmcp'

function toolMap(store: ReturnType<typeof useCanvasStore>, steps: string[]) {
  const map: Record<string, WebMcpToolDefinition> = {}
  for (const t of buildCanvasTools(store, { step: (l) => steps.push(l) })) map[t.name] = t
  return map
}
function parse(result: WebMcpResult): any {
  const t = result.content[0]!.text
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

describe('WebMCP canvas & object tools', () => {
  let store: ReturnType<typeof useCanvasStore>
  let tools: Record<string, WebMcpToolDefinition>
  let steps: string[]
  let ab: any
  let symbol: any
  let wordmark: any

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    steps = []
    tools = toolMap(store, steps)
    ab = store.addArtboard({ name: 'Primary Logo', width: 400, height: 300 })
    symbol = store.addObject({ type: 'path', artboardId: ab.id, semanticRole: 'logoSymbol', d: 'M0 0 L10 10 Z', fill: '#3754FA' })
    wordmark = store.addObject({ type: 'path', artboardId: ab.id, semanticRole: 'wordmark', d: 'M20 0 L30 0', fill: '#211A43' })
  })

  it('every tool has the WebMCP shape', () => {
    for (const t of buildCanvasTools(store)) {
      expect(typeof t.name).toBe('string')
      expect(t.inputSchema.type).toBe('object')
      expect(typeof t.execute).toBe('function')
    }
  })

  it('inspect_canvas returns artboards + total', async () => {
    const out = parse((await tools.inspect_canvas!.execute({})) as WebMcpResult)
    expect(out.artboards).toHaveLength(1)
    expect(out.totalObjects).toBe(2)
    expect(steps).toContain('Inspected canvas')
  })

  it('inspect_path exposes d + style', async () => {
    const out = parse((await tools.inspect_path!.execute({ id: symbol.id })) as WebMcpResult)
    expect(out.d).toBe('M0 0 L10 10 Z')
    expect(out.fill).toBe('#3754FA')
  })

  it('select_objects by role', async () => {
    await tools.select_objects!.execute({ role: 'wordmark' })
    expect(store.selectedIds).toEqual([wordmark.id])
  })

  it('get_selection returns the human’s current object selection', async () => {
    store.selectObjects([symbol.id])
    const out = parse((await tools.get_selection!.execute({})) as WebMcpResult)
    expect(out.objectIds).toEqual([symbol.id])
    expect(out.objects).toHaveLength(1)
    expect(out.objects[0].id).toBe(symbol.id)
    expect(out.objects[0].semanticRole).toBe('logoSymbol')
    expect(out.artboard).toBeNull()
  })

  it('get_selection reports a selected artboard (mutually exclusive with objects)', async () => {
    store.selectArtboard(ab.id)
    const out = parse((await tools.get_selection!.execute({})) as WebMcpResult)
    expect(out.objectIds).toEqual([])
    expect(out.artboardId).toBe(ab.id)
    expect(out.artboard.name).toBe('Primary Logo')
  })

  it('set_fill by role recolors the whole logo', async () => {
    await tools.set_fill!.execute({ role: 'logoSymbol', fill: '#000000' })
    await tools.set_fill!.execute({ role: 'wordmark', fill: '#000000' })
    expect((store.getObject(symbol.id) as any).fill).toBe('#000000')
    expect((store.getObject(wordmark.id) as any).fill).toBe('#000000')
  })

  it('set_path_data rewrites d', async () => {
    await tools.set_path_data!.execute({ id: symbol.id, d: 'M5 5 L9 9' })
    expect((store.getObject(symbol.id) as any).d).toBe('M5 5 L9 9')
  })

  it('missing object returns a message, not throw', async () => {
    const out = parse((await tools.get_object!.execute({ id: 'nope' })) as WebMcpResult)
    expect(out).toMatch(/No object/)
  })

  it('fit_artboard_to_artwork resizes the artboard to wrap its objects', async () => {
    // Reposition the two seeded paths (each 100×100 by default) so their union
    // bounds are known: symbol at (10,20), wordmark at (60,90) -> union
    // top-left (10,20), bottom-right (160,190) => 150×170 at local (10,20).
    store.moveObject(symbol.id, { x: 10, y: 20 })
    store.moveObject(wordmark.id, { x: 60, y: 90 })

    const out = parse((await tools.fit_artboard_to_artwork!.execute({ artboardId: ab.id })) as WebMcpResult)
    expect(out.artboard.width).toBe(150)
    expect(out.artboard.height).toBe(170)
    // Artboard moved to the artwork origin; objects rebased to keep place.
    expect(out.artboard.x).toBe(10)
    expect(out.artboard.y).toBe(20)
    expect((store.getObject(symbol.id) as any).x).toBe(0)
    expect((store.getObject(symbol.id) as any).y).toBe(0)
    expect(steps.some((s) => /Fit artboard/.test(s))).toBe(true)
  })

  it('fit_artboard_to_artwork reports when the artboard is empty', async () => {
    const empty = store.addArtboard({ name: 'Empty', width: 300, height: 300 })
    const out = parse((await tools.fit_artboard_to_artwork!.execute({ artboardId: empty.id })) as WebMcpResult)
    expect(out).toMatch(/no artwork/i)
  })

  it('fit_artboard_to_artwork reports an unknown artboard', async () => {
    const out = parse((await tools.fit_artboard_to_artwork!.execute({ artboardId: 'nope' })) as WebMcpResult)
    expect(out).toMatch(/No artboard/)
  })

  it('reparent_object moves an object to another artboard, keeping it in place', async () => {
    const b = store.addArtboard({ name: 'Secondary', x: 500, y: 100, width: 400, height: 300 })
    store.moveObject(symbol.id, { x: 50, y: 60 }) // local in ab (origin 0,0) -> abs (50,60)

    const out = parse((await tools.reparent_object!.execute({ id: symbol.id, artboardId: b.id })) as WebMcpResult)
    expect(out.artboardId).toBe(b.id)
    // Rebased to b origin (500,100): (50-500, 60-100) = (-450, -40).
    expect(out.x).toBe(-450)
    expect(out.y).toBe(-40)
    expect(store.getArtboard(ab.id)!.objectIds).not.toContain(symbol.id)
    expect(store.getArtboard(b.id)!.objectIds).toContain(symbol.id)
  })

  it('reparent_object rejects an unknown target artboard', async () => {
    const out = parse((await tools.reparent_object!.execute({ id: symbol.id, artboardId: 'nope' })) as WebMcpResult)
    expect(out).toMatch(/No artboard/)
    // Unchanged.
    expect((store.getObject(symbol.id) as any).artboardId).toBe(ab.id)
  })

  it('reparent_object can detach an object to the canvas (artboardId null)', async () => {
    store.moveObject(symbol.id, { x: 5, y: 7 })
    const out = parse((await tools.reparent_object!.execute({ id: symbol.id, artboardId: null })) as WebMcpResult)
    expect(out.artboardId).toBeNull()
    // ab origin is (0,0) so coords are unchanged, just detached.
    expect(store.getArtboard(ab.id)!.objectIds).not.toContain(symbol.id)
  })
})

describe('registerCanvasTools — WebMCP registration wiring', () => {
  let store: ReturnType<typeof useCanvasStore>
  let registered: string[]
  let aborted: string[]

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    registered = []
    aborted = []
    ;(document as any).modelContext = {
      registerTool(tool: WebMcpToolDefinition, opts?: { signal?: AbortSignal }) {
        registered.push(tool.name)
        opts?.signal?.addEventListener('abort', () => aborted.push(tool.name))
      },
    }
  })

  it('registers every canvas tool and abort unregisters', () => {
    const expected = buildCanvasTools(store).map((t) => t.name)
    const unregister = registerCanvasTools(store)
    expect(registered.sort()).toEqual(expected.sort())
    unregister()
    expect(aborted.sort()).toEqual(expected.sort())
  })

  it('no-ops safely when modelContext is unavailable', () => {
    delete (document as any).modelContext
    const unregister = registerCanvasTools(store)
    expect(registered).toHaveLength(0)
    expect(() => unregister()).not.toThrow()
  })
})
