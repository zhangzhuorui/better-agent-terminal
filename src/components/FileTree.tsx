import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { subscribeUiEffectiveTheme } from '../utils/apply-ui-theme'
import { HighlightedCode } from './PathLinker'
import hljs from 'highlight.js/lib/core'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface FileTreeProps {
  rootPath: string
}

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm',
  'md', 'txt', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'env', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'dockerfile', 'makefile', 'cfg', 'ini', 'conf', 'log',
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

function getFileExt(name: string): string {
  const lower = name.toLowerCase()
  // Handle dotfiles like .gitignore, .env
  if (lower.startsWith('.') && !lower.includes('.', 1)) {
    return lower.substring(1)
  }
  return lower.split('.').pop() || ''
}

function canPreview(name: string): 'text' | 'image' | null {
  const ext = getFileExt(name)
  if (TEXT_EXTS.has(ext)) return 'text'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return null
}

function FileTreeNode({
  entry, depth, selectedPath, onSelect, onContextMenu,
}: {
  entry: FileEntry; depth: number; selectedPath: string | null; onSelect: (entry: FileEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(async () => {
    if (entry.isDirectory) {
      if (expanded) {
        setExpanded(false)
        return
      }
      if (children === null) {
        setLoading(true)
        try {
          const entries = await window.electronAPI.fs.readdir(entry.path)
          setChildren(entries)
        } catch {
          setChildren([])
        }
        setLoading(false)
      }
      setExpanded(true)
    } else {
      onSelect(entry)
    }
  }, [entry, expanded, children, onSelect])

  const icon = entry.isDirectory
    ? (expanded ? '📂' : '📁')
    : getFileIcon(entry.name)

  const isSelected = !entry.isDirectory && entry.path === selectedPath

  return (
    <>
      <div
        className={`file-tree-item ${entry.isDirectory ? 'file-tree-folder' : 'file-tree-file'} ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        <span className="file-tree-icon">{icon}</span>
        <span className="file-tree-name">{entry.name}</span>
        {loading && <span className="file-tree-loading">...</span>}
      </div>
      {expanded && children && children.map(child => (
        <FileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}

function getFileIcon(name: string): string {
  const ext = getFileExt(name)
  switch (ext) {
    case 'ts': case 'tsx': return '🔷'
    case 'js': case 'jsx': return '🟡'
    case 'json': return '📋'
    case 'css': case 'scss': case 'less': return '🎨'
    case 'html': case 'htm': return '🌐'
    case 'md': return '📝'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return '🖼️'
    case 'sh': case 'bash': case 'zsh': return '⚙️'
    case 'yml': case 'yaml': case 'toml': return '⚙️'
    case 'lock': return '🔒'
    case 'py': return '🐍'
    case 'go': return '🔵'
    case 'rs': return '🦀'
    case 'java': return '☕'
    case 'cpp': case 'c': case 'h': case 'hpp': return '⚡'
    case 'cs': return '#️⃣'
    case 'rb': return '💎'
    case 'php': return '🐘'
    case 'swift': return '🕊️'
    case 'kt': return '🟣'
    case 'sql': return '🗃️'
    case 'csv': return '📊'
    case 'pdf': return '📕'
    case 'zip': case 'tar': case 'gz': case 'rar': case '7z': return '📦'
    case 'dockerfile': return '🐳'
    case 'vue': return '🟢'
    case 'svelte': return '🔥'
    case 'gitignore': return '🙈'
    default: return '📄'
  }
}

interface SymbolInfo {
  type: 'function' | 'class' | 'interface' | 'variable' | 'unknown'
  name: string
  line: number
}

function extractSymbols(content: string): SymbolInfo[] {
  const patterns: { regex: RegExp; type: SymbolInfo['type'] }[] = [
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, type: 'function' },
    { regex: /^(?:export\s+)?class\s+(\w+)/, type: 'class' },
    { regex: /^(?:export\s+)?interface\s+(\w+)/, type: 'interface' },
    { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/, type: 'variable' },
    { regex: /^(?:export\s+)?(?:def|fn)\s+(\w+)/, type: 'function' },
    { regex: /^\s*(\w+)\s*[=:].*=>\s*\{/, type: 'function' },
    { regex: /^\s*(?:public|private|protected|static)?\s*(?:async\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*\{/, type: 'function' },
  ]
  const symbols: SymbolInfo[] = []
  const seen = new Set<string>()
  content.split('\n').forEach((line, idx) => {
    for (const p of patterns) {
      const m = line.match(p.regex)
      if (m) {
        const key = `${p.type}:${m[1]}:${idx}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ type: p.type, name: m[1], line: idx + 1 })
        }
        break
      }
    }
  })
  return symbols
}

