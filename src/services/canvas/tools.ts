// WebMCP tool layer for the agent-native canvas.
//
// Tools are registered via `document.modelContext.registerTool(...)`. Each
// tool's execute() maps to a Pinia store action (the source of truth), appends
// a step to the agent activity log, and returns { content: [{ type, text }] }.
import type { CanvasStore, CanvasObject, Artboard } from '@/stores/canvas'
import { text, type WebMcpToolDefinition, type ToolLogger } from './webmcp'

/* eslint-disable @typescript-eslint/no-explicit-any */

function objView(o: CanvasObject | null): Record<string, unknown> | null {
  if (!o) return null
  const base: Record<string, unknown> = {
    id: o.id,
    type: o.type,
    semanticRole: o.semanticRole,
    artboardId: o.artboardId,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    opacity: o.opacity,
  }
  if (o.type === 'path') {
    base.fill = o.fill
    base.stroke = o.stroke
    base.strokeWidth = o.strokeWidth
  } else if (o.type === 'text') {
    base.text = o.text
    base.fontFamily = o.fontFamily
    base.fontSize = o.fontSize
    base.fontWeight = o.fontWeight
    base.fill = o.fill
    base.align = o.align
  } else if (o.type === 'image') {
    base.href = o.href
    base.alt = o.alt
  }
  return base
}

function artboardView(a: Artboard | null): Record<string, unknown> | null {
  if (!a) return null
  return {
    id: a.id,
    name: a.name,
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    backgroundColor: a.backgroundColor,
    objectIds: [...a.objectIds],
    objectCount: a.objectIds.length,
  }
}

function resolveTargets(store: CanvasStore, { ids, role }: { ids?: string[]; role?: string }): string[] {
  if (Array.isArray(ids) && ids.length) return ids.filter((id) => !!store.getObject(id))
  if (role) return store.findByRole(role).map((o) => o.id)
  return []
}

// Which properties are readable/writable, keyed by object type. This is the
// single source of truth the generic get/set_object_properties tools use to
// validate keys, so adding a property to a type here (plus the store) makes it
// agent-editable without a new tool.
const COMMON_PROPS = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'opacity',
  'semanticRole',
  'artboardId',
] as const

const TYPE_PROPS: Record<string, readonly string[]> = {
  path: ['d', 'fill', 'stroke', 'strokeWidth', 'cornerRadius'],
  text: ['text', 'fontFamily', 'fontSize', 'fontWeight', 'fill', 'align'],
  image: ['href', 'sourceUrl', 'alt'],
}

// The set of property names editable for a given object type. `cornerRadius` is
// only meaningful for rectangle-shaped paths.
function editableProps(o: CanvasObject): string[] {
  const typeProps = (TYPE_PROPS[o.type] || []).filter((p) => {
    if (p === 'cornerRadius') return o.type === 'path' && (o as any).shape === 'rect'
    return true
  })
  return [...COMMON_PROPS, ...typeProps]
}

// Read the current values of a single object's editable properties.
function readProps(o: CanvasObject): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of editableProps(o)) out[key] = (o as any)[key]
  return out
}

// Apply a property patch to one object, keeping only keys valid for its type.
// cornerRadius routes through setCornerRadius so the path `d` is regenerated;
// everything else goes through updateObject. Returns the applied keys.
function applyProps(
  store: CanvasStore,
  o: CanvasObject,
  properties: Record<string, unknown>,
): string[] {
  const allowed = new Set(editableProps(o))
  const patch: Record<string, unknown> = {}
  const applied: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || !allowed.has(key)) continue
    if (key === 'cornerRadius') {
      store.setCornerRadius(o.id, Number(value))
      applied.push(key)
      continue
    }
    patch[key] = value
    applied.push(key)
  }
  if (Object.keys(patch).length) store.updateObject(o.id, patch)
  return applied
}

