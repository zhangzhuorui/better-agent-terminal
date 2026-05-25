import { logger } from './logger'
import type { ClaudeAgentManager } from './claude-agent-manager'
import type { PtyManager } from './pty-manager'
import type { BuiltinAgentManager } from './builtin-agent-manager'
import type { WorkflowNodeToolCall } from '../src/types/platform-extensions'
import { isToolCall } from '../src/types/claude-agent'

export interface AgentDispatchOptions {
  terminalId: string
  prompt: string
  agentPreset?: string
  waitForComplete: boolean
  timeoutMs: number
  signal: AbortSignal
  onProgress: (meta: AgentProgressMeta) => void
  contextPackageIds?: string[]
  analyticsSource?: 'user' | 'automation'
}

export interface AgentProgressMeta {
  turns: number
  inputTokens: number
  outputTokens: number
  toolCalls: WorkflowNodeToolCall[]
}

export interface AgentResult {
  output: string
  costUsd: number
}

/** PTY output buffer for idle detection */
interface PtyOutputBuffer {
  chunks: string[]
  lastActivityTime: number
  resolved: boolean
}

const PTY_IDLE_THRESHOLD = 5000 // 5s of no output = likely idle
const PTY_POLL_INTERVAL = 1000

export class AgentDispatcher {
  private ptyOutputBuffers = new Map<string, PtyOutputBuffer>()
  private ptyUnsubscribers = new Map<string, () => void>()

  constructor(
    private claudeManager: ClaudeAgentManager | null,
    private ptyManager: PtyManager | null,
    private builtinManager: BuiltinAgentManager | null = null,
  ) {}

  /**
   * Dispatch a prompt to the appropriate agent backend.
   * - Claude SDK sessions: send via claudeAgentManager, poll for completion
   * - Built-in (OpenAI/Gemini/Copilot): send via builtinAgentManager
   * - PTY-based agents: write to PTY, buffer output
   */
  async dispatch(options: AgentDispatchOptions): Promise<AgentResult> {
    const { terminalId, prompt, agentPreset, waitForComplete, timeoutMs, signal, onProgress, contextPackageIds, analyticsSource } = options

    // Route based on agent preset
    const isClaudeSdk = agentPreset === 'claude-code' || (!agentPreset && this.claudeManager?.getSessionState(terminalId))

    if (isClaudeSdk && this.claudeManager) {
      return this.dispatchToClaudeSdk(terminalId, prompt, waitForComplete, timeoutMs, signal, onProgress, contextPackageIds, analyticsSource)
    }

    // Built-in path: if builtin manager has a session for this terminal, prefer it
    if (this.builtinManager && this.builtinManager.getSessionState(terminalId)) {
      return this.dispatchToBuiltin(terminalId, prompt, waitForComplete, timeoutMs, signal, onProgress)
    }

    return this.dispatchToPty(terminalId, prompt, waitForComplete, timeoutMs, signal, onProgress)
  }

  // ---------------------------------------------------------------------------
  // Built-in agent (OpenAI / Gemini / Copilot)
  // ---------------------------------------------------------------------------

  private async dispatchToBuiltin(
    terminalId: string,
    prompt: string,
    waitForComplete: boolean,
    timeoutMs: number,
    signal: AbortSignal,
    onProgress: (meta: AgentProgressMeta) => void,
  ): Promise<AgentResult> {
    if (!this.builtinManager) throw new Error('Built-in agent manager not available')

    if (!waitForComplete) {
      this.builtinManager.sendMessage(terminalId, prompt).catch(err =>
        logger.error('[dispatcher] builtin sendMessage failed', err)
      )
      return { output: 'Message sent', costUsd: 0 }
    }

    // Race sendMessage against timeout/abort
    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      let lastOutputLen = 0

      const progressTimer = setInterval(() => {
        const state = this.builtinManager!.getSessionState(terminalId)
        if (!state) return
        const lastMsg = state.messages[state.messages.length - 1]
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.length !== lastOutputLen) {
          lastOutputLen = lastMsg.content.length
          onProgress({
            turns: state.messages.filter(m => m.role === 'user').length,
            inputTokens: state.totalInputTokens,
            outputTokens: state.totalOutputTokens,
            toolCalls: [],
          })
        }
      }, 500)

      const cleanup = () => {
        clearInterval(progressTimer)
      }

      signal.addEventListener('abort', () => {
        cleanup()
        this.builtinManager?.stopSession(terminalId)
        reject(new Error('Cancelled'))
      })

