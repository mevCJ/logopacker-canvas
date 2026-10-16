// WebMCP tools for the Illustrator-style design features: layers, outline
// view, Pathfinder / Shape Builder, Image Trace and type on a path. Registered
// as "extra tools" alongside the canvas tools. Each mirrors what the UI does,
// so agent and designer edits stay interchangeable (and undoable).
import type { CanvasStore, PathObject } from '@/stores/canvas'
import { text, type WebMcpToolDefinition, type ToolLogger } from './webmcp'
import {
  applyPathfinder,
  commitShapeBuilder,
  computeShapeRegions,
  replaceObjects,
  textPathGeometry,
  PATHFINDER_OPS,
  type PathfinderOp,
} from './pathBoolean'
import { vectorizeImageObject, VECTORIZE_DEFAULTS } from './vectorize'
import { normalizeGradient, withAngle } from './gradient'
import { CleanupSession, decodePhoto } from '@/services/capture/cleanupClient'
import { CLEANUP_DEFAULTS, type ColorFilter } from '@/services/capture/sketchCleanup'
import { placeSketch } from '@/services/capture/placeSketch'
import { openSketchDialog } from '@/services/capture/captureState'

export function buildDesignTools(
  store: CanvasStore,
  logger: ToolLogger = { step() {} },
): WebMcpToolDefinition[] {
  const log = (label: string, opts?: { status?: 'done' | 'running' | 'error' }) => {
    try {
      logger.step(label, opts)
    } catch {
      /* noop */
    }
  }

  const fail = (label: string, err: unknown) => {
    const msg = (err as Error)?.message || String(err)
    log(`${label} failed: ${msg}`, { status: 'error' })
    return text({ error: msg })
  }

  return [
    {
      name: 'set_view_mode',
      description:
        'Switches the canvas between "preview" (normal rendering) and "outline" (every object as a thin unfilled wireframe, to inspect construction and overlaps).',
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['preview', 'outline'] } },
        required: ['mode'],
      },
      execute({ mode }: { mode: 'preview' | 'outline' }) {
        const m = store.setViewMode(mode)
        log(`View mode: ${m}`)
        return text({ viewMode: m })
      },
    },
    {
      name: 'list_layers',
      description:
        'Lists objects front-to-back (layers panel order) with name, type, artboard, hidden, locked and opacity.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        const layers = [...store.orderedObjects].reverse().map((o, i) => ({
          index: store.objectOrder.length - 1 - i,
          id: o.id,
          name: o.name ?? null,
          type: o.type,
          semanticRole: o.semanticRole,
          artboardId: o.artboardId,
          hidden: !!o.hidden,
          locked: !!o.locked,
          opacity: o.opacity,
        }))
        return text({ layers, note: 'index is paint order: 0 = backmost.' })
      },
    },
    {
      name: 'update_layer',
      description:
        'Updates layer state of one object: rename, hide/show, lock/unlock, and/or move in paint order (exact index, 0 = backmost, or a step: forward/backward/front/back).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: 'Empty string clears a custom name.' },
          hidden: { type: 'boolean' },
          locked: { type: 'boolean' },
          index: { type: 'number' },
          move: { type: 'string', enum: ['forward', 'backward', 'front', 'back'] },
        },
        required: ['id'],
      },
      execute(input: {
        id: string
        name?: string
        hidden?: boolean
        locked?: boolean
        index?: number
        move?: 'forward' | 'backward' | 'front' | 'back'
      }) {
        const o = store.getObject(input.id)
        if (!o) return text({ error: `No object ${input.id}` })
        store.snapshot('Update layer')
        if (input.name !== undefined) store.renameObject(o.id, input.name)
        if (input.hidden !== undefined) store.setObjectHidden(o.id, input.hidden)
        if (input.locked !== undefined) store.setObjectLocked(o.id, input.locked)
        if (typeof input.index === 'number') store.reorderObject(o.id, input.index)
        if (input.move === 'forward') store.shiftObject(o.id, 1)
        if (input.move === 'backward') store.shiftObject(o.id, -1)
        if (input.move === 'front') store.bringToFront(o.id)
        if (input.move === 'back') store.sendToBack(o.id)
        log(`Updated layer ${o.name || o.id}`)
        return text({ id: o.id, name: o.name ?? null, hidden: !!o.hidden, locked: !!o.locked, index: store.objectOrder.indexOf(o.id) })
      },
    },
    {
      name: 'pathfinder',
      description:
        'Combines 2+ path objects into one. unite = merge all (front style); minusFront = backmost minus everything in front (back style); intersect = only the area all share; exclude = areas covered an odd number of times. Replaces the sources.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          op: { type: 'string', enum: [...PATHFINDER_OPS] },
        },
        required: ['ids', 'op'],
      },
      async execute({ ids, op }: { ids: string[]; op: PathfinderOp }) {
        store.snapshot(`Pathfinder ${op}`)
        try {
          const out = await applyPathfinder(store, ids, op)
          store.selectObjects(out)
          log(`Pathfinder ${op} → ${out.length} object(s)`)
          return text({ created: out })
        } catch (err) {
          store.undo()
          return fail('Pathfinder', err)
        }
      },
    },
    {
      name: 'shape_builder_regions',
      description:
        'Shape Builder step 1: splits the overlapping path objects into their distinct regions. Returns each region index with its canvas-space bounds, area and owning (frontmost covering) object. Use with shape_builder_apply.',
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' } } },
        required: ['ids'],
      },
      async execute({ ids }: { ids: string[] }) {
        try {
          const regions = await computeShapeRegions(store, ids)
          return text({
            regions: regions.map((r, index) => {
              const b = r.item.bounds
              return {
                index,
                ownerId: r.ownerId,
                bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
                area: Math.round(Math.abs((r.item as unknown as { area: number }).area)),
              }
            }),
          })
        } catch (err) {
          return fail('Shape builder', err)
        }
      },
    },
    {
      name: 'shape_builder_apply',
      description:
        'Shape Builder step 2: merges the given region indices (from shape_builder_regions, same ids) into one shape, or deletes them with erase=true. Untouched regions become separate shapes; the source objects are replaced.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          regions: { type: 'array', items: { type: 'number' } },
          erase: { type: 'boolean' },
        },
        required: ['ids', 'regions'],
      },
      async execute({ ids, regions: picked, erase = false }: { ids: string[]; regions: number[]; erase?: boolean }) {
        try {
          const regions = await computeShapeRegions(store, ids)
          const valid = picked.filter((i) => i >= 0 && i < regions.length)
          if (!valid.length) return text({ error: 'No valid region indices.' })
          store.snapshot(erase ? 'Shape builder erase' : 'Shape builder merge')
          const out = commitShapeBuilder(store, ids, regions, valid, erase)
          store.selectObjects(out)
          log(`Shape builder ${erase ? 'erased' : 'merged'} ${valid.length} region(s)`)
          return text({ created: out })
        } catch (err) {
          return fail('Shape builder', err)
        }
      },
    },
    {
      name: 'set_gradient_fill',
      description:
        'Gives paths/text a linear or radial gradient fill (replacing the solid fill), or removes it with clear=true. Stops are {offset 0-1, color (hex or rgba)}. Linear direction via angle in degrees (0 = left→right, 90 = top→bottom) or explicit x1,y1,x2,y2 in 0-1 bounding-box fractions; radial is centered on x1,y1 with radius to x2,y2.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          type: { type: 'string', enum: ['linear', 'radial'] },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              properties: { offset: { type: 'number' }, color: { type: 'string' } },
              required: ['offset', 'color'],
            },
          },
          angle: { type: 'number' },
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
          clear: { type: 'boolean' },
        },
        required: ['ids'],
      },
      execute(input: {
        ids: string[]
        type?: 'linear' | 'radial'
        stops?: { offset: number; color: string }[]
        angle?: number
        x1?: number
        y1?: number
        x2?: number
        y2?: number
        clear?: boolean
      }) {
        const targets = input.ids.map((id) => store.getObject(id)).filter((o) => !!o && o.type !== 'image')
        if (!targets.length) return text({ error: 'No path or text objects among ids.' })
        if (input.clear) {
          store.snapshot('Remove gradient')
          targets.forEach((o) => store.setFillGradient(o!.id, null))
          log(`Removed gradient from ${targets.length} object(s)`)
          return text({ updated: targets.map((o) => o!.id) })
        }
        let g = normalizeGradient({ ...input, type: input.type ?? 'linear' })
        if (!g) return text({ error: 'Need at least two valid stops ({offset, color}).' })
        if (g.type === 'linear' && typeof input.angle === 'number') g = withAngle(g, input.angle)
        store.snapshot('Gradient')
        targets.forEach((o) => store.setFillGradient(o!.id, g))
        log(`Applied ${g.type} gradient to ${targets.length} object(s)`)
        return text({ updated: targets.map((o) => o!.id), gradient: g })
      },
    },
    {
      name: 'vectorize_image',
      description:
        'Image Trace: converts an image object into editable vector paths laid over it (the image is hidden, not deleted). Fewer colors give a flatter, logo-like result.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          colors: { type: 'number', description: `Palette size 2-16 (default ${VECTORIZE_DEFAULTS.colors}).` },
          detail: { type: 'number', description: `0 smooth .. 1 detailed (default ${VECTORIZE_DEFAULTS.detail}).` },
          removeWhite: { type: 'boolean', description: 'Drop near-white background shapes (default true).' },
        },
        required: ['id'],
      },
      async execute({ id, colors, detail, removeWhite }: { id: string; colors?: number; detail?: number; removeWhite?: boolean }) {
        store.snapshot('Vectorize')
        try {
          const out = await vectorizeImageObject(store, id, { colors, detail, removeWhite })
          store.selectObjects(out)
          log(`Vectorized image into ${out.length} path(s)`)
          return text({ created: out, hiddenImage: id })
        } catch (err) {
          store.undo()
          return fail('Vectorize', err)
        }
      },
    },
    {
      name: 'capture_sketch_from_phone',
      description:
        'Opens the phone capture dialog (QR code) so the designer can photograph a paper sketch with their phone. The designer finishes cleanup and placement in the dialog; nothing is returned to the agent.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        openSketchDialog()
        log('Opened phone sketch capture')
        return text({ opened: true, note: 'The designer completes capture and cleanup in the dialog.' })
      },
    },
    {
      name: 'clean_up_sketch',
      description:
        'Cleans a photographed sketch already on the canvas (an image object): straightens the paper (auto-detected), removes shadows/glare, smooths paper texture, optionally drops colored lines and screen moiré, then binarizes to black on white. Places the result over the original (which is hidden), traced to vector paths when vectorize=true.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Image object id.' },
          vectorize: { type: 'boolean', description: 'Trace into black vector paths (default true).' },
          straighten: { type: 'boolean', description: 'Auto-detect and straighten the paper (default true).' },
          colorFilter: { type: 'string', enum: ['none', 'darkInk', 'removeBlue', 'removeRed'] },
          moire: { type: 'boolean' },
          removeShadows: { type: 'boolean' },
          smoothing: { type: 'number', description: '0-1' },
          sensitivity: { type: 'number', description: '0-1, higher keeps fainter strokes' },
          despeckle: { type: 'number', description: '0-1' },
          strokeAdjust: { type: 'number', description: '-2..2 thin/thicken strokes' },
        },
        required: ['id'],
      },
      async execute(input: {
        id: string
        vectorize?: boolean
        straighten?: boolean
        colorFilter?: ColorFilter
        moire?: boolean
        removeShadows?: boolean
        smoothing?: number
        sensitivity?: number
        despeckle?: number
        strokeAdjust?: number
      }) {
        const img = store.getObject(input.id)
        if (!img || img.type !== 'image') return text({ error: `No image object ${input.id}` })
        const session = new CleanupSession()
        try {
          const photo = await decodePhoto(await (await fetch(img.href)).blob())
          const corners = await session.load(photo)
          const { id: _id, vectorize = true, straighten = true, ...rest } = input
          const r = await session.process({
            ...CLEANUP_DEFAULTS,
            ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
            corners: straighten ? corners : null,
          })
          if (!r) return text({ error: 'Cleanup was interrupted.' })
          const cv = document.createElement('canvas')
          cv.width = r.image.width
          cv.height = r.image.height
          cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.image.data), r.image.width, r.image.height), 0, 0)
          const ids = await placeSketch(store, {
            dataUrl: cv.toDataURL('image/png'),
            width: r.image.width,
            height: r.image.height,
            vectorize,
            replaceImageId: img.id,
          })
          log(`Cleaned up sketch → ${ids.length} object(s)`)
          return text({ created: ids, hiddenImage: img.id, straightened: !!(straighten && corners) })
        } catch (err) {
          return fail('Clean up sketch', err)
        } finally {
          session.dispose()
        }
      },
    },
    {
      name: 'text_on_path',
      description:
        'Type on a path: converts a path object into the guide of a new text object whose glyphs flow along it (e.g. curved/circular wordmarks). The path is replaced by the text.',
      inputSchema: {
        type: 'object',
        properties: {
          pathId: { type: 'string' },
          text: { type: 'string' },
          fontSize: { type: 'number' },
          fontFamily: { type: 'string' },
          fontWeight: { type: 'number' },
          fill: { type: 'string' },
          offset: { type: 'number', description: 'Start offset along the path, percent 0-100.' },
        },
        required: ['pathId', 'text'],
      },
      async execute(input: {
        pathId: string
        text: string
        fontSize?: number
        fontFamily?: string
        fontWeight?: number
        fill?: string
        offset?: number
      }) {
        const path = store.getObject(input.pathId)
        if (!path || path.type !== 'path') return text({ error: `No path object ${input.pathId}` })
        try {
          const geo = await textPathGeometry(store, path as PathObject)
          store.snapshot('Type on path')
          const [id] = replaceObjects(store, [path.id], [
            {
              type: 'text',
              text: input.text,
              pathD: geo.pathD,
              pathOffset: input.offset ?? 0,
              x: geo.x,
              y: geo.y,
              width: geo.width,
              height: geo.height,
              fontSize: input.fontSize,
              fontFamily: input.fontFamily,
              fontWeight: input.fontWeight,
              fill: input.fill,
              artboardId: path.artboardId,
              semanticRole: 'wordmark',
            },
          ])
          log(`Set "${input.text}" on a path`)
          return text({ id })
        } catch (err) {
          return fail('Text on path', err)
        }
      },
    },
  ]
}
