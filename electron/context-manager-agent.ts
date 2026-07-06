import type { ContextManagerAgentPlan, ContextPackage, ContextPackageMetadata } from '../src/types/platform-extensions'
import type { ClaudeMessage } from '../src/types/claude-agent'
import { logger } from './logger'
import * as contextPackageStore from './context-package-store'
import * as contextMemoryStore from './context-memory-store'
import { buildContextInjectionPlan } from './context-retrieval-service'
import { summarizeConversationContext } from './conversation-context-summary'
import { compressStructured } from './context-structured-compressor'

let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null

async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    queryFn = sdk.query
  }
  return queryFn
}

interface Session {
  cwd: string
  model?: string
}

interface PlanningLock {
  promise: Promise<unknown>
  resolve: () => void
}

export interface ContextManagerPlanInput {
  prompt: string
  workspacePath?: string
  explicitPackageIds?: string[]
  sessionHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
}

const MAX_HISTORY_TURNS = 12
const MAX_PACKAGES_IN_PROMPT = 50

function packageSummary(pkg: ContextPackage): string {
  const meta = pkg.metadata
  const lines = [
    `- id: ${pkg.id}`,
    `  name: ${pkg.name}`,
    pkg.description ? `  description: ${pkg.description}` : '',
    meta?.shortSummary ? `  summary: ${meta.shortSummary}` : '',
    pkg.tags?.length ? `  tags: ${pkg.tags.join(', ')}` : '',
    meta?.contentType ? `  contentType: ${meta.contentType}` : '',
    meta?.tokenEstimate ? `  tokens: ${meta.tokenEstimate}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

async function buildAgentPrompt(input: ContextManagerPlanInput, allPackages: ContextPackage[]): Promise<string> {
  const explicit = new Set(input.explicitPackageIds ?? [])
  const relevantPackages = allPackages
    .filter(pkg => explicit.has(pkg.id) || !pkg.archived)
    .slice(0, MAX_PACKAGES_IN_PROMPT)

  const historyLines = (input.sessionHistory ?? [])
    .slice(-MAX_HISTORY_TURNS * 2)
    .map(m => `<turn role="${m.role}">\n${m.content}\n</turn>`)

  const packageList = relevantPackages.length
    ? relevantPackages.map(packageSummary).join('\n\n')
    : '(no context packages available)'

  return [
    'You are a context-management specialist for a coding agent.',
    '',
    'Task: decide which existing context packages to attach, whether to create a new context package from the conversation, and whether to record any memory entries.',
    '',
    'Rules:',
    '- Only use the provided package list. Do not invent package IDs.',
    '- Prefer packages whose name/tags/summary match the user prompt.',
    '- Create a new package only when the conversation contains reusable engineering context (decisions, constraints, changed files, blockers, next steps).',
    '- If a user is asking a follow-up question, attach the package that contains the relevant prior work.',
    '- Keep the total token budget reasonable; do not attach more than 5 packages unless necessary.',
    '',
    'Output only valid JSON with this schema:',
    JSON.stringify({
      explicitPackageIds: ['existing-package-id-1'],
      rulePackageIds: [],
      recommendedPackageIds: ['existing-package-id-2'],
      createdPackages: [{ name: 'string', description: 'string', content: 'string', tags: ['string'] }],
      updatedPackages: [{ packageId: 'string', content: 'string' }],
      memoryEntries: [{ kind: 'fact|decision|constraint|blocker|goal|file', content: 'string', confidence: 0.9 }],
      reasoning: 'string',
    }, null, 2),
    '',
    'Use empty arrays when there is nothing to add.',
    '',
    `Workspace: ${input.workspacePath || 'unknown'}`,
    '',
    'Available context packages:',
    packageList,
    '',
    'Recent conversation:',
    ...historyLines,
    '',
    `User prompt: ${input.prompt}`,
  ].join('\n')
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || typeof msg !== 'object') continue
    const type = (msg as { type?: unknown }).type
    if (type !== 'assistant') continue
    const content = (msg as { message?: { content?: unknown[] } }).message?.content
    if (!Array.isArray(content)) continue
    const texts = content
      .filter((block: unknown) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
      .map((block: unknown) => String((block as { text?: unknown }).text || ''))
    const joined = texts.join('\n').trim()
    if (joined) return joined
  }
  return ''
}

function parsePlan(text: string): ContextManagerAgentPlan | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ContextManagerAgentPlan>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      explicitPackageIds: Array.isArray(parsed.explicitPackageIds) ? parsed.explicitPackageIds.filter((id): id is string => typeof id === 'string') : [],
      rulePackageIds: Array.isArray(parsed.rulePackageIds) ? parsed.rulePackageIds.filter((id): id is string => typeof id === 'string') : [],
      recommendedPackageIds: Array.isArray(parsed.recommendedPackageIds) ? parsed.recommendedPackageIds.filter((id): id is string => typeof id === 'string') : [],
      createdPackages: Array.isArray(parsed.createdPackages)
        ? parsed.createdPackages
          .filter((p): p is { name: string; description?: string; content: string; tags?: string[]; workspaceRoot?: string } => p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string' && typeof (p as { content?: unknown }).content === 'string')
          .map(p => ({ ...p, tags: p.tags ?? [] }))
        : [],
      updatedPackages: Array.isArray(parsed.updatedPackages)
        ? parsed.updatedPackages
          .filter((p): p is { packageId: string; content: string } => p && typeof p === 'object' && typeof (p as { packageId?: unknown }).packageId === 'string' && typeof (p as { content?: unknown }).content === 'string')
        : [],
      memoryEntries: Array.isArray(parsed.memoryEntries)
        ? parsed.memoryEntries
          .filter((m): m is { kind: 'fact' | 'decision' | 'constraint' | 'blocker' | 'goal' | 'file'; content: string; confidence: number; tags?: string[] } =>
            m && typeof m === 'object' && typeof (m as { content?: unknown }).content === 'string')
        : [],
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
    }
  } catch {
    return null
  }
}

async function summarizeHistoryForAgent(input: ContextManagerPlanInput): Promise<string | null> {
  const history = input.sessionHistory
  if (!history || history.length < 4) return null
  try {
    const draft = await summarizeConversationContext({
      sessionId: 'context-manager-agent',
      cwd: input.workspacePath,
      messages: history.map(h => ({ role: h.role, content: h.content })),
    })
    return draft.content
  } catch (error) {
    logger.error('[context-manager-agent] history summary failed:', error instanceof Error ? error.message : String(error))
    return null
  }
}

export class ContextManagerAgent {
  private sessions = new Map<string, Session>()
  private lastPlans = new Map<string, ContextManagerAgentPlan & { at: number }>()
  private planningLocks = new Map<string, PlanningLock>()
  /** Optional renderer-facing callback set by main.ts. */
  onPlan?: (sessionId: string, plan: ContextManagerAgentPlan & { at: number }) => void

  getLastPlan(sessionId: string): (ContextManagerAgentPlan & { at: number }) | null {
    return this.lastPlans.get(sessionId) ?? null
  }

  async startSession(sessionId: string, options: { cwd: string; model?: string }): Promise<boolean> {
    if (this.sessions.has(sessionId)) {
      this.sessions.get(sessionId)!.model = options.model ?? this.sessions.get(sessionId)!.model
      return true
    }
    this.sessions.set(sessionId, {
      cwd: options.cwd,
      model: options.model,
    })
    return true
  }

  async stopSession(sessionId: string): Promise<boolean> {
    if (!this.sessions.has(sessionId)) return false
    this.sessions.delete(sessionId)
    return true
  }

  private async acquirePlanningLock(sessionId: string): Promise<() => void> {
    while (this.planningLocks.has(sessionId)) {
      await this.planningLocks.get(sessionId)!.promise
    }
    let resolve: () => void = () => {}
    const promise = new Promise<void>(r => { resolve = r })
    this.planningLocks.set(sessionId, { promise, resolve })
    return () => {
      this.planningLocks.delete(sessionId)
      resolve()
    }
  }

  async plan(sessionId: string, input: ContextManagerPlanInput, options?: { abortController?: AbortController }): Promise<ContextManagerAgentPlan> {
    const releaseLock = await this.acquirePlanningLock(sessionId)
    try {
      return await this.runPlan(sessionId, input, options)
    } finally {
      releaseLock()
    }
  }

  private async runPlan(sessionId: string, input: ContextManagerPlanInput, options?: { abortController?: AbortController }): Promise<ContextManagerAgentPlan> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Context manager session not found: ${sessionId}`)

    const query = await getQuery()
    const allPackages = await contextPackageStore.listContextPackages()
    const prompt = await buildAgentPrompt(input, allPackages)

    logger.log(`[context-manager-agent] planning for session ${sessionId}`)

    const planAbortController = options?.abortController ?? new AbortController()
    const messages: unknown[] = []
    let finalText = ''
    let error: Error | undefined

    try {
      const generator = query({
        prompt,
        options: {
          abortController: planAbortController,
          cwd: session.cwd,
          model: session.model ?? 'claude-sonnet-4-6',
          systemPrompt: [
            'You are a context-management specialist.',
            'You decide which context packages to inject and when to create/update packages or memory entries.',
            'You have read-only access to the workspace via Read/Glob/Grep.',
            'Output only the requested JSON plan. Never output a full transcript.',
          ].join(' '),
          tools: ['Read', 'Glob', 'Grep'],
          allowedTools: ['Read', 'Glob', 'Grep'],
          permissionMode: 'acceptEdits',
          maxTurns: 5,
          thinking: { type: 'adaptive' },
          settingSources: [],
        },
      })

      for await (const message of generator) {
        messages.push(message)
        const text = extractLastAssistantText([message])
        if (text) finalText = text
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e))
      logger.error(`[context-manager-agent] query failed for ${sessionId}:`, error.message)
    }

    if (!finalText && !error) {
      // If no assistant text came through, try to summarize the conversation history ourselves.
      const summary = await summarizeHistoryForAgent(input)
      if (summary) {
        finalText = JSON.stringify({
          explicitPackageIds: [],
          rulePackageIds: [],
          recommendedPackageIds: [],
          createdPackages: [{ name: 'Conversation summary', content: summary, tags: ['conversation', 'auto-summary'] }],
          updatedPackages: [],
          memoryEntries: [],
          reasoning: 'Agent produced no text; created a summary from conversation history.',
        })
      }
    }

    let agentPlan = parsePlan(finalText)
    if (!agentPlan) {
      logger.error(`[context-manager-agent] could not parse plan for ${sessionId}`)
      agentPlan = { explicitPackageIds: [], rulePackageIds: [], recommendedPackageIds: [], createdPackages: [], updatedPackages: [], memoryEntries: [] }
    }

    // Validate package IDs against the actual store.
    const validIds = new Set(allPackages.map(p => p.id))
    agentPlan.explicitPackageIds = agentPlan.explicitPackageIds.filter(id => validIds.has(id))
    agentPlan.recommendedPackageIds = agentPlan.recommendedPackageIds.filter(id => validIds.has(id))

    // Merge explicit user selection with agent suggestions.
    const explicit = new Set(input.explicitPackageIds ?? [])
    agentPlan.explicitPackageIds = [...new Set([...agentPlan.explicitPackageIds, ...explicit])]

    // Create new packages requested by the agent.
    const createdIds: string[] = []
    for (const create of agentPlan.createdPackages ?? []) {
      try {
        const pkg = await contextPackageStore.createContextPackage({
          name: create.name,
          description: create.description,
          content: create.content,
          tags: create.tags,
          workspaceRoot: create.workspaceRoot ?? session.cwd,
        })
        createdIds.push(pkg.id)
      } catch (e) {
        logger.error('[context-manager-agent] failed to create package:', e instanceof Error ? e.message : String(e))
      }
    }

    // Update packages requested by the agent.
    const updatedIds: string[] = []
    for (const update of agentPlan.updatedPackages ?? []) {
      try {
        await contextPackageStore.updateContextPackage(update.packageId, { content: update.content })
        updatedIds.push(update.packageId)
      } catch (e) {
        logger.error('[context-manager-agent] failed to update package:', e instanceof Error ? e.message : String(e))
      }
    }

    if (agentPlan.memoryEntries?.length) {
      logger.log(`[context-manager-agent] ${agentPlan.memoryEntries.length} memory entries recorded for ${sessionId}`)
      for (const entry of agentPlan.memoryEntries) {
        logger.log(`[context-manager-agent] memory [${entry.kind}]: ${entry.content.slice(0, 120)}`)
      }
      await contextMemoryStore.recordMemoryEntries(
        agentPlan.memoryEntries.map(e => ({ ...e, sessionId, workspaceRoot: session.cwd }))
      ).catch(e => logger.error('[context-manager-agent] failed to record memory entries:', e instanceof Error ? e.message : String(e)))
    }

    const result: ContextManagerAgentPlan & { createdPackageIds: string[]; updatedPackageIds: string[] } = {
      ...agentPlan,
      createdPackageIds: createdIds,
      updatedPackageIds: updatedIds,
    }

    this.lastPlans.set(sessionId, { ...result, at: Date.now() })
    this.onPlan?.(sessionId, this.lastPlans.get(sessionId)!)

    logger.log(`[context-manager-agent] plan for ${sessionId}: explicit=${agentPlan.explicitPackageIds.length} recommended=${agentPlan.recommendedPackageIds.length} created=${createdIds.length} updated=${updatedIds.length}`)

    return result
  }
}

export const contextManagerAgent = new ContextManagerAgent()
