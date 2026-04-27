import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { ContextPackage } from '../src/types/platform-extensions'
import { logger } from './logger'

const FILE = 'context-packages.json'

interface FileShape {
  version: 1
  packages: ContextPackage[]
}

function dataPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(dataPath(), 'utf-8')
    const parsed = JSON.parse(raw) as FileShape
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.packages)) {
      return { version: 1, packages: [] }
    }
    return parsed
  } catch {
    return { version: 1, packages: [] }
  }
}

async function writeFile(data: FileShape): Promise<void> {
  const p = dataPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

export async function listContextPackages(): Promise<ContextPackage[]> {
  const f = await readFile()
  return f.packages.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getContextPackage(id: string): Promise<ContextPackage | null> {
  const f = await readFile()
  return f.packages.find(p => p.id === id) ?? null
}

export async function getContextPackagesByIds(ids: string[]): Promise<ContextPackage[]> {
  if (!ids.length) return []
  const set = new Set(ids)
  const f = await readFile()
  const order = new Map(ids.map((id, i) => [id, i]))
  return f.packages
    .filter(p => set.has(p.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export async function createContextPackage(input: {
  name: string
  description?: string
  content: string
  tags?: string[]
  workspaceRoot?: string
}): Promise<ContextPackage> {
  const now = Date.now()
  const wr = input.workspaceRoot?.trim()
  const pkg: ContextPackage = {
    id: randomUUID(),
    name: input.name.trim() || 'Untitled',
    description: input.description?.trim() || undefined,
    content: input.content,
    tags: input.tags?.length ? input.tags : undefined,
    workspaceRoot: wr || undefined,
    createdAt: now,
    updatedAt: now,
  }
  const f = await readFile()
  f.packages.push(pkg)
  await writeFile(f)
  logger.log(`[context-packages] created ${pkg.id} "${pkg.name}"`)
  return pkg
}

export async function updateContextPackage(
  id: string,
  updates: Partial<Pick<ContextPackage, 'name' | 'description' | 'content' | 'tags' | 'workspaceRoot'>>
): Promise<ContextPackage | null> {
  const f = await readFile()
  const idx = f.packages.findIndex(p => p.id === id)
  if (idx === -1) return null
  const cur = f.packages[idx]
  const next: ContextPackage = {
    ...cur,
    ...('name' in updates && updates.name !== undefined ? { name: updates.name.trim() || cur.name } : {}),
    ...('description' in updates ? { description: updates.description?.trim() || undefined } : {}),
    ...('content' in updates && updates.content !== undefined ? { content: updates.content } : {}),
    ...('tags' in updates ? { tags: updates.tags?.length ? updates.tags : undefined } : {}),
    ...('workspaceRoot' in updates
      ? { workspaceRoot: updates.workspaceRoot?.trim() ? updates.workspaceRoot.trim() : undefined }
      : {}),
    updatedAt: Date.now(),
  }
  f.packages[idx] = next
  await writeFile(f)
  return next
}

export async function deleteContextPackage(id: string): Promise<boolean> {
  const f = await readFile()
  const len = f.packages.length
  f.packages = f.packages.filter(p => p.id !== id)
  if (f.packages.length === len) return false
  await writeFile(f)
  return true
}

export interface ContextPackageSearchResult {
  id: string
  name: string
  description?: string
  snippet: string
  content: string
  tags?: string[]
  workspaceRoot?: string
  updatedAt: number
}

export async function searchContextPackages(query: string): Promise<ContextPackageSearchResult[]> {
  const term = query.trim().toLowerCase()
  if (!term) return []
  const f = await readFile()
  const results: ContextPackageSearchResult[] = []
  for (const p of f.packages) {
    const nameMatch = p.name.toLowerCase().includes(term)
    const descMatch = p.description?.toLowerCase().includes(term)
    const contentMatch = p.content.toLowerCase().includes(term)
    const tagMatch = p.tags?.some(t => t.toLowerCase().includes(term))
    if (nameMatch || descMatch || contentMatch || tagMatch) {
      const snippet = extractSnippet(p.content, term, 120)
      results.push({
        id: p.id,
        name: p.name,
        description: p.description,
        snippet,
        content: p.content,
        tags: p.tags,
        workspaceRoot: p.workspaceRoot,
        updatedAt: p.updatedAt,
      })
    }
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt)
}

function extractSnippet(text: string, term: string, maxLen: number): string {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(term)
  if (idx === -1) return text.slice(0, maxLen)
  const start = Math.max(0, idx - maxLen / 2)
  const end = Math.min(text.length, idx + term.length + maxLen / 2)
  let snippet = text.slice(start, end)
  if (start > 0) snippet = '...' + snippet
  if (end < text.length) snippet = snippet + '...'
  return snippet
}

/** Format for Claude query prompt (English markers to avoid confusing the model). */
export function formatContextPackagesForPrompt(packages: ContextPackage[], userPrompt: string): string {
  if (!packages.length) return userPrompt
  const blocks = packages.map(
    p => `### Context package: ${p.name} (id: ${p.id})\n${p.content.trim()}`
  )
  return `${blocks.join('\n\n---\n\n')}\n\n### User message\n${userPrompt}`
}
