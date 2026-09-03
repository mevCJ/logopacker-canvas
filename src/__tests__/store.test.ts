import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'

describe('canvas store — core mutations', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('adds an artboard with defaults and unique id', () => {
    const ab = store.addArtboard({ name: 'Primary Logo' })
    expect(ab.id).toBeTruthy()
    expect(ab.name).toBe('Primary Logo')
    expect(ab.width).toBe(400)
    expect(store.artboards).toHaveLength(1)
  })

  it('adds an object, assigns id, and links to artboard', () => {
    const ab = store.addArtboard({})
    const obj = store.addObject({ type: 'path', d: 'M0 0 L10 10', artboardId: ab.id })
    expect(obj.id).toBeTruthy()
    expect(obj.type).toBe('path')
    expect(obj.artboardId).toBe(ab.id)
    expect(store.getArtboard(ab.id)!.objectIds).toContain(obj.id)
    expect(store.objectOrder).toContain(obj.id)
  })

  it('applies type-specific defaults', () => {
    store.addArtboard({})
    const text = store.addObject({ type: 'text' })
    expect((text as any).fontFamily).toBe('Inter')
    const path = store.addObject({ type: 'path' })
    expect((path as any).fill).toBe('#000000')
  })

  it('rejects unknown object type', () => {
    store.addArtboard({})
    expect(() => store.addObject({ type: 'bogus' as any })).toThrow()
  })

  it('updateObject merges fields but not id/type', () => {
    store.addArtboard({})
    const obj = store.addObject({ type: 'path' })
    store.updateObject(obj.id, { fill: '#FF0000', id: 'nope', type: 'text' })
    const after = store.getObject(obj.id)!
    expect((after as any).fill).toBe('#FF0000')
    expect(after.id).toBe(obj.id)
    expect(after.type).toBe('path')
  })

  it('removeObject unlinks from artboard, order, and selection', () => {
    const ab = store.addArtboard({})
    const obj = store.addObject({ type: 'path', artboardId: ab.id })
    store.selectObjects([obj.id])
    expect(store.removeObject(obj.id)).toBe(true)
    expect(store.getObject(obj.id)).toBeNull()
    expect(store.getArtboard(ab.id)!.objectIds).not.toContain(obj.id)
    expect(store.objectOrder).not.toContain(obj.id)
    expect(store.selectedIds).not.toContain(obj.id)
  })

  it('duplicateObject creates a new id offset from source', () => {
    const ab = store.addArtboard({})
    const obj = store.addObject({ type: 'path', x: 10, y: 10, artboardId: ab.id })
    const dup = store.duplicateObject(obj.id, { x: 20, y: 20 })!
    expect(dup.id).not.toBe(obj.id)
    expect(dup.x).toBe(30)
    expect(dup.artboardId).toBe(ab.id)
  })

  it('assignToArtboard reassigns linkage cleanly', () => {
    const a = store.addArtboard({})
    const b = store.addArtboard({})
    const obj = store.addObject({ type: 'path', artboardId: a.id })
    store.assignToArtboard(obj.id, b.id)
    expect(store.getArtboard(a.id)!.objectIds).not.toContain(obj.id)
    expect(store.getArtboard(b.id)!.objectIds).toContain(obj.id)
  })

  it('findByRole returns objects with matching semantic role', () => {
    store.addArtboard({})
    store.addObject({ type: 'path', semanticRole: 'logoSymbol' })
    store.addObject({ type: 'text', semanticRole: 'wordmark' })
    store.addObject({ type: 'text', semanticRole: 'wordmark' })
    expect(store.findByRole('logoSymbol')).toHaveLength(1)
    expect(store.findByRole('wordmark')).toHaveLength(2)
  })

  it('selectArtboard sets the artboard selection and clears object selection', () => {
    const ab = store.addArtboard({})
    const obj = store.addObject({ type: 'path', artboardId: ab.id })
    store.selectObjects([obj.id])
    store.selectArtboard(ab.id)
    expect(store.selectedArtboardId).toBe(ab.id)
    expect(store.selectedArtboard!.id).toBe(ab.id)
    expect(store.selectedIds).toEqual([])
  })

  it('selecting an object clears artboard selection (mutually exclusive)', () => {
    const ab = store.addArtboard({})
    const obj = store.addObject({ type: 'path', artboardId: ab.id })
    store.selectArtboard(ab.id)
    store.selectObjects([obj.id])
    expect(store.selectedArtboardId).toBeNull()
    expect(store.selectedIds).toEqual([obj.id])
  })

  it('selectArtboard ignores unknown ids and clearSelection clears both', () => {
    const ab = store.addArtboard({})
    store.selectArtboard('nope')
    expect(store.selectedArtboardId).toBeNull()
    store.selectArtboard(ab.id)
    store.clearSelection()
    expect(store.selectedArtboardId).toBeNull()
  })

  it('removeArtboard clears its selection', () => {
    const ab = store.addArtboard({})
    store.selectArtboard(ab.id)
    store.removeArtboard(ab.id)
    expect(store.selectedArtboardId).toBeNull()
  })

  it('updateArtboard changes size but not id/objectIds', () => {
    const ab = store.addArtboard({ width: 400, height: 300 })
    store.updateArtboard(ab.id, { width: 600, height: 500, id: 'nope' } as any)
    const after = store.getArtboard(ab.id)!
    expect(after.width).toBe(600)
    expect(after.height).toBe(500)
    expect(after.id).toBe(ab.id)
  })

  it('style helpers update fields', () => {
    store.addArtboard({})
    const p = store.addObject({ type: 'path' })
    store.setFill(p.id, '#123456')
    store.setStroke(p.id, { stroke: '#000', strokeWidth: 2 })
    store.setOpacity(p.id, 0.5)
    store.setPathData(p.id, 'M1 1')
    const after = store.getObject(p.id)! as any
    expect(after.fill).toBe('#123456')
    expect(after.stroke).toBe('#000')
    expect(after.strokeWidth).toBe(2)
    expect(after.opacity).toBe(0.5)
    expect(after.d).toBe('M1 1')
  })
})

