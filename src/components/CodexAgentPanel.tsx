import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { TerminalPanel } from './TerminalPanel'
import { getAgentPreset } from '../types/agent-presets'

interface CodexMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result'
  content: string
  timestamp: number
}

interface CodexToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'failed'
  timestamp: number
}

type CodexStatus = 'idle' | 'thinking' | 'acting' | 'error'

interface CodexAgentPanelProps {
  terminalId: string
  isActive: boolean
}

const MAX_MESSAGES = 200

export const CodexAgentPanel = memo(function CodexAgentPanel({ terminalId, isActive }: CodexAgentPanelProps) {
  const { t } = useTranslation()
  const preset = getAgentPreset('codex-cli')
  const [messages, setMessages] = useState<CodexMessage[]>([])
  const [status, setStatus] = useState<CodexStatus>('idle')
  const [toolCalls, setToolCalls] = useState<CodexToolCall[]>([])
  const [showTerminal, setShowTerminal] = useState(false)
  const [inputText, setInputText] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, toolCalls])

  // Start session and subscribe to events
  useEffect(() => {
    window.electronAPI.codex.startSession(terminalId, terminalId)

    const unsubMessage = window.electronAPI.codex.onMessage((_sessionId, msg) => {
      if (_sessionId !== terminalId) return
      const codexMsg = msg as CodexMessage
      setMessages(prev => {
        const next = [...prev, codexMsg]
        if (next.length > MAX_MESSAGES) return next.slice(-MAX_MESSAGES)
        return next
      })
    })

    const unsubStatus = window.electronAPI.codex.onStatus((_sessionId, meta) => {
      if (_sessionId !== terminalId) return
      const s = (meta as { status: CodexStatus }).status
      setStatus(s)
    })

    const unsubToolUse = window.electronAPI.codex.onToolUse((_sessionId, tc) => {
      if (_sessionId !== terminalId) return
      const tool = tc as CodexToolCall
      setToolCalls(prev => [...prev, { ...tool, status: 'running' }])
    })

    const unsubToolResult = window.electronAPI.codex.onToolResult((_sessionId, result) => {
      if (_sessionId !== terminalId) return
      const r = result as CodexToolCall
      setToolCalls(prev =>
        prev.map(tc => (tc.id === r.id ? { ...tc, status: r.status } : tc))
      )
    })

    const unsubError = window.electronAPI.codex.onError((_sessionId, error) => {
      if (_sessionId !== terminalId) return
      setStatus('error')
      window.electronAPI.debug.log('[codex] error:', error)
    })

    return () => {
      unsubMessage()
      unsubStatus()
      unsubToolUse()
      unsubToolResult()
      unsubError()
    }
  }, [terminalId])

  const handleSend = useCallback(async () => {
    const prompt = inputText.trim()
    if (!prompt) return

    // Track in codex manager
    await window.electronAPI.codex.sendMessage(terminalId, prompt)

    // Write to PTY
    await window.electronAPI.pty.write(terminalId, prompt)
    await new Promise(r => setTimeout(r, 100))
    await window.electronAPI.pty.write(terminalId, '\r')

    setInputText('')
    textareaRef.current?.focus()
  }, [terminalId, inputText])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const statusConfig: Record<CodexStatus, { label: string; color: string; dot: string }> = {
    idle: { label: 'Idle', color: '#888', dot: '○' },
    thinking: { label: 'Thinking', color: '#e5c07b', dot: '◐' },
    acting: { label: 'Acting', color: '#61afef', dot: '●' },
    error: { label: 'Error', color: '#e06c75', dot: '◉' },
  }

  const sc = statusConfig[status]

  return (
    <div className="codex-agent-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div className="codex-agent-header" style={{ borderBottom: '1px solid var(--border-color)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
        <span style={{ color: preset?.color, fontSize: 14 }}>{preset?.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{preset?.name}</span>
        <span
          className={`agent-status-indicator agent-status-${status}`}
          style={{ color: sc.color, fontSize: 12, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span className="agent-status-dot" style={{ animation: status === 'thinking' || status === 'acting' ? 'pulse 1.5s infinite' : 'none' }}>
            {sc.dot}
          </span>
          {sc.label}
        </span>
        <button
          className="action-btn"
          onClick={() => setShowTerminal(v => !v)}
          title={showTerminal ? 'Hide terminal' : 'Show terminal'}
        >
          {showTerminal ? '📺' : '💻'}
        </button>
      </div>

      {/* Messages */}
      <div className="codex-agent-messages" style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {messages.length === 0 && toolCalls.length === 0 ? (
          <div className="codex-agent-empty" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40, fontSize: 13 }}>
            <p>💬 {preset?.name} is ready</p>
            <p style={{ marginTop: 8, fontSize: 12 }}>Type a message below to start</p>
          </div>
        ) : (
          <>
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`codex-agent-message codex-agent-message-${msg.role}`}
                style={{
                  marginBottom: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: msg.role === 'user' ? 'var(--bg-tertiary)' : msg.role === 'tool_call' ? 'rgba(97, 175, 239, 0.08)' : 'transparent',
                  borderLeft: msg.role === 'user'
                    ? `3px solid ${preset?.color}`
                    : msg.role === 'tool_call'
                      ? '3px solid #61afef'
                      : msg.role === 'tool_result'
                        ? '3px solid #98c379'
                        : '3px solid transparent',
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  {msg.role === 'user' && 'You'}
                  {msg.role === 'assistant' && preset?.name}
                  {msg.role === 'system' && 'System'}
                  {msg.role === 'tool_call' && 'Tool Call'}
                  {msg.role === 'tool_result' && 'Tool Result'}
                  <span style={{ marginLeft: 8, opacity: 0.6 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
              </div>
            ))}

            {/* Active tool calls */}
            {toolCalls.filter(tc => tc.status === 'running').map(tc => (
              <div
                key={tc.id}
                className="codex-agent-tool-call"
                style={{
                  marginBottom: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(97, 175, 239, 0.08)',
                  borderLeft: '3px solid #61afef',
                }}
              >
                <div style={{ fontSize: 11, color: '#61afef', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ animation: 'spin 1.5s linear infinite' }}>◐</span>
                  Running: {tc.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(tc.input, null, 2)}
                </div>
              </div>
            ))}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Terminal preview */}
      {showTerminal && (
        <div style={{ height: 200, borderTop: '1px solid var(--border-color)', flex: 'none' }}>
          <TerminalPanel terminalId={terminalId} isActive={isActive} />
        </div>
      )}

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
          disabled={!inputText.trim()}
          style={{
            padding: '8px 14px',
            borderRadius: 6,
            background: inputText.trim() ? preset?.color : 'var(--bg-tertiary)',
            color: inputText.trim() ? '#fff' : 'var(--text-secondary)',
            border: 'none',
            cursor: inputText.trim() ? 'pointer' : 'not-allowed',
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
