import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore, DOCUMENT_VERSION } from '@/stores/canvas'
import {
  documentFilename,
  parseDocumentFile,
} from '@/services/canvas/documentIO'

function seedDocument(store: ReturnType<typeof useCanvasStore>) {
  const ab = store.addArtboard({ name: 'Primary', width: 400, height: 300, backgroundColor: '#fafafa' })
  const path = store.addObject({ type: 'path', d: 'M0 0 L10 10', fill: '#123456', artboardId: ab.id })
  const text = store.addObject({ type: 'text', text: 'Hello', artboardId: ab.id })
  const img = store.addObject({
    type: 'image',
    href: 'data:image/png;base64,AAAA',
    sourceUrl: 'https://example.com/x.png',
    artboardId: ab.id,
  })
  store.viewport = { x: 12, y: -34, zoom: 1.5 }
  return { ab, path, text, img }
}

describe('document save / load', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('serializeDocument captures artwork, viewport and id counter, not transient state', () => {
    seedDocument(store)
    store.snapshot('Edit') // adds undo history that must NOT be serialized

    const doc = store.serializeDocument()
    expect(doc.version).toBe(DOCUMENT_VERSION)
    expect(doc.artboards).toHaveLength(1)
    expect(Object.keys(doc.objects)).toHaveLength(3)
    expect(doc.objectOrder).toHaveLength(3)
    expect(doc.viewport).toEqual({ x: 12, y: -34, zoom: 1.5 })
    expect(doc.idCounter).toBeGreaterThan(0)
    // Transient fields are absent from the serialized document.
    expect((doc as Record<string, unknown>).history).toBeUndefined()
    expect((doc as Record<string, unknown>).activityLog).toBeUndefined()
    expect((doc as Record<string, unknown>).selectedIds).toBeUndefined()
  })

  it('round-trips a document through serialize -> JSON -> load', () => {
    const { path } = seedDocument(store)
    const json = JSON.stringify(store.serializeDocument())

    // Load into a fresh store.
    setActivePinia(createPinia())
    const fresh = useCanvasStore()
    fresh.loadDocument(JSON.parse(json))

    expect(fresh.artboards).toHaveLength(1)
    expect(fresh.artboards[0]!.name).toBe('Primary')
    expect(fresh.objectOrder).toHaveLength(3)
    const loadedPath = fresh.objects[path.id]
    expect(loadedPath).toBeTruthy()
    expect((loadedPath as { fill: string }).fill).toBe('#123456')
    expect(fresh.viewport).toEqual({ x: 12, y: -34, zoom: 1.5 })
  })

  it('loadDocument replaces the existing document and resets selection/history', () => {
    seedDocument(store)
    const doc = store.serializeDocument()

    // Mutate the current store so we can prove load replaces it.
    store.addArtboard({ name: 'Extra' })
    store.selectArtboard?.(store.artboards[0]!.id)
    store.snapshot('Edit')

    store.loadDocument(doc)
    expect(store.artboards).toHaveLength(1)
    expect(store.selectedIds).toHaveLength(0)
    expect(store.selectedArtboardId).toBeNull()
    expect(store.history).toHaveLength(0)
  })

  it('loadDocument drops dangling order refs and repairs artboard ids', () => {
    const { ab, path } = seedDocument(store)
    const doc = store.serializeDocument()
    // Corrupt: reference an object that is not in the map, and an object
    // pointing at a non-existent artboard.
    doc.objectOrder.push('ghost_object')
    doc.objects[path.id]!.artboardId = 'ghost_artboard'

    store.loadDocument(doc)
    expect(store.objectOrder).not.toContain('ghost_object')
    expect(store.objectOrder).toHaveLength(3)
    expect(store.objects[path.id]!.artboardId).toBeNull()
    // The valid artboard survives.
    expect(store.getArtboard(ab.id)).toBeTruthy()
  })

  it('loadDocument rejects a mismatched version', () => {
    const doc = store.serializeDocument()
    ;(doc as { version: number }).version = 999
    expect(() => store.loadDocument(doc)).toThrow(/version/i)
  })

  it('documentFilename is timestamped and .json', () => {
    const name = documentFilename(new Date(2026, 8, 3, 13, 30, 5))
    expect(name).toBe('logopacker-20260903-133005.json')
  })

  it('parseDocumentFile parses a valid file and rejects malformed JSON', async () => {
    const good = new File([JSON.stringify(store.serializeDocument())], 'doc.json', {
      type: 'application/json',
    })
    const parsed = await parseDocumentFile(good)
    expect(parsed.version).toBe(DOCUMENT_VERSION)

    const bad = new File(['{ not json'], 'bad.json', { type: 'application/json' })
    await expect(parseDocumentFile(bad)).rejects.toThrow(/JSON/i)
  })
})