describe('canvas store — undo + activity log', () => {
  let store: ReturnType<typeof useCanvasStore>
  let ab: ReturnType<typeof useCanvasStore>['artboards'][number]
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    ab = store.addArtboard({})
  })

  it('beginGroup snapshots once so a batch undoes as one action', () => {
    store.addObject({ type: 'path', artboardId: ab.id })
    store.beginGroup('Agent Changes')
    store.addArtboard({ name: 'Black Logo' })
    store.addObject({ type: 'path', artboardId: ab.id })
    expect(store.artboards).toHaveLength(2)
    const label = store.undo()
    expect(label).toBe('Agent Changes')
    expect(store.artboards).toHaveLength(1)
    expect(store.orderedObjects).toHaveLength(1)
  })

  it('activity log groups steps', () => {
    store.beginActivityGroup('Handoff')
    store.logStep('Inspected canvas')
    store.logStep('Found logo symbol')
    const g = store.activityLog[0]!
    expect(g.steps.map((s) => s.label)).toEqual(['Inspected canvas', 'Found logo symbol'])
    store.endActivityGroup({ status: 'done' })
    expect(store.activityLog[0]!.status).toBe('done')
    expect(store.currentGroup).toBeNull()
  })
})

describe('canvas store — resize + rotate', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    store.addArtboard({})
  })

  it('defaults baseWidth/baseHeight to the initial size', () => {
    const o = store.addObject({ type: 'path', width: 120, height: 80 }) as any
    expect(o.baseWidth).toBe(120)
    expect(o.baseHeight).toBe(80)
  })

  it('respects explicitly provided base dimensions', () => {
    const o = store.addObject({ type: 'image', width: 300, height: 200, baseWidth: 1200, baseHeight: 800 }) as any
    expect(o.baseWidth).toBe(1200)
    expect(o.baseHeight).toBe(800)
  })

  it('resizeObject updates x/y/width/height and clamps to >= 1', () => {
    const o = store.addObject({ type: 'path', x: 0, y: 0, width: 100, height: 100 })
    store.resizeObject(o.id, { x: 10, y: 20, width: 250, height: 0 })
    const after = store.getObject(o.id)! as any
    expect(after.x).toBe(10)
    expect(after.y).toBe(20)
    expect(after.width).toBe(250)
    expect(after.height).toBe(1)
    // Base dims are untouched by a resize.
    expect(after.baseWidth).toBe(100)
    expect(after.baseHeight).toBe(100)
  })

  it('rotateObject normalizes the angle into 0..360', () => {
    const o = store.addObject({ type: 'text' })
    expect((store.rotateObject(o.id, 45) as any).rotation).toBe(45)
    expect((store.rotateObject(o.id, 380) as any).rotation).toBe(20)
    expect((store.rotateObject(o.id, -90) as any).rotation).toBe(270)
  })
})

