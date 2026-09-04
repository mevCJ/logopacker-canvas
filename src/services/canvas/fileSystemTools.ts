// WebMCP tools for reading image assets and exporting the canvas. Registered as
// "extra tools" alongside the canvas/object/image tools.
//
// These use only stable, universally-supported browser primitives so they work
// everywhere — including embedded Chromium webviews (e.g. the ChatGPT in-app
// browser) that lack the experimental File System Access API:
//   read_assets — a <input type="file" multiple> picker; places chosen images.
//   save_export — renders SVG/PNG and downloads it (existing export pipeline).
//   autosave    — downloads the canvas as a portable .json document (Save).
import type { CanvasStore } from '@/stores/canvas'
import { text, type WebMcpToolDefinition, type ToolLogger } from './webmcp'
import {
  resolveExportSet,
  buildExportSvg,
  type ExportScope,
  type ExportStateSnapshot,
} from './svgExport'
import type { RenderObject } from './svgEngine'
import { exportSvg, exportPng, exportFilename } from './exportService'
import { saveDocumentToFile, documentFilename } from './documentIO'
import { readFileAsDataUrl, probeImageSize } from './userTools'

/* eslint-disable @typescript-eslint/no-explicit-any */

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'] as const

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}
function isImageName(name: string): boolean {
  return (IMAGE_EXT as readonly string[]).includes(extOf(name))
}