      const timeoutTimer = setTimeout(() => {
        cleanup()
        this.builtinManager?.stopSession(terminalId)
        reject(new Error(`Timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      this.builtinManager!.sendMessage(terminalId, prompt).then(ok => {
        cleanup()
        clearTimeout(timeoutTimer)
        if (!ok) {
          const state = this.builtinManager!.getSessionState(terminalId)
          reject(new Error(state?.error || 'Built-in agent failed'))
          return
        }
        const state = this.builtinManager!.getSessionState(terminalId)
        const lastMsg = state?.messages[state.messages.length - 1]
        resolve({
          output: (lastMsg && lastMsg.role === 'assistant') ? lastMsg.content : '',
          costUsd: 0,
        })
      }).catch(err => {
        cleanup()
        clearTimeout(timeoutTimer)
        reject(err)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Claude SDK
  // ---------------------------------------------------------------------------

  private async dispatchToClaudeSdk(
    terminalId: string,
    prompt: string,
    waitForComplete: boolean,
    timeoutMs: number,
    signal: AbortSignal,
    onProgress: (meta: AgentProgressMeta) => void,
    contextPackageIds?: string[],
    analyticsSource?: 'user' | 'automation',
  ): Promise<AgentResult> {
    if (!this.claudeManager) {
      throw new Error('Claude agent manager not available')
    }

    const ok = await this.claudeManager.sendMessage(terminalId, prompt, undefined, {
      contextPackageIds,
      analyticsSource: analyticsSource ?? 'automation',
    })
    if (!ok) {
      throw new Error('Failed to send message to Claude session')
    }

    if (!waitForComplete) {
      return { output: 'Message sent', costUsd: 0 }
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      const checkInterval = setInterval(() => {
        if (signal.aborted) {
          clearInterval(checkInterval)
          reject(new Error('Cancelled'))
          return
        }

        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval)
          reject(new Error(`Timeout after ${timeoutMs}ms`))
          return
        }

        const sessionState = this.claudeManager!.getSessionState(terminalId)
        const session = (this.claudeManager as any).sessions?.get(terminalId)
        const activeTasks = session?.activeTasks as Map<string, { toolUseId: string; description: string }> | undefined

        const turns = sessionState?.messages?.filter(m => m.role === 'user').length ?? 0
        const totalTokens = sessionState?.totalTokens ?? 0
        const costUsd = sessionState?.totalCost ?? 0

        const toolCalls: WorkflowNodeToolCall[] = []
        if (activeTasks) {
          for (const [, task] of activeTasks) {
            toolCalls.push({
              id: task.toolUseId,
              name: task.description.split(' ')[0] || 'tool',
              status: 'running',
              startedAt: startTime,
            })
          }
        }

        onProgress({
          turns,
          inputTokens: Math.floor(totalTokens * 0.3),
          outputTokens: Math.floor(totalTokens * 0.7),
          toolCalls,
        })

        // Detect idle: not streaming and no active tasks
        const isIdle = sessionState && !sessionState.isStreaming && (!activeTasks || activeTasks.size === 0)
        if (isIdle) {
          clearInterval(checkInterval)

          // Extract last assistant message as output
          const messages = sessionState.messages ?? []
          let output = ''
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (!isToolCall(msg) && msg.role === 'assistant') {
              output = msg.content
              break
            }
          }

          resolve({ output, costUsd })
        }
      }, PTY_POLL_INTERVAL)
    })
  }

  // ---------------------------------------------------------------------------
  // PTY-based agents
  // ---------------------------------------------------------------------------

  private async dispatchToPty(
    terminalId: string,
    prompt: string,
    waitForComplete: boolean,
    timeoutMs: number,
    signal: AbortSignal,
    onProgress: (meta: AgentProgressMeta) => void,
  ): Promise<AgentResult> {
    if (!this.ptyManager) {
      throw new Error('PTY manager not available')
    }

    // Write prompt to terminal
    this.ptyManager.write(terminalId, prompt + '\r')

    if (!waitForComplete) {
      return { output: 'Command sent', costUsd: 0 }
    }

    // Set up output buffering
    const buffer: PtyOutputBuffer = {
      chunks: [],
      lastActivityTime: Date.now(),
      resolved: false,
    }
    this.ptyOutputBuffers.set(terminalId, buffer)

    // Subscribe to PTY output
    const unsubscribe = this.ptyManager.onData(terminalId, (data: string) => {
      if (!buffer.resolved) {
        buffer.chunks.push(data)
        buffer.lastActivityTime = Date.now()
      }
    })

    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      let lastOutputLength = 0

      const checkInterval = setInterval(() => {
        if (signal.aborted) {
          clearInterval(checkInterval)
          unsubscribe()
          buffer.resolved = true
          this.ptyOutputBuffers.delete(terminalId)
          reject(new Error('Cancelled'))
          return
        }

        const elapsed = Date.now() - startTime
        if (elapsed > timeoutMs) {
          clearInterval(checkInterval)
          unsubscribe()
          buffer.resolved = true
          const output = buffer.chunks.join('')
          this.ptyOutputBuffers.delete(terminalId)
          resolve({ output, costUsd: 0 })
          return
        }

        // Report progress (no precise metrics for PTY agents)
        const currentOutput = buffer.chunks.join('')
        if (currentOutput.length !== lastOutputLength) {
          lastOutputLength = currentOutput.length
          buffer.lastActivityTime = Date.now()
          onProgress({ turns: 0, inputTokens: 0, outputTokens: 0, toolCalls: [] })
        }

        // Idle detection: no new output for PTY_IDLE_THRESHOLD
        if (elapsed > 3000 && Date.now() - buffer.lastActivityTime > PTY_IDLE_THRESHOLD) {
          clearInterval(checkInterval)
          unsubscribe()
          buffer.resolved = true
          const output = buffer.chunks.join('')
          this.ptyOutputBuffers.delete(terminalId)
          resolve({ output, costUsd: 0 })
        }
      }, PTY_POLL_INTERVAL)
    })
  }

}
