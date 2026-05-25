/**
 * BuiltinAgentManager — unified in-process agent backend for OpenAI, Gemini, and Copilot.
 *
 * Instead of spawning external CLIs inside a PTY, this manager calls each
 * vendor's chat-completion HTTP API directly from the main process.
 * Users only need to provide an API key (stored encrypted via safeStorage).
 *
 * Architecture per vendor:
 *   OpenAI   → POST https://api.openai.com/v1/chat/completions  (SSE streaming)
 *   Gemini   → POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent
 *   Copilot  → POST https://api.githubcopilot.com/chat/completions (OpenAI-compatible)
 *
 * MVP: chat-only (no tool execution). Tool support will be added in a follow-up.
 */

import { BrowserWindow } from 'electron'
import { logger } from './logger'
import { broadcastHub } from './remote/broadcast-hub'
import { decryptSecret } from './secret-store'
import { executeBuiltinTool, getGeminiToolDeclarations, getOpenAIToolDefinitions } from './builtin-tools'
import type { AgentPresetId } from '../src/types/agent-presets'

// ─── Types ────────────────────────────────────────────────────────────────

export interface BuiltinMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface BuiltinSessionState {
  sessionId: string
  presetId: AgentPresetId
  status: 'idle' | 'thinking' | 'acting' | 'error'
  messages: BuiltinMessage[]
  totalInputTokens: number
  totalOutputTokens: number
  model: string
  error?: string
}

interface SessionInstance {
  state: BuiltinSessionState
  abortController: AbortController | null
  conversationHistory: ChatMessage[]  // sent to the API
  cwd: string
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
  geminiFunctionCalls?: GeminiFunctionCall[]
}

