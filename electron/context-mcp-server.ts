import type { ContextPackage, ContextMemoryEntry, McpServerConfig, McpToolInfo, ContextModuleSettings } from '../src/types/platform-extensions'
import { defaultContextModuleSettings } from '../src/types'
import * as contextPackageStore from './context-package-store'
import * as contextMemoryStore from './context-memory-store'
import { buildContextInjectionPlan } from './context-retrieval-service'
import { compressStructured } from './context-structured-compressor'
import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'

export const BUILTIN_CONTEXT_SERVER_ID = 'builtin-context'

async function loadUserContextModuleSettings(): Promise<ContextModuleSettings> {
  try {
    const raw = await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { contextModule?: Partial<ContextModuleSettings> }
    return { ...defaultContextModuleSettings, ...parsed.contextModule }
  } catch {
    return defaultContextModuleSettings
  }
}

export function builtinContextServerConfig(): McpServerConfig {
  return {
    id: BUILTIN_CONTEXT_SERVER_ID,
    name: 'Built-in Context Server',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: ['--mcp-server=builtin-context'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function getContextMcpTools(): McpToolInfo[] {
  return [
    {
      name: 'context_package_list',
      description: 'List all context packages.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'context_package_get',
      description: 'Get a context package by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'context_package_search',
      description: 'Search context packages by query text.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'context_retrieval_plan',
      description: 'Build a context injection plan for a user prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          workspacePath: { type: 'string' },
          explicitPackageIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'context_memory_search',
      description: 'Search atomic memory entries by query text.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    },
    {
      name: 'context_compress',
      description: 'Return a structured compression preview for the given content.',
      inputSchema: { type: 'object', properties: { content: { type: 'string' }, queryTerms: { type: 'array', items: { type: 'string' } } }, required: ['content'] },
    },
  ]
}

export async function callContextMcpTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    switch (toolName) {
      case 'context_package_list': {
        const list = await contextPackageStore.listContextPackages()
        return { ok: true, result: { packages: list.map(summarizePackage) } }
      }
      case 'context_package_get': {
        const id = String(toolInput.id || '')
        const pkg = id ? await contextPackageStore.getContextPackage(id) : null
        return pkg ? { ok: true, result: { package: summarizePackage(pkg) } } : { ok: false, error: 'Package not found' }
      }
      case 'context_package_search': {
        const query = String(toolInput.query || '')
        const results = await contextPackageStore.searchContextPackages(query)
        return { ok: true, result: { results } }
      }
      case 'context_retrieval_plan': {
        const prompt = String(toolInput.prompt || '')
        const workspacePath = toolInput.workspacePath ? String(toolInput.workspacePath) : undefined
        const explicitPackageIds = Array.isArray(toolInput.explicitPackageIds)
          ? toolInput.explicitPackageIds.map(String)
          : []
        const overrides = toolInput.settings && typeof toolInput.settings === 'object'
          ? (toolInput.settings as Partial<ContextModuleSettings>)
          : {}
        const settings = { ...await loadUserContextModuleSettings(), ...overrides }
        const plan = await buildContextInjectionPlan({
          prompt,
          workspacePath,
          explicitPackageIds,
          settings,
        })
        return { ok: true, result: { plan } }
      }
      case 'context_memory_search': {
        const query = String(toolInput.query || '')
        const limit = typeof toolInput.limit === 'number' ? toolInput.limit : 10
        const entries = await contextMemoryStore.searchMemoryEntries(query, { limit })
        return { ok: true, result: { entries } }
      }
      case 'context_compress': {
        const content = String(toolInput.content || '')
        const queryTerms = Array.isArray(toolInput.queryTerms)
          ? toolInput.queryTerms.map(String)
          : undefined
        const variant = compressStructured(content, { queryTerms })
        return { ok: true, result: { variant } }
      }
      default:
        return { ok: false, error: `Unknown tool: ${toolName}` }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function summarizePackage(pkg: ContextPackage): unknown {
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    tags: pkg.tags,
    workspaceRoot: pkg.workspaceRoot,
    updatedAt: pkg.updatedAt,
    tokenEstimate: pkg.metadata?.tokenEstimate,
    summary: pkg.metadata?.shortSummary ?? pkg.metadata?.summary,
    content: pkg.content,
  }
}

/** If called directly as a stdio MCP server, handle JSON-RPC. */
export async function runStdioContextMcpServer(): Promise<void> {
  const tools = getContextMcpTools()
  const send = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify(msg) + '\n')

  const handlers: Record<string, (params?: Record<string, unknown>) => Promise<unknown> | unknown> = {
    initialize: () => ({
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'builtin-context', version: '1.0.0' },
    }),
    'notifications/initialized': () => undefined,
    'tools/list': () => ({ tools }),
    'tools/call': async (params) => {
      const name = String((params as Record<string, unknown>)?.name ?? '')
      const input = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>
      const res = await callContextMcpTool(name, input)
      if (!res.ok) return { content: [{ type: 'text', text: `Error: ${res.error}` }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(res.result, null, 2) }] }
    },
  }

  let buffer = ''
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const req = JSON.parse(trimmed) as { id?: number | string; method?: string; params?: Record<string, unknown> }
        const handler = req.method ? handlers[req.method] : undefined
        if (!handler) {
          if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } })
          continue
        }
        Promise.resolve(handler(req.params))
          .then(result => {
            if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, result: result ?? {} })
          })
          .catch(err => {
            if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
          })
      } catch (e) {
        logger.error('[mcp-server] malformed JSON-RPC line:', trimmed.slice(0, 200), e instanceof Error ? e.message : String(e))
      }
    }
  })
}
