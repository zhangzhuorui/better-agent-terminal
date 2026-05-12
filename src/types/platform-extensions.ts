export interface ContextPackageVersion {
  version: number
  content: string
  updatedAt: number
}

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
  /** Version history for rollback and comparison. */
  versions?: ContextPackageVersion[]
}

export interface DailyAnalyticsModelBreakdown {
  inputTokens: number
  outputTokens: number
  costUsd: number
  agentTurns: number
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
      /** Per-model breakdown for the day */
      byModel?: Record<string, DailyAnalyticsModelBreakdown>
    }
  >
  updatedAt: number
  /** Monthly budget limit in USD (0 = no limit) */
  budgetLimitUsd?: number
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
  /** e.g. `5m`, `1h`; optional when `promptDelivery === ‘claude_loop’` (see `buildAutomationPromptText`). */
  loopInterval?: string
  contextPackageIds?: string[]
  permissionMode?: AutomationPermissionMode
  lastRunAt?: number
  lastError?: string
}

// ============================================
//   MCP Server Management
// ============================================

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  /** Transport type for MCP connection */
  transport: ‘stdio’ | ‘sse’ | ‘websocket’
  /** Command to launch stdio server (e.g. ‘npx’, ‘node’, ‘python’) */
  command?: string
  /** Arguments for stdio command */
  args?: string[]
  /** Environment variables for stdio server */
  env?: Record<string, string>
  /** URL for SSE/websocket transport */
  url?: string
  /** Timeout in ms for tool calls */
  timeoutMs?: number
  /** Last health check result */
  lastHealthCheck?: { ok: boolean; error?: string; checkedAt: number }
  createdAt: number
  updatedAt: number
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

// ============================================
//   Workflow Orchestration
// ============================================

export type WorkflowTriggerType = ‘schedule’ | ‘git_commit’ | ‘file_change’ | ‘webhook’ | ‘manual’

export interface WorkflowTrigger {
  type: WorkflowTriggerType
  /** For schedule: cron expression or HH:mm */
  schedule?: string
  /** For git_commit: branch pattern regex */
  branchPattern?: string
  /** For file_change: glob patterns to watch */
  watchPatterns?: string[]
  /** For webhook: secret token */
  webhookSecret?: string
}

export type WorkflowNodeType = ‘send’ | ‘wait’ | ‘condition’ | ‘human’ | ‘parallel’ | ‘loop’

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  /** Human-readable label */
  label?: string
  /** For ‘send’: target terminal and prompt */
  terminalId?: string
  prompt?: string
  contextPackageIds?: string[]
  permissionMode?: AutomationPermissionMode
  /** For ‘wait’: duration in ms or event name */
  durationMs?: number
  waitForEvent?: ‘agent_complete’ | ‘file_change’
  /** For ‘condition’: simple expression like ‘{{prev.status}} === "success"’ */
  condition?: string
  /** For ‘human’: confirmation dialog text */
  confirmTitle?: string
  confirmDescription?: string
  timeoutMs?: number
  /** For ‘parallel’: child node IDs */
  parallelNodeIds?: string[]
  /** For ‘loop’: child node ID and loop config */
  loopNodeId?: string
  loopCount?: number
  loopUntil?: string
}

export interface WorkflowEdge {
  from: string
  to: string
  /** Optional condition label for the edge */
  label?: string
}

export interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  enabled: boolean
  trigger: WorkflowTrigger
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  createdAt: number
  updatedAt: number
}

export type WorkflowExecutionStatus = ‘pending’ | ‘running’ | ‘paused’ | ‘completed’ | ‘failed’ | ‘cancelled’

export interface WorkflowNodeState {
  status: WorkflowExecutionStatus
  output?: string
  startedAt?: number
  endedAt?: number
  error?: string
}

export interface WorkflowExecution {
  id: string
  workflowId: string
  status: WorkflowExecutionStatus
  nodeStates: Record<string, WorkflowNodeState>
  startedAt: number
  endedAt?: number
  error?: string
}

// ============================================
//   Git Enhanced
// ============================================

export interface GitStashEntry {
  index: number
  hash: string
  message: string
  date: string
}

export interface GitBlameLine {
  lineNumber: number
  commitHash: string
  author: string
  date: string
  content: string
}

export interface GitBranchInfo {
  name: string
  current: boolean
  ahead: number
  behind: number
  remote?: string
}
