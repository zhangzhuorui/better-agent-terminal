import type { Workspace } from '../types'
import type { ContextPackage } from '../types/platform-extensions'

/** Normalize paths for grouping (case-insensitive, slashes unified, no trailing slash). */
export function normWorkspaceKey(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export interface ContextFolderGroup {
  key: string
  label: string
  folderPath: string
  workspaceId?: string
  isOpenWorkspace: boolean
  packages: ContextPackage[]
}

export interface ContextPackageTreeModel {
  open: ContextFolderGroup[]
  other: ContextFolderGroup[]
  global: ContextPackage[]
}

/**
 * Virtual tree: open workspaces (even if empty), other roots from package.workspaceRoot,
 * then global packages without workspaceRoot.
 */
export function groupContextPackagesForTree(
  packages: ContextPackage[],
  workspaces: Workspace[]
): ContextPackageTreeModel {
  const byPath = new Map<string, { displayPath: string; packages: ContextPackage[] }>()
  const global: ContextPackage[] = []

  for (const p of packages) {
    const r = p.workspaceRoot?.trim()
    if (!r) {
      global.push(p)
      continue
    }
    const k = normWorkspaceKey(r)
    if (!byPath.has(k)) {
      byPath.set(k, { displayPath: r, packages: [] })
    }
    byPath.get(k)!.packages.push(p)
  }

  const open: ContextFolderGroup[] = workspaces.map(w => {
    const k = normWorkspaceKey(w.folderPath)
    const bucket = byPath.get(k)
    if (bucket) byPath.delete(k)
    const pkgs = bucket?.packages ?? []
    pkgs.sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      key: `open:${w.id}`,
      label: w.alias || w.name,
      folderPath: w.folderPath,
      workspaceId: w.id,
      isOpenWorkspace: true,
      packages: pkgs,
    }
  })

  const other: ContextFolderGroup[] = [...byPath.values()]
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
    .map(b => {
      const base = b.displayPath.split(/[/\\]/).filter(Boolean).pop() || b.displayPath
      return {
        key: `other:${normWorkspaceKey(b.displayPath)}`,
        label: base,
        folderPath: b.displayPath,
        isOpenWorkspace: false,
        packages: b.packages.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      }
    })

  global.sort((a, b) => b.updatedAt - a.updatedAt)

  return { open, other, global }
}

export function filterPackagesByQuery(packages: ContextPackage[], q: string): ContextPackage[] {
  const s = q.trim().toLowerCase()
  if (!s) return packages
  return packages.filter(p => {
    const hay = [p.name, p.description, p.content, ...(p.tags || [])].join('\n').toLowerCase()
    return hay.includes(s)
  })
}

/** When searching, hide folders with no matching packages. */
export function filterContextTreeModel(model: ContextPackageTreeModel, q: string): ContextPackageTreeModel {
  const s = q.trim()
  if (!s) return model
  return {
    open: model.open
      .map(g => ({ ...g, packages: filterPackagesByQuery(g.packages, s) }))
      .filter(g => g.packages.length > 0),
    other: model.other
      .map(g => ({ ...g, packages: filterPackagesByQuery(g.packages, s) }))
      .filter(g => g.packages.length > 0),
    global: filterPackagesByQuery(model.global, s),
  }
}
