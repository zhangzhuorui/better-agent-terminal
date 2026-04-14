/** Reusable context injected into Claude user turns (main process resolves content). */
export interface ContextPackage {
  id: string
  name: string
  description?: string
  content: string
  tags?: string[]
  /** Workspace folder path this package belongs to; omit = global (all projects). */
  workspaceRoot?: string
  createdAt: number
  updatedAt: number
}

export interface PlatformAnalyticsSummary {
  totals: {
    userMessages: number
    automationUserMessages: number
    agentTurns: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    automationRuns: number
    automationFailures: number
  }
  byDay: Record<
    string,
    {
      userMessages: number
      automationUserMessages: number
      agentTurns: number
      inputTokens: number
      outputTokens: number
      costUsd: number
      automationRuns: number
      automationFailures: number
    }
  >
  updatedAt: number
}

export type AutomationPermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPlan'
  | 'bypassPermissions'

/** How the job text is sent as the user turn (before context-package injection). */
export type AutomationPromptDelivery = 'plain' | 'claude_loop'

export interface AutomationJob {
  id: string
  name: string
  enabled: boolean
  runAtLocal: string
  /** 0–6 Sun–Sat; empty or omit = every day */
  weekdays?: number[]
  terminalId: string
  prompt: string
  /**
   * `plain` — send `prompt` as-is (default).
   * `claude_loop` — send a `/loop …` line so Claude Code’s bundled loop skill runs in-session (requires compatible CLI).
   */
  promptDelivery?: AutomationPromptDelivery
  /** e.g. `5m`, `1h`; optional when `promptDelivery === 'claude_loop'` (see `buildAutomationPromptText`). */
  loopInterval?: string
  contextPackageIds?: string[]
  permissionMode?: AutomationPermissionMode
  lastRunAt?: number
  lastError?: string
}
