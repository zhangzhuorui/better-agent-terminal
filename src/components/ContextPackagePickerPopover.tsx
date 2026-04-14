import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace } from '../types'
import {
  groupContextPackagesForTree,
  filterContextTreeModel,
  type ContextFolderGroup,
} from '../utils/context-package-tree'

export interface ContextPackagePickerPopoverProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  packages: ContextPackage[]
  workspaces: Workspace[]
  /** Highlight folder for this workspace (current agent tab). */
  terminalWorkspaceId?: string
  selectedIds: string[]
  onClose: () => void
  onApply: (ids: string[]) => void
}

export function ContextPackagePickerPopover({
  open,
  anchorRef,
  packages,
  workspaces,
  terminalWorkspaceId,
  selectedIds,
  onClose,
  onApply,
}: Readonly<ContextPackagePickerPopoverProps>) {
  const { t } = useTranslation()
  const popRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<string[]>(selectedIds)

  useEffect(() => {
    if (open) setDraft(selectedIds)
  }, [open, selectedIds])

  const baseTree = useMemo(() => groupContextPackagesForTree(packages, workspaces), [packages, workspaces])
  const tree = useMemo(() => filterContextTreeModel(baseTree, search), [baseTree, search])

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!open) return
    const next = new Set<string>()
    tree.open.forEach(g => next.add(g.key))
    tree.other.forEach(g => next.add(g.key))
    next.add('section-global')
    setExpanded(next)
  }, [open, tree.open, tree.other])

  const toggleFolder = useCallback((key: string) => {
    setExpanded(prev => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])

  const togglePkg = useCallback((id: string) => {
    setDraft(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
  }, [open, onClose, anchorRef])

  const [pos, setPos] = useState({ top: 0, left: 0, width: 360 })

  useEffect(() => {
    if (!open) return
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const w = Math.min(400, Math.max(300, window.innerWidth - 24))
    let left = r.left
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8
    if (left < 8) left = 8
    let top = r.bottom + 6
    const maxH = 380
    if (top + maxH > window.innerHeight - 8) top = Math.max(8, r.top - maxH - 6)
    setPos({ top, left, width: w })
  }, [open, anchorRef])

  if (!open) return null

  const renderFolder = (g: ContextFolderGroup, sectionOther: boolean) => {
    const isExpanded = expanded.has(g.key)
    const isTerminalWs = terminalWorkspaceId && g.workspaceId === terminalWorkspaceId
    return (
      <div
        key={g.key}
        className={`ctx-pkg-tree-folder${isTerminalWs ? ' ctx-pkg-tree-folder--terminal' : ''}${sectionOther ? ' ctx-pkg-tree-folder--other' : ''}`}
      >
        <button
          type="button"
          className="ctx-pkg-tree-folder-head"
          onClick={() => toggleFolder(g.key)}
          aria-expanded={isExpanded}
        >
          <span className="ctx-pkg-tree-chevron">{isExpanded ? '\u25BC' : '\u25B6'}</span>
          <span className="ctx-pkg-tree-folder-title">{g.label}</span>
          {isTerminalWs && <span className="ctx-pkg-tree-badge">{t('claude.contextPickerThisProject')}</span>}
          <span className="ctx-pkg-tree-count">{g.packages.length}</span>
        </button>
        {isExpanded && (
          <div className="ctx-pkg-tree-folder-body">
            {g.packages.length === 0 ? (
              <div className="ctx-pkg-tree-empty">{t('platform.context.treeFolderEmpty')}</div>
            ) : (
              g.packages.map(p => (
                <label key={p.id} className="ctx-pkg-tree-item">
                  <input type="checkbox" checked={draft.includes(p.id)} onChange={() => togglePkg(p.id)} />
                  <span className="ctx-pkg-tree-item-name">{p.name}</span>
                  {p.workspaceRoot && sectionOther && (
                    <span className="ctx-pkg-tree-item-hint" title={p.workspaceRoot}>
                      {t('claude.contextPickerCrossProject')}
                    </span>
                  )}
                </label>
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  const globalExpanded = expanded.has('section-global')

  return (
    <div
      ref={popRef}
      className="ctx-pkg-picker-popover"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      role="dialog"
      aria-label={t('claude.contextPackagesBrowse')}
    >
      <div className="ctx-pkg-picker-head">
        <input
          type="search"
          className="ctx-pkg-picker-search"
          placeholder={t('claude.contextPickerSearchPh')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      <div className="ctx-pkg-picker-body">
        <div className="ctx-pkg-tree-section-label">{t('platform.context.treeOpenWorkspaces')}</div>
        {tree.open.length === 0 ? (
          <div className="ctx-pkg-tree-empty">{t('platform.context.treeNoWorkspaces')}</div>
        ) : (
          tree.open.map(g => renderFolder(g, false))
        )}

        {tree.other.length > 0 && (
          <>
            <div className="ctx-pkg-tree-section-label ctx-pkg-tree-section-label--spaced">
              {t('platform.context.treeOtherRoots')}
            </div>
            {tree.other.map(g => renderFolder(g, true))}
          </>
        )}

        <div className="ctx-pkg-tree-section-label ctx-pkg-tree-section-label--spaced">
          {t('platform.context.treeGlobal')}
        </div>
        <div className="ctx-pkg-tree-folder">
          <button
            type="button"
            className="ctx-pkg-tree-folder-head"
            onClick={() => toggleFolder('section-global')}
            aria-expanded={globalExpanded}
          >
            <span className="ctx-pkg-tree-chevron">{globalExpanded ? '\u25BC' : '\u25B6'}</span>
            <span className="ctx-pkg-tree-folder-title">{t('platform.context.treeGlobalPackages')}</span>
            <span className="ctx-pkg-tree-count">{tree.global.length}</span>
          </button>
          {globalExpanded && (
            <div className="ctx-pkg-tree-folder-body">
              {tree.global.length === 0 ? (
                <div className="ctx-pkg-tree-empty">{t('platform.context.treeFolderEmpty')}</div>
              ) : (
                tree.global.map(p => (
                  <label key={p.id} className="ctx-pkg-tree-item">
                    <input type="checkbox" checked={draft.includes(p.id)} onChange={() => togglePkg(p.id)} />
                    <span className="ctx-pkg-tree-item-name">{p.name}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      <div className="ctx-pkg-picker-footer">
        <span className="ctx-pkg-picker-summary">{t('claude.contextPickerSelectedCount', { count: draft.length })}</span>
        <div className="ctx-pkg-picker-actions">
          <button type="button" className="ctx-pkg-picker-btn ctx-pkg-picker-btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="ctx-pkg-picker-btn ctx-pkg-picker-btn--primary"
            onClick={() => {
              onApply(draft)
              onClose()
            }}
          >
            {t('claude.contextPickerApply')}
          </button>
        </div>
      </div>
    </div>
  )
}
