import { logger } from './logger'
import type { ContextMemoryEntry } from '../src/types/platform-extensions'

let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null

async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    queryFn = sdk.query
  }
  return queryFn
}

export interface ConversationContextSummaryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: number
}

export interface ConversationContextSummaryInput {
  sessionId: string
  cwd?: string
  sdkSessionId?: string
  messages: ConversationContextSummaryMessage[]
}

export interface ConversationContextSummaryDraft {
  name: string
  description?: string
  content: string
  tags?: string[]
  source: 'llm' | 'heuristic'
  memoryEntries?: ContextMemoryEntry[]
}

const MAX_MESSAGE_CHARS = 12_000
const MAX_TOTAL_CHARS = 80_000
const MAX_FALLBACK_CHARS = 6_000

function cleanContent(text: string): string {
  return text
    .replace(/\n\[附加上下文包:[^\]]+\]/g, '')
    .replace(/\n\[\d+ images? attached\]/g, '')
    .replace(/<context-block[\s\S]*?<\/context-block>/g, '[context package omitted]')
    .replace(/### Retrieved Context[\s\S]*?### User message\n/g, '')
    .replace(/### Context package:[\s\S]*?### User message\n/g, '')
    .trim()
}

function sanitizeMessages(input: ConversationContextSummaryInput): ConversationContextSummaryMessage[] {
  const out: ConversationContextSummaryMessage[] = []
  let total = 0
  for (const msg of input.messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    const cleaned = cleanContent(String(msg.content || '')).slice(0, MAX_MESSAGE_CHARS)
    if (!cleaned) continue
    if (total + cleaned.length > MAX_TOTAL_CHARS) {
      const remaining = MAX_TOTAL_CHARS - total
      if (remaining > 500) out.push({ ...msg, content: cleaned.slice(0, remaining) })
      break
    }
    total += cleaned.length
    out.push({ ...msg, content: cleaned })
  }
  return out
}

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  if ('result' in message && typeof (message as { result?: unknown }).result === 'string') {
    return (message as { result: string }).result
  }
  if ((message as { type?: unknown }).type === 'assistant') {
    const content = (message as { message?: { content?: unknown[] } }).message?.content
    if (Array.isArray(content)) {
      return content
        .map(block => {
          if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
            return String((block as { text?: unknown }).text || '')
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
  }
  return ''
}

function parseDraft(text: string): ConversationContextSummaryDraft | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ConversationContextSummaryDraft>
    if (!parsed.name || !parsed.content) return null
    return {
      name: String(parsed.name).slice(0, 80),
      description: parsed.description ? String(parsed.description).slice(0, 240) : undefined,
      content: String(parsed.content).trim(),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8)
        : undefined,
      source: 'llm',
    }
  } catch {
    return null
  }
}

