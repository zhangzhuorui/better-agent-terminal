import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { ContextInjectionPlan, ContextPackage, ResolvedContextBlock } from '../src/types/platform-extensions'
import { logger } from './logger'
import { generateContextMetadata } from './context-metadata-engine'

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
  const id = randomUUID()
  const name = input.name.trim() || 'Untitled'
  const description = input.description?.trim() || undefined
  const tags = input.tags?.length ? input.tags : undefined
  const generated = generateContextMetadata({ id, name, description, content: input.content, userTags: tags, workspaceRoot: wr || undefined })
  const pkg: ContextPackage = {
    id,
    name,
    description,
    content: input.content,
    tags,
    workspaceRoot: wr || undefined,
    createdAt: now,
    updatedAt: now,
    metadata: generated.metadata,
    chunks: generated.chunks,
    compressed: generated.compressed,
  }
  const f = await readFile()
  f.packages.push(pkg)
  await writeFile(f)
  logger.log(`[context-packages] created ${pkg.id} "${pkg.name}"`)
  return pkg
}

export async function updateContextPackage(
  id: string,
  updates: Partial<Pick<ContextPackage, 'name' | 'description' | 'content' | 'tags' | 'workspaceRoot'>>,
  saveVersion = true
): Promise<ContextPackage | null> {
  const f = await readFile()
  const idx = f.packages.findIndex(p => p.id === id)
  if (idx === -1) return null
  const cur = f.packages[idx]

  // Save version history before update
  let versions = cur.versions ? [...cur.versions] : []
  if (saveVersion && 'content' in updates && updates.content !== undefined && updates.content !== cur.content) {
    const nextVersionNum = versions.length > 0 ? versions[versions.length - 1].version + 1 : 1
    versions.push({
      version: nextVersionNum,
      content: cur.content,
      updatedAt: cur.updatedAt,
    })
    // Keep at most 20 versions
    if (versions.length > 20) versions = versions.slice(versions.length - 20)
  }

  const nextBase: ContextPackage = {
    ...cur,
    ...('name' in updates && updates.name !== undefined ? { name: updates.name.trim() || cur.name } : {}),
    ...('description' in updates ? { description: updates.description?.trim() || undefined } : {}),
    ...('content' in updates && updates.content !== undefined ? { content: updates.content } : {}),
    ...('tags' in updates ? { tags: updates.tags?.length ? updates.tags : undefined } : {}),
    ...('workspaceRoot' in updates
      ? { workspaceRoot: updates.workspaceRoot?.trim() ? updates.workspaceRoot.trim() : undefined }
      : {}),
    updatedAt: Date.now(),
    versions,
  }
  const metadataChanged = ['name', 'description', 'content', 'tags', 'workspaceRoot'].some(k => k in updates)
  const generated = metadataChanged
    ? generateContextMetadata({
      id: nextBase.id,
      name: nextBase.name,
      description: nextBase.description,
      content: nextBase.content,
      userTags: nextBase.tags,
      workspaceRoot: nextBase.workspaceRoot,
    })
    : null
  const next: ContextPackage = generated
    ? { ...nextBase, metadata: generated.metadata, chunks: generated.chunks, compressed: generated.compressed }
    : nextBase
  f.packages[idx] = next
  await writeFile(f)
  logger.log(`[context-packages] updated ${id} "${next.name}" (versions: ${versions.length})`)
  return next
}