interface OpenAIToolCall {
  id: string
  index?: number
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface GeminiFunctionCall {
  name: string
  args: Record<string, unknown>
}

// ─── Vendor configurations ────────────────────────────────────────────────

interface VendorConfig {
  /** Build the streaming request for this vendor. Returns { url, headers, body } */
  buildRequest(
    model: string,
    messages: ChatMessage[],
    apiKey: string,
    baseUrl?: string,
    enableTools?: boolean,
  ): { url: string; headers: Record<string, string>; body: string }
  /** Parse a SSE data line into delta text. Return null if not a content delta. */
  parseDelta(line: string): string | null
  /** Parse the final [DONE] or usage info from SSE. */
  parseDone(line: string): { inputTokens?: number; outputTokens?: number } | null
  parseToolCalls?(line: string): OpenAIToolCall[]
  parseGeminiFunctionCalls?(line: string): GeminiFunctionCall[]
  /** Default models for this vendor */
  defaultModels: string[]
}

const VENDORS: Record<string, VendorConfig> = {
  'codex-cli': {
    buildRequest(model, messages, apiKey, baseUrl, enableTools) {
      const url = baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`
        : 'https://api.openai.com/v1/chat/completions'
      return {
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: toOpenAIChatMessages(messages),
          stream: true,
          ...(enableTools ? { tools: getOpenAIToolDefinitions(), tool_choice: 'auto' } : {}),
        }),
      }
    },
    parseDelta(line) {
      // OpenAI SSE format: data: {"choices":[{"delta":{"content":"..."}}]}
      if (!line.startsWith('data: ') || line === 'data: [DONE]') return null
      try {
        const obj = JSON.parse(line.slice(6))
        return obj.choices?.[0]?.delta?.content ?? null
      } catch { return null }
    },
    parseDone(line) {
      if (line === 'data: [DONE]') return { inputTokens: 0, outputTokens: 0 }
      return null
    },
    parseToolCalls: parseOpenAIToolCalls,
    defaultModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o4-mini'],
  },

  'gemini-cli': {
    buildRequest(model, messages, apiKey, baseUrl, enableTools) {
      const url = baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
      // Gemini uses a different format for messages
      const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => {
          if (m.role === 'tool') {
            return {
              role: 'function',
              parts: [{ functionResponse: { name: m.tool_call_id || 'tool', response: { content: m.content } } }],
            }
          }
          if (m.geminiFunctionCalls?.length) {
            return {
              role: 'model',
              parts: m.geminiFunctionCalls.map(call => ({ functionCall: { name: call.name, args: call.args } })),
            }
          }
          return {
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          }
        })
      const systemInstruction = messages.find(m => m.role === 'system')
      return {
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction.content }] } } : {}),
          ...(enableTools ? { tools: [{ functionDeclarations: getGeminiToolDeclarations() }] } : {}),
          generationConfig: { temperature: 1 },
        }),
      }
    },
    parseDelta(line) {
      // Gemini SSE format: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
      if (!line.startsWith('data: ')) return null
      try {
        const obj = JSON.parse(line.slice(6))
        return obj.candidates?.[0]?.content?.parts?.[0]?.text ?? null
      } catch { return null }
    },
    parseDone(_line) {
      // Gemini doesn't have a [DONE] marker; usage is in the last chunk
      return null
    },
    parseGeminiFunctionCalls: parseGeminiFunctionCallsFromSSE,
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },

  'copilot-cli': {
    buildRequest(model, messages, apiKey, _baseUrl, enableTools) {
      // apiKey here is the Copilot session token (short-lived)
      return {
        url: 'https://api.githubcopilot.com/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Copilot-Integration-Id': 'vscode-chat',
          'Editor-Version': 'better-agent-terminal/1.0',
        },
        body: JSON.stringify({
          model,
          messages: toOpenAIChatMessages(messages),
          stream: true,
          ...(enableTools ? { tools: getOpenAIToolDefinitions(), tool_choice: 'auto' } : {}),
        }),
      }
    },
    parseDelta(line) {
      // OpenAI-compatible
      if (!line.startsWith('data: ') || line === 'data: [DONE]') return null
      try {
        const obj = JSON.parse(line.slice(6))
        return obj.choices?.[0]?.delta?.content ?? null
      } catch { return null }
    },
    parseDone(line) {
      if (line === 'data: [DONE]') return { inputTokens: 0, outputTokens: 0 }
      return null
    },
    parseToolCalls: parseOpenAIToolCalls,
    defaultModels: ['gpt-4.1', 'gpt-4o', 'o3-mini', 'claude-sonnet-4-20250514'],
  },
}

// ─── SSE tool parsers ─────────────────────────────────────────────────────

function toOpenAIChatMessages(messages: ChatMessage[]) {
  return messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }))
}

function parseOpenAIToolCalls(line: string): OpenAIToolCall[] {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') return []
  try {
    const obj = JSON.parse(line.slice(6))
    const calls = obj.choices?.[0]?.delta?.tool_calls
    if (!Array.isArray(calls)) return []
    return calls.map((call: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }, index: number) => ({
      id: call.id || `tool-${call.index ?? index}`,
      index: call.index ?? index,
      type: 'function' as const,
      function: {
        name: call.function?.name || '',
        arguments: call.function?.arguments || '',
      },
    }))
  } catch {
    return []
  }
}

function parseGeminiFunctionCallsFromSSE(line: string): GeminiFunctionCall[] {
  if (!line.startsWith('data: ')) return []
  try {
    const obj = JSON.parse(line.slice(6))
    const parts = obj.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) return []
    return parts
      .map((part: { functionCall?: { name?: string; args?: Record<string, unknown> } }) => part.functionCall)
      .filter((call: { name?: string; args?: Record<string, unknown> } | undefined): call is { name: string; args?: Record<string, unknown> } => Boolean(call?.name))
      .map(call => ({ name: call.name, args: call.args || {} }))
  } catch {
    return []
  }
}

// ─── Manager ──────────────────────────────────────────────────────────────

const MSG_BUFFER_CAP = 500
const MAX_TOOL_ROUNDS = 4

export class BuiltinAgentManager {
  private sessions = new Map<string, SessionInstance>()
  private getWindows: () => BrowserWindow[]
  /** Callback to resolve the encrypted API key for a given preset */
  private getApiKey: (presetId: AgentPresetId) => string
  /** Callback to resolve the custom base URL for a given preset */
  private getBaseUrl: (presetId: AgentPresetId) => string | undefined

  constructor(
    getWindows: () => BrowserWindow[],
    getApiKey: (presetId: AgentPresetId) => string,
    getBaseUrl: (presetId: AgentPresetId) => string | undefined,
  ) {
    this.getWindows = getWindows
    this.getApiKey = getApiKey
    this.getBaseUrl = getBaseUrl
  }

  private send(channel: string, ...args: unknown[]) {
    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send(channel, ...args) } catch { /* ignore */ }
      }
    }
    broadcastHub.broadcast(channel, ...args)
  }

  // ─── Session lifecycle ────────────────────────────────────────────────

  startSession(sessionId: string, presetId: AgentPresetId, opts: {
    model?: string
    systemPrompt?: string
    cwd?: string
  }): void {
    const vendor = VENDORS[presetId]
    if (!vendor) {
      this.send('builtin-agent:error', sessionId, `Unknown vendor for preset: ${presetId}`)
      return
    }

    const model = opts.model || vendor.defaultModels[0]
    const instance: SessionInstance = {
      state: {
        sessionId,
        presetId,
        status: 'idle',
        messages: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        model,
      },
      abortController: null,
      conversationHistory: opts.systemPrompt
        ? [{ role: 'system' as const, content: opts.systemPrompt }]
        : [],
      cwd: opts.cwd || process.cwd(),
    }
    this.sessions.set(sessionId, instance)
    logger.log(`[builtin-agent] started session ${sessionId} for ${presetId} model=${model}`)
    this.send('builtin-agent:status', sessionId, { status: 'idle', model })
  }

  stopSession(sessionId: string): void {
    const instance = this.sessions.get(sessionId)
    if (!instance) return
    instance.abortController?.abort()
    instance.abortController = null
    instance.state.status = 'idle'
    this.send('builtin-agent:status', sessionId, { status: 'idle' })
  }

  getSessionState(sessionId: string): BuiltinSessionState | null {
    return this.sessions.get(sessionId)?.state ?? null
  }

  // ─── Send message ────────────────────────────────────────────────────

  async sendMessage(sessionId: string, prompt: string): Promise<boolean> {
    const instance = this.sessions.get(sessionId)
    if (!instance) {
      this.send('builtin-agent:error', sessionId, 'Session not found')
      return false
    }

    const { presetId } = instance.state
    const vendor = VENDORS[presetId]
    if (!vendor) {
      this.send('builtin-agent:error', sessionId, `No vendor config for ${presetId}`)
      return false
    }

    // Resolve credential. Copilot stores a GitHub OAuth token and exchanges it
    // for a short-lived Copilot chat token; other vendors use the configured API key directly.
    const encryptedKey = this.getApiKey(presetId)
    let apiKey = decryptSecret(encryptedKey)
    if (presetId === 'copilot-cli' && apiKey) {
      apiKey = await this.getCopilotToken() || ''
    }
    if (!apiKey) {
      this.send('builtin-agent:error', sessionId, `API key not configured for ${presetId}. Please add it in Settings → Agents.`)
      this.updateStatus(sessionId, 'error')
      return false
    }

    // Cancel any in-progress request
    instance.abortController?.abort()

    // Add user message
    const userMsg: BuiltinMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    }
    this.addMessage(sessionId, userMsg)
    instance.conversationHistory.push({ role: 'user', content: prompt })

    // Start streaming request
    instance.state.error = undefined
    this.updateStatus(sessionId, 'thinking')

    const ac = new AbortController()
    instance.abortController = ac

    const baseUrl = this.getBaseUrl(presetId)

    // Prepare assistant message
    const assistantMsg: BuiltinMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }
    this.addMessage(sessionId, assistantMsg)

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const result = await this.streamVendorResponse(
          sessionId,
          instance,
          vendor,
          apiKey,
          baseUrl,
          ac,
          assistantMsg,
          round < MAX_TOOL_ROUNDS,
        )

        if (result.openAIToolCalls.length > 0) {
          instance.conversationHistory.push({ role: 'assistant', content: result.content, tool_calls: result.openAIToolCalls })
          await this.executeOpenAIToolCalls(sessionId, instance, result.openAIToolCalls)
          this.updateStatus(sessionId, 'thinking')
          continue
        }

        if (result.geminiFunctionCalls.length > 0) {
          instance.conversationHistory.push({ role: 'assistant', content: result.content, geminiFunctionCalls: result.geminiFunctionCalls })
          await this.executeGeminiFunctionCalls(sessionId, instance, result.geminiFunctionCalls)
          this.updateStatus(sessionId, 'thinking')
          continue
        }

        assistantMsg.content = result.content
        instance.conversationHistory.push({ role: 'assistant', content: result.content })
        this.send('builtin-agent:message', sessionId, assistantMsg)

        this.updateStatus(sessionId, 'idle')
        this.send('builtin-agent:result', sessionId, {
          content: result.content,
          inputTokens: instance.state.totalInputTokens,
          outputTokens: instance.state.totalOutputTokens,
        })

        return true
      }

      throw new Error('Tool call loop exceeded the maximum number of rounds')
    } catch (err: unknown) {
      if (ac.signal.aborted) {
        logger.log(`[builtin-agent] request aborted for ${sessionId}`)
        this.updateStatus(sessionId, 'idle')
        return false
      }
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[builtin-agent] error for ${sessionId}:`, errorMsg)
      instance.state.error = errorMsg
      this.send('builtin-agent:error', sessionId, errorMsg)
      this.updateStatus(sessionId, 'error')
      return false
    } finally {
      instance.abortController = null
    }
  }