export function buildCanvasTools(
  store: CanvasStore,
  logger: ToolLogger = { step() {} },
): WebMcpToolDefinition[] {
  const log = (label: string, opts?: { status?: 'done' | 'running' | 'error' }) => {
    try {
      logger.step(label, opts)
    } catch {
      /* logging must never break a tool */
    }
  }

  return [
    // ---- Canvas inspection -------------------------------------------------
    {
      name: 'inspect_canvas',
      description:
        'Returns an overview of the whole canvas: all artboards (id, name, size, position, object count) and total object count. Use this first to understand what exists.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        log('Inspected canvas')
        const artboards = store.artboards.map((a) => artboardView(a))
        return text({ artboards, totalObjects: store.objectOrder.length })
      },
    },
    {
      name: 'inspect_artboard',
      description: 'Returns details of a single artboard and the objects it contains (compact views).',
      inputSchema: {
        type: 'object',
        properties: { artboardId: { type: 'string', description: 'The artboard id.' } },
        required: ['artboardId'],
      },
      execute({ artboardId }: { artboardId: string }) {
        const a = store.getArtboard(artboardId)
        if (!a) return text(`No artboard with id ${artboardId}`)
        log(`Inspected artboard "${a.name}"`)
        const objects = a.objectIds.map((id) => objView(store.getObject(id))).filter(Boolean)
        return text({ artboard: artboardView(a), objects })
      },
    },
    {
      name: 'list_objects',
      description:
        'Lists objects on the canvas as compact views. Optionally filter by artboardId, semanticRole, or type.',
      inputSchema: {
        type: 'object',
        properties: {
          artboardId: { type: 'string' },
          role: { type: 'string', description: 'Semantic role, e.g. logoSymbol or wordmark.' },
          type: { type: 'string', enum: ['path', 'text', 'image'] },
        },
      },
      execute({ artboardId, role, type }: { artboardId?: string; role?: string; type?: string } = {}) {
        let objs = store.orderedObjects
        if (artboardId) objs = objs.filter((o) => o.artboardId === artboardId)
        if (role) objs = objs.filter((o) => o.semanticRole === role)
        if (type) objs = objs.filter((o) => o.type === type)
        log('Listed objects')
        return text({ objects: objs.map(objView) })
      },
    },
    {
      name: 'get_object',
      description:
        'Returns the full compact view of a single object by id, including path data (d) for path objects.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute({ id }: { id: string }) {
        const o = store.getObject(id)
        if (!o) return text(`No object with id ${id}`)
        const view = objView(o) as Record<string, unknown>
        if (o.type === 'path') view.d = o.d
        return text(view)
      },
    },
    {
      name: 'inspect_path',
      description:
        'Returns the vector path details of a path object: raw path data (d), fill, stroke, strokeWidth, opacity, semanticRole, and position.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute({ id }: { id: string }) {
        const o = store.getObject(id)
        if (!o) return text(`No object with id ${id}`)
        if (o.type !== 'path') return text(`Object ${id} is not a path (type=${o.type}).`)
        log('Inspected path')
        return text({
          id: o.id,
          semanticRole: o.semanticRole,
          d: o.d,
          fill: o.fill,
          stroke: o.stroke,
          strokeWidth: o.strokeWidth,
          opacity: o.opacity,
          x: o.x,
          y: o.y,
        })
      },
    },

    // ---- Selection ---------------------------------------------------------
    {
      name: 'get_selection',
      description:
        'Returns what the human currently has selected on the canvas: the selected object ids and their compact views, or the selected artboard (object and artboard selection are mutually exclusive). Use this to resolve references like "this", "the selected shape", or "make it blue" to concrete object ids.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        log('Read selection')
        const objects = store.selectedObjects.map(objView)
        const artboard = store.selectedArtboard ? artboardView(store.selectedArtboard) : null
        return text({
          objectIds: [...store.selectedIds],
          objects,
          artboardId: store.selectedArtboardId,
          artboard,
        })
      },
    },
    {
      name: 'select_objects',
      description:
        'Selects objects on the canvas so the human can see what the agent is working on. Provide ids or a semanticRole.',
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' } }, role: { type: 'string' } },
      },
      execute({ ids, role }: { ids?: string[]; role?: string } = {}) {
        const targets = resolveTargets(store, { ids, role })
        store.selectObjects(targets)
        log(`Selected ${targets.length} object(s)`)
        return text({ selected: targets })
      },
    },

    // ---- Artboards ---------------------------------------------------------
    {
      name: 'create_artboard',
      description:
        'Creates a new artboard, auto-placed neatly to the right of existing artboards unless x/y are given. Returns the new artboard.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          backgroundColor: { type: 'string' },
        },
      },
      execute(payload: any = {}) {
        const a = store.addArtboardAuto(payload)
        log(`Created ${a.name}`)
        return text({ artboard: artboardView(a) })
      },
    },

    // ---- Object mutations --------------------------------------------------
    {
      name: 'duplicate_object',
      description:
        'Duplicates an object (optionally into a target artboard) with an offset. Returns the new object id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          artboardId: { type: 'string', description: 'Optional target artboard for the copy.' },
          offsetX: { type: 'number' },
          offsetY: { type: 'number' },
        },
        required: ['id'],
      },
      execute({ id, artboardId, offsetX = 0, offsetY = 0 }: any = {}) {
        const src = store.getObject(id)
        if (!src) return text(`No object with id ${id}`)
        const dup = store.duplicateObject(id, { x: offsetX, y: offsetY })
        if (!dup) return text(`Could not duplicate ${id}`)
        if (artboardId && store.getArtboard(artboardId)) {
          store.assignToArtboard(dup.id, artboardId)
        }
        log('Duplicated object')
        return text({ id: dup.id, artboardId: dup.artboardId })
      },
    },
    {
      name: 'delete_object',
      description: 'Deletes an object by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute({ id }: { id: string }) {
        const ok = store.removeObject(id)
        log('Deleted object')
        return text({ deleted: ok })
      },
    },
    {
      name: 'move_object',
      description:
        'Moves an object to a new local position (x, y) within its artboard, or by a relative delta (dx, dy).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          dx: { type: 'number' },
          dy: { type: 'number' },
        },
        required: ['id'],
      },
      execute({ id, x, y, dx, dy }: any = {}) {
        const o = store.getObject(id)
        if (!o) return text(`No object with id ${id}`)
        const nx = typeof x === 'number' ? x : (o.x || 0) + (dx || 0)
        const ny = typeof y === 'number' ? y : (o.y || 0) + (dy || 0)
        store.moveObject(id, { x: nx, y: ny })
        log('Moved object')
        return text({ id, x: nx, y: ny })
      },
    },
    {
      name: 'set_fill',
      description:
        'Sets the fill color of one or more objects. Target by ids or by semanticRole (e.g. role="logoSymbol").',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          role: { type: 'string' },
          fill: { type: 'string', description: 'CSS color, e.g. #000000.' },
        },
        required: ['fill'],
      },
      execute({ ids, role, fill }: { ids?: string[]; role?: string; fill: string }) {
        const targets = resolveTargets(store, { ids, role })
        if (!targets.length) return text('No matching objects to fill.')
        targets.forEach((id) => store.setFill(id, fill))
        log(`Set fill ${fill} on ${targets.length} object(s)`)
        return text({ updated: targets, fill })
      },
    },
    {
      name: 'get_object_properties',
      description:
        'Returns the current values of every editable property for an object, plus the list of property names you may set for that object type. Call this before set_object_properties so you know which keys are valid. ' +
        'Common (all types): x, y, width, height, rotation, opacity, semanticRole, artboardId. ' +
        'path: d, fill, stroke, strokeWidth, cornerRadius (rectangles only). ' +
        'text: text, fontFamily, fontSize, fontWeight, fill, align. ' +
        'image: href, sourceUrl, alt.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute({ id }: { id: string }) {
        const o = store.getObject(id)
        if (!o) return text(`No object with id ${id}`)
        log('Read object properties')
        return text({ id: o.id, type: o.type, editable: editableProps(o), properties: readProps(o) })
      },
    },
    {
      name: 'set_object_properties',
      description:
        'Sets any editable properties on one or more objects, targeted by ids or semanticRole. Pass a `properties` object with the keys to change; only keys valid for each object type are applied (unknown/invalid keys are ignored). Use get_object_properties first to see which keys are valid. ' +
        'Common (all types): x, y, width, height, rotation, opacity, semanticRole, artboardId. ' +
        'path: d, fill, stroke, strokeWidth, cornerRadius (rectangles only, regenerates the path). ' +
        'text: text, fontFamily, fontSize, fontWeight, fill, align. ' +
        'image: href, sourceUrl, alt.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          role: { type: 'string', description: 'Semantic role, e.g. logoSymbol.' },
          properties: {
            type: 'object',
            description: 'Property key/value pairs to set. Keys are validated per object type.',
          },
        },
        required: ['properties'],
      },
      execute({ ids, role, properties }: { ids?: string[]; role?: string; properties?: Record<string, unknown> } = {}) {
        const targets = resolveTargets(store, { ids, role })
        if (!targets.length) return text('No matching objects.')
        if (!properties || typeof properties !== 'object') return text('Provide a `properties` object.')
        const results: Array<{ id: string; applied: string[] }> = []
        for (const id of targets) {
          const o = store.getObject(id)
          if (!o) continue
          results.push({ id, applied: applyProps(store, o, properties) })
        }
        const keys = [...new Set(results.flatMap((r) => r.applied))]
        log(`Set ${keys.join(', ') || 'no'} propert${keys.length === 1 ? 'y' : 'ies'} on ${results.length} object(s)`)
        return text({ updated: results })
      },
    },
    {
      name: 'set_path_data',
      description:
        'Replaces the vector path data (d attribute) of a path object. Use inspect_path first to read the current d.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, d: { type: 'string', description: 'New SVG path data.' } },
        required: ['id', 'd'],
      },
      execute({ id, d }: { id: string; d: string }) {
        const o = store.setPathData(id, d)
        if (!o) return text(`Object ${id} is not a path or does not exist.`)
        log('Edited path data')
        return text({ id, updated: true })
      },
    },

    // ---- Request bracketing (undo grouping + activity group) --------------
    {
      name: 'begin_agent_request',
      description:
        'Call this FIRST at the start of a multi-step task. It snapshots the canvas so the entire request can be reverted with a single "Undo Agent Changes", and opens an activity group for progress. Pass a short title.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Short title of the request.' } },
      },
      execute({ title = 'Agent changes' }: { title?: string } = {}) {
        store.beginGroup(title)
        store.beginActivityGroup(title)
        return text({ started: true, title })
      },
    },
    {
      name: 'end_agent_request',
      description:
        'Call this LAST when a multi-step task is complete. Marks the activity group done. Optionally arranges all artboards into a tidy grid.',
      inputSchema: {
        type: 'object',
        properties: { arrange: { type: 'boolean' }, columns: { type: 'number' } },
      },
      execute({ arrange = false, columns = 3 }: { arrange?: boolean; columns?: number } = {}) {
        if (arrange) {
          store.arrangeArtboards({ columns })
          log('Arranged artboards')
        }
        store.endActivityGroup({ status: 'done' })
        return text({ ended: true })
      },
    },

    // ---- Composite design helpers -----------------------------------------
    {
      name: 'center_object',
      description:
        'Centers an object horizontally and/or vertically within its artboard. Provide objWidth/objHeight for paths if known.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          horizontal: { type: 'boolean' },
          vertical: { type: 'boolean' },
          objWidth: { type: 'number' },
          objHeight: { type: 'number' },
        },
        required: ['id'],
      },
      execute({ id, horizontal = true, vertical = false, objWidth, objHeight }: any = {}) {
        const o = store.centerObjectInArtboard(id, { horizontal, vertical, objWidth, objHeight })
        if (!o) return text(`Cannot center object ${id}.`)
        log('Centered object')
        return text({ id, x: o.x, y: o.y })
      },
    },
    {
      name: 'arrange_artboards',
      description: 'Arranges all artboards into a tidy grid for a clean presentation.',
      inputSchema: {
        type: 'object',
        properties: { columns: { type: 'number' }, gap: { type: 'number' } },
      },
      execute({ columns = 3, gap = 80 }: { columns?: number; gap?: number } = {}) {
        store.arrangeArtboards({ columns, gap })
        log('Arranged artboards')
        return text({ arranged: true, columns })
      },
    },
  ]
}

export interface RegisterOptions {
  logger?: ToolLogger
  extraTools?: (store: CanvasStore, logger: ToolLogger) => WebMcpToolDefinition[]
}

// Register all canvas tools with document.modelContext. Returns an unregister fn.
export function registerCanvasTools(store: CanvasStore, options: RegisterOptions = {}): () => void {
  const logger: ToolLogger =
    options.logger || { step: (label, opts) => store.logStep(label, opts) }

  if (typeof document === 'undefined' || !document.modelContext || !document.modelContext.registerTool) {
    console.warn('[canvas tools] document.modelContext unavailable — tools not registered.')
    return () => {}
  }

  const controller = new AbortController()
  const tools = buildCanvasTools(store, logger)
  const extra = options.extraTools ? options.extraTools(store, logger) : []
  const all = [...tools, ...extra]

  for (const tool of all) {
    try {
      document.modelContext.registerTool(tool, { signal: controller.signal })
    } catch (e) {
      console.warn('[canvas tools] failed to register', tool.name, (e as Error)?.message)
    }
  }

  return () => controller.abort()
}

export const __internals = { objView, artboardView, resolveTargets, text }
