import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'

interface PromptBoxProps {
  terminalId: string
}

// Per-terminal history stored in memory
const historyMap = new Map<string, string[]>()

interface SuggestionItem {
  name: string
  path: string
  isDirectory: boolean
}

export function PromptBox({ terminalId }: Readonly<PromptBoxProps>) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [fontFamily, setFontFamily] = useState(settingsStore.getFontFamilyString())
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const draftRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [suggestIndex, setSuggestIndex] = useState(0)
  const [suggestActive, setSuggestActive] = useState(false)
  const suggestDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const unsubscribe = settingsStore.subscribe(() => {
      setFontFamily(settingsStore.getFontFamilyString())
    })
    return unsubscribe
  }, [])

  const getHistory = () => historyMap.get(terminalId) || []

  const handleSend = async () => {
    const content = text.trim()
    if (!content && !imagePath) return

    // Save to history
    if (content) {
      const history = getHistory()
      // Avoid consecutive duplicates
      if (history[history.length - 1] !== content) {
        history.push(content)
        historyMap.set(terminalId, history)
      }
    }
    setHistoryIndex(-1)
    draftRef.current = ''

    // Order: text first (no Enter) → attach image → Enter to submit
    if (content) {
      await window.electronAPI.pty.write(terminalId, content)
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    if (imagePath) {
      await window.electronAPI.clipboard.writeImage(imagePath)
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.electronAPI.pty.write(terminalId, '\x1bv')
      await new Promise(resolve => setTimeout(resolve, 800))
    }

    await window.electronAPI.pty.write(terminalId, '\r')

    setText('')
    setImagePath(null)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Suggestion navigation takes precedence
    if (suggestActive && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggestIndex(i => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggestIndex(i => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applySuggestion(suggestions[suggestIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSuggestActive(false)
        return
      }
    }

    if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      textareaRef.current?.blur()
      return
    }

    const history = getHistory()
    if (history.length === 0) return

    // Up arrow: only when cursor is at the start (first line)
    if (e.key === 'ArrowUp') {
      const textarea = textareaRef.current
      if (textarea && textarea.selectionStart !== 0) return

      e.preventDefault()
      if (historyIndex === -1) {
        // Save current draft before navigating history
        draftRef.current = text
      }
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(newIndex)
      setText(history[newIndex])
      return
    }

    // Down arrow: only when cursor is at the end (last line)
    if (e.key === 'ArrowDown') {
      const textarea = textareaRef.current
      if (textarea && textarea.selectionStart !== textarea.value.length) return
      if (historyIndex === -1) return

      e.preventDefault()
      const newIndex = historyIndex + 1
      if (newIndex >= history.length) {
        // Back to draft
        setHistoryIndex(-1)
        setText(draftRef.current)
      } else {
        setHistoryIndex(newIndex)
        setText(history[newIndex])
      }
      return
    }
  }

  const getSearchBasePath = useCallback(() => {
    const state = workspaceStore.getState()
    const term = state.terminals.find(t => t.id === terminalId)
    if (!term) return null
    const ws = state.workspaces.find(w => w.id === term.workspaceId)
    return term.cwd || ws?.folderPath || null
  }, [terminalId])

  const fetchSuggestions = useCallback((query: string) => {
    const basePath = getSearchBasePath()
    if (!basePath) {
      setSuggestions([])
      setSuggestActive(false)
      return
    }
    setSearching(true)
    window.electronAPI.fs.search(basePath, query).then((results: unknown) => {
      if (Array.isArray(results)) {
        setSuggestions(results.slice(0, 8) as SuggestionItem[])
        setSuggestIndex(0)
        setSuggestActive(results.length > 0)
      } else {
        setSuggestions([])
        setSuggestActive(false)
      }
      setSearching(false)
    }).catch(() => {
      setSuggestions([])
      setSuggestActive(false)
      setSearching(false)
    })
  }, [getSearchBasePath])

  const applySuggestion = (item: SuggestionItem) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const cursor = textarea.selectionStart
    const before = text.slice(0, cursor)
    const after = text.slice(cursor)
    const atIndex = before.lastIndexOf('@')
    if (atIndex < 0) return
    const nextText = before.slice(0, atIndex) + item.path + after
    setText(nextText)
    setSuggestActive(false)
    setSuggestions([])
    requestAnimationFrame(() => {
      const pos = atIndex + item.path.length
      textarea.setSelectionRange(pos, pos)
      textarea.focus()
    })
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setText(val)
    // Reset history navigation when user types
    if (historyIndex !== -1) {
      setHistoryIndex(-1)
      draftRef.current = ''
    }

    // Check for @ mention
    const cursor = e.target.selectionStart
    const before = val.slice(0, cursor)
    const atIndex = before.lastIndexOf('@')
    const hasSpaceAfterAt = before.slice(atIndex + 1).includes(' ')
    if (atIndex >= 0 && !hasSpaceAfterAt && before.slice(atIndex - 1, atIndex) !== '\\') {
      const query = before.slice(atIndex + 1)
      if (suggestDebounce.current) clearTimeout(suggestDebounce.current)
      if (query.length === 0) {
        setSuggestActive(false)
        setSuggestions([])
      } else {
        suggestDebounce.current = setTimeout(() => fetchSuggestions(query), 200)
      }
    } else {
      setSuggestActive(false)
      setSuggestions([])
    }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const filePath = await window.electronAPI.clipboard.saveImage()
        if (filePath) {
          setImagePath(filePath)
        }
        return
      }
    }
  }

  const hasContent = text.trim() || imagePath

  return (
    <div className="prompt-box">
      <div className="prompt-box-suggestions">
        {suggestActive && (
          <div className="prompt-box-suggestion-list">
            {searching && (
              <div className="prompt-box-suggestion-item">{t('common.loading')}</div>
            )}
            {!searching && suggestions.length === 0 && (
              <div className="prompt-box-suggestion-item">No matches</div>
            )}
            {!searching && suggestions.map((item, i) => (
              <div
                key={item.path}
                className={`prompt-box-suggestion-item ${i === suggestIndex ? 'active' : ''}`}
                onClick={() => applySuggestion(item)}
              >
                <span className="prompt-box-suggestion-icon">{item.isDirectory ? '📁' : '📄'}</span>
                <span className="prompt-box-suggestion-name">{item.name}</span>
                <span className="prompt-box-suggestion-path">{item.path}</span>
              </div>
            ))}
          </div>
        )}
        <div className="prompt-box-inner">
          <textarea
            ref={textareaRef}
            className="prompt-box-textarea"
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={imagePath ? t('promptBox.placeholderWithImage') : t('promptBox.placeholder')}
            style={{ fontFamily }}
            rows={3}
          />
          <button
            className="prompt-box-send"
            onClick={handleSend}
            disabled={!hasContent}
            title={t('promptBox.sendToTerminal')}
          >
            ▶
          </button>
        </div>
      </div>
      <div className="prompt-box-hint">
        {imagePath ? (
          <>
            <span className="prompt-box-image-badge">
              {t('promptBox.imageAttached')}
              <button className="prompt-box-image-remove" onClick={() => setImagePath(null)} title={t('promptBox.removeImage')}>×</button>
            </span>
            {' · '}
          </>
        ) : null}
        {t('promptBox.hint')}
      </div>
    </div>
  )
}
