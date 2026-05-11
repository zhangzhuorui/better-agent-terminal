import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'

interface GitCommit {
  hash: string
  author: string
  date: string
  message: string
}

interface GitStatusEntry {
  status: string
  file: string
}

interface GitBranchInfo {
  name: string
  current: boolean
  ahead: number
  behind: number
  remote?: string
}

interface GitStashEntry {
  index: number
  hash: string
  message: string
  date: string
}

interface GitBlameLine {
  lineNumber: number
  commitHash: string
  author: string
  date: string
  content: string
}

interface GitPanelProps {
  workspaceFolderPath: string
}

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'cfg', 'ini', 'conf', 'log',
])

function isTextFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return TEXT_EXTS.has(ext)
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return i18next.t('git.justNow')
    if (diffMins < 60) return i18next.t('git.minutesAgo', { count: diffMins })
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return i18next.t('git.hoursAgo', { count: diffHours })
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 30) return i18next.t('git.daysAgo', { count: diffDays })
    return d.toLocaleDateString()
  } catch {
    return dateStr
  }
}

function statusColor(s: string): string {
  switch (s) {
    case 'M': return '#d97706'
    case 'A': case '??': return '#4ec9b0'
    case 'D': return '#f44336'
    case 'R': return '#569cd6'
    default: return 'var(--text-secondary)'
  }
}

function DiffView({ diff }: { diff: string }) {
  const { t } = useTranslation()
  if (!diff) {
    return <div className="git-diff-empty">{t('git.selectFileToViewDiff')}</div>
  }

  const lines = diff.split('\n')

  return (
    <pre className="git-diff-content">
      {lines.map((line, i) => {
        let className = 'git-diff-line'
        if (line.startsWith('+') && !line.startsWith('+++')) {
          className += ' git-diff-add'
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          className += ' git-diff-del'
        } else if (line.startsWith('@@')) {
          className += ' git-diff-hunk'
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          className += ' git-diff-header'
        }
        return <div key={i} className={className}>{line || ' '}</div>
      })}
    </pre>
  )
}

