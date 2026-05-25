import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TerminalInstance } from '../types'
import { getAgentPreset, isCliAgent } from '../types/agent-presets'
import { TerminalPanel } from './TerminalPanel'
import { PromptBox } from './PromptBox'
import { workspaceStore } from '../stores/workspace-store'

interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

interface GenericAgentPanelProps {
  terminal: TerminalInstance
  isActive: boolean
}

/** 全局每終端消息歷史 */
const messageHistoryMap = new Map<string, AgentMessage[]>()

/** 狀態檢測關鍵字 */
const THINKING_KEYWORDS = [
  'thinking', 'analyzing', 'processing', 'working on',
  '正在思考', '分析中', '处理中',
]
const ACTING_KEYWORDS = [
  'running', 'executing', 'calling', 'reading', 'writing',
  '正在执行', '运行中', '调用',
]
const DONE_KEYWORDS = [
  'done', 'completed', 'finished', 'ready',
  '完成', '已结束',
]
const ERROR_KEYWORDS = [
  'error', 'failed', 'exception', 'abort',
  '错误', '失败',
]

type AgentStatus = 'idle' | 'thinking' | 'acting' | 'error'

function detectStatus(text: string): AgentStatus | null {
  const lower = text.toLowerCase()
  for (const kw of ERROR_KEYWORDS) {
    if (lower.includes(kw)) return 'error'
  }
  for (const kw of ACTING_KEYWORDS) {
    if (lower.includes(kw)) return 'acting'
  }
  for (const kw of THINKING_KEYWORDS) {
    if (lower.includes(kw)) return 'thinking'
  }
  for (const kw of DONE_KEYWORDS) {
    if (lower.includes(kw)) return 'idle'
  }
  return null
}

function getHistory(terminalId: string): AgentMessage[] {
  if (!messageHistoryMap.has(terminalId)) {
    messageHistoryMap.set(terminalId, [])
  }
  return messageHistoryMap.get(terminalId)!
}

function addMessage(terminalId: string, message: AgentMessage) {
  const history = getHistory(terminalId)
  history.push(message)
  // 保留最近 100 條
  if (history.length > 100) {
    messageHistoryMap.set(terminalId, history.slice(-100))
  }
}

export const GenericAgentPanel = memo(function GenericAgentPanel({ terminal, isActive }: GenericAgentPanelProps) {
  const { t } = useTranslation()
  const preset = getAgentPreset(terminal.agentPreset || 'none')
  const [messages, setMessages] = useState<AgentMessage[]>(() => getHistory(terminal.id))
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [showTerminal, setShowTerminal] = useState(false)
  const [lastOutput, setLastOutput] = useState('')
  const statusRef = useRef<AgentStatus>('idle')
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outputBufferRef = useRef('')

  // 監聽終端輸出，檢測狀態
  useEffect(() => {
    const unsubscribe = window.electronAPI.pty.onOutput((id, data) => {
      if (id !== terminal.id) return

      outputBufferRef.current += data
      // 每 500ms 或遇到換行時分析
      const lines = outputBufferRef.current.split('\n')
      if (lines.length > 1 || outputBufferRef.current.length > 200) {
        const textToAnalyze = outputBufferRef.current.slice(-500) // 只分析最近 500 字元
        outputBufferRef.current = ''

        const detected = detectStatus(textToAnalyze)
        if (detected) {
          statusRef.current = detected
          setStatus(detected)

          // 檢測到活動時清除 idle 計時器
          if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current)
            idleTimerRef.current = null
          }

          // 2 秒無新活動後回到 idle
          if (detected !== 'idle') {
            idleTimerRef.current = setTimeout(() => {
              statusRef.current = 'idle'
              setStatus('idle')
            }, 3000)
          }
        }

        setLastOutput(textToAnalyze)
      }
    })

    return () => {
      unsubscribe()
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [terminal.id])

  // 監聽 workspaceStore 中的終端活動（用戶通過 PromptBox 發送消息）
  useEffect(() => {
    const unsubscribe = workspaceStore.subscribe(() => {
      const term = workspaceStore.getState().terminals.find(t => t.id === terminal.id)
      if (term?.lastActivityTime) {
        // 如果有活動且狀態是 idle，可能是用戶發送了消息
        // 這裡我們暫時無法精確知道是 user 消息還是 agent 輸出
        // P2 階段會通過 codex-agent-manager 提供更精確的消息追蹤
      }
    })
    return unsubscribe
  }, [terminal.id])

  const handleSendPrompt = useCallback((prompt: string) => {
    if (!prompt.trim()) return
    addMessage(terminal.id, {
      id: `${Date.now()}-user`,
      role: 'user',
      content: prompt.trim(),
      timestamp: Date.now(),
    })
    setMessages(getHistory(terminal.id))
  }, [terminal.id])

  const statusConfig: Record<AgentStatus, { label: string; color: string; dot: string }> = {
    idle: { label: 'Idle', color: '#888', dot: '○' },
    thinking: { label: 'Thinking', color: '#e5c07b', dot: '◐' },
    acting: { label: 'Acting', color: '#61afef', dot: '●' },
    error: { label: 'Error', color: '#e06c75', dot: '◉' },
  }

  const sc = statusConfig[status]

  return (
    <div className="generic-agent-panel">
      {/* 頂部狀態欄 */}
      <div className="generic-agent-header" style={{ borderBottom: '1px solid var(--border-color)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
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

      {/* 消息歷史 */}
      <div className="generic-agent-messages" style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {messages.length === 0 ? (
          <div className="generic-agent-empty" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40, fontSize: 13 }}>
            <p>💬 {preset?.name} is ready</p>
            <p style={{ marginTop: 8, fontSize: 12 }}>Type a message below to start</p>
          </div>
        ) : (
          messages.map(msg => (
            <div
              key={msg.id}
              className={`generic-agent-message generic-agent-message-${msg.role}`}
              style={{
                marginBottom: 8,
                padding: '8px 12px',
                borderRadius: 8,
                background: msg.role === 'user' ? 'var(--bg-tertiary)' : 'transparent',
                borderLeft: msg.role === 'user' ? `3px solid ${preset?.color}` : '3px solid transparent',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                {msg.role === 'user' ? 'You' : preset?.name}
                <span style={{ marginLeft: 8, opacity: 0.6 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
            </div>
          ))
        )}

        {/* 最新輸出預覽（當沒有結構化消息時） */}
        {messages.length === 0 && lastOutput && (
          <div className="generic-agent-last-output" style={{ marginTop: 16, padding: 8, background: 'var(--bg-secondary)', borderRadius: 4, fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
            {lastOutput.slice(-300)}
          </div>
        )}
      </div>

      {/* 終端預覽（可折疊） */}
      {showTerminal && (
        <div style={{ height: 200, borderTop: '1px solid var(--border-color)', flex: 'none' }}>
          <TerminalPanel terminalId={terminal.id} isActive={isActive} />
        </div>
      )}

      {/* 底部輸入區 */}
      <div style={{ borderTop: '1px solid var(--border-color)' }}>
        <PromptBox terminalId={terminal.id} />
      </div>
    </div>
  )
})