// Open the native file dialog via a transient <input type="file"> and resolve
// the chosen files (empty if dismissed). Supported by every browser. Dismissal
// detection is best-effort: the 'cancel' event fires in modern browsers; a
// window-focus fallback covers the rest. done() is idempotent so a late
// fallback after a real selection is harmless.
function inputFilePicker(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = IMAGE_EXT.map((e) => `.${e}`).join(',') + ',image/*'
    input.multiple = multiple
    input.style.display = 'none'
    let settled = false
    const done = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done(input.files ? Array.from(input.files) : []))
    input.addEventListener('cancel', () => done([]))
    // ponytail: 300ms focus fallback for browsers without a 'cancel' event; a
    // late resolve is harmless because done() is idempotent.
    window.addEventListener('focus', () => setTimeout(() => done([]), 300), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

// probeImageSize with a timeout so a data: URL that never fires load/error
// (headless engines) degrades to unknown dimensions instead of hanging.
function probeSize(src: string): Promise<{ width: number; height: number }> {
  return Promise.race([
    probeImageSize(src).catch(() => ({ width: 0, height: 0 })),
    new Promise<{ width: number; height: number }>((r) => setTimeout(() => r({ width: 0, height: 0 }), 1500)),
  ])
}

export interface FileSystemDeps {
  // Injectable for tests. Defaults to a real <input type="file"> picker.
  pickFiles?: (multiple: boolean) => Promise<File[]>
  // Injectable image-size probe (tests skip the real Image() load).
  probeSize?: (src: string) => Promise<{ width: number; height: number }>
}

export function buildFileSystemTools(
  store: CanvasStore,
  logger: ToolLogger = { step() {} },
  deps: FileSystemDeps = {},
): WebMcpToolDefinition[] {
  const log = (label: string, opts?: { status?: 'done' | 'running' | 'error' }) => {
    try {
      logger.step(label, opts)
    } catch {
      /* noop */
    }
  }

  const pickFiles =
    deps.pickFiles || (typeof document !== 'undefined' ? inputFilePicker : undefined)
  const probe = deps.probeSize || probeSize

  // Build the export snapshot from live store state (mirrors ExportDialog).
  function snapshot(): ExportStateSnapshot {
    return {
      artboards: JSON.parse(JSON.stringify(store.artboards)),
      objects: JSON.parse(JSON.stringify(store.objects)) as Record<string, RenderObject>,
      objectOrder: [...store.objectOrder],
      selectedIds: [...store.selectedIds],
      selectedArtboardId: store.selectedArtboardId,
    }
  }

  return [
    // ---- Reading assets ----------------------------------------------------
    {
      name: 'read_assets',
      description:
        'Opens a file picker (works in every browser) for the user to choose one or more image/SVG files, then adds each as an image object on an artboard. ' +
        'Use this to bring the user’s own logos/photos onto the canvas. Provide the target artboardId and optional position/size for the first image. Returns the created object ids.',
      inputSchema: {
        type: 'object',
        properties: {
          artboardId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      async execute(payload: any = {}) {
        if (!pickFiles) {
          log('File picker unavailable', { status: 'error' })
          return text('A file picker is not available in this environment.')
        }
        log('Waiting for the user to choose image(s)', { status: 'running' })
        let files: File[]
        try {
          files = await pickFiles(true)
        } catch (e) {
          log('File selection cancelled', { status: 'error' })
          return text(`File selection was cancelled: ${(e as Error)?.message || 'aborted'}`)
        }
        const images = files.filter((f) => isImageName(f.name))
        if (!images.length) {
          log('No image chosen', { status: 'error' })
          return text('No supported image/SVG file was chosen.')
        }
        const created: Array<{ id: string; name: string; type: string }> = []
        // Offset extra images so they don't stack exactly on the first.
        let offset = 0
        for (const file of images) {
          const href = await readFileAsDataUrl(file)
          // probeImageSize resolves on the image's load/error; if neither fires
          // (some headless engines never load a data: URL) fall back to the
          // store's default size rather than hanging. ponytail: 1.5s cap.
          const size = await probe(href)
          const img = store.addImage({
            href,
            alt: file.name,
            artboardId: payload.artboardId,
            x: (payload.x ?? 0) + offset,
            y: (payload.y ?? 0) + offset,
            width: payload.width ?? (size.width || undefined),
            height: payload.height ?? (size.height || undefined),
          })
          created.push({ id: img.id, name: file.name, type: file.type })
          offset += 24
        }
        store.selectObjects(created.map((c) => c.id))
        log(`Read ${created.length} asset(s)`)
        return text({ artboardId: payload.artboardId, created })
      },
    },

    // ---- Exporting ---------------------------------------------------------
    {
      name: 'save_export',
      description:
        'Exports the canvas and downloads it as a file (works in every browser; the file goes to the browser’s downloads). ' +
        'scope: "selection" | "artboard" (needs artboardId) | "all". format: "svg" | "png". ' +
        'Optional: scale (PNG, default 1), transparent (default false), filename (defaults to a timestamped name). Returns { filename, failed }.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['selection', 'artboard', 'all'] },
          artboardId: { type: 'string' },
          format: { type: 'string', enum: ['svg', 'png'] },
          scale: { type: 'number' },
          transparent: { type: 'boolean' },
          filename: { type: 'string' },
        },
        required: ['scope', 'format'],
      },
      async execute(payload: any = {}) {
        const scope: ExportScope = payload.scope
        const format: 'svg' | 'png' = payload.format === 'png' ? 'png' : 'svg'
        const set = resolveExportSet(snapshot(), scope, payload.artboardId)
        if (!set.objects.length) return text('Nothing to export for that scope/artboard.')
        const transparent = !!payload.transparent
        const solidBg = transparent || set.includeArtboardBackgrounds ? null : '#FFFFFF'
        const { svg, bounds } = buildExportSvg({
          objects: set.objects,
          artboards: set.artboards,
          includeArtboardBackgrounds: set.includeArtboardBackgrounds && !transparent,
          background: solidBg,
        })
        if (bounds.width <= 0 || bounds.height <= 0) {
          return text('The content has no visible area to export.')
        }
        const filename = payload.filename || exportFilename(scope, format)
        if (format === 'svg') {
          exportSvg({ svgString: svg, filename })
          log(`Exported ${filename}`)
          return text({ filename, failed: [] })
        }
        try {
          const { failed } = await exportPng({
            svgString: svg,
            width: bounds.width,
            height: bounds.height,
            scale: payload.scale || 1,
            background: transparent ? null : '#FFFFFF',
            filename,
          })
          log(`Exported ${filename}`)
          return text({ filename, failed })
        } catch (e) {
          log('Export failed', { status: 'error' })
          return text(`Could not export PNG: ${(e as Error)?.message || 'unknown error'}`)
        }
      },
    },
    {
      name: 'autosave',
      description:
        'Saves the whole canvas as a portable .json document (the same Save the toolbar uses) and downloads it. ' +
        'This is the reloadable source document — all artboards, objects and layout — not a rendered image. Use save_export for SVG/PNG output. Returns { filename }.',
      inputSchema: {
        type: 'object',
        properties: { filename: { type: 'string', description: 'Optional .json filename.' } },
      },
      execute({ filename }: { filename?: string } = {}) {
        if (!store.artboards.length && !store.objectOrder.length) {
          return text('There is nothing on the canvas to save yet.')
        }
        const name = filename || documentFilename()
        saveDocumentToFile(store.serializeDocument(), name)
        log(`Saved document ${name}`)
        return text({ filename: name })
      },
    },
  ]
}