export async function rollbackContextPackage(id: string, version: number): Promise<ContextPackage | null> {
  const f = await readFile()
  const idx = f.packages.findIndex(p => p.id === id)
  if (idx === -1) return null
  const cur = f.packages[idx]
  const target = cur.versions?.find(v => v.version === version)
  if (!target) return null

  const versions = cur.versions ? [...cur.versions] : []
  const nextVersionNum = versions.length > 0 ? versions[versions.length - 1].version + 1 : 1
  versions.push({
    version: nextVersionNum,
    content: cur.content,
    updatedAt: cur.updatedAt,
  })
  if (versions.length > 20) versions.slice(versions.length - 20)

  const generated = generateContextMetadata({
    id: cur.id,
    name: cur.name,
    description: cur.description,
    content: target.content,
    userTags: cur.tags,
    workspaceRoot: cur.workspaceRoot,
  })
  const next: ContextPackage = {
    ...cur,
    content: target.content,
    updatedAt: Date.now(),
    versions,
    metadata: generated.metadata,
    chunks: generated.chunks,
    compressed: generated.compressed,
  }
  f.packages[idx] = next
  await writeFile(f)
  logger.log(`[context-packages] rolled back ${id} to version ${version}`)
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

export async function generateMetadataForPackage(id: string): Promise<ContextPackage | null> {
  const f = await readFile()
  const idx = f.packages.findIndex(p => p.id === id)
  if (idx === -1) return null
  const cur = f.packages[idx]
  const generated = generateContextMetadata({
    id: cur.id,
    name: cur.name,
    description: cur.description,
    content: cur.content,
    userTags: cur.tags,
    workspaceRoot: cur.workspaceRoot,
  })
  const next: ContextPackage = { ...cur, metadata: generated.metadata, chunks: generated.chunks, compressed: generated.compressed, updatedAt: Date.now() }
  f.packages[idx] = next
  await writeFile(f)
  logger.log(`[context-packages] regenerated metadata for ${id}`)
  return next
}

export async function enrichAllContextPackageMetadata(): Promise<{ updated: number; total: number }> {
  const f = await readFile()
  let updated = 0
  f.packages = f.packages.map(pkg => {
    const hashMatches = pkg.metadata?.contentHash && pkg.metadata.contentHash === generateContextMetadata({ id: pkg.id, name: pkg.name, description: pkg.description, content: pkg.content, userTags: pkg.tags, workspaceRoot: pkg.workspaceRoot }).metadata.contentHash
    if (pkg.metadata?.metadataVersion && hashMatches) return pkg
    const generated = generateContextMetadata({
      id: pkg.id,
      name: pkg.name,
      description: pkg.description,
      content: pkg.content,
      userTags: pkg.tags,
      workspaceRoot: pkg.workspaceRoot,
    })
    updated += 1
    return { ...pkg, metadata: generated.metadata, chunks: generated.chunks, compressed: generated.compressed }
  })
  if (updated > 0) await writeFile(f)
  logger.log(`[context-packages] enriched metadata for ${updated}/${f.packages.length} packages`)
  return { updated, total: f.packages.length }
}

export async function getContextPackageMetadataStatus(): Promise<{ total: number; withMetadata: number; stale: number; missing: number }> {
  const f = await readFile()
  let withMetadata = 0
  let stale = 0
  for (const pkg of f.packages) {
    if (!pkg.metadata?.contentHash) continue
    withMetadata += 1
    const generated = generateContextMetadata({ id: pkg.id, name: pkg.name, description: pkg.description, content: pkg.content, userTags: pkg.tags, workspaceRoot: pkg.workspaceRoot })
    if (generated.metadata.contentHash !== pkg.metadata.contentHash) stale += 1
  }
  return { total: f.packages.length, withMetadata, stale, missing: f.packages.length - withMetadata }
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

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function formatResolvedContextForPrompt(blocks: ResolvedContextBlock[], userPrompt: string, _plan?: ContextInjectionPlan): string {
  if (!blocks.length) return userPrompt
  const rendered = blocks.map(block => {
    const tags = block.tags?.length ? `Tags: ${block.tags.join(', ')}\n` : ''
    const summary = block.summary ? `Summary: ${block.summary}\n` : ''
    return `<context-block source="${block.source}" id="${escapeAttr(block.packageId)}" title="${escapeAttr(block.title)}" compression="${block.compression}" tokens="${block.tokenEstimate}">\n${summary}${tags}Content:\n${block.content.trim()}\n</context-block>`
  })
  return `### Retrieved Context\nThe following context was selected, rule-injected, or automatically retrieved. Some content may be compressed.\n\n${rendered.join('\n\n')}\n\n### User message\n${userPrompt}`
}
