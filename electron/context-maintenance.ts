import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { logger } from './logger'
import * as contextPackageStore from './context-package-store'
import * as contextMemoryStore from './context-memory-store'
import { invalidateContextPackageIndex } from './context-package-index'
import type { ContextPackage } from '../src/types/platform-extensions'

export interface ContextMaintenanceReport {
  archivedPackages: string[]
  mergedPackages: string[]
  deletedPackages: string[]
  prunedMemoryEntries: number
}

const DEFAULT_STALE_DAYS = 90
const DEFAULT_MEMORY_DECAY_DAYS = 30

function hashContent(text: string): string {
  // Simple stable hash; collisions across packages are unlikely for real content.
  let h = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h = ((h << 5) - h + c) | 0
  }
  return String(h)
}

async function ensureArchiveDir(): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'context-archives')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function archivePackage(pkg: ContextPackage, reason: string): Promise<void> {
  const dir = await ensureArchiveDir()
  const file = path.join(dir, `${pkg.id}.json`)
  await fs.writeFile(
    file,
    JSON.stringify({ ...pkg, archived: true, archivedAt: Date.now(), archiveReason: reason }, null, 2),
    'utf-8'
  )
}

export async function runContextMaintenance(options?: {
  dryRun?: boolean
  staleDays?: number
  memoryDecayDays?: number
}): Promise<ContextMaintenanceReport> {
  const dryRun = options?.dryRun ?? false
  const staleDays = options?.staleDays ?? DEFAULT_STALE_DAYS
  const memoryDecayDays = options?.memoryDecayDays ?? DEFAULT_MEMORY_DECAY_DAYS

  const report: ContextMaintenanceReport = {
    archivedPackages: [],
    mergedPackages: [],
    deletedPackages: [],
    prunedMemoryEntries: 0,
  }

  const packages = await contextPackageStore.listContextPackages()
  const now = Date.now()
  const staleCutoff = now - staleDays * 86400000

  // Archive old, unused packages
  for (const pkg of packages) {
    if (pkg.archived) continue
    const lastUsed = pkg.lastUsedAt ?? pkg.updatedAt
    const isStale = lastUsed < staleCutoff
    const hasUsage = (pkg.usageCount ?? 0) > 0
    if (isStale && !hasUsage) {
      if (!dryRun) {
        await archivePackage(pkg, `stale for ${staleDays} days`)
        await contextPackageStore.updateContextPackage(pkg.id, { archived: true })
        invalidateContextPackageIndex()
      }
      report.archivedPackages.push(pkg.id)
    }
  }

  // Merge duplicate non-archived packages by content hash
  const byHash = new Map<string, ContextPackage[]>()
  for (const pkg of packages) {
    if (pkg.archived) continue
    const hash = pkg.metadata?.contentHash ?? hashContent(pkg.content)
    const list = byHash.get(hash) ?? []
    list.push(pkg)
    byHash.set(hash, list)
  }

  for (const [, list] of byHash) {
    if (list.length < 2) continue
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    const [keeper, ...dupes] = list
    const mergedTags = new Set<string>([...(keeper.tags ?? []), ...(keeper.metadata?.autoTags ?? []), ...(keeper.metadata?.keywords ?? [])])
    for (const dupe of dupes) {
      for (const t of [...(dupe.tags ?? []), ...(dupe.metadata?.autoTags ?? []), ...(dupe.metadata?.keywords ?? [])]) {
        mergedTags.add(t)
      }
    }
    const tagsArray = [...mergedTags].slice(0, 32)
    if (!dryRun) {
      await contextPackageStore.updateContextPackage(keeper.id, { tags: tagsArray })
      for (const dupe of dupes) {
        await archivePackage(dupe, `merged into ${keeper.id}`)
        await contextPackageStore.updateContextPackage(dupe.id, { archived: true })
      }
      invalidateContextPackageIndex()
    }
    report.mergedPackages.push(...dupes.map(p => p.id))
  }

  // Prune very old archived packages and memory entries
  const archiveDir = await ensureArchiveDir()
  try {
    const files = await fs.readdir(archiveDir)
    const deleteCutoff = now - (memoryDecayDays + staleDays) * 86400000
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(archiveDir, file)
      const stat = await fs.stat(filePath)
      if (stat.mtimeMs < deleteCutoff) {
        if (!dryRun) await fs.unlink(filePath)
        report.deletedPackages.push(file.replace(/\.json$/, ''))
      }
    }
  } catch {
    // ignore archive dir errors
  }

  if (!dryRun) {
    report.prunedMemoryEntries = await contextMemoryStore.pruneMemoryEntries(memoryDecayDays)
  }

  logger.log(
    `[context-maintenance] dryRun=${dryRun} archived=${report.archivedPackages.length} merged=${report.mergedPackages.length} deleted=${report.deletedPackages.length} memoryPruned=${report.prunedMemoryEntries}`
  )
  return report
}