describe('canvas store — tool state', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  it('defaults to the select tool', () => {
    expect(store.activeTool).toBe('select')
    expect(store.pendingImage).toBeNull()
  })

  it('setActiveTool updates the active tool', () => {
    store.setActiveTool('rect')
    expect(store.activeTool).toBe('rect')
    store.setActiveTool('text')
    expect(store.activeTool).toBe('text')
  })

  it('setActiveTool falls back to select for unknown ids', () => {
    store.setActiveTool('bogus' as any)
    expect(store.activeTool).toBe('select')
  })

  it('setPendingImage stores and clears the staged image', () => {
    store.setPendingImage({ href: 'data:img', alt: 'x', width: 10, height: 20 })
    expect(store.pendingImage).toMatchObject({ href: 'data:img', width: 10, height: 20 })
    store.setPendingImage(null)
    expect(store.pendingImage).toBeNull()
  })

  it('setPendingImage ignores payloads without an href', () => {
    store.setPendingImage({ href: '' })
    expect(store.pendingImage).toBeNull()
  })

  it('switching away from the image tool discards the pending image', () => {
    store.setActiveTool('image')
    store.setPendingImage({ href: 'data:img' })
    store.setActiveTool('select')
    expect(store.pendingImage).toBeNull()
  })

  it('resetToolState returns to select with no pending image', () => {
    store.setActiveTool('image')
    store.setPendingImage({ href: 'data:img' })
    store.resetToolState()
    expect(store.activeTool).toBe('select')
    expect(store.pendingImage).toBeNull()
  })
})

describe('canvas store — artboard layout', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
  })

  function overlaps(a: any, b: any) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  }

  it('auto-placed artboards do not overlap', () => {
    const a = store.addArtboardAuto({ width: 400, height: 300 })
    const b = store.addArtboardAuto({ width: 500, height: 300 })
    expect(overlaps(a, b)).toBe(false)
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width)
  })

  it('arrangeArtboards lays out a grid without overlaps', () => {
    for (let i = 0; i < 5; i++) store.addArtboard({ width: 400, height: 300, x: 0, y: 0 })
    store.arrangeArtboards({ columns: 2, gap: 50 })
    for (let i = 0; i < store.artboards.length; i++) {
      for (let j = i + 1; j < store.artboards.length; j++) {
        expect(overlaps(store.artboards[i], store.artboards[j])).toBe(false)
      }
    }
  })
})

describe('canvas store — layering', () => {
  let store: ReturnType<typeof useCanvasStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCanvasStore()
    store.addArtboard({})
  })

  it('bringToFront moves the object to the end of paint order', () => {
    const a = store.addObject({ type: 'path' })
    const b = store.addObject({ type: 'path' })
    const c = store.addObject({ type: 'path' })
    expect(store.objectOrder).toEqual([a.id, b.id, c.id])
    expect(store.bringToFront(a.id)).toBe(true)
    expect(store.objectOrder).toEqual([b.id, c.id, a.id])
  })

  it('sendToBack moves the object to the start of paint order', () => {
    const a = store.addObject({ type: 'path' })
    const b = store.addObject({ type: 'path' })
    const c = store.addObject({ type: 'path' })
    expect(store.sendToBack(c.id)).toBe(true)
    expect(store.objectOrder).toEqual([c.id, a.id, b.id])
  })

  it('returns false for an unknown id and leaves order untouched', () => {
    const a = store.addObject({ type: 'path' })
    expect(store.bringToFront('nope')).toBe(false)
    expect(store.sendToBack('nope')).toBe(false)
    expect(store.objectOrder).toEqual([a.id])
  })
})
