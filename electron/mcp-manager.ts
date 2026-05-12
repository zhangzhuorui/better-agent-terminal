import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { logger } from './logger'
import type { McpServerConfig, McpToolInfo } from '../src/types/platform-extensions'

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
  return f.servers.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getMcpServer(id: string): Promise<McpServerConfig | null> {
  const f = await readFile()
  return f.servers.find(s => s.id === id) ?? null
}

export async function createMcpServer(input: Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<McpServerConfig> {
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
