import type { AgentPresetId } from './agent-presets'

export interface ContextPackageVersion {
  version: number
  content: string
  updatedAt: number
}

export type ContextContentType = 'text' | 'json' | 'code' | 'markdown'

export interface StructuredCompressionVariant {
  mode: ContextContentType
  summary: string
  body: string
  tokenEstimate: number
  originalTokens: number
  /** Short ID -> original text map for CCR-style reversible compression. */
  retrieveIdMap?: Record<string, string>
  /** Terms that caused full detail to be preserved. */
  queryTerms?: string[]
}

export interface ContextPackageMetadata {
  summary?: string
  shortSummary?: string
  autoTags?: string[]
  keywords?: string[]
  language?: string
  framework?: string
  relatedFiles?: string[]
  contentHash?: string
  tokenEstimate?: number
  metadataVersion?: number
  generatedAt?: number
  contentType?: ContextContentType
  compressionProfile?: 'none' | 'structure' | 'retrieve-id' | 'auto'
}

export interface ContextPackageChunk {
  id: string
  packageId: string
  content: string
  summary?: string
  keywords?: string[]
  tokenEstimate: number
  startOffset: number
  endOffset: number
  hash: string
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
  metadata?: ContextPackageMetadata
  chunks?: ContextPackageChunk[]
  compressed?: {
    brief?: string
    medium?: string
    detailed?: string
    structured?: StructuredCompressionVariant
    updatedAt: number
  }
  archived?: boolean
  lastUsedAt?: number
  usageCount?: number
}

export type ResolvedContextSource = 'explicit' | 'rule' | 'auto'
export type ContextCompressionMode = 'none' | 'summary' | 'extractive'

export interface ContextRecommendation {
  packageId: string
  name: string
  score: number
  reasons: string[]
  tokenEstimate?: number
  summary?: string
  tags?: string[]
  workspaceRoot?: string
  source?: 'context-package' | 'local-file' | 'memory'
}

export interface ContextRetrievalOptions {
  prompt: string
  workspacePath?: string
  agentPreset?: AgentPresetId
  excludePackageIds?: string[]
  limit?: number
  minScore?: number
  includeLocalFiles?: boolean
}

export interface ContextInjectionPlan {
  mode: 'off' | 'recommend' | 'inject'
  explicitPackageIds: string[]
  rulePackageIds: string[]
  recommendedPackageIds: string[]
  finalPackageIds: string[]
  recommendations: ContextRecommendation[]
  /** High-confidence memory entries surfaced for this prompt. */
  memoryRecommendations?: ContextRecommendation[]
  tokenBudget: number
  estimatedTokens: number
  cacheHit?: boolean
  compressed?: boolean
}

export interface ResolvedContextBlock {
  id: string
  packageId: string
  title: string
  source: ResolvedContextSource
  content: string
  summary?: string
  tags?: string[]
  compression: ContextCompressionMode | 'structured'
  score?: number
  tokenEstimate: number
  contentHash?: string
  retrieveIdMap?: Record<string, string>
}

export interface ContextMemoryEntry {
  id: string
  packageId?: string
  sessionId?: string
  kind: 'fact' | 'decision' | 'constraint' | 'blocker' | 'file' | 'goal'
  content: string
  confidence: number
  createdAt: number
  updatedAt: number
  workspaceRoot?: string
  tags?: string[]
}

export interface ContextManagerAgentPlan {
  explicitPackageIds: string[]
  rulePackageIds: string[]
  recommendedPackageIds: string[]
  createdPackages?: Array<{ name: string; description?: string; content: string; tags?: string[]; workspaceRoot?: string }>
  updatedPackages?: Array<{ packageId: string; content: string }>
  createdPackageIds?: string[]
  updatedPackageIds?: string[]
  memoryEntries?: ContextMemoryEntry[]
  reasoning?: string
}