export function GitPanel({ workspaceFolderPath }: Readonly<GitPanelProps>) {
  const { t } = useTranslation()
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [status, setStatus] = useState<GitStatusEntry[]>([])
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [changedFiles, setChangedFiles] = useState<GitStatusEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'diff' | 'file' | 'blame'>('diff')
  const [loading, setLoading] = useState(true)
  const [filesLoading, setFilesLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(true)
  const [gitRoot, setGitRoot] = useState<string | null>(null)
  const [gitViewMode, setGitViewMode] = useState<'commits' | 'branches' | 'stash'>('commits')
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [stash, setStash] = useState<GitStashEntry[]>([])
  const [blame, setBlame] = useState<GitBlameLine[]>([])

  const loadData = useCallback(async () => {
    setLoading(true)
    setSelectedCommit(null)
    setChangedFiles([])
    setSelectedFile(null)
    setDiff('')
    try {
      const [logResult, statusResult, branch, root, branchGraph, stashList] = await Promise.all([
        window.electronAPI.git.getLog(workspaceFolderPath),
        window.electronAPI.git.getStatus(workspaceFolderPath),
        window.electronAPI.git.getBranch(workspaceFolderPath),
        window.electronAPI.git.getRoot(workspaceFolderPath),
        window.electronAPI.git.getBranchGraph(workspaceFolderPath),
        window.electronAPI.git.getStash(workspaceFolderPath),
      ])
      setIsGitRepo(branch !== null)
      setGitRoot(root)
      setCommits(logResult)
      setStatus(statusResult)
      setBranches(branchGraph)
      setStash(stashList)
    } catch {
      setIsGitRepo(false)
    }
    setLoading(false)
  }, [workspaceFolderPath])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSelectCommit = useCallback(async (hash: string) => {
    setSelectedCommit(hash)
    setSelectedFile(null)
    setDiff('')
    setFilesLoading(true)
    try {
      if (hash === 'working') {
        setChangedFiles(status)
      } else {
        const files = await window.electronAPI.git.getDiffFiles(workspaceFolderPath, hash)
        setChangedFiles(files)
      }
    } catch {
      setChangedFiles([])
    }
    setFilesLoading(false)
  }, [workspaceFolderPath, status])

  const handleSelectFile = useCallback(async (filePath: string) => {
    setSelectedFile(filePath)
    setViewMode('diff')
    setFileContent(null)
    setBlame([])
    setDiffLoading(true)
    try {
      const d = await window.electronAPI.git.getDiff(workspaceFolderPath, selectedCommit || undefined, filePath)
      if (d.trim()) {
        setDiff(d)
      } else {
        // For untracked/new files, git diff returns empty - read file content directly
        const fileEntry = changedFiles.find(f => f.file === filePath)
        if (fileEntry && (fileEntry.status === '??' || fileEntry.status === 'A')) {
          const base = gitRoot || workspaceFolderPath
          const sep = window.electronAPI.platform === 'win32' ? '\\' : '/'
          const fullPath = base + sep + filePath.replace(/[/\\]/g, sep)
          const result = await window.electronAPI.fs.readFile(fullPath)
          if (result.content) {
            const lines = result.content.split('\n').map(l => '+' + l).join('\n')
            setDiff(`diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${result.content.split('\n').length} @@\n${lines}`)
          } else {
            setDiff(result.error || '')
          }
        } else {
          setDiff('')
        }
      }
    } catch {
      setDiff('')
    }
    setDiffLoading(false)
  }, [workspaceFolderPath, selectedCommit, changedFiles, gitRoot])

  const handleViewFile = useCallback(async () => {
    if (!selectedFile) return
    setViewMode('file')
    if (fileContent !== null) return // already loaded
    const base = gitRoot || workspaceFolderPath
    const sep = window.electronAPI.platform === 'win32' ? '\\' : '/'
    const fullPath = base + sep + selectedFile.replace(/[/\\]/g, sep)
    const result = await window.electronAPI.fs.readFile(fullPath)
    setFileContent(result.content || result.error || 'Unable to read file')
  }, [selectedFile, fileContent, workspaceFolderPath, gitRoot])

  const handleViewBlame = useCallback(async () => {
    if (!selectedFile) return
    setViewMode('blame')
    if (blame.length > 0) return // already loaded
    setDiffLoading(true)
    try {
      const lines = await window.electronAPI.git.getBlame(workspaceFolderPath, selectedFile)
      setBlame(lines)
    } catch {
      setBlame([])
    }
    setDiffLoading(false)
  }, [selectedFile, blame.length, workspaceFolderPath])

  if (loading) {
    return <div className="git-panel-empty">{t('common.loading')}</div>
  }

  if (!isGitRepo) {
    return <div className="git-panel-empty">{t('git.notAGitRepo')}</div>
  }

  return (
    <div className="git-panel">
      {/* Column 1: Commit log / Branches / Stash */}
      <div className="git-commit-list">
        <div className="git-col-header">
          <div className="git-diff-mode-bar" style={{ padding: 0, borderBottom: 'none' }}>
            <button className={`git-diff-mode-btn ${gitViewMode === 'commits' ? 'active' : ''}`} onClick={() => setGitViewMode('commits')}>
              {t('git.commits')}
            </button>
            <button className={`git-diff-mode-btn ${gitViewMode === 'branches' ? 'active' : ''}`} onClick={() => setGitViewMode('branches')}>
              {t('git.branches')}
            </button>
            <button className={`git-diff-mode-btn ${gitViewMode === 'stash' ? 'active' : ''}`} onClick={() => setGitViewMode('stash')}>
              {t('git.stash')}
            </button>
          </div>
          <button className="git-refresh-btn" onClick={loadData} title={t('git.refresh')}>↻</button>
        </div>
        <div className="git-commit-list-items">
          {gitViewMode === 'commits' && (
            <>
              {status.length > 0 && (
                <div
                  className={`git-commit-item ${selectedCommit === 'working' ? 'active' : ''}`}
                  onClick={() => handleSelectCommit('working')}
                >
                  <div className="git-commit-message">
                    <span className="git-uncommitted-badge">●</span>
                    {t('git.uncommittedChanges')}
                  </div>
                  <div className="git-commit-meta">
                    {t('git.filesChanged', { count: status.length })}
                  </div>
                </div>
              )}
              {commits.map(commit => (
                <div
                  key={commit.hash}
                  className={`git-commit-item ${selectedCommit === commit.hash ? 'active' : ''}`}
                  onClick={() => handleSelectCommit(commit.hash)}
                >
                  <div className="git-commit-message">{commit.message}</div>
                  <div className="git-commit-meta">
                    <span className="git-commit-hash">{commit.hash.substring(0, 7)}</span>
                    <span className="git-commit-author">{commit.author}</span>
                    <span className="git-commit-date">{formatDate(commit.date)}</span>
                  </div>
                </div>
              ))}
              {commits.length === 0 && status.length === 0 && (
                <div className="git-panel-empty">{t('git.noCommitsYet')}</div>
              )}
            </>
          )}
          {gitViewMode === 'branches' && (
            <>
              {branches.map(b => (
                <div key={b.name} className={`git-commit-item ${b.current ? 'active' : ''}`}>
                  <div className="git-commit-message">
                    {b.current && <span className="git-uncommitted-badge">★</span>}
                    {b.name}
                  </div>
                  <div className="git-commit-meta">
                    {b.ahead > 0 && <span>{t('git.branchAhead', { count: b.ahead })}</span>}
                    {b.behind > 0 && <span>{t('git.branchBehind', { count: b.behind })}</span>}
                    {b.remote && <span className="git-commit-author">{b.remote}</span>}
                  </div>
                </div>
              ))}
              {branches.length === 0 && <div className="git-panel-empty">{t('git.noBranches')}</div>}
            </>
          )}
          {gitViewMode === 'stash' && (
            <>
              {stash.map(s => (
                <div key={s.index} className="git-commit-item">
                  <div className="git-commit-message">{s.message}</div>
                  <div className="git-commit-meta">
                    <span className="git-commit-hash">{s.hash.substring(0, 7)}</span>
                    <span className="git-commit-date">{formatDate(s.date)}</span>
                  </div>
                </div>
              ))}
              {stash.length === 0 && <div className="git-panel-empty">{t('git.noStash')}</div>}
            </>
          )}
        </div>
      </div>

      {/* Column 2: Changed files */}
      <div className="git-file-list">
        <div className="git-col-header">
          <span>{t('git.files')}</span>
          {changedFiles.length > 0 && (
            <span className="git-file-count">{changedFiles.length}</span>
          )}
        </div>
        <div className="git-file-list-items">
          {!selectedCommit && (
            <div className="git-col-placeholder">{t('git.selectACommit')}</div>
          )}
          {selectedCommit && filesLoading && (
            <div className="git-col-placeholder">{t('common.loading')}</div>
          )}
          {selectedCommit && !filesLoading && changedFiles.length === 0 && (
            <div className="git-col-placeholder">{t('git.noChangedFiles')}</div>
          )}
          {changedFiles.map(f => (
            <div
              key={f.file}
              className={`git-file-item ${selectedFile === f.file ? 'active' : ''}`}
              onClick={() => handleSelectFile(f.file)}
            >
              <span className="git-file-status" style={{ color: statusColor(f.status) }}>
                {f.status}
              </span>
              <span className="git-file-name" title={f.file}>
                {f.file.split('/').pop()}
              </span>
              <span className="git-file-path" title={f.file}>
                {f.file.includes('/') ? f.file.substring(0, f.file.lastIndexOf('/') + 1) : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Column 3: Diff / File preview / Blame */}
      <div className="git-diff-view">
        {selectedFile && isTextFile(selectedFile.split('/').pop() || '') && (
          <div className="git-diff-mode-bar">
            <button
              className={`git-diff-mode-btn ${viewMode === 'diff' ? 'active' : ''}`}
              onClick={() => setViewMode('diff')}
            >
              {t('git.diff')}
            </button>
            <button
              className={`git-diff-mode-btn ${viewMode === 'file' ? 'active' : ''}`}
              onClick={handleViewFile}
            >
              {t('git.file')}
            </button>
            <button
              className={`git-diff-mode-btn ${viewMode === 'blame' ? 'active' : ''}`}
              onClick={handleViewBlame}
            >
              {t('git.blame')}
            </button>
          </div>
        )}
        {diffLoading ? (
          <div className="git-diff-empty">{t('common.loading')}</div>
        ) : viewMode === 'file' && fileContent !== null ? (
          <pre className="git-file-content">{fileContent}</pre>
        ) : viewMode === 'blame' ? (
          <pre className="git-diff-content">
            {blame.length === 0 ? (
              <div className="git-diff-empty">No blame data</div>
            ) : (
              blame.map((line, i) => (
                <div key={i} className="git-diff-line" style={{ display: 'flex', gap: 12 }}>
                  <span style={{ color: 'var(--text-secondary)', minWidth: 120, textOverflow: 'ellipsis', overflow: 'hidden' }} title={line.author}>
                    {line.author}
                  </span>
                  <span style={{ color: 'var(--accent-color)', minWidth: 60, fontFamily: 'monospace' }}>
                    {line.commitHash.slice(0, 7)}
                  </span>
                  <span style={{ color: 'var(--text-secondary)', minWidth: 40, textAlign: 'right' }}>
                    {line.lineNumber}
                  </span>
                  <span style={{ flex: 1 }}>{line.content}</span>
                </div>
              ))
            )}
          </pre>
        ) : (
          <DiffView diff={diff} />
        )}
      </div>
    </div>
  )
}
