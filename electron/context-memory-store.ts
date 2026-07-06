import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { ContextMemoryEntry } from '../src/types/platform-extensions'
import { logger } from './logger'

const FILE = 'context-memory.json'

interface FileShape {
  version: 1
  entries: ContextMemoryEntry[]
}

function dataPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(dataPath(), 'utf-8')
    const parsed = JSON.parse(raw) as FileShape
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] }
    }
    return parsed
  } catch {
    return { version: 1, entries: [] }
  }
}

async function writeFile(data: FileShape): Promise<void> {
  const p = dataPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

function normalizeEntry(entry: Partial<ContextMemoryEntry> & { content: string; kind: ContextMemoryEntry['kind'] }): ContextMemoryEntry {
  const now = Date.now()
  return {
    id: entry.id ?? randomUUID(),
    packageId: entry.packageId,
    sessionId: entry.sessionId,
    kind: entry.kind,
    content: entry.content.trim(),
    confidence: typeof entry.confidence === 'number' ? Math.max(0, Math.min(1, entry.confidence)) : 0.8,
    createdAt: entry.createdAt ?? now,
    updatedAt: entry.updatedAt ?? now,
    workspaceRoot: entry.workspaceRoot,
    tags: entry.tags?.length ? entry.tags : undefined,
  }
}

export async function listMemoryEntries(options?: { workspaceRoot?: string; kinds?: ContextMemoryEntry['kind'][]; limit?: number }): Promise<ContextMemoryEntry[]> {
  const f = await readFile()
  let entries = f.entries.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  if (options?.workspaceRoot) {
    const root = options.workspaceRoot
    entries = entries.filter(e => e.workspaceRoot === root || (!e.workspaceRoot && root === 'global'))
  }
  if (options?.kinds?.length) {
    entries = entries.filter(e => options.kinds!.includes(e.kind))
  }
  if (options?.limit) {
    entries = entries.slice(0, options.limit)
  }
  return entries
}

export async function searchMemoryEntries(query: string, options?: { workspaceRoot?: string; limit?: number }): Promise<ContextMemoryEntry[]> {
  const term = query.trim().toLowerCase()
  const entries = await listMemoryEntries(options)
  if (!term) return entries
  return entries
    .filter(e => e.content.toLowerCase().includes(term) || e.tags?.some(t => t.toLowerCase().includes(term)))
    .slice(0, options?.limit ?? 20)
}

export async function getMemoryEntry(id: string): Promise<ContextMemoryEntry | null> {
  const f = await readFile()
  return f.entries.find(e => e.id === id) ?? null
}

export async function getMemoryEntriesByIds(ids: string[]): Promise<ContextMemoryEntry[]> {
  if (!ids.length) return []
  const set = new Set(ids)
  const f = await readFile()
  const order = new Map(ids.map((id, i) => [id, i]))
  return f.entries
    .filter(e => set.has(e.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export async function createMemoryEntry(entry: Partial<ContextMemoryEntry> & { content: string; kind: ContextMemoryEntry['kind'] }): Promise<ContextMemoryEntry> {
  const f = await readFile()
  const normalized = normalizeEntry(entry)
  f.entries.push(normalized)
  await writeFile(f)
  logger.log(`[context-memory] created ${normalized.id} [${normalized.kind}]`)
  return normalized
}

export async function recordMemoryEntries(entries: Array<Partial<ContextMemoryEntry> & { content: string; kind: ContextMemoryEntry['kind'] }>): Promise<ContextMemoryEntry[]> {
  const f = await readFile()
  const created = entries.map(e => normalizeEntry(e))
  f.entries.push(...created)
  await writeFile(f)
  logger.log(`[context-memory] recorded ${created.length} entries`)
  return created
}

export async function updateMemoryEntry(id: string, updates: Partial<Pick<ContextMemoryEntry, 'content' | 'confidence' | 'tags' | 'workspaceRoot'>>): Promise<ContextMemoryEntry | null> {
  const f = await readFile()
  const idx = f.entries.findIndex(e => e.id === id)
  if (idx === -1) return null
  const cur = f.entries[idx]
  const next: ContextMemoryEntry = {
    ...cur,
    ...(updates.content !== undefined ? { content: updates.content.trim() } : {}),
    ...(typeof updates.confidence === 'number' ? { confidence: Math.max(0, Math.min(1, updates.confidence)) } : {}),
    ...(updates.tags !== undefined ? { tags: updates.tags?.length ? updates.tags : undefined } : {}),
    ...(updates.workspaceRoot !== undefined ? { workspaceRoot: updates.workspaceRoot } : {}),
    updatedAt: Date.now(),
  }
  f.entries[idx] = next
  await writeFile(f)
  return next
}

export async function deleteMemoryEntry(id: string): Promise<boolean> {
  const f = await readFile()
  const len = f.entries.length
  f.entries = f.entries.filter(e => e.id !== id)
  if (f.entries.length === len) return false
  await writeFile(f)
  return true
}

export async function pruneMemoryEntries(olderThanDays: number): Promise<number> {
  const cutoff = Date.now() - olderThanDays * 86400000
  const f = await readFile()
  const before = f.entries.length
  f.entries = f.entries.filter(e => e.updatedAt > cutoff)
  const removed = before - f.entries.length
  if (removed) await writeFile(f)
  return removed
}

export async function getMemoryStats(): Promise<{ total: number; byKind: Record<ContextMemoryEntry['kind'], number> }> {
  const f = await readFile()
  const byKind: Record<ContextMemoryEntry['kind'], number> = { fact: 0, decision: 0, constraint: 0, blocker: 0, file: 0, goal: 0 }
  for (const e of f.entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
  }
  return { total: f.entries.length, byKind }
}
