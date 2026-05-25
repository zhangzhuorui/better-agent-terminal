import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { getAgentPreset, type AgentPresetId } from '../types/agent-presets'
import { settingsStore } from '../stores/settings-store'

interface BuiltinMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

type BuiltinStatus = 'idle' | 'thinking' | 'acting' | 'error'

interface BuiltinAgentPanelProps {
  terminalId: string
  presetId: AgentPresetId
  cwd: string
  isActive: boolean
}

const MAX_MESSAGES = 500

/** Markdown-lite renderer: code blocks + inline code + bold + line breaks */
function renderContent(text: string) {
  // Split by code fences
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3)
      const firstNewline = inner.indexOf('\n')
      const code = firstNewline >= 0 ? inner.slice(firstNewline + 1) : inner
      return (
        <pre key={i} className="builtin-agent-code-block">
          <code>{code}</code>
        </pre>
      )
    }
    // Simple inline formatting
    return (
      <span key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {part.split(/(`[^`]+`)/g).map((seg, j) =>
          seg.startsWith('`') && seg.endsWith('`')
            ? <code key={j} className="builtin-agent-inline-code">{seg.slice(1, -1)}</code>
            : seg
        )}
      </span>
    )
  })
}

export const BuiltinAgentPanel = memo(function BuiltinAgentPanel({ terminalId, presetId, cwd, isActive }: BuiltinAgentPanelProps) {
  const { t } = useTranslation()
  const preset = getAgentPreset(presetId)
  const [messages, setMessages] = useState<BuiltinMessage[]>([])
  const [status, setStatus] = useState<BuiltinStatus>('idle')
  const [inputText, setInputText] = useState('')
  const [streamingContent, setStreamingContent] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent])

  // Init: load models and start session
  useEffect(() => {
    const config = settingsStore.getAgentConfig(presetId)
    const savedModel = config.builtinModel || ''

    window.electronAPI.builtinAgent.getModels(presetId).then(m => {
      setModels(m)
      if (!savedModel && m.length > 0) {
        setSelectedModel(m[0])
      } else {
        setSelectedModel(savedModel)
      }
    })

    window.electronAPI.builtinAgent.startSession(terminalId, presetId, {
      model: savedModel || undefined,
      cwd,
    })

    return () => {
      window.electronAPI.builtinAgent.stopSession(terminalId)
    }
  }, [terminalId, presetId, cwd])

  // Subscribe to events
  useEffect(() => {
    const unsubMessage = window.electronAPI.builtinAgent.onMessage((_sid, msg) => {
      if (_sid !== terminalId) return
      setMessages(prev => {
        const next = [...prev]
        // Replace last assistant message if it has the same id (streaming update)
        const lastIdx = next.length - 1
        if (lastIdx >= 0 && next[lastIdx].id === msg.id) {
          next[lastIdx] = msg as BuiltinMessage
        } else {
          next.push(msg as BuiltinMessage)
        }
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next
      })
    })

    const unsubStream = window.electronAPI.builtinAgent.onStream((_sid, data) => {
      if (_sid !== terminalId) return
      setStreamingContent(data.fullContent)
    })

    const unsubStatus = window.electronAPI.builtinAgent.onStatus((_sid, meta) => {
      if (_sid !== terminalId) return
      setStatus(meta.status as BuiltinStatus)
      // Clear streaming content when idle
      if (meta.status === 'idle') {
        setStreamingContent('')
      }
    })

    const unsubResult = window.electronAPI.builtinAgent.onResult((_sid, _result) => {
      if (_sid !== terminalId) return
      setStreamingContent('')
    })

    const unsubError = window.electronAPI.builtinAgent.onError((_sid, error) => {
      if (_sid !== terminalId) return
      setStatus('error')
      window.electronAPI.debug.log('[builtin-agent] error:', error)
    })

    return () => {
      unsubMessage()
      unsubStream()
      unsubStatus()
      unsubResult()
      unsubError()
    }
  }, [terminalId])

  const handleSend = useCallback(async () => {
    const prompt = inputText.trim()
    if (!prompt || status === 'thinking' || status === 'acting') return

    setStreamingContent('')
    setInputText('')

    await window.electronAPI.builtinAgent.sendMessage(terminalId, prompt)
    textareaRef.current?.focus()
  }, [terminalId, inputText, status])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleModelChange = (model: string) => {
    setSelectedModel(model)
    window.electronAPI.builtinAgent.setModel(terminalId, model)
    settingsStore.setAgentConfig(presetId, { builtinModel: model })
  }

  const statusConfig: Record<BuiltinStatus, { label: string; color: string; dot: string }> = {
    idle: { label: 'Idle', color: '#888', dot: '○' },
    thinking: { label: 'Thinking', color: '#e5c07b', dot: '◐' },
    acting: { label: 'Acting', color: '#61afef', dot: '●' },
    error: { label: 'Error', color: '#e06c75', dot: '◉' },
  }
  const sc = statusConfig[status]

  return (
    <div className="builtin-agent-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div className="builtin-agent-header" style={{
        borderBottom: '1px solid var(--border-color)',
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: 'none',
      }}>
        <span style={{ color: preset?.color, fontSize: 14 }}>{preset?.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{preset?.name}</span>
        {/* Model selector */}
        {models.length > 0 && (
          <select
            value={selectedModel}
            onChange={e => handleModelChange(e.target.value)}
            style={{
              fontSize: 11,
              padding: '2px 6px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              outline: 'none',
            }}
          >
            {models.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
        {/* Status */}
        <span
          className={`agent-status-indicator agent-status-${status}`}
          style={{ color: sc.color, fontSize: 12, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span className="agent-status-dot" style={{ animation: status === 'thinking' || status === 'acting' ? 'pulse 1.5s infinite' : 'none' }}>
            {sc.dot}
          </span>
          {sc.label}
        </span>
        {/* Stop button */}
        {(status === 'thinking' || status === 'acting') && (
          <button
            className="action-btn danger"
            onClick={() => window.electronAPI.builtinAgent.stopSession(terminalId)}
            title="Stop"
            style={{ fontSize: 12, padding: '2px 8px' }}
          >
            ■
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="builtin-agent-messages" style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {messages.length === 0 && !streamingContent ? (
          <div className="builtin-agent-empty" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40, fontSize: 13 }}>
            <p>{preset?.icon} {preset?.name} is ready (built-in mode)</p>
            <p style={{ marginTop: 8, fontSize: 12 }}>
              {t('prompt.placeholder') || 'Type a message below (Ctrl+Enter to send)'}
            </p>
          </div>
        ) : (
          <>
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`builtin-agent-message builtin-agent-message-${msg.role}`}
                style={{
                  marginBottom: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: msg.role === 'user'
                    ? 'var(--bg-tertiary)'
                    : 'transparent',
                  borderLeft: msg.role === 'user'
                    ? `3px solid ${preset?.color}`
                    : '3px solid transparent',
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  {msg.role === 'user' && 'You'}
                  {msg.role === 'assistant' && preset?.name}
                  {msg.role === 'system' && 'System'}
                  <span style={{ marginLeft: 8, opacity: 0.6 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {msg.role === 'assistant' ? renderContent(msg.content) : msg.content}
                </div>
              </div>
            ))}
            {/* Streaming content */}
            {streamingContent && (
              <div
                className="builtin-agent-message builtin-agent-message-assistant"
                style={{
                  marginBottom: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  borderLeft: '3px solid transparent',
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {preset?.name}
                  <span style={{ animation: 'pulse 1.5s infinite', color: '#e5c07b' }}>◐</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {renderContent(streamingContent)}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div style={{ borderTop: '1px solid var(--border-color)', padding: '8px 12px', flex: 'none', display: 'flex', gap: 8 }}>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('prompt.placeholder') || 'Type a message... (Ctrl+Enter to send)'}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <button
          className="action-btn primary"
          onClick={handleSend}
          disabled={!inputText.trim() || status === 'thinking' || status === 'acting'}
          style={{
            padding: '8px 14px',
            borderRadius: 6,
            background: inputText.trim() && status === 'idle' ? preset?.color : 'var(--bg-tertiary)',
            color: inputText.trim() && status === 'idle' ? '#fff' : 'var(--text-secondary)',
            border: 'none',
            cursor: inputText.trim() && status === 'idle' ? 'pointer' : 'not-allowed',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
})