// Markdown rendering using marked + DOMPurify + highlight.js
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Configure marked with GFM (tables, task lists, strikethrough) + highlight.js
marked.setOptions({
  gfm: true,
  breaks: true,
})

// Custom renderer for code blocks (syntax highlighting) and links (open in browser)
const renderer = new marked.Renderer()

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  // Mermaid blocks: render as div with class "mermaid" for post-render processing
  if (lang === 'mermaid') {
    return `<div class="mermaid">${text}</div>`
  }
  let highlighted: string
  try {
    highlighted = lang
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value
  } catch {
    highlighted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlighted}</code></pre>`
}

renderer.link = function ({ href, text }: { href: string; text: string }) {
  // Links open in external browser, not inside Electron
  return `<a href="${href}" data-external-link="true">${text}</a>`
}

renderer.image = function ({ href, text }: { href: string; text: string }) {
  // Support local file paths
  const src = href.startsWith('/') ? `file://${href}` : href
  return `<img alt="${text || ''}" src="${src}" style="max-width:100%"/>`
}

marked.use({ renderer })

function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text) as string
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['input'],  // Allow checkboxes for task lists
    ADD_ATTR: ['checked', 'disabled', 'type', 'data-external-link'],
  })
}

// Mermaid rendering: dynamically import mermaid only when needed
let mermaidInitEffective: 'dark' | 'light' | null = null

async function getMermaid() {
  const effective = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  const mermaid = (await import('mermaid')).default
  if (mermaidInitEffective !== effective) {
    mermaidInitEffective = effective
    mermaid.initialize({
      startOnLoad: false,
      theme: effective === 'light' ? 'neutral' : 'dark',
      themeVariables:
        effective === 'light'
          ? {
              background: '#ffffff',
              primaryColor: '#0063b1',
              primaryTextColor: '#333333',
              lineColor: '#888888',
            }
          : {
              darkMode: true,
              background: '#1e1e1e',
              primaryColor: '#3498db',
              primaryTextColor: '#e0e0e0',
              lineColor: '#666',
            },
    })
  }
  return mermaid
}

async function renderMermaidBlocks(container: HTMLElement) {
  const mermaidDivs = container.querySelectorAll('.mermaid')
  if (mermaidDivs.length === 0) return

  const mermaid = await getMermaid()
  mermaidDivs.forEach((div, i) => {
    div.id = `mermaid-${Date.now()}-${i}`
  })
  try {
    await mermaid.run({ nodes: mermaidDivs as unknown as ArrayLike<HTMLElement> })
  } catch {
    mermaidDivs.forEach(div => {
      if (!div.querySelector('svg')) {
        div.classList.add('mermaid-error')
      }
    })
  }
}

function MarkdownPreview({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [themeTick, setThemeTick] = useState(0)
  const html = renderMarkdown(content)

  useEffect(() => subscribeUiEffectiveTheme(() => setThemeTick(t => t + 1)), [])

  useEffect(() => {
    if (containerRef.current) {
      renderMermaidBlocks(containerRef.current)
    }
  }, [html, themeTick])

  return (
    <div
      key={themeTick}
      ref={containerRef}
      className="file-preview-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = e.target as HTMLElement
        const link = target.closest('a[data-external-link]') as HTMLAnchorElement | null
        if (link) {
          e.preventDefault()
          window.electronAPI.shell.openExternal(link.href)
        }
      }}
    />
  )
}

