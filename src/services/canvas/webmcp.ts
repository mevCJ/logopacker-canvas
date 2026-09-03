// Shared WebMCP tool types + a global declaration for document.modelContext.
// The WebMCP API is experimental; these types describe the subset the app uses.

export interface WebMcpContent {
  type: 'text'
  text: string
}

export interface WebMcpResult {
  content: WebMcpContent[]
}

export interface WebMcpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input?: any) => WebMcpResult | Promise<WebMcpResult>
}

export interface ModelContext {
  registerTool: (tool: WebMcpToolDefinition, options?: { signal?: AbortSignal }) => void
  getTools?: () => Promise<unknown>
  executeTool?: (name: string, args: unknown) => Promise<unknown>
}

// --- Experimental browser APIs used by agent tools -------------------------
// These are Chromium-only and gated to secure contexts; the tools that use
// them feature-detect at call time and degrade gracefully elsewhere.

// EyeDropper API (https://developer.mozilla.org/docs/Web/API/EyeDropper_API)
export interface EyeDropperOpenResult {
  sRGBHex: string
}
export interface EyeDropperInstance {
  open: (options?: { signal?: AbortSignal }) => Promise<EyeDropperOpenResult>
}

// Local Font Access API (https://developer.mozilla.org/docs/Web/API/Local_Font_Access_API)
export interface FontData {
  postscriptName: string
  fullName: string
  family: string
  style: string
}

declare global {
  interface Document {
    modelContext?: ModelContext
  }
  interface Window {
    EyeDropper?: { new (): EyeDropperInstance }
    queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontData[]>
  }
}

export interface ToolLogger {
  step: (label: string, opts?: { status?: 'done' | 'running' | 'error'; groupId?: string | null }) => void
}

// Standard WebMCP text result.
export function text(t: unknown): WebMcpResult {
  return { content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] }
}
