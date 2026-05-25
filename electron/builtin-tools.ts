import path from 'path'
import * as fs from 'fs/promises'

export interface BuiltinToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface BuiltinToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface BuiltinToolResult {
  ok: boolean
  content: string
}

const MAX_FILE_BYTES = 80_000
const MAX_DIR_ENTRIES = 200
const MAX_SEARCH_RESULTS = 80
const MAX_SEARCH_FILE_BYTES = 120_000
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release', '.next', '.vite', 'coverage'])

export const BUILTIN_TOOLS: BuiltinToolDefinition[] = [
  {
    name: 'workspace_info',
    description: 'Get basic information about the current workspace root. Use this before reading files when you need orientation.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders under the workspace. Paths are relative to the workspace root. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path. Use empty string or . for the workspace root.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the workspace. Paths are relative to the workspace root. Read-only and size-limited.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to read.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description: 'Search file names and text contents under the workspace. Read-only and result-limited.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for in file names and file contents.' },
        path: { type: 'string', description: 'Optional relative directory to search within.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
]

export function getOpenAIToolDefinitions() {
  return BUILTIN_TOOLS.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

export function getGeminiToolDeclarations() {
  return BUILTIN_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: stripUnsupportedSchemaFields(tool.inputSchema),
  }))
}

function stripUnsupportedSchemaFields(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaFields)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    out[key] = stripUnsupportedSchemaFields(value)
  }
  return out
}

export async function executeBuiltinTool(cwd: string, call: BuiltinToolCall): Promise<BuiltinToolResult> {
  try {
    switch (call.name) {
      case 'workspace_info':
        return await workspaceInfo(cwd)
      case 'list_directory':
        return await listDirectory(cwd, stringArg(call.arguments.path) || '.')
      case 'read_file':
        return await readFile(cwd, requiredStringArg(call.arguments.path, 'path'))
      case 'search_files':
        return await searchFiles(cwd, requiredStringArg(call.arguments.query, 'query'), stringArg(call.arguments.path) || '.')
      default:
        return { ok: false, content: `Unknown tool: ${call.name}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, content: message }
  }
}

async function workspaceInfo(cwd: string): Promise<BuiltinToolResult> {
  const root = await resolveWorkspaceRoot(cwd)
  const entries = await fs.readdir(root, { withFileTypes: true })
  const visible = entries
    .filter(entry => !entry.name.startsWith('.'))
    .slice(0, MAX_DIR_ENTRIES)
    .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
  return {
    ok: true,
    content: JSON.stringify({ root, entries: visible, truncated: entries.length > MAX_DIR_ENTRIES }, null, 2),
  }
}

async function listDirectory(cwd: string, relativePath: string): Promise<BuiltinToolResult> {
  const target = await resolveInsideWorkspace(cwd, relativePath)
  const stat = await fs.stat(target)
  if (!stat.isDirectory()) return { ok: false, content: `${relativePath} is not a directory` }

  const entries = await fs.readdir(target, { withFileTypes: true })
  const rows = entries.slice(0, MAX_DIR_ENTRIES).map(entry => ({
    name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  }))
  return {
    ok: true,
    content: JSON.stringify({ path: normalizeRelative(relativePath), entries: rows, truncated: entries.length > MAX_DIR_ENTRIES }, null, 2),
  }
}

async function readFile(cwd: string, relativePath: string): Promise<BuiltinToolResult> {
  const target = await resolveInsideWorkspace(cwd, relativePath)
  const stat = await fs.stat(target)
  if (!stat.isFile()) return { ok: false, content: `${relativePath} is not a file` }
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, content: `File is too large (${stat.size} bytes). Limit is ${MAX_FILE_BYTES} bytes.` }
  }
  const content = await fs.readFile(target, 'utf8')
  return { ok: true, content }
}

async function searchFiles(cwd: string, query: string, relativePath: string): Promise<BuiltinToolResult> {
  const root = await resolveInsideWorkspace(cwd, relativePath)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) return { ok: false, content: `${relativePath} is not a directory` }

  const lowerQuery = query.toLowerCase()
  const results: Array<{ path: string; match: 'name' | 'content'; line?: number; preview?: string }> = []

  async function walk(dir: string) {
    if (results.length >= MAX_SEARCH_RESULTS) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) return
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const fullPath = path.join(dir, entry.name)
      const rel = path.relative(await resolveWorkspaceRoot(cwd), fullPath)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.toLowerCase().includes(lowerQuery)) {
        results.push({ path: rel, match: 'name' })
        continue
      }
      try {
        const fileStat = await fs.stat(fullPath)
        if (fileStat.size > MAX_SEARCH_FILE_BYTES) continue
        const content = await fs.readFile(fullPath, 'utf8')
        const lines = content.split(/\r?\n/)
        const foundIndex = lines.findIndex(line => line.toLowerCase().includes(lowerQuery))
        if (foundIndex >= 0) {
          results.push({ path: rel, match: 'content', line: foundIndex + 1, preview: lines[foundIndex].trim().slice(0, 240) })
        }
      } catch {
        // Ignore binary or unreadable files.
      }
    }
  }

  await walk(root)
  return {
    ok: true,
    content: JSON.stringify({ query, results, truncated: results.length >= MAX_SEARCH_RESULTS }, null, 2),
  }
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  const root = path.resolve(cwd || process.cwd())
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error('Workspace root is not a directory')
  return root
}

async function resolveInsideWorkspace(cwd: string, relativePath: string): Promise<string> {
  const root = await resolveWorkspaceRoot(cwd)
  const normalized = normalizeRelative(relativePath)
  const target = path.resolve(root, normalized)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes workspace root')
  }
  return target
}

function normalizeRelative(value: string): string {
  const raw = (value || '.').trim()
  return raw === '' ? '.' : raw
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requiredStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required string argument: ${name}`)
  return value
}
