// WebMCP tools for typography and images. Registered as "extra tools" alongside
// the canvas/object tools. search_pexels calls the Worker proxy at
// /api/pexels/search so the API key stays server-side.
import type { CanvasStore } from '@/stores/canvas'
import {
  text,
  type WebMcpToolDefinition,
  type ToolLogger,
  type FontData,
  type EyeDropperInstance,
} from './webmcp'

/* eslint-disable @typescript-eslint/no-explicit-any */

async function httpGetJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

export interface ImageTextDeps {
  fetchJson?: (url: string) => Promise<any>
  // Injectable browser-API hooks (default to the real APIs). Tests override
  // these; unsupported browsers leave them undefined so the tools no-op safely.
  queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontData[]>
  createEyeDropper?: () => EyeDropperInstance
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

  // Resolve the experimental browser APIs: prefer injected deps (tests), then
  // the real window API, else undefined (unsupported browser / SSR / jsdom).
  const queryLocalFonts =
    deps.queryLocalFonts ||
    (typeof window !== 'undefined' && window.queryLocalFonts
      ? (opts?: { postscriptNames?: string[] }) => window.queryLocalFonts!(opts)
      : undefined)
  const createEyeDropper =
    deps.createEyeDropper ||
    (typeof window !== 'undefined' && window.EyeDropper
      ? () => new window.EyeDropper!()
      : undefined)

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
    // Typography edits (fontFamily, fontSize, fontWeight, fill, align, text) are
    // handled by the generic set_object_properties tool in tools.ts.

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
    // Positioning/resizing an image (x, y, width, height) is handled by the
    // generic set_object_properties tool in tools.ts.

    // ---- Local fonts (Local Font Access API) -------------------------------
    {
      name: 'list_local_fonts',
      description:
        'Lists fonts actually installed on the user’s machine (via the browser Local Font Access API),' +
        'Returns an array of { family, fullName, postscriptName, style }. Optionally filter with `query` (case-insensitive substring match on family/fullName) and cap the count with `limit`. ',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive substring to filter font family/name.' },
          limit: { type: 'number', description: 'Maximum number of fonts to return (default 50).' },
        },
      },
      async execute({ query, limit = 50 }: { query?: string; limit?: number } = {}) {
        if (!queryLocalFonts) {
          log('Local fonts unavailable', { status: 'error' })
          return text(
            'Local Font Access API is not available in this browser. It requires a Chromium-based browser in a secure context.',
          )
        }
        log('Reading local fonts', { status: 'running' })
        let fonts: FontData[]
        try {
          fonts = await queryLocalFonts()
        } catch (e) {
          log('Local font access denied', { status: 'error' })
          return text(`Could not read local fonts: ${(e as Error)?.message || 'permission denied'}`)
        }
        const q = String(query || '').trim().toLowerCase()
        let list = fonts.map((f) => ({
          family: f.family,
          fullName: f.fullName,
          postscriptName: f.postscriptName,
          style: f.style,
        }))
        if (q) {
          list = list.filter(
            (f) => f.family.toLowerCase().includes(q) || f.fullName.toLowerCase().includes(q),
          )
        }
        // De-duplicate by family so the agent sees pickable font families first.
        const families = [...new Set(list.map((f) => f.family))]
        const cap = Math.max(1, Math.min(Number(limit) || 50, 200))
        const trimmed = list.slice(0, cap)
        log(`Found ${families.length} local font famil${families.length === 1 ? 'y' : 'ies'}`)
        return text({ totalFaces: list.length, families: families.slice(0, cap), fonts: trimmed })
      },
    },

    // ---- Screen color picker (EyeDropper API) ------------------------------
    // {
    //   name: 'pick_screen_color',
    //   description:
    //     'Opens the browser EyeDropper so the human can click any pixel ANYWHERE on their screen (even outside the app) to sample a color; the chosen hex value is returned to you. ' +
    //     'Use this human-in-the-loop tool when the user wants to match a brand/reference color you cannot see — e.g. "use the blue from my brand guide". ' +
    //     'Optionally pass `applyTo` (object ids) and/or `role` to immediately set the sampled color as the fill of those objects. Requires a supported browser (Chromium, secure context) and a user gesture; returns a clear message otherwise.',
    //   inputSchema: {
    //     type: 'object',
    //     properties: {
    //       applyTo: {
    //         type: 'array',
    //         items: { type: 'string' },
    //         description: 'Optional object ids to fill with the sampled color.',
    //       },
    //       role: {
    //         type: 'string',
    //         description: 'Optional semanticRole whose objects should be filled with the sampled color.',
    //       },
    //     },
    //   },
    //   async execute({ applyTo, role }: { applyTo?: string[]; role?: string } = {}) {
    //     if (!createEyeDropper) {
    //       log('EyeDropper unavailable', { status: 'error' })
    //       return text(
    //         'EyeDropper API is not available in this browser. It requires a Chromium-based browser in a secure context.',
    //       )
    //     }
    //     log('Waiting for the user to pick a color', { status: 'running' })
    //     let sRGBHex: string
    //     try {
    //       const result = await createEyeDropper().open()
    //       sRGBHex = result.sRGBHex
    //     } catch (e) {
    //       // The user pressed Escape or aborted the eyedropper.
    //       log('Color pick cancelled', { status: 'error' })
    //       return text(`Color selection was cancelled: ${(e as Error)?.message || 'aborted'}`)
    //     }

    //     // Resolve any objects to recolor: explicit ids, matching role, else the
    //     // human's current selection.
    //     const targets = new Set<string>()
    //     if (Array.isArray(applyTo)) applyTo.forEach((id) => store.getObject(id) && targets.add(id))
    //     if (role) store.findByRole(role).forEach((o) => targets.add(o.id))
    //     const ids = [...targets]
    //     ids.forEach((id) => store.setFill(id, sRGBHex))

    //     if (ids.length) {
    //       store.selectObjects(ids)
    //       log(`Picked ${sRGBHex} and filled ${ids.length} object(s)`)
    //     } else {
    //       log(`Picked color ${sRGBHex}`)
    //     }
    //     return text({ color: sRGBHex, applied: ids })
    //   },
    // },
  ]
}
