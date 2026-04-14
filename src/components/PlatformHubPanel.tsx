import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { v4 as uuidv4 } from 'uuid'
import type {
  ContextPackage,
  PlatformAnalyticsSummary,
  AutomationJob,
  AutomationPermissionMode,
  AutomationPromptDelivery,
} from '../types/platform-extensions'
import type { Workspace } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { groupContextPackagesForTree, filterContextTreeModel, type ContextFolderGroup } from '../utils/context-package-tree'

type TabId = 'dashboard' | 'context' | 'automation'
type ContextPaneId = 'library' | 'create'

interface PlatformHubPanelProps {
  onClose: () => void
}

const PERMISSION_MODES: AutomationPermissionMode[] = [
  'bypassPermissions',
  'acceptEdits',
  'default',
  'plan',
  'bypassPlan',
]

const WEEKDAYS = [
  { v: 0, k: 'sun' },
  { v: 1, k: 'mon' },
  { v: 2, k: 'tue' },
  { v: 3, k: 'wed' },
  { v: 4, k: 'thu' },
  { v: 5, k: 'fri' },
  { v: 6, k: 'sat' },
]

export function PlatformHubPanel({ onClose }: PlatformHubPanelProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabId>('dashboard')
  const [summary, setSummary] = useState<PlatformAnalyticsSummary | null>(null)
  const [packages, setPackages] = useState<ContextPackage[]>([])
  const [jobs, setJobs] = useState<AutomationJob[]>([])
  const [editingPkg, setEditingPkg] = useState<ContextPackage | null>(null)
  const [pkgForm, setPkgForm] = useState({ name: '', description: '', content: '', tags: '' })
  const [terminals, setTerminals] = useState(() => workspaceStore.getState().terminals)
  const [jobForm, setJobForm] = useState({
    name: '',
    runAtLocal: '02:00',
    terminalId: '',
    prompt: '',
    promptDelivery: 'plain' as AutomationPromptDelivery,
    loopInterval: '',
    weekdays: [] as number[],
    permissionMode: 'bypassPermissions' as AutomationPermissionMode,
    contextPackageIds: [] as string[],
    enabled: true,
  })
  const [automationMsg, setAutomationMsg] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => workspaceStore.getState().workspaces)
  const [contextPane, setContextPane] = useState<ContextPaneId>('library')
  const [pkgBindRoot, setPkgBindRoot] = useState('')
  const [libSearch, setLibSearch] = useState('')
  const [libExpanded, setLibExpanded] = useState<Set<string>>(() => new Set())
  const [libSelectedId, setLibSelectedId] = useState<string | null>(null)

  const refreshAnalytics = useCallback(() => {
    window.electronAPI.analytics.getSummary().then((s: unknown) => {
      if (s && typeof s === 'object') setSummary(s as PlatformAnalyticsSummary)
    }).catch(() => setSummary(null))
  }, [])

  const refreshPackages = useCallback(() => {
    window.electronAPI.contextPackage.list().then((list: unknown) => {
      if (Array.isArray(list)) setPackages(list as ContextPackage[])
    }).catch(() => setPackages([]))
  }, [])

  const refreshJobs = useCallback(() => {
    window.electronAPI.automation.list().then((list: unknown) => {
      if (Array.isArray(list)) setJobs(list as AutomationJob[])
    }).catch(() => setJobs([]))
  }, [])

  useEffect(() => {
    refreshAnalytics()
    refreshPackages()
    refreshJobs()
  }, [refreshAnalytics, refreshPackages, refreshJobs])

  useEffect(() => {
    return workspaceStore.subscribe(() => {
      const st = workspaceStore.getState()
      setTerminals(st.terminals)
      setWorkspaces(st.workspaces)
    })
  }, [])

  const treeModel = useMemo(() => groupContextPackagesForTree(packages, workspaces), [packages, workspaces])
  const filteredLibTree = useMemo(() => filterContextTreeModel(treeModel, libSearch), [treeModel, libSearch])
  const libSelectedPkg = useMemo(
    () => (libSelectedId ? packages.find(p => p.id === libSelectedId) ?? null : null),
    [libSelectedId, packages]
  )

  const toggleLibFolder = useCallback((key: string) => {
    setLibExpanded(prev => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])

  const prevContextPane = useRef(contextPane)
  useEffect(() => {
    if (contextPane === 'library' && prevContextPane.current !== 'library') {
      const s = new Set<string>()
      treeModel.open.forEach(g => s.add(g.key))
      treeModel.other.forEach(g => s.add(g.key))
      s.add('section-global')
      setLibExpanded(s)
    }
    prevContextPane.current = contextPane
  }, [contextPane, treeModel])

  const claudeTerminals = useMemo(
    () => terminals.filter(t => t.agentPreset === 'claude-code'),
    [terminals]
  )

  const last7Days = useMemo(() => {
    const out: string[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      out.push(`${y}-${m}-${day}`)
    }
    return out
  }, [])

  const handleSavePackage = async () => {
    const wr = pkgBindRoot.trim() || undefined
    const tagList = pkgForm.tags ? pkgForm.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined
    if (editingPkg) {
      const u = await window.electronAPI.contextPackage.update(editingPkg.id, {
        name: pkgForm.name,
        description: pkgForm.description || undefined,
        content: pkgForm.content,
        tags: tagList,
        workspaceRoot: wr,
      })
      if (u) {
        setPackages(prev => prev.map(p => (p.id === editingPkg.id ? (u as ContextPackage) : p)))
        setEditingPkg(null)
        setPkgForm({ name: '', description: '', content: '', tags: '' })
        setPkgBindRoot('')
      }
    } else {
      const c = await window.electronAPI.contextPackage.create({
        name: pkgForm.name,
        description: pkgForm.description || undefined,
        content: pkgForm.content,
        tags: tagList,
        workspaceRoot: wr,
      })
      if (c) {
        setPackages(prev => [c as ContextPackage, ...prev])
        setPkgForm({ name: '', description: '', content: '', tags: '' })
        setPkgBindRoot('')
      }
    }
  }

  const handleDeletePackage = async (id: string) => {
    if (!confirm(t('platform.context.deleteConfirm'))) return
    const ok = await window.electronAPI.contextPackage.delete(id)
    if (ok) {
      setPackages(prev => prev.filter(p => p.id !== id))
      if (libSelectedId === id) setLibSelectedId(null)
    }
  }

  const openEditPackage = (p: ContextPackage) => {
    setEditingPkg(p)
    setPkgForm({
      name: p.name,
      description: p.description || '',
      content: p.content,
      tags: p.tags?.join(', ') || '',
    })
    setPkgBindRoot(p.workspaceRoot || '')
    setContextPane('create')
  }

  const renderLibFolderRow = (g: ContextFolderGroup, isOtherRoot: boolean) => {
    const ex = libExpanded.has(g.key)
    return (
      <div key={g.key} className={`platform-lib-folder${isOtherRoot ? ' platform-lib-folder--other' : ''}`}>
        <button type="button" className="platform-lib-folder-head" onClick={() => toggleLibFolder(g.key)}>
          <span className="platform-lib-chevron">{ex ? '\u25BC' : '\u25B6'}</span>
          <span className="platform-lib-folder-title">{g.label}</span>
          <span className="platform-lib-count">{g.packages.length}</span>
        </button>
        {ex && (
          <div className="platform-lib-folder-body">
            {g.packages.length === 0 ? (
              <div className="platform-lib-empty">{t('platform.context.treeFolderEmpty')}</div>
            ) : (
              g.packages.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`platform-lib-pkg-row${libSelectedId === p.id ? ' selected' : ''}`}
                  onClick={() => setLibSelectedId(p.id)}
                >
                  {p.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  const persistJobs = async (next: AutomationJob[]) => {
    await window.electronAPI.automation.saveAll(next)
    setJobs(next)
  }

  const addJob = async () => {
    if (!jobForm.terminalId) {
      setAutomationMsg(t('platform.automation.fillTerminal'))
      return
    }
    if (jobForm.promptDelivery !== 'claude_loop' && !jobForm.prompt.trim()) {
      setAutomationMsg(t('platform.automation.fillPromptPlain'))
      return
    }
    const loopIv = jobForm.loopInterval.trim()
    const job: AutomationJob = {
      id: uuidv4(),
      name: jobForm.name.trim() || t('platform.automation.untitledJob'),
      enabled: jobForm.enabled,
      runAtLocal: jobForm.runAtLocal,
      weekdays: jobForm.weekdays.length ? jobForm.weekdays : undefined,
      terminalId: jobForm.terminalId,
      prompt: jobForm.prompt.trim(),
      ...(jobForm.promptDelivery === 'claude_loop'
        ? {
            promptDelivery: 'claude_loop' as const,
            ...(loopIv ? { loopInterval: loopIv } : {}),
          }
        : {}),
      contextPackageIds: jobForm.contextPackageIds.length ? jobForm.contextPackageIds : undefined,
      permissionMode: jobForm.permissionMode,
    }
    await persistJobs([...jobs, job])
    setAutomationMsg(t('platform.automation.saved'))
    setJobForm(f => ({
      ...f,
      name: '',
      prompt: '',
      loopInterval: '',
    }))
  }

  const toggleJobEnabled = async (id: string) => {
    const next = jobs.map(j => (j.id === id ? { ...j, enabled: !j.enabled } : j))
    await persistJobs(next)
  }

  const removeJob = async (id: string) => {
    if (!confirm(t('platform.automation.deleteConfirm'))) return
    await persistJobs(jobs.filter(j => j.id !== id))
  }

  const runJobNow = async (id: string) => {
    setAutomationMsg(null)
    const r = await window.electronAPI.automation.runNow(id)
    if (r.ok) setAutomationMsg(t('platform.automation.runOk'))
    else setAutomationMsg(r.error || t('platform.automation.runFail'))
    refreshJobs()
    refreshAnalytics()
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel platform-hub-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('platform.title')}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label={t('common.close')}>
            &times;
          </button>
        </div>

        <div className="platform-hub-tabs">
          <button type="button" className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>
            {t('platform.tab.dashboard')}
          </button>
          <button type="button" className={tab === 'context' ? 'active' : ''} onClick={() => setTab('context')}>
            {t('platform.tab.context')}
          </button>
          <button type="button" className={tab === 'automation' ? 'active' : ''} onClick={() => setTab('automation')}>
            {t('platform.tab.automation')}
          </button>
        </div>

        <div className="settings-body platform-hub-body">
          {tab === 'dashboard' && (
            <div className="platform-section">
              <p className="platform-muted">{t('platform.dashboard.hint')}</p>
              {summary && (
                <>
                  <div className="platform-stat-grid">
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.userMessages')}</span>
                      <span className="platform-stat-value">{summary.totals.userMessages}</span>
                    </div>
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.autoMessages')}</span>
                      <span className="platform-stat-value">{summary.totals.automationUserMessages}</span>
                    </div>
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.agentTurns')}</span>
                      <span className="platform-stat-value">{summary.totals.agentTurns}</span>
                    </div>
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.inputTokens')}</span>
                      <span className="platform-stat-value">{summary.totals.inputTokens.toLocaleString()}</span>
                    </div>
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.outputTokens')}</span>
                      <span className="platform-stat-value">{summary.totals.outputTokens.toLocaleString()}</span>
                    </div>
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.costUsd')}</span>
                      <span className="platform-stat-value">${summary.totals.costUsd.toFixed(4)}</span>
                    </div>
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.autoRuns')}</span>
                      <span className="platform-stat-value">{summary.totals.automationRuns}</span>
                    </div>
                    <div className="platform-stat-card">
                      <span className="platform-stat-label">{t('platform.dashboard.autoFails')}</span>
                      <span className="platform-stat-value">{summary.totals.automationFailures}</span>
                    </div>
                  </div>
                  <h3 className="platform-subhead">{t('platform.dashboard.last7')}</h3>
                  <div className="platform-table-wrap">
                    <table className="platform-table">
                      <thead>
                        <tr>
                          <th>{t('platform.dashboard.col.date')}</th>
                          <th>{t('platform.dashboard.col.userMsg')}</th>
                          <th>{t('platform.dashboard.col.turns')}</th>
                          <th>{t('platform.dashboard.col.tokens')}</th>
                          <th>{t('platform.dashboard.col.cost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {last7Days.map(day => {
                          const row = summary.byDay[day]
                          return (
                            <tr key={day}>
                              <td>{day}</td>
                              <td>{row ? row.userMessages + row.automationUserMessages : 0}</td>
                              <td>{row?.agentTurns ?? 0}</td>
                              <td>{row ? (row.inputTokens + row.outputTokens).toLocaleString() : 0}</td>
                              <td>{row ? `$${row.costUsd.toFixed(4)}` : '$0'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <div className="platform-dashboard-actions">
                <button type="button" className="settings-save-btn" onClick={refreshAnalytics}>
                  {t('platform.dashboard.refresh')}
                </button>
              </div>
            </div>
          )}

          {tab === 'context' && (
            <div className="platform-section">
              <p className="platform-muted">{t('platform.context.hintFull')}</p>
              <div className="platform-context-subtabs">
                <button
                  type="button"
                  className={contextPane === 'library' ? 'active' : ''}
                  onClick={() => setContextPane('library')}
                >
                  {t('platform.context.tabLibrary')}
                </button>
                <button
                  type="button"
                  className={contextPane === 'create' ? 'active' : ''}
                  onClick={() => setContextPane('create')}
                >
                  {t('platform.context.tabCreate')}
                </button>
              </div>

              {contextPane === 'create' && (
                <div className="platform-form platform-card">
                  <h3 className="platform-subhead">{editingPkg ? t('platform.context.edit') : t('platform.context.create')}</h3>
                  <label>
                    {t('platform.context.bindWorkspace')}
                    <select value={pkgBindRoot} onChange={e => setPkgBindRoot(e.target.value)}>
                      <option value="">{t('platform.context.bindGlobal')}</option>
                      {workspaces.map(w => (
                        <option key={w.id} value={w.folderPath}>
                          {w.alias || w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('platform.context.name')}
                    <input
                      value={pkgForm.name}
                      onChange={e => setPkgForm(f => ({ ...f, name: e.target.value }))}
                      placeholder={t('platform.context.namePh')}
                    />
                  </label>
                  <label>
                    {t('platform.context.description')}
                    <input
                      value={pkgForm.description}
                      onChange={e => setPkgForm(f => ({ ...f, description: e.target.value }))}
                    />
                  </label>
                  <label>
                    {t('platform.context.tags')}
                    <input
                      value={pkgForm.tags}
                      onChange={e => setPkgForm(f => ({ ...f, tags: e.target.value }))}
                      placeholder={t('platform.context.tagsPh')}
                    />
                  </label>
                  <label>
                    {t('platform.context.content')}
                    <textarea
                      rows={8}
                      value={pkgForm.content}
                      onChange={e => setPkgForm(f => ({ ...f, content: e.target.value }))}
                    />
                  </label>
                  <div className="platform-form-actions">
                    <button type="button" className="settings-save-btn" onClick={() => void handleSavePackage()}>
                      {t('platform.context.save')}
                    </button>
                    {editingPkg && (
                      <button
                        type="button"
                        className="settings-cancel-btn"
                        onClick={() => {
                          setEditingPkg(null)
                          setPkgForm({ name: '', description: '', content: '', tags: '' })
                          setPkgBindRoot('')
                        }}
                      >
                        {t('platform.context.cancelEdit')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {contextPane === 'library' && (
                <div className="platform-context-library">
                  <div className="platform-context-library-toolbar">
                    <input
                      type="search"
                      className="platform-context-lib-search"
                      placeholder={t('platform.context.libSearchPh')}
                      value={libSearch}
                      onChange={e => setLibSearch(e.target.value)}
                    />
                    <button
                      type="button"
                      className="settings-save-btn platform-context-new-btn"
                      onClick={() => {
                        setEditingPkg(null)
                        setPkgForm({ name: '', description: '', content: '', tags: '' })
                        setPkgBindRoot('')
                        setContextPane('create')
                      }}
                    >
                      {t('platform.context.newPackage')}
                    </button>
                  </div>
                  <div className="platform-context-library-split">
                    <div className="platform-context-library-tree platform-card">
                      <div className="platform-lib-section-label">{t('platform.context.treeOpenWorkspaces')}</div>
                      {workspaces.length === 0 ? (
                        <div className="platform-lib-empty">{t('platform.context.treeNoWorkspaces')}</div>
                      ) : (
                        filteredLibTree.open.map(g => renderLibFolderRow(g, false))
                      )}
                      {filteredLibTree.other.length > 0 && (
                        <>
                          <div className="platform-lib-section-label platform-lib-section-label--spaced">
                            {t('platform.context.treeOtherRoots')}
                          </div>
                          {filteredLibTree.other.map(g => renderLibFolderRow(g, true))}
                        </>
                      )}
                      <div className="platform-lib-section-label platform-lib-section-label--spaced">
                        {t('platform.context.treeGlobal')}
                      </div>
                      <div className="platform-lib-folder">
                        <button
                          type="button"
                          className="platform-lib-folder-head"
                          onClick={() => toggleLibFolder('section-global')}
                        >
                          <span className="platform-lib-chevron">{libExpanded.has('section-global') ? '\u25BC' : '\u25B6'}</span>
                          <span className="platform-lib-folder-title">{t('platform.context.treeGlobalPackages')}</span>
                          <span className="platform-lib-count">{filteredLibTree.global.length}</span>
                        </button>
                        {libExpanded.has('section-global') && (
                          <div className="platform-lib-folder-body">
                            {filteredLibTree.global.length === 0 ? (
                              <div className="platform-lib-empty">{t('platform.context.treeFolderEmpty')}</div>
                            ) : (
                              filteredLibTree.global.map(p => (
                                <button
                                  key={p.id}
                                  type="button"
                                  className={`platform-lib-pkg-row${libSelectedId === p.id ? ' selected' : ''}`}
                                  onClick={() => setLibSelectedId(p.id)}
                                >
                                  {p.name}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="platform-context-library-detail platform-card">
                      {!libSelectedPkg ? (
                        <p className="platform-muted">{t('platform.context.libPickHint')}</p>
                      ) : (
                        <>
                          <h3 className="platform-lib-detail-title">{libSelectedPkg.name}</h3>
                          {libSelectedPkg.description && (
                            <p className="platform-lib-detail-desc">{libSelectedPkg.description}</p>
                          )}
                          {libSelectedPkg.workspaceRoot ? (
                            <div className="platform-lib-detail-path" title={libSelectedPkg.workspaceRoot}>
                              {t('platform.context.libBoundPath')}: {libSelectedPkg.workspaceRoot}
                            </div>
                          ) : (
                            <div className="platform-lib-detail-path">{t('platform.context.libGlobalBadge')}</div>
                          )}
                          {libSelectedPkg.tags && libSelectedPkg.tags.length > 0 && (
                            <div className="platform-pkg-tags">
                              {libSelectedPkg.tags.map(tag => (
                                <span key={tag} className="platform-tag">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                          <pre className="platform-lib-detail-preview">{libSelectedPkg.content.slice(0, 2000)}{libSelectedPkg.content.length > 2000 ? '\n…' : ''}</pre>
                          <div className="platform-lib-detail-meta">{libSelectedPkg.id}</div>
                          <div className="platform-form-actions platform-lib-detail-actions">
                            <button type="button" className="settings-save-btn" onClick={() => openEditPackage(libSelectedPkg)}>
                              {t('platform.context.editBtn')}
                            </button>
                            <button
                              type="button"
                              className="settings-danger-btn"
                              onClick={() => void handleDeletePackage(libSelectedPkg.id)}
                            >
                              {t('platform.context.deleteBtn')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'automation' && (
            <div className="platform-section">
              <p className="platform-muted">{t('platform.automation.hint')}</p>
              {automationMsg && <div className="platform-banner">{automationMsg}</div>}
              <div className="platform-form platform-card">
                <h3 className="platform-subhead">{t('platform.automation.newJob')}</h3>
                <label>
                  {t('platform.automation.jobName')}
                  <input
                    value={jobForm.name}
                    onChange={e => setJobForm(f => ({ ...f, name: e.target.value }))}
                  />
                </label>
                <label>
                  {t('platform.automation.runAt')}
                  <input
                    value={jobForm.runAtLocal}
                    onChange={e => setJobForm(f => ({ ...f, runAtLocal: e.target.value }))}
                    placeholder={t('platform.automation.timePlaceholder')}
                  />
                </label>
                <div className="platform-weekdays">
                  <span>{t('platform.automation.weekdays')}</span>
                  {WEEKDAYS.map(({ v, k }) => (
                    <label key={v} className="platform-check-inline">
                      <input
                        type="checkbox"
                        checked={jobForm.weekdays.includes(v)}
                        onChange={() => {
                          setJobForm(f => ({
                            ...f,
                            weekdays: f.weekdays.includes(v) ? f.weekdays.filter(x => x !== v) : [...f.weekdays, v].sort(),
                          }))
                        }}
                      />
                      {t(`platform.automation.wd.${k}`)}
                    </label>
                  ))}
                </div>
                <label>
                  {t('platform.automation.terminal')}
                  <select
                    value={jobForm.terminalId}
                    onChange={e => setJobForm(f => ({ ...f, terminalId: e.target.value }))}
                  >
                    <option value="">{t('platform.automation.pickTerminal')}</option>
                    {claudeTerminals.map(term => (
                      <option key={term.id} value={term.id}>
                        {term.title} ({term.id.slice(0, 8)}…)
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('platform.automation.permission')}
                  <select
                    value={jobForm.permissionMode}
                    onChange={e => setJobForm(f => ({ ...f, permissionMode: e.target.value as AutomationPermissionMode }))}
                  >
                    {PERMISSION_MODES.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('platform.automation.promptDelivery')}
                  <select
                    value={jobForm.promptDelivery}
                    onChange={e =>
                      setJobForm(f => ({
                        ...f,
                        promptDelivery: e.target.value as AutomationPromptDelivery,
                      }))
                    }
                  >
                    <option value="plain">{t('platform.automation.deliveryPlain')}</option>
                    <option value="claude_loop">{t('platform.automation.deliveryLoop')}</option>
                  </select>
                </label>
                {jobForm.promptDelivery === 'claude_loop' && (
                  <>
                    <label>
                      {t('platform.automation.loopInterval')}
                      <input
                        value={jobForm.loopInterval}
                        onChange={e => setJobForm(f => ({ ...f, loopInterval: e.target.value }))}
                        placeholder={t('platform.automation.loopIntervalPh')}
                      />
                    </label>
                    <p className="platform-muted">{t('platform.automation.loopHint')}</p>
                  </>
                )}
                <label>
                  {t('platform.automation.prompt')}
                  <textarea
                    rows={5}
                    value={jobForm.prompt}
                    onChange={e => setJobForm(f => ({ ...f, prompt: e.target.value }))}
                    placeholder={
                      jobForm.promptDelivery === 'claude_loop'
                        ? t('platform.automation.promptPhLoop')
                        : undefined
                    }
                  />
                </label>
                <div className="platform-muted">{t('platform.automation.pkgAttach')}</div>
                <div className="platform-pkg-checkboxes">
                  {packages.map(p => (
                    <label key={p.id} className="platform-check-inline">
                      <input
                        type="checkbox"
                        checked={jobForm.contextPackageIds.includes(p.id)}
                        onChange={() => {
                          setJobForm(f => ({
                            ...f,
                            contextPackageIds: f.contextPackageIds.includes(p.id)
                              ? f.contextPackageIds.filter(x => x !== p.id)
                              : [...f.contextPackageIds, p.id],
                          }))
                        }}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
                <label className="platform-check-inline">
                  <input
                    type="checkbox"
                    checked={jobForm.enabled}
                    onChange={e => setJobForm(f => ({ ...f, enabled: e.target.checked }))}
                  />
                  {t('platform.automation.enabled')}
                </label>
                <button type="button" className="settings-save-btn" onClick={() => void addJob()}>
                  {t('platform.automation.add')}
                </button>
              </div>

              <h3 className="platform-subhead">{t('platform.automation.scheduled')}</h3>
              <ul className="platform-job-list">
                {jobs.map(j => (
                  <li key={j.id} className="platform-job-item">
                    <div>
                      <strong>{j.name}</strong>
                      <span className="platform-muted">
                        {' '}
                        · {j.runAtLocal} · {j.enabled ? t('platform.automation.on') : t('platform.automation.off')}
                        {j.promptDelivery === 'claude_loop' ? ` · ${t('platform.automation.loopBadge')}` : ''}
                      </span>
                      {j.lastError && <div className="platform-job-error">{j.lastError}</div>}
                      {j.lastRunAt && (
                        <div className="platform-muted platform-job-meta">
                          {t('platform.automation.lastRun')}: {new Date(j.lastRunAt).toLocaleString()}
                        </div>
                      )}
                    </div>
                    <div className="platform-job-actions">
                      <button type="button" className="settings-save-btn" onClick={() => void runJobNow(j.id)}>
                        {t('platform.automation.runNow')}
                      </button>
                      <button type="button" className="settings-cancel-btn" onClick={() => void toggleJobEnabled(j.id)}>
                        {j.enabled ? t('platform.automation.disable') : t('platform.automation.enable')}
                      </button>
                      <button type="button" className="settings-danger-btn" onClick={() => void removeJob(j.id)}>
                        {t('platform.automation.remove')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
