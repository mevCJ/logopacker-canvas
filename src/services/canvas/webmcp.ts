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

declare global {
  interface Document {
    modelContext?: ModelContext
  }
}

export interface ToolLogger {
  step: (label: string, opts?: { status?: 'done' | 'running' | 'error'; groupId?: string | null }) => void
}

// Standard WebMCP text result.
export function text(t: unknown): WebMcpResult {
  return { content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] }
}
