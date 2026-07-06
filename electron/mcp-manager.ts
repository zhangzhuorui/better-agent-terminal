import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { logger } from './logger'
import type { McpServerConfig, McpToolInfo } from '../src/types/platform-extensions'
import {
  BUILTIN_CONTEXT_SERVER_ID,
  builtinContextServerConfig,
  callContextMcpTool,
  getContextMcpTools,
} from './context-mcp-server'

const FILE = 'mcp-servers.json'

interface FileShape {
  version: 1
  servers: McpServerConfig[]
}

function dataPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(dataPath(), 'utf-8')
    const parsed = JSON.parse(raw) as FileShape
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.servers)) {
      return { version: 1, servers: [] }
    }
    return parsed
  } catch {
    return { version: 1, servers: [] }
  }
}

async function writeFile(data: FileShape): Promise<void> {
  const p = dataPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const f = await readFile()
  const hasBuiltin = f.servers.some(s => s.id === BUILTIN_CONTEXT_SERVER_ID)
  const servers = f.servers.slice()
  if (!hasBuiltin) servers.unshift(builtinContextServerConfig())
  return servers.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getMcpServer(id: string): Promise<McpServerConfig | null> {
  if (id === BUILTIN_CONTEXT_SERVER_ID) return builtinContextServerConfig()
  const f = await readFile()
  return f.servers.find(s => s.id === id) ?? null
}

export async function createMcpServer(input: Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<McpServerConfig> {
  if ((input as McpServerConfig).id === BUILTIN_CONTEXT_SERVER_ID) throw new Error('Cannot create the built-in context server')
  const now = Date.now()
  const server: McpServerConfig = {
    id: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  const f = await readFile()
  f.servers.push(server)
  await writeFile(f)
  logger.log(`[mcp] created server ${server.id} "${server.name}"`)
  return server
}

export async function updateMcpServer(id: string, updates: Partial<Omit<McpServerConfig, 'id' | 'createdAt'>>): Promise<McpServerConfig | null> {
  if (id === BUILTIN_CONTEXT_SERVER_ID) return builtinContextServerConfig()
  const f = await readFile()
  const idx = f.servers.findIndex(s => s.id === id)
  if (idx === -1) return null
  const cur = f.servers[idx]
  const next: McpServerConfig = { ...cur, ...updates, updatedAt: Date.now() }
  f.servers[idx] = next
  await writeFile(f)
  return next
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  if (id === BUILTIN_CONTEXT_SERVER_ID) return false
  const f = await readFile()
  const len = f.servers.length
  f.servers = f.servers.filter(s => s.id !== id)
  if (f.servers.length === len) return false
  await writeFile(f)
  return true
}

export async function healthCheckMcpServer(id: string): Promise<{ ok: boolean; error?: string }> {
  const server = await getMcpServer(id)
  if (!server) return { ok: false, error: 'Server not found' }
  if (id === BUILTIN_CONTEXT_SERVER_ID) return { ok: true }
  if (!server.enabled) return { ok: false, error: 'Server is disabled' }

  // For stdio transport, try to spawn and immediately kill to verify binary exists
  if (server.transport === 'stdio') {
    try {
      const { spawn } = await import('child_process')
      const child = spawn(server.command || 'echo', server.args || ['hello'], {
        env: { ...process.env, ...server.env },
        timeout: 5000,
      })
      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('close', (code: number | null) => {
          if (code === 0 || code === null) {
            resolve({ ok: true })
          } else {
            resolve({ ok: false, error: `Exited with code ${code}: ${stderr.slice(0, 200)}` })
          }
        })
        child.on('error', (err: Error) => {
          resolve({ ok: false, error: err.message })
        })
        setTimeout(() => {
          try { child.kill() } catch { /* noop */ }
        }, 3000)
      })
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  // For SSE/websocket, try a quick connection
  if (server.url) {
    try {
      const res = await fetch(server.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      if (res.ok || res.status < 500) {
        return { ok: true }
      }
      return { ok: false, error: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  return { ok: false, error: 'No URL configured for non-stdio transport' }
}

export async function runMcpHealthChecks(): Promise<void> {
  const servers = await listMcpServers()
  for (const s of servers) {
    if (!s.enabled) continue
    const result = await healthCheckMcpServer(s.id)
    await updateMcpServer(s.id, {
      lastHealthCheck: { ok: result.ok, error: result.error, checkedAt: Date.now() },
    })
    logger.log(`[mcp] health check ${s.name}: ${result.ok ? 'OK' : result.error}`)
  }
}

// ---------------------------------------------------------------------------
// MCP Tool Call (stdio transport only for now)
// ---------------------------------------------------------------------------

interface McpJsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

let _mcpRequestId = 0
function nextMcpRequestId(): number {
  return ++_mcpRequestId
}

/**
 * Call an MCP tool via stdio transport.
 * Spawns the server process, performs initialize handshake, calls the tool, then kills.
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const server = await getMcpServer(serverId)
  if (!server) return { ok: false, error: 'Server not found' }
  if (!server.enabled) return { ok: false, error: 'Server is disabled' }
  if (serverId === BUILTIN_CONTEXT_SERVER_ID) {
    return callContextMcpTool(toolName, toolInput)
  }
  if (server.transport !== 'stdio') {
    return { ok: false, error: `Transport ${server.transport} not yet supported for tool calls` }
  }

  const { spawn } = await import('child_process')
  const child = spawn(server.command || 'echo', server.args || ['hello'], {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const pending = new Map<number | string, { resolve: (msg: McpJsonRpcMessage) => void; reject: (err: Error) => void }>()
  let buffer = ''

  child.stdout?.on('data', (d: Buffer) => {
    buffer += d.toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as McpJsonRpcMessage
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!.resolve(msg)
          pending.delete(msg.id)
        }
      } catch {
        logger.log('[mcp] non-JSON stdout:', trimmed.slice(0, 200))
      }
    }
  })

  child.stderr?.on('data', (d: Buffer) => {
    logger.log('[mcp] stderr:', d.toString('utf-8').slice(0, 200))
  })

  function send(msg: Omit<McpJsonRpcMessage, 'jsonrpc'>): void {
    const full = JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'
    child.stdin?.write(full)
  }

  function waitForResponse(id: number | string, ms: number): Promise<McpJsonRpcMessage> {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`MCP request ${id} timed out after ${ms}ms`))
        }
      }, ms)
    })
  }

  try {
    // Initialize handshake
    const initId = nextMcpRequestId()
    send({
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'better-agent-terminal', version: app.getVersion() },
      },
    })
    const initRes = await waitForResponse(initId, 10_000)
    if (initRes.error) {
      return { ok: false, error: `Initialize failed: ${initRes.error.message}` }
    }

    // Send initialized notification
    send({ method: 'notifications/initialized' })

    // Call tool
    const callId = nextMcpRequestId()
    send({
      id: callId,
      method: 'tools/call',
      params: { name: toolName, arguments: toolInput },
    })
    const callRes = await waitForResponse(callId, timeoutMs)
    if (callRes.error) {
      return { ok: false, error: `Tool call failed: ${callRes.error.message}` }
    }

    return { ok: true, result: callRes.result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    try { child.kill() } catch { /* noop */ }
  }
}
