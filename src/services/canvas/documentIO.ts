// Save / load of the full canvas document as a portable .json file.
// The store owns serialization (serializeDocument / loadDocument); this module
// is just the browser plumbing: a filename, a Blob download, and a parse of a
// user-picked file. Mirrors the shape of exportService.ts for consistency.
import { downloadBlob } from './exportService'
import { readFileAsText } from './userTools'
import { DOCUMENT_VERSION, type CanvasDocument } from '@/stores/canvas'

// A timestamped document filename, e.g. "logopacker-20260903-1330.json".
export function documentFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `logopacker-${stamp}.json`
}

// Serialize a document to pretty JSON and trigger a browser download.
export function saveDocumentToFile(doc: CanvasDocument, filename = documentFilename()): void {
  const json = JSON.stringify(doc, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  downloadBlob(blob, filename)
}

// Read a user-picked file and parse it into a CanvasDocument. Throws with a
// friendly message on malformed JSON or a mismatched version/shape.
export async function parseDocumentFile(file: File): Promise<CanvasDocument> {
  const text = await readFileAsText(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('That file does not contain a document.')
  }
  const doc = parsed as CanvasDocument
  if (doc.version !== DOCUMENT_VERSION) {
    throw new Error(
      `This file is version ${String(doc.version)}, but this app expects version ${DOCUMENT_VERSION}.`,
    )
  }
  return doc
}