export interface ContextMaintenanceReport {
  archivedPackages: string[]
  mergedPackages: string[]
  deletedPackages: string[]
  prunedMemoryEntries: number
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
  /** e.g. `5m`, `1h`; optional when `promptDelivery === 'claude_loop'` (see `buildAutomationPromptText`). */
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
  transport: 'stdio' | 'sse' | 'websocket'
  /** Command to launch stdio server (e.g. 'npx', 'node', 'python') */
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

export type WorkflowTriggerType = 'schedule' | 'git_commit' | 'file_change' | 'webhook' | 'manual'

export interface WorkflowTrigger {
  type: WorkflowTriggerType
  /** For schedule: cron expression or HH:mm */
  schedule?: string
  /** For schedule: 0–6 Sun–Sat; empty or omit = every day */
  weekdays?: number[]
  /** For git_commit: branch pattern regex */
  branchPattern?: string
  /** For file_change: glob patterns to watch */
  watchPatterns?: string[]
  /** For webhook: secret token */
  webhookSecret?: string
}

/** V2 node types — 'send' is deprecated, use 'agent' or 'terminal' */
export type WorkflowNodeType =
  | 'send'        // v1 legacy
  | 'agent'       // send prompt to an agent and wait for completion
  | 'terminal'    // send command to a terminal
  | 'wait'        // wait for duration or event
  | 'condition'   // conditional branch
  | 'human'       // human approval
  | 'parallel'    // parallel gateway (fork)
  | 'join'        // join gateway (sync)
  | 'loop'        // loop/repeat
  | 'start'       // visual start node
  | 'end'         // visual end node
  | 'mcp'         // MCP tool call

export interface WorkflowNodePosition {
  x: number
  y: number
}

export type WorkflowAgentPreset = string | 'inherit'

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  /** Human-readable label */
  label?: string
  /** Canvas position (V2) */
  position?: WorkflowNodePosition
  /** For 'agent'/'send'/'terminal': target terminal */
  terminalId?: string
  /** For 'agent'/'send': prompt text */
  prompt?: string
  contextPackageIds?: string[]
  permissionMode?: AutomationPermissionMode
  /** For 'agent': which agent preset to use ('inherit' = use terminal's preset) */
  agentPreset?: WorkflowAgentPreset
  /** For 'agent': override default model */
  model?: string
  /** For 'agent': override effort setting */
  effort?: string
  /** For 'agent': wait for agent to finish (default true) */
  waitForComplete?: boolean
  /** For 'wait': duration in ms or event name */
  durationMs?: number
  waitForEvent?: 'agent_complete' | 'file_change' | 'user_input'
  /** For 'condition': simple expression like '{{prev.status}} === "success"' */
  condition?: string
  /** For 'human': confirmation dialog text */
  confirmTitle?: string
  confirmDescription?: string
  timeoutMs?: number
  /** For 'parallel': child node IDs */
  parallelNodeIds?: string[]
  /** For 'loop': child node ID and loop config */
  loopNodeId?: string
  loopCount?: number
  loopUntil?: string
  /** For 'terminal': shell command to execute */
  command?: string
  /** For 'mcp': MCP server and tool config */
  mcpServerId?: string
  mcpToolName?: string
  mcpToolInput?: Record<string, unknown>
  /** Retry strategy: how many times to retry on failure (default 0) */
  retryCount?: number
  /** Delay between retries in ms (default 5000) */
  retryDelayMs?: number
}

export interface WorkflowEdge {
  /** Edge ID — auto-generated if missing (backward compat) */
  id?: string
  from: string
  to: string
  /** Optional condition label for the edge */
  label?: string
  /** For conditional branches: value that must match to traverse this edge */
  conditionValue?: string
}

export interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  enabled: boolean
  trigger: WorkflowTrigger
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  /** Canvas viewport state (V2) */
  viewport?: { x: number; y: number; zoom: number }
  createdAt: number
  updatedAt: number
}

export type WorkflowExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type WorkflowNodeExecutionStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting_agent'
  | 'waiting_human'
  | 'waiting_event'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'timeout'
  | 'cancelled'

export interface WorkflowNodeToolCall {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  endedAt?: number
}

export interface WorkflowNodeState {
  status: WorkflowNodeExecutionStatus
  output?: string
  startedAt?: number
  endedAt?: number
  error?: string
  /** Agent execution details */
  agentTurns?: number
  agentTokensIn?: number
  agentTokensOut?: number
  agentCostUsd?: number
  /** Tool call tracking */
  toolCalls?: WorkflowNodeToolCall[]
}

export interface WorkflowExecution {
  id: string
  workflowId: string
  status: WorkflowExecutionStatus
  nodeStates: Record<string, WorkflowNodeState>
  /** Currently executing node IDs (supports parallel) */
  currentNodeIds?: string[]
  startedAt: number
  endedAt?: number
  error?: string
  /** External context injected by triggers (e.g. webhook body) */
  context?: Record<string, unknown>
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