  // ─── Model management ────────────────────────────────────────────────

  setModel(sessionId: string, model: string): void {
    const instance = this.sessions.get(sessionId)
    if (!instance) return
    instance.state.model = model
  }

  getAvailableModels(presetId: string): string[] {
    return VENDORS[presetId]?.defaultModels ?? []
  }

  // ─── Copilot auth ────────────────────────────────────────────────────

  /** Cached Copilot token: { token, expiresAt } */
  private copilotTokenCache: { token: string; expiresAt: number } | null = null

  async getCopilotToken(): Promise<string | null> {
    // If cached and not expired (with 2 min buffer), return it
    if (this.copilotTokenCache && Date.now() < this.copilotTokenCache.expiresAt - 120_000) {
      return this.copilotTokenCache.token
    }

    const encryptedKey = this.getApiKey('copilot-cli')
    const githubToken = decryptSecret(encryptedKey)
    if (!githubToken) return null

    try {
      const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: {
          'Authorization': `token ${githubToken}`,
          'Accept': 'application/json',
        },
      })
      if (!res.ok) return null
      const data = await res.json() as { token: string; expires_at: number }
      this.copilotTokenCache = {
        token: data.token,
        expiresAt: data.expires_at * 1000,
      }
      return data.token
    } catch (err) {
      logger.error('[builtin-agent] failed to get Copilot token', err)
      return null
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async streamVendorResponse(
    sessionId: string,
    instance: SessionInstance,
    vendor: VendorConfig,
    apiKey: string,
    baseUrl: string | undefined,
    ac: AbortController,
    assistantMsg: BuiltinMessage,
    enableTools: boolean,
  ): Promise<{ content: string; openAIToolCalls: OpenAIToolCall[]; geminiFunctionCalls: GeminiFunctionCall[] }> {
    const { url, headers, body } = vendor.buildRequest(
      instance.state.model,
      instance.conversationHistory,
      apiKey,
      baseUrl,
      enableTools,
    )

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: ac.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorMsg = `API error ${response.status}`
      try {
        const errObj = JSON.parse(errorText)
        errorMsg = errObj.error?.message || errObj.message || errorMsg
      } catch { /* use raw */ }
      throw new Error(errorMsg)
    }

    if (!response.body) {
      throw new Error('No response body (streaming not supported)')
    }

    let fullContent = ''
    const openAIToolCalls = new Map<number, OpenAIToolCall>()
    const geminiFunctionCalls: GeminiFunctionCall[] = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const delta = vendor.parseDelta(trimmed)
        if (delta !== null) {
          fullContent += delta
          assistantMsg.content = fullContent
          this.send('builtin-agent:stream', sessionId, { delta, fullContent })
        }

        for (const partial of vendor.parseToolCalls?.(trimmed) || []) {
          const key = partial.index ?? openAIToolCalls.size
          const existing = openAIToolCalls.get(key) || {
            id: partial.id,
            index: key,
            type: 'function' as const,
            function: { name: '', arguments: '' },
          }
          if (partial.id && existing.id.startsWith('tool-')) existing.id = partial.id
          if (partial.function.name) existing.function.name += partial.function.name
          if (partial.function.arguments) existing.function.arguments += partial.function.arguments
          openAIToolCalls.set(key, existing)
        }

        const geminiCalls = vendor.parseGeminiFunctionCalls?.(trimmed) || []
        if (geminiCalls.length > 0) geminiFunctionCalls.push(...geminiCalls)

        const doneInfo = vendor.parseDone(trimmed)
        if (doneInfo) {
          if (doneInfo.inputTokens) instance.state.totalInputTokens += doneInfo.inputTokens
          if (doneInfo.outputTokens) instance.state.totalOutputTokens += doneInfo.outputTokens
        }
      }
    }

    return {
      content: fullContent,
      openAIToolCalls: [...openAIToolCalls.values()].filter(call => call.function.name),
      geminiFunctionCalls,
    }
  }

  private async executeOpenAIToolCalls(sessionId: string, instance: SessionInstance, calls: OpenAIToolCall[]): Promise<void> {
    this.updateStatus(sessionId, 'acting')
    for (const call of calls) {
      let args: Record<string, unknown> = {}
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch (err) {
        logger.error('[builtin-agent] invalid tool arguments', err)
      }
      const result = await executeBuiltinTool(instance.cwd, { name: call.function.name, arguments: args })
      const content = JSON.stringify(result)
      instance.conversationHistory.push({ role: 'tool', tool_call_id: call.id, content })
      this.send('builtin-agent:stream', sessionId, { delta: `\n[tool:${call.function.name}] ${result.ok ? 'ok' : 'error'}\n`, fullContent: '' })
    }
  }

  private async executeGeminiFunctionCalls(sessionId: string, instance: SessionInstance, calls: GeminiFunctionCall[]): Promise<void> {
    this.updateStatus(sessionId, 'acting')
    for (const call of calls) {
      const result = await executeBuiltinTool(instance.cwd, { name: call.name, arguments: call.args })
      instance.conversationHistory.push({ role: 'tool', tool_call_id: call.name, content: JSON.stringify(result) })
      this.send('builtin-agent:stream', sessionId, { delta: `\n[tool:${call.name}] ${result.ok ? 'ok' : 'error'}\n`, fullContent: '' })
    }
  }

  private addMessage(sessionId: string, msg: BuiltinMessage): void {
    const instance = this.sessions.get(sessionId)
    if (!instance) return
    instance.state.messages.push(msg)
    if (instance.state.messages.length > MSG_BUFFER_CAP) {
      instance.state.messages = instance.state.messages.slice(-MSG_BUFFER_CAP)
    }
    this.send('builtin-agent:message', sessionId, msg)
  }

  private updateStatus(sessionId: string, status: BuiltinSessionState['status']): void {
    const instance = this.sessions.get(sessionId)
    if (!instance || instance.state.status === status) return
    instance.state.status = status
    this.send('builtin-agent:status', sessionId, { status })
  }

  dispose(): void {
    for (const [, instance] of this.sessions) {
      instance.abortController?.abort()
    }
    this.sessions.clear()
  }
}
