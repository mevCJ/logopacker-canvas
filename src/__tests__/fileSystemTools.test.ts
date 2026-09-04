import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import { buildFileSystemTools, type FileSystemDeps } from '@/services/canvas/fileSystemTools'
import * as exportService from '@/services/canvas/exportService'
import * as documentIO from '@/services/canvas/documentIO'
import type { WebMcpToolDefinition, WebMcpResult } from '@/services/canvas/webmcp'

function parse(result: WebMcpResult): any {
  const t = result.content[0]!.text
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

describe('WebMCP file system tools (stable, cross-browser)', () => {
  let store: ReturnType<typeof useCanvasStore>
  let steps: string[]
  let ab: any

  function build(deps?: FileSystemDeps) {
    const logger = { step: (l: string) => steps.push(l) }
    const map: Record<string, WebMcpToolDefinition> = {}
    for (const t of buildFileSystemTools(store, logger, deps)) map[t.name] = t
    return map
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    setActivePinia(createPinia())
    store = useCanvasStore()
    steps = []
    ab = store.addArtboard({ name: 'Primary Logo', width: 400, height: 400 })
    store.addObject({ type: 'path', artboardId: ab.id, d: 'M0 0 L100 0 L100 100 Z', fill: '#000' })
  })

  it('registers the expected tool names', () => {
    expect(Object.keys(build()).sort()).toEqual(['autosave', 'read_assets', 'save_export'].sort())
  })

  it('read_assets places every chosen image as an image object', async () => {
    // happy-dom never fires load/error for a data: URL, so inject the probe.
    const tools = build({
      pickFiles: async () => [png('logo.png'), png('mark.png')],
      probeSize: async () => ({ width: 64, height: 64 }),
    })
    const out = parse((await tools.read_assets!.execute({ artboardId: ab.id })) as WebMcpResult)
    expect(out.created).toHaveLength(2)
    const objs = out.created.map((c: any) => store.getObject(c.id)) as any[]
    expect(objs.every((o) => o.type === 'image')).toBe(true)
    expect(objs[0].href.startsWith('data:image/png;base64,')).toBe(true)
    expect(objs.every((o) => o.artboardId === ab.id)).toBe(true)
  })

  it('read_assets filters non-images and reports when nothing usable is chosen', async () => {
    const only = build({ pickFiles: async () => [new File(['x'], 'notes.txt', { type: 'text/plain' })] })
    expect(parse((await only.read_assets!.execute({ artboardId: ab.id })) as WebMcpResult)).toMatch(/no supported image/i)
    const none = build({ pickFiles: async () => [] })
    expect(parse((await none.read_assets!.execute({ artboardId: ab.id })) as WebMcpResult)).toMatch(/no supported image/i)
  })

  it('save_export builds an SVG and downloads it', async () => {
    const spy = vi.spyOn(exportService, 'exportSvg').mockImplementation(() => {})
    const tools = build()
    const out = parse((await tools.save_export!.execute({ scope: 'all', format: 'svg' })) as WebMcpResult)
    expect(spy).toHaveBeenCalledTimes(1)
    const arg = spy.mock.calls[0]![0]
    expect(arg.svgString).toContain('<svg')
    expect(out.filename).toMatch(/\.svg$/)
  })

  it('save_export renders and downloads a PNG', async () => {
    const spy = vi.spyOn(exportService, 'exportPng').mockResolvedValue({ failed: [] })
    const tools = build()
    const out = parse(
      (await tools.save_export!.execute({ scope: 'artboard', artboardId: ab.id, format: 'png', scale: 2 })) as WebMcpResult,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0].scale).toBe(2)
    expect(out.filename).toMatch(/\.png$/)
  })

  it('save_export reports when there is nothing to export', async () => {
    setActivePinia(createPinia())
    const empty = useCanvasStore()
    const map: Record<string, WebMcpToolDefinition> = {}
    for (const t of buildFileSystemTools(empty, { step: () => {} })) map[t.name] = t
    expect(parse((await map.save_export!.execute({ scope: 'all', format: 'svg' })) as WebMcpResult)).toMatch(/nothing to export/i)
  })

  it('autosave downloads the canvas JSON document via the Save path', async () => {
    const spy = vi.spyOn(documentIO, 'saveDocumentToFile').mockImplementation(() => {})
    const serialize = vi.spyOn(store, 'serializeDocument')
    const tools = build()
    const out = parse((await tools.autosave!.execute({})) as WebMcpResult)
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(out.filename).toMatch(/\.json$/)
  })
})
