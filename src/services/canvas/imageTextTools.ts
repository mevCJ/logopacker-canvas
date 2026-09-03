// WebMCP tools for typography and images. Registered as "extra tools" alongside
// the canvas/object tools. search_pexels calls the Worker proxy at
// /api/pexels/search so the API key stays server-side.
import type { CanvasStore } from '@/stores/canvas'
import { text, type WebMcpToolDefinition, type ToolLogger } from './webmcp'

/* eslint-disable @typescript-eslint/no-explicit-any */

async function httpGetJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

export interface ImageTextDeps {
  fetchJson?: (url: string) => Promise<any>
}

export function buildImageTextTools(
  store: CanvasStore,
  logger: ToolLogger = { step() {} },
  deps: ImageTextDeps = {},
): WebMcpToolDefinition[] {
  const log = (label: string, opts?: { status?: 'done' | 'running' | 'error' }) => {
    try {
      logger.step(label, opts)
    } catch {
      /* noop */
    }
  }
  const fetchJson = deps.fetchJson || ((url: string) => httpGetJson(url))

  return [
    // ---- Typography --------------------------------------------------------
    {
      name: 'add_text',
      description:
        'Adds a text object to an artboard. Provide the text content, target artboardId, position (x,y local to the artboard), and optional typography + semanticRole (e.g. headline, bodyText, wordmark).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          artboardId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          fontFamily: { type: 'string' },
          fontSize: { type: 'number' },
          fontWeight: { type: 'number' },
          fill: { type: 'string' },
          align: { type: 'string', enum: ['left', 'center', 'right'] },
          semanticRole: { type: 'string' },
        },
        required: ['text'],
      },
      execute(payload: any = {}) {
        const obj = store.addObject({
          type: 'text',
          text: payload.text,
          artboardId: payload.artboardId,
          x: payload.x ?? 0,
          y: payload.y ?? 0,
          fontFamily: payload.fontFamily,
          fontSize: payload.fontSize,
          fontWeight: payload.fontWeight,
          fill: payload.fill,
          align: payload.align,
          semanticRole: payload.semanticRole || 'bodyText',
        })
        log(`Added text “${payload.text}”`)
        return text({ id: obj.id, artboardId: obj.artboardId })
      },
    },
    {
      name: 'set_typography',
      description:
        'Updates typography of one or more text objects (by ids or semanticRole): fontFamily, fontSize, fontWeight, fill, align, and/or text content.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          role: { type: 'string' },
          text: { type: 'string' },
          fontFamily: { type: 'string' },
          fontSize: { type: 'number' },
          fontWeight: { type: 'number' },
          fill: { type: 'string' },
          align: { type: 'string', enum: ['left', 'center', 'right'] },
        },
      },
      execute({ ids, role, ...typography }: any = {}) {
        let targets: string[] = []
        if (Array.isArray(ids) && ids.length) targets = ids.filter((id: string) => store.getObject(id))
        else if (role) targets = store.findByRole(role).map((o) => o.id)
        targets = targets.filter((id) => store.getObject(id)?.type === 'text')
        if (!targets.length) return text('No matching text objects.')
        const patch: Record<string, unknown> = {}
        for (const k of ['text', 'fontFamily', 'fontSize', 'fontWeight', 'fill', 'align']) {
          if (typography[k] !== undefined) patch[k] = typography[k]
        }
        targets.forEach((id) => store.updateObject(id, patch))
        log(`Updated typography on ${targets.length} text object(s)`)
        return text({ updated: targets, patch })
      },
    },

    // ---- Images ------------------------------------------------------------
    {
      name: 'search_pexels',
      description:
        'Searches Pexels for photos matching a natural-language description. Returns an array of results (id, alt, thumb, src, width, height). Review the results, choose one, then call add_image.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language image description.' },
          perPage: { type: 'number', description: 'How many results (1-24).' },
          orientation: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
        },
        required: ['query'],
      },
      async execute({ query, perPage = 8, orientation }: any = {}) {
        log(`Searching Pexels for “${query}”`, { status: 'running' })
        const params = new URLSearchParams({ query: String(query), perPage: String(perPage) })
        if (orientation) params.set('orientation', orientation)
        let data: any
        try {
          data = await fetchJson(`/api/pexels/search?${params.toString()}`)
        } catch (e) {
          log('Pexels search failed', { status: 'error' })
          return text(`Pexels search failed: ${(e as Error)?.message || 'unknown error'}`)
        }
        const results = (data && data.results) || []
        log(`Found ${results.length} image(s) for “${query}”`)
        return text({ query, total: data?.total ?? results.length, results })
      },
    },
    {
      name: 'add_image',
      description:
        'Adds an image to an artboard. Provide a Pexels result (src/href, alt, width/height from search_pexels) plus the target artboardId and optional position/size. Returns the new image object id.',
      inputSchema: {
        type: 'object',
        properties: {
          artboardId: { type: 'string' },
          src: { type: 'string', description: 'Image URL (use the src from search_pexels).' },
          href: { type: 'string' },
          alt: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          semanticRole: { type: 'string' },
        },
      },
      execute(payload: any = {}) {
        const href = payload.href || payload.src
        if (!href) return text('add_image requires src or href.')
        const img = store.addImage(payload)
        log('Added image to artboard')
        return text({ id: img.id, artboardId: img.artboardId })
      },
    },
    {
      name: 'position_image',
      description: 'Positions and/or resizes an image (or any object) by id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['id'],
      },
      execute({ id, x, y, width, height }: any = {}) {
        const o = store.getObject(id)
        if (!o) return text(`No object with id ${id}`)
        store.positionImage(id, { x, y, width, height })
        log('Positioned image')
        return text({ id, x, y, width, height })
      },
    },
  ]
}
