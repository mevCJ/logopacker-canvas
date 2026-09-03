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
      name: 'set_stroke',
      description: 'Sets the stroke color and/or width of objects, by ids or semanticRole.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          role: { type: 'string' },
          stroke: { type: 'string' },
          strokeWidth: { type: 'number' },
        },
      },
      execute({ ids, role, stroke, strokeWidth }: any = {}) {
        const targets = resolveTargets(store, { ids, role })
        if (!targets.length) return text('No matching objects for stroke.')
        targets.forEach((id) => store.setStroke(id, { stroke, strokeWidth }))
        log(`Set stroke on ${targets.length} object(s)`)
        return text({ updated: targets, stroke, strokeWidth })
      },
    },
    {
      name: 'set_opacity',
      description: 'Sets the opacity (0..1) of objects, by ids or semanticRole.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          role: { type: 'string' },
          opacity: { type: 'number' },
        },
        required: ['opacity'],
      },
      execute({ ids, role, opacity }: { ids?: string[]; role?: string; opacity: number }) {
        const targets = resolveTargets(store, { ids, role })
        if (!targets.length) return text('No matching objects for opacity.')
        targets.forEach((id) => store.setOpacity(id, opacity))
        log(`Set opacity ${opacity} on ${targets.length} object(s)`)
        return text({ updated: targets, opacity })
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
      name: 'recolor_role',
      description:
        'Recolors all objects of a semantic role to a single fill (e.g. recolor both logoSymbol and wordmark to black).',
      inputSchema: {
        type: 'object',
        properties: {
          roles: {
            type: 'array',
            items: { type: 'string' },
            description: 'One or more semantic roles, e.g. ["logoSymbol","wordmark"].',
          },
          fill: { type: 'string' },
        },
        required: ['roles', 'fill'],
      },
      execute({ roles = [], fill }: { roles?: string[]; fill: string }) {
        let count = 0
        for (const role of roles) {
          for (const o of store.findByRole(role)) {
            if (o.type !== 'image') {
              store.setFill(o.id, fill)
              count += 1
            }
          }
        }
        log(`Recolored ${count} object(s) to ${fill}`)
        return text({ recolored: count, fill })
      },
    },
    {
      name: 'copy_role_to_artboard',
      description:
        'Copies every object of a semantic role into a target artboard (preserving local position), optionally recoloring. Ideal for building logo variations like Black Logo or White Logo.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          targetArtboardId: { type: 'string' },
          sourceArtboardId: {
            type: 'string',
            description:
              'Optional: only copy objects of this role from this source artboard (e.g. the Primary Logo). Recommended to avoid copying earlier variations.',
          },
          recolorFill: { type: 'string' },
        },
        required: ['role', 'targetArtboardId'],
      },
      execute({ role, targetArtboardId, sourceArtboardId, recolorFill }: any = {}) {
        if (!store.getArtboard(targetArtboardId)) return text('Target artboard not found.')
        const ids = store.copyRoleToArtboard(role, targetArtboardId, { recolorFill, sourceArtboardId })
        log(`Copied ${role} to artboard`)
        return text({ ids })
      },
    },
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
