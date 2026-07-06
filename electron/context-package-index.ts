import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { ContextPackage, ContextPackageChunk, ContextPackageMetadata } from '../src/types/platform-extensions'
import { listContextPackages, getContextPackage } from './context-package-store'
import { generateContextMetadata } from './context-metadata-engine'
import { deleteCacheByPrefix } from './context-cache'

const INDEX_FILE = 'context-package-index.json'

export interface ContextPackageIndexEntry {
  packageId: string
  contentHash: string
  updatedAt: number
  workspaceRoot?: string
  tokens: number
  termFreq: Record<string, number>
  searchableText: string
  metadata?: ContextPackageMetadata
  chunks?: ContextPackageChunk[]
}

interface IndexFileShape {
  version: 1
  entries: ContextPackageIndexEntry[]
}

function indexPath(): string {
  return path.join(app.getPath('userData'), INDEX_FILE)
}

function normalizeTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_./-]+|_/)
    .map(t => t.trim())
    .filter(t => t.length >= 2)
}

function termFreq(text: string): Record<string, number> {
  const freq: Record<string, number> = {}
  for (const token of normalizeTokens(text)) freq[token] = (freq[token] ?? 0) + 1
  return freq
}

function searchableText(pkg: ContextPackage): string {
  return [
    pkg.name,
    pkg.description,
    pkg.tags?.join(' '),
    pkg.metadata?.summary,
    pkg.metadata?.shortSummary,
    pkg.metadata?.autoTags?.join(' '),
    pkg.metadata?.keywords?.join(' '),
    pkg.metadata?.relatedFiles?.join(' '),
    pkg.content,
  ].filter(Boolean).join('\n')
}

function buildEntry(pkg: ContextPackage): ContextPackageIndexEntry {
  const generated = pkg.metadata?.contentHash
    ? null
    : generateContextMetadata({ id: pkg.id, name: pkg.name, description: pkg.description, content: pkg.content, userTags: pkg.tags, workspaceRoot: pkg.workspaceRoot })
  const metadata = pkg.metadata ?? generated?.metadata
  const chunks = pkg.chunks ?? generated?.chunks
  const text = searchableText({ ...pkg, metadata, chunks })
  return {
    packageId: pkg.id,
    contentHash: metadata?.contentHash ?? '',
    updatedAt: pkg.updatedAt,
    workspaceRoot: pkg.workspaceRoot,
    tokens: metadata?.tokenEstimate ?? Math.ceil(pkg.content.length / 4),
    termFreq: termFreq(text),
    searchableText: text,
    metadata,
    chunks,
  }
}

async function readIndex(): Promise<IndexFileShape> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as IndexFileShape
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] }
    return parsed
  } catch {
    return { version: 1, entries: [] }
  }
}

async function writeIndex(data: IndexFileShape): Promise<void> {
  const p = indexPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

export async function getOrBuildContextPackageIndex(): Promise<ContextPackageIndexEntry[]> {
  const packages = (await listContextPackages()).filter(p => !p.archived)
  const index = await readIndex()
  const byId = new Map(index.entries.map(e => [e.packageId, e]))
  let changed = false
  const entries = packages.map(pkg => {
    const existing = byId.get(pkg.id)
    if (existing && existing.contentHash && existing.contentHash === pkg.metadata?.contentHash) return existing
    changed = true
    return buildEntry(pkg)
  })
  if (changed || entries.length !== index.entries.length) await writeIndex({ version: 1, entries })
  return entries
}

export function invalidateContextPackageIndex(packageId?: string): void {
  deleteCacheByPrefix('recommend:')
  deleteCacheByPrefix('plan:')
  if (!packageId) deleteCacheByPrefix('index:')
}

export async function rebuildContextPackageIndex(packageId?: string): Promise<ContextPackageIndexEntry[]> {
  if (packageId) {
    const pkg = await getContextPackage(packageId)
    const index = await readIndex()
    const entries = index.entries.filter(e => e.packageId !== packageId)
    if (pkg) entries.push(buildEntry(pkg))
    await writeIndex({ version: 1, entries })
    invalidateContextPackageIndex(packageId)
    return entries
  }
  const entries = (await listContextPackages()).map(buildEntry)
  await writeIndex({ version: 1, entries })
  invalidateContextPackageIndex()
  return entries
}