function heuristicSummary(messages: ConversationContextSummaryMessage[]): ConversationContextSummaryDraft {
  const userMessages = messages.filter(m => m.role === 'user')
  const assistantMessages = messages.filter(m => m.role === 'assistant')
  const lastUser = userMessages[userMessages.length - 1]?.content || ''
  const firstUser = userMessages[0]?.content || ''
  const headingLines = assistantMessages
    .flatMap(m => m.content.split(/\r?\n/))
    .map(line => line.trim())
    .filter(line => /^(#{1,4}\s+|[-*]\s+|\d+\.\s+)/.test(line))
    .slice(-24)
  const filePaths = Array.from(new Set(messages
    .flatMap(m => m.content.match(/[\w./-]+\.(?:ts|tsx|js|jsx|json|css|md|py|go|rs|java|c|cpp|h|yml|yaml)/g) || [])
    .slice(-30)))
  const content = [
    '# Conversation context summary',
    '',
    '## User goal / latest request',
    (lastUser || firstUser || 'Continue from the previous engineering conversation.').slice(0, 1200),
    '',
    '## Notable decisions / progress',
    headingLines.length ? headingLines.join('\n') : assistantMessages.slice(-3).map(m => m.content.slice(0, 900)).join('\n\n'),
    '',
    filePaths.length ? `## Referenced files\n${filePaths.map(p => `- ${p}`).join('\n')}` : '',
    '',
    '## Next-step hint',
    'Use this as concise engineering context for follow-up work; it is not a full transcript.',
  ].filter(Boolean).join('\n').slice(0, MAX_FALLBACK_CHARS)

  const title = (lastUser || firstUser || 'Conversation summary')
    .split(/\r?\n/)[0]
    .replace(/^#+\s*/, '')
    .slice(0, 72)

  return {
    name: title || 'Conversation summary',
    description: 'Auto-generated conversation context summary.',
    content,
    tags: ['conversation', 'auto-summary'],
    source: 'heuristic',
  }
}

function inferMemoryKind(line: string): ContextMemoryEntry['kind'] {
  const lower = line.toLowerCase()
  if (lower.includes('blocker') || lower.includes('blocked') || lower.includes('issue:')) return 'blocker'
  if (lower.includes('decision') || lower.includes('decided') || lower.includes('agreed')) return 'decision'
  if (lower.includes('constraint') || lower.includes('must') || lower.includes('cannot')) return 'constraint'
  if (lower.includes('goal') || lower.includes('objective') || lower.includes('aim')) return 'goal'
  if (lower.includes('file') || /[\w./-]+\.(ts|tsx|js|jsx|json|py|go|rs|java|md)/.test(line)) return 'file'
  return 'fact'
}

function extractMemoryEntries(draft: ConversationContextSummaryDraft, sessionId: string, cwd?: string): ContextMemoryEntry[] {
  const entries: ContextMemoryEntry[] = []
  const seen = new Set<string>()
  const lines = draft.content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!/^[-*\d]/.test(trimmed) && trimmed.length < 40) continue
    let content = trimmed.replace(/^[-*\d]+\.?\s*/, '').trim()
    if (content.length < 10 || content.length > 500) continue
    content = content.replace(/^#+\s*/, '')
    const key = content.toLowerCase().slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      id: '',
      sessionId,
      kind: inferMemoryKind(content),
      content,
      confidence: 0.75,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceRoot: cwd,
      tags: draft.tags?.slice(0, 4),
    })
  }
  return entries.slice(0, 12)
}

export async function summarizeConversationContext(input: ConversationContextSummaryInput): Promise<ConversationContextSummaryDraft> {
  const messages = sanitizeMessages(input)
  if (messages.length === 0) return heuristicSummary([])

  const transcript = messages
    .map((m, i) => `<turn index="${i + 1}" role="${m.role}">\n${m.content}\n</turn>`)
    .join('\n\n')

  const prompt = `Summarize this engineering conversation into a compact context package for future continuation.\n\nRequirements:\n- Do not output a full transcript.\n- Preserve goals, decisions, constraints, changed/important files, current blockers, and next steps.\n- Be concise but specific enough to inject into a later coding-agent prompt.\n- Return only valid JSON with keys: name, description, content, tags.\n\nSession: ${input.sessionId}\nSDK session: ${input.sdkSessionId || 'unknown'}\nWorking directory: ${input.cwd || 'unknown'}\n\nConversation:\n${transcript}`

  try {
    logger.log(`[conversation-summary] generating summary for ${input.sessionId} messages=${messages.length}`)
    let text = ''
    const query = await getQuery()
    for await (const message of query({
      prompt,
      options: {
        cwd: input.cwd,
        allowedTools: [],
        tools: [],
        maxTurns: 1,
        model: 'claude-opus-4-6',
        thinking: { type: 'adaptive' },
        systemPrompt: 'You create concise engineering context summaries for later coding-agent continuation. Output only JSON. Never include hidden chain-of-thought or full transcripts.',
        settingSources: [],
      },
    })) {
      text += extractTextFromMessage(message)
    }
    const draft = parseDraft(text)
    if (draft) {
      draft.memoryEntries = extractMemoryEntries(draft, input.sessionId, input.cwd)
      return draft
    }
    logger.error(`[conversation-summary] could not parse LLM output for ${input.sessionId}`)
  } catch (error) {
    logger.error(`[conversation-summary] generation failed for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const fallback = heuristicSummary(messages)
  fallback.memoryEntries = extractMemoryEntries(fallback, input.sessionId, input.cwd)
  return fallback
}
