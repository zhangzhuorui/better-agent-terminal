import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

type SearchScope = 'all' | 'messages' | 'packages'

interface MessageSearchResult {
  id: string
  role?: 'user' | 'assistant' | 'system'
  toolName?: string
  snippet: string
  timestamp: number
  fullContent: string
}

interface PackageSearchResult {
  id: string
  name: string
  description?: string
  snippet: string
  content: string
  tags?: string[]
  workspaceRoot?: string
  updatedAt: number
}

interface UnifiedResult {
  id: string
  source: 'message' | 'context-package'
  title: string
  snippet: string
  timestamp?: number
  meta?: string
  fullContent?: string
}

interface ContentSearchPanelProps {
  sessionId: string
  open: boolean
  onClose: () => void
  onJumpToMessage?: (messageId: string) => void
}

function highlightTerm(text: string, term: string): (string | JSX.Element)[] {
  if (!term) return [text]
  const lower = term.toLowerCase()
  const parts: (string | JSX.Element)[] = []
  let lastIndex = 0
  let key = 0

  while (true) {
    const idx = text.toLowerCase().indexOf(lower, lastIndex)
    if (idx === -1) {
      parts.push(text.slice(lastIndex))
      break
    }
    if (idx > lastIndex) parts.push(text.slice(lastIndex, idx))
    parts.push(
      <mark className="content-search-highlight" key={key++}>
        {text.slice(idx, idx + term.length)}
      </mark>
    )
    lastIndex = idx + term.length
  }
  return parts
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function ContentSearchPanel({
  sessionId,
  open,
  onClose,
  onJumpToMessage,
}: Readonly<ContentSearchPanelProps>) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [results, setResults] = useState<UnifiedResult[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const performSearch = useCallback(
    async (q: string, s: SearchScope) => {
      const term = q.trim()
      if (!term) {
        setResults([])
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const all: UnifiedResult[] = []
        if (s === 'all' || s === 'messages') {
          const msgs: MessageSearchResult[] =
            await window.electronAPI.contentSearch.searchMessages(sessionId, term)
          for (const m of msgs) {
            all.push({
              id: `msg-${m.id}`,
              source: 'message',
              title: m.role === 'user' ? t('contentSearch.user') : m.role === 'assistant' ? t('contentSearch.assistant') : t('contentSearch.system'),
              snippet: m.snippet,
              timestamp: m.timestamp,
              meta: m.toolName || m.role,
              fullContent: m.fullContent,
            })
          }
        }
        if (s === 'all' || s === 'packages') {
          const pkgs: PackageSearchResult[] =
            await window.electronAPI.contentSearch.searchContextPackages(term)
          for (const p of pkgs) {
            all.push({
              id: `pkg-${p.id}`,
              source: 'context-package',
              title: p.name,
              snippet: p.snippet,
              timestamp: p.updatedAt,
              meta: p.tags?.join(', ') || p.workspaceRoot,
              fullContent: p.content,
            })
          }
        }
        setResults(all)
      } catch (e) {
        window.electronAPI.debug.log('[contentSearch] error:', e)
        setResults([])
      } finally {
        setLoading(false)
      }
    },
    [sessionId, t]
  )

  const debouncedSearch = useCallback(
    (q: string, s: SearchScope) => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = setTimeout(() => performSearch(q, s), 250)
    },
    [performSearch]
  )

  useEffect(() => {
    debouncedSearch(query, scope)
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    }
  }, [query, scope, debouncedSearch])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  if (!open) return null

  return (
    <div className="content-search-panel" onKeyDown={handleKeyDown}>
      <div className="content-search-header">
        <div className="content-search-input-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="content-search-input"
            placeholder={t('contentSearch.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="content-search-clear" onClick={() => setQuery('')} title={t('common.clear')}>
              ×
            </button>
          )}
        </div>
        <div className="content-search-scope">
          <button
            className={scope === 'all' ? 'active' : ''}
            onClick={() => setScope('all')}
          >
            {t('contentSearch.all')}
          </button>
          <button
            className={scope === 'messages' ? 'active' : ''}
            onClick={() => setScope('messages')}
          >
            {t('contentSearch.messages')}
          </button>
          <button
            className={scope === 'packages' ? 'active' : ''}
            onClick={() => setScope('packages')}
          >
            {t('contentSearch.packages')}
          </button>
        </div>
      </div>

      <div className="content-search-results">
        {loading && (
          <div className="content-search-loading">{t('contentSearch.searching')}</div>
        )}
        {!loading && query.trim() && results.length === 0 && (
          <div className="content-search-empty">{t('contentSearch.noResults')}</div>
        )}
        {!query.trim() && (
          <div className="content-search-empty">{t('contentSearch.typeToSearch')}</div>
        )}
        {results.map((r) => {
          const isExpanded = expandedId === r.id
          return (
            <div
              key={r.id}
              className={`content-search-result ${r.source}`}
              onClick={() => {
                if (r.source === 'message' && onJumpToMessage) {
                  const msgId = r.id.replace('msg-', '')
                  onJumpToMessage(msgId)
                }
                setExpandedId(isExpanded ? null : r.id)
              }}
            >
              <div className="content-search-result-header">
                <span className={`content-search-source-badge ${r.source}`}>
                  {r.source === 'message'
                    ? r.meta === 'user'
                      ? t('contentSearch.user')
                      : r.meta === 'assistant'
                        ? t('contentSearch.assistant')
                        : r.meta === 'system'
                          ? t('contentSearch.system')
                          : r.meta || t('contentSearch.tool')
                    : t('contentSearch.package')}
                </span>
                <span className="content-search-result-title">{r.title}</span>
                {r.timestamp && (
                  <span className="content-search-result-time">{formatTime(r.timestamp)}</span>
                )}
              </div>
              <div className="content-search-result-snippet">
                {highlightTerm(r.snippet, query)}
              </div>
              {isExpanded && (
                <div className="content-search-result-full">
                  {highlightTerm(r.fullContent || r.snippet, query)}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="content-search-footer">
        <span className="content-search-count">
          {results.length > 0
            ? t('contentSearch.resultCount', { count: results.length })
            : ''}
        </span>
        <button className="content-search-close-btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  )
}