function SymbolOutline({ symbols, onSelect }: { symbols: SymbolInfo[]; onSelect: (line: number) => void }) {
  const typeIcon: Record<string, string> = {
    function: '🔧',
    class: '🔷',
    interface: '🔹',
    variable: '📌',
    unknown: '•',
  }
  return (
    <div className="file-symbol-outline">
      <div className="file-symbol-outline-header">Outline</div>
      <div className="file-symbol-outline-list">
        {symbols.map(s => (
          <div
            key={`${s.type}:${s.name}:${s.line}`}
            className="file-symbol-outline-item"
            onClick={() => onSelect(s.line)}
            title={`${s.type} ${s.name} (line ${s.line})`}
          >
            <span className="file-symbol-outline-icon">{typeIcon[s.type] || '•'}</span>
            <span className="file-symbol-outline-name">{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function FilePreview({ filePath, fileName, refreshKey }: { filePath: string; fileName: string; refreshKey: number }) {
  const { t } = useTranslation()
  const [content, setContent] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'source' | 'rendered'>('rendered')
  const [showOutline, setShowOutline] = useState(true)
  const isMarkdown = getFileExt(fileName) === 'md'

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setImageUrl(null)
    setError(null)
    setLoading(true)

    const type = canPreview(fileName)
    if (type === 'text') {
      window.electronAPI.fs.readFile(filePath).then(result => {
        if (cancelled) return
        if (result.error) {
          setError(result.error === 'File too large' ? `File too large (${Math.round((result.size || 0) / 1024)}KB)` : result.error)
        } else {
          setContent(result.content || '')
        }
        setLoading(false)
      })
    } else if (type === 'image') {
      window.electronAPI.image.readAsDataUrl(filePath).then(url => {
        if (cancelled) return
        setImageUrl(url)
        setLoading(false)
      }).catch(() => {
        if (cancelled) return
        setError(t('fileTree.previewLoadImageFailed'))
        setLoading(false)
      })
    } else {
      setError(t('fileTree.previewNotAvailable'))
      setLoading(false)
    }

    return () => { cancelled = true }
  }, [filePath, fileName, refreshKey, t])

  if (loading) {
    return <div className="file-preview-status">{t('fileTree.loading')}</div>
  }

  if (error) {
    return <div className="file-preview-status">{error}</div>
  }

  if (imageUrl) {
    return (
      <div className="file-preview-image">
        <img src={imageUrl} alt={fileName} />
      </div>
    )
  }

  const handleScrollToLine = (line: number) => {
    const el = document.getElementById(`line-${line}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.style.background = 'rgba(217, 119, 6, 0.15)'
      setTimeout(() => { el.style.background = '' }, 1200)
    }
  }

  const symbols = content ? extractSymbols(content) : []
  const hasSymbols = symbols.length > 0

  if (content !== null) {
    return (
      <>
        {(isMarkdown || hasSymbols) && (
          <div className="file-preview-mode-bar">
            {isMarkdown && (
              <>
                <button className={`git-diff-mode-btn${viewMode === 'rendered' ? ' active' : ''}`} onClick={() => setViewMode('rendered')}>{t('fileTree.preview')}</button>
                <button className={`git-diff-mode-btn${viewMode === 'source' ? ' active' : ''}`} onClick={() => setViewMode('source')}>{t('fileTree.source')}</button>
              </>
            )}
            {hasSymbols && (
              <button className={`git-diff-mode-btn${showOutline ? ' active' : ''}`} onClick={() => setShowOutline(v => !v)}>Outline</button>
            )}
          </div>
        )}
        {isMarkdown && viewMode === 'rendered'
          ? <MarkdownPreview content={content} />
          : (
            <div style={{ display: 'flex', flexDirection: 'row', height: '100%', overflow: 'hidden' }}>
              {hasSymbols && showOutline && (
                <SymbolOutline symbols={symbols} onSelect={handleScrollToLine} />
              )}
              <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
                <HighlightedCode code={content} ext={getFileExt(fileName)} className="file-preview-text" />
              </div>
            </div>
          )
        }
      </>
    )
  }

  return null
}

export function FileTree({ rootPath }: Readonly<FileTreeProps>) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)
  const restoredRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.fs.readdir(rootPath)
      setEntries(result)
    } catch {
      setEntries([])
    }
    setLoading(false)
  }, [rootPath])

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1)
    loadRoot()
  }, [loadRoot])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  // Watch for file system changes and auto-refresh
  useEffect(() => {
    window.electronAPI.fs.watch(rootPath)
    const unsubscribe = window.electronAPI.fs.onChanged((changedPath: string) => {
      if (changedPath === rootPath) {
        setRefreshKey(k => k + 1)
        loadRoot()
      }
    })
    return () => {
      unsubscribe()
      window.electronAPI.fs.unwatch(rootPath)
    }
  }, [rootPath, loadRoot])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [contextMenu])

  // Debounced search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI.fs.search(rootPath, q)
        setSearchResults(results)
      } catch {
        setSearchResults([])
      }
      setSearching(false)
    }, 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [searchQuery, rootPath])

  // Restore last selected file on mount
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const storageKey = `file-tree-selected:${rootPath}`
    const saved = localStorage.getItem(storageKey)
    if (!saved) return
    try {
      const { path, name } = JSON.parse(saved)
      // Check if file still exists
      window.electronAPI.fs.readFile(path).then(result => {
        if (!result.error) {
          setSelectedFile({ path, name, isDirectory: false })
        } else {
          localStorage.removeItem(storageKey)
        }
      })
    } catch {
      localStorage.removeItem(storageKey)
    }
  }, [rootPath])

  const handleSelect = useCallback((entry: FileEntry) => {
    setSelectedFile(entry)
    localStorage.setItem(`file-tree-selected:${rootPath}`, JSON.stringify({ path: entry.path, name: entry.name }))
  }, [rootPath])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const getRelativePath = useCallback((filePath: string) => {
    // Normalize separators and compute relative path
    const norm = (p: string) => p.replace(/\\/g, '/')
    const rel = norm(filePath).replace(norm(rootPath), '').replace(/^\//, '')
    return rel
  }, [rootPath])

  const handleCopyRelativePath = useCallback(() => {
    if (!contextMenu) return
    navigator.clipboard.writeText(getRelativePath(contextMenu.entry.path))
    setContextMenu(null)
  }, [contextMenu, getRelativePath])

  const handleCopyAbsolutePath = useCallback(() => {
    if (!contextMenu) return
    navigator.clipboard.writeText(contextMenu.entry.path)
    setContextMenu(null)
  }, [contextMenu])

  const handleOpenInExplorer = useCallback(() => {
    if (!contextMenu) return
    const target = contextMenu.entry.isDirectory
      ? contextMenu.entry.path
      : contextMenu.entry.path.replace(/[\\/][^\\/]+$/, '') // parent dir
    window.electronAPI.shell.openPath(target)
    setContextMenu(null)
  }, [contextMenu])

  if (loading && entries.length === 0) {
    return <div className="file-tree-empty">{t('fileTree.loading')}</div>
  }

  if (entries.length === 0) {
    return <div className="file-tree-empty">{t('fileTree.noFiles')}</div>
  }

  const displayEntries = searchResults !== null ? searchResults : entries

  return (
    <div className="file-tree-split">
      <div className="file-tree">
        <div className="file-tree-header">
          <input
            className="file-tree-search"
            type="text"
            placeholder={t('fileTree.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button className="file-tree-refresh-btn" onClick={handleRefresh} title={t('fileTree.refresh')}>↻</button>
        </div>
        <div className="file-tree-list">
          {searching && <div className="file-tree-item file-tree-loading-row">{t('fileTree.searching')}</div>}
          {searchResults !== null ? (
            // Search results: flat list with relative paths
            displayEntries.map(entry => (
              <div
                key={entry.path}
                className={`file-tree-item file-tree-file ${entry.path === selectedFile?.path ? 'selected' : ''}`}
                style={{ paddingLeft: '12px' }}
                onClick={() => {
                  if (!entry.isDirectory) handleSelect(entry)
                }}
                onContextMenu={(e) => handleContextMenu(e, entry)}
              >
                <span className="file-tree-icon">{entry.isDirectory ? '📁' : getFileIcon(entry.name)}</span>
                <span className="file-tree-name file-tree-search-path">{getRelativePath(entry.path)}</span>
              </div>
            ))
          ) : (
            entries.map(entry => (
              <FileTreeNode
                key={`${entry.path}:${refreshKey}`}
                entry={entry}
                depth={0}
                selectedPath={selectedFile?.path || null}
                onSelect={handleSelect}
                onContextMenu={handleContextMenu}
              />
            ))
          )}
          {searchResults !== null && searchResults.length === 0 && !searching && (
            <div className="file-tree-empty">{t('fileTree.noMatches')}</div>
          )}
        </div>
      </div>
      <div className="file-preview">
        {selectedFile ? (
          <>
            <div className="file-preview-header">
              <span className="file-preview-filename">{selectedFile.name}</span>
              <button className="file-tree-refresh-btn" onClick={handleRefresh} title={t('fileTree.refresh')}>↻</button>
            </div>
            <div className="file-preview-body">
              <FilePreview filePath={selectedFile.path} fileName={selectedFile.name} refreshKey={refreshKey} />
            </div>
          </>
        ) : (
          <div className="file-preview-status">{t('fileTree.selectFilePreview')}</div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="workspace-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-menu-item" onClick={handleCopyRelativePath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
            Copy Relative Path
          </div>
          <div className="context-menu-item" onClick={handleCopyAbsolutePath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              <line x1="8" y1="10" x2="16" y2="10" />
              <line x1="8" y1="14" x2="12" y2="14" />
            </svg>
            Copy Absolute Path
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleOpenInExplorer}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Open in Explorer
          </div>
        </div>
      )}
    </div>
  )
}
