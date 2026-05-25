import { BrowserWindow } from 'electron'
import { logger } from './logger'
import { broadcastHub } from './remote/broadcast-hub'
import type { WorkflowNodeToolCall } from '../src/types/platform-extensions'

export interface CodexMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result'
  content: string
  timestamp: number
}

export interface CodexSessionState {
  sessionId: string
  messages: CodexMessage[]
  status: 'idle' | 'thinking' | 'acting' | 'error'
  currentToolCall?: WorkflowNodeToolCall
}

interface SessionInstance {
  ptyId: string
  state: CodexSessionState
  outputBuffer: string
  lastActivityTime: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

/** Codex CLI output patterns — configurable since format may change */
const DEFAULT_PATTERNS = {
  // User prompt ready indicators (various TUI styles)
  promptReady: [
    /^\s*>\s*$/m,
    /^\s*\$\s*$/m,
    /^\s*codex>\s*/im,
    /^\s*You:\s*/im,
  ],
  // Thinking / processing indicators
  thinking: [
    /thinking[:.…]/i,
    /analyzing[:.…]/i,
    /processing[:.…]/i,
    /让我想想/i,
    /正在思考/i,
    /分析中/i,
  ],
  // Tool call indicators
  toolCall: [
    /(?:running|executing|calling)\s*:?\s*(.+)/i,
    /(?:read|write|edit|shell|bash)\s*:?\s*(.+)/i,
    /(?:\[|\()?(?:tool|command|action)\s*:?\s*(.+)/i,
  ],
  // Completion indicators
  done: [
    /^\s*done[:!]?\s*$/im,
    /^\s*completed[:!]?\s*$/im,
    /^\s*finished[:!]?\s*$/im,
  ],
  // Error indicators
  error: [
    /error[:\s]/i,
    /failed[:\s]/i,
    /exception[:\s]/i,
  ],
}

const MSG_BUFFER_CAP = 200
const IDLE_TIMEOUT = 4000 // ms of no output before assuming response ended

export class CodexAgentManager {
  private sessions: Map<string, SessionInstance> = new Map()
  private getWindows: () => BrowserWindow[]
  private patterns: typeof DEFAULT_PATTERNS

  constructor(getWindows: () => BrowserWindow[], patterns = DEFAULT_PATTERNS) {
    this.getWindows = getWindows
    this.patterns = patterns
  }

  private send(channel: string, ...args: unknown[]) {
    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, ...args)
        } catch { /* ignore */ }
      }
    }
    broadcastHub.broadcast(channel, ...args)
  }

  /** Register a PTY session as a Codex session */
  registerSession(sessionId: string, ptyId: string): void {
    const session: SessionInstance = {
      ptyId,
      state: {
        sessionId,
        messages: [],
        status: 'idle',
      },
      outputBuffer: '',
      lastActivityTime: Date.now(),
      idleTimer: null,
    }
    this.sessions.set(sessionId, session)
    logger.log(`[codex] registered session ${sessionId} -> pty ${ptyId}`)
  }

  unregisterSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.idleTimer) clearTimeout(session.idleTimer)
    this.sessions.delete(sessionId)
    logger.log(`[codex] unregistered session ${sessionId}`)
  }

  /** Called by PTY output handler when data arrives */
  onPtyOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.outputBuffer += data
    session.lastActivityTime = Date.now()

    // Reset idle timer
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      this.flushOutputBuffer(sessionId)
    }, IDLE_TIMEOUT)

    // Real-time status detection
    this.detectStatus(sessionId)
  }

  /** Send a user message to Codex via PTY write */
  sendMessage(sessionId: string, prompt: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.send('codex:error', sessionId, 'Session not found')
      return false
    }

    // Add user message to history
    const userMsg: CodexMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    }
    this.addMessage(sessionId, userMsg)

    // Transition to thinking
    this.updateStatus(sessionId, 'thinking')

    // Note: actual PTY write is done by the frontend calling pty:write
    // This method just tracks state. The frontend should write to PTY after this.
    return true
  }

  /** Flush accumulated output into assistant message */
  private flushOutputBuffer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.outputBuffer.trim()) return

    const text = session.outputBuffer.trim()
    session.outputBuffer = ''

    // Skip if it's just prompt indicators or shell noise
    if (this.isPromptOnly(text)) return

    // Detect tool calls within the output
    const toolCalls = this.extractToolCalls(text)

    const assistantMsg: CodexMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    }
    this.addMessage(sessionId, assistantMsg)

    // Emit tool calls
    for (const tc of toolCalls) {
      this.send('codex:tool-use', sessionId, tc)
      // Mark as completed since we can't track individual tool results for PTY agents
      setTimeout(() => {
        this.send('codex:tool-result', sessionId, { ...tc, status: 'completed' as const })
      }, 500)
    }

    // Return to idle
    this.updateStatus(sessionId, 'idle')
  }

  /** Real-time status detection from output buffer */
  private detectStatus(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const text = session.outputBuffer.toLowerCase()

    for (const p of this.patterns.error) {
      if (p.test(text)) {
        this.updateStatus(sessionId, 'error')
        return
      }
    }

    for (const p of this.patterns.toolCall) {
      if (p.test(text)) {
        this.updateStatus(sessionId, 'acting')
        return
      }
    }

    for (const p of this.patterns.thinking) {
      if (p.test(text)) {
        this.updateStatus(sessionId, 'thinking')
        return
      }
    }

    // If buffer is small and looks like a prompt, we're idle
    if (this.isPromptOnly(session.outputBuffer)) {
      this.updateStatus(sessionId, 'idle')
    }
  }

  private isPromptOnly(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return true
    for (const p of this.patterns.promptReady) {
      if (p.test(trimmed)) return true
    }
    return false
  }

  private extractToolCalls(text: string): Array<{ id: string; name: string; input: Record<string, unknown>; status: 'running'; timestamp: number }> {
    const results: Array<{ id: string; name: string; input: Record<string, unknown>; status: 'running'; timestamp: number }> = []
    for (const p of this.patterns.toolCall) {
      const matches = text.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'))
      for (const m of matches) {
        const desc = m[1] || m[0]
        results.push({
          id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: desc.split(' ')[0] || 'tool',
          input: { description: desc },
          status: 'running',
          timestamp: Date.now(),
        })
      }
    }
    return results
  }

  private addMessage(sessionId: string, msg: CodexMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.state.messages.push(msg)
    if (session.state.messages.length > MSG_BUFFER_CAP) {
      session.state.messages = session.state.messages.slice(-MSG_BUFFER_CAP)
    }
    this.send('codex:message', sessionId, msg)
  }

  private updateStatus(sessionId: string, status: CodexSessionState['status']): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.state.status === status) return
    session.state.status = status
    this.send('codex:status', sessionId, { status })
  }

  /** Find and forward PTY output by ptyId (for main process routing) */
  onPtyOutputByPtyId(ptyId: string, data: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.ptyId === ptyId) {
        this.onPtyOutput(sessionId, data)
        return
      }
    }
  }

  getSessionState(sessionId: string): CodexSessionState | null {
    return this.sessions.get(sessionId)?.state ?? null
  }

  /** Stop a running task/session */
  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.outputBuffer = ''
    this.updateStatus(sessionId, 'idle')
    return true
  }

  dispose(): void {
    for (const [id, session] of this.sessions) {
      if (session.idleTimer) clearTimeout(session.idleTimer)
    }
    this.sessions.clear()
  }
}
