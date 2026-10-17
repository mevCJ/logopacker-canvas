import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'

let store: ReturnType<typeof useCanvasStore>
const sq = (name: string, extra: Record<string, unknown> = {}) =>
  store.addObject({ type: 'path', d: 'M0 0 H10 V10 H0 Z', width: 10, height: 10, name, ...extra })

beforeEach(() => {
  setActivePinia(createPinia())
  store = useCanvasStore()
})

describe('layers', () => {
  it('puts artwork into the active layer, creating Layer 1 on first use', () => {
    const a = sq('a')
    expect(store.layers.map((l) => l.name)).toEqual(['Layer 1'])
    expect(a.layerId).toBe(store.activeLayerId)
    const top = store.addLayer()
    const b = sq('b')
    expect(b.layerId).toBe(top.id)
    expect(store.layers).toHaveLength(2)
  })

  it('keeps paint order grouped by layer', () => {
    const base = store.ensureActiveLayer()
    const a = sq('a')
    const top = store.addLayer()
    const b = sq('b')
    store.setActiveLayer(base.id)
    const c = sq('c')
    // c was added last but its layer is below b's.
    expect(store.objectOrder).toEqual([a.id, c.id, b.id])
    store.bringToFront(a.id)
    expect(store.objectOrder).toEqual([c.id, a.id, b.id])
    store.moveLayer(top.id, 0)
    expect(store.objectOrder).toEqual([b.id, c.id, a.id])
  })

  it('moves objects between layers', () => {
    const a = sq('a')
    const top = store.addLayer()
    const b = sq('b')
    store.moveObjectsToLayer([a.id], top.id)
    expect(store.getObject(a.id)!.layerId).toBe(top.id)
    // Moved artwork lands on top of the layer.
    expect(store.objectOrder).toEqual([b.id, a.id])
  })

  it('hides and locks everything in a layer', () => {
    const a = sq('a')
    const layer = store.layerOf(a)!
    store.selectObjects([a.id])
    store.setLayerHidden(layer.id, true)
    expect(store.selectedIds).toEqual([])
    expect(store.isHidden(a)).toBe(true)
    expect(store.renderObjects()[a.id]!.hidden).toBe(true)
    // The object's own flag is untouched.
    expect(store.getObject(a.id)!.hidden).toBeFalsy()
    store.setLayerHidden(layer.id, false)
    store.setLayerLocked(layer.id, true)
    expect(store.selectObjects([a.id])).toEqual([])
  })

  it('deletes a layer with its artwork but never the last one', () => {
    const a = sq('a')
    const first = store.layerOf(a)!
    expect(store.removeLayer(first.id)).toBe(false)
    const top = store.addLayer()
    sq('b')
    expect(store.removeLayer(top.id)).toBe(true)
    expect(store.objectOrder).toEqual([a.id])
    expect(store.activeLayerId).toBe(first.id)
  })

  it('round-trips through save and undo, and upgrades old documents', () => {
    sq('a')
    const top = store.addLayer('Ink')
    sq('b')
    const doc = store.serializeDocument()
    store.loadDocument(doc)
    expect(store.layers.map((l) => l.name)).toEqual(['Layer 1', 'Ink'])
    store.snapshot('x')
    store.addLayer()
    store.undo()
    expect(store.layers.map((l) => l.id)).toContain(top.id)
    expect(store.layers).toHaveLength(2)
    // A document from before layers: everything lands in one layer.
    const old = { ...doc, layers: undefined, groups: undefined }
    for (const o of Object.values(old.objects)) delete (o as { layerId?: string }).layerId
    store.loadDocument(old)
    expect(store.layers).toHaveLength(1)
    expect(Object.values(store.objects).every((o) => o.layerId === store.layers[0]!.id)).toBe(true)
  })
})

describe('groups', () => {
  it('groups objects contiguously at the frontmost member', () => {
    const a = sq('a')
    const x = sq('x')
    const b = sq('b')
    const gid = store.groupObjects([a.id, b.id])!
    expect(store.objectOrder).toEqual([x.id, a.id, b.id])
    expect(store.groupMembers(gid)).toEqual([a.id, b.id])
    // Any member widens to the whole group.
    expect(store.expandToGroups([a.id])).toEqual([a.id, b.id])
    expect(store.groupObjects([a.id])).toBeNull()
  })

  it('nests groups and ungroups one level at a time', () => {
    const a = sq('a')
    const b = sq('b')
    const c = sq('c')
    const inner = store.groupObjects([a.id, b.id])!
    const outer = store.groupObjects([a.id, c.id])!
    expect(store.groups[inner]!.parentId).toBe(outer)
    expect(store.topGroupOf(a.id)).toBe(outer)
    expect(store.expandToGroups([c.id])).toEqual([a.id, b.id, c.id])
    store.ungroupObjects([c.id])
    expect(store.groups[outer]).toBeUndefined()
    expect(store.topGroupOf(a.id)).toBe(inner)
    expect(store.topGroupOf(c.id)).toBeNull()
  })

  it("brings members into the frontmost member's layer", () => {
    const a = sq('a')
    const top = store.addLayer()
    const b = sq('b')
    store.groupObjects([a.id, b.id])
    expect(store.getObject(a.id)!.layerId).toBe(top.id)
  })

  it('duplicating a whole group makes a new group', () => {
    const a = sq('a')
    const b = sq('b')
    const gid = store.groupObjects([a.id, b.id])!
    const copies = store.duplicateObjects([a.id, b.id])
    expect(copies).toHaveLength(2)
    expect(copies[0]!.groupId).toBeDefined()
    expect(copies[0]!.groupId).not.toBe(gid)
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId)
  })

  it('drops a group once its members are deleted', () => {
    const a = sq('a')
    const b = sq('b')
    const gid = store.groupObjects([a.id, b.id])!
    store.removeObject(a.id)
    store.removeObject(b.id)
    expect(store.groups[gid]).toBeUndefined()
  })

  it('relocates an object into a group and to another layer', () => {
    const a = sq('a')
    const b = sq('b')
    const gid = store.groupObjects([a.id, b.id])!
    const c = sq('c')
    expect(store.relocate({ kind: 'object', id: c.id }, { kind: 'object', id: a.id }, true)).toBe(true)
    expect(store.getObject(c.id)!.groupId).toBe(gid)
    expect(store.objectOrder).toEqual([a.id, c.id, b.id])
    const top = store.addLayer()
    store.relocate({ kind: 'group', id: gid }, { kind: 'layer', id: top.id })
    expect(store.groupMembers(gid).every((m) => store.getObject(m)!.layerId === top.id)).toBe(true)
  })
})
