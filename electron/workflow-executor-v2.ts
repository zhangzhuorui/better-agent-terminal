import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { logger } from './logger'
import * as mcpManager from './mcp-manager'
import { saveExecutionToDisk } from './workflow-engine'
import type { AgentDispatcher, AgentDispatchOptions, AgentProgressMeta } from './agent-dispatcher'
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowExecutionStatus,
  WorkflowNode,
  WorkflowNodeExecutionStatus,
  WorkflowNodeState,
  WorkflowEdge,
} from '../src/types/platform-extensions'

// In-memory execution registry
const activeExecutions = new Map<string, WorkflowExecutionV2>()

// Human confirmation registry: executionId + nodeId → resolver
const humanConfirmResolvers = new Map<string, { resolve: (approved: boolean) => void; reject: (err: Error) => void }>()

export function resolveHumanConfirm(executionId: string, nodeId: string, approved: boolean): void {
  const key = `${executionId}:${nodeId}`
  const resolver = humanConfirmResolvers.get(key)
  if (resolver) {
    resolver.resolve(approved)
    humanConfirmResolvers.delete(key)
  }
}

export interface WorkflowExecutionV2 extends WorkflowExecution {
  /** Internal: currently running node IDs */
  _runningNodeIds: Set<string>
  /** Internal: completed node IDs */
  _completedNodeIds: Set<string>
  /** Internal: abort controllers per node */
  _abortControllers: Map<string, AbortController>
}

interface BroadcastFn {
  (channel: string, ...args: unknown[]): void
}

function createExecutionV2(workflow: WorkflowDefinition, initialContext?: Record<string, unknown>): WorkflowExecutionV2 {
  const nodeStates: Record<string, WorkflowNodeState> = {}
  for (const node of workflow.nodes) {
    nodeStates[node.id] = { status: 'pending' }
  }

  return {
    id: randomUUID(),
    workflowId: workflow.id,
    status: 'pending' as WorkflowExecutionStatus,
    nodeStates,
    currentNodeIds: [],
    startedAt: Date.now(),
    context: initialContext ? { ...initialContext } : {},
    _runningNodeIds: new Set(),
    _completedNodeIds: new Set(),
    _abortControllers: new Map(),
  }
}

export class WorkflowExecutorV2 {
  private execution: WorkflowExecutionV2
  private workflow: WorkflowDefinition
  private dispatcher: AgentDispatcher
  private broadcast: BroadcastFn
  /** Current loop index (1-based) for template resolution */
  private loopIndex = 0

  constructor(
    workflow: WorkflowDefinition,
    dispatcher: AgentDispatcher,
    broadcast: BroadcastFn,
    initialContext?: Record<string, unknown>,
  ) {
    this.workflow = workflow
    this.dispatcher = dispatcher
    this.broadcast = broadcast
    this.execution = createExecutionV2(workflow, initialContext)
    activeExecutions.set(this.execution.id, this.execution)
  }

  getExecution(): WorkflowExecutionV2 {
    return this.execution
  }

  async start(): Promise<WorkflowExecution> {
    this.execution.status = 'running'
    logger.log(`[workflow-v2] starting execution ${this.execution.id} for "${this.workflow.name}"`)

    try {
      const startNodes = this.getStartNodes()
      await this.scheduleNodes(startNodes)
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      this.execution.status = 'failed'
      this.execution.error = errMsg
      this.execution.endedAt = Date.now()
      logger.error(`[workflow-v2] execution ${this.execution.id} failed:`, errMsg)
    }

    await this.saveExecution()
    return this.execution
  }

  private async saveExecution(): Promise<void> {
    try {
      // Strip internal V2 fields before saving
      const { _runningNodeIds, _completedNodeIds, _abortControllers, ...clean } = this.execution as any
      await saveExecutionToDisk(clean as WorkflowExecution)
    } catch (err) {
      logger.error('[workflow-v2] failed to save execution:', err)
    }
  }

  cancel(): boolean {
    if (this.execution.status !== 'running') return false
    this.execution.status = 'cancelled'
    for (const [, ctrl] of this.execution._abortControllers) {
      ctrl.abort()
    }
    for (const nodeId of this.execution._runningNodeIds) {
      this.execution.nodeStates[nodeId].status = 'cancelled'
      this.execution.nodeStates[nodeId].endedAt = Date.now()
    }
    this.execution.endedAt = Date.now()
    this.broadcastExecutionUpdate()
    void this.saveExecution()
    return true
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private getStartNodes(): WorkflowNode[] {
    // Nodes with no incoming edges, or explicit 'start' nodes
    const incoming = new Set(this.workflow.edges.map(e => e.to))
    const startTypeNodes = this.workflow.nodes.filter(n => n.type === 'start')
    if (startTypeNodes.length > 0) return startTypeNodes

    const zeroInDegree = this.workflow.nodes.filter(n => !incoming.has(n.id))
    if (zeroInDegree.length > 0) return zeroInDegree

    // Fallback: all nodes
    return this.workflow.nodes.slice()
  }

  private async scheduleNodes(nodes: WorkflowNode[]): Promise<void> {
    await Promise.all(nodes.map(n => this.scheduleNode(n.id)))
  }

  private async scheduleNode(nodeId: string): Promise<void> {
    if (this.execution._runningNodeIds.has(nodeId) || this.execution._completedNodeIds.has(nodeId)) return
    if (this.execution.status !== 'running') return

    const node = this.workflow.nodes.find(n => n.id === nodeId)
    if (!node) return

    // Check if all predecessors are completed (for join/regular nodes)
    if (!this.areAllPredecessorsCompleted(nodeId)) return

    const abortCtrl = new AbortController()
    this.execution._abortControllers.set(nodeId, abortCtrl)
    this.execution._runningNodeIds.add(nodeId)
    this.execution.currentNodeIds = Array.from(this.execution._runningNodeIds)

    // Execute asynchronously so scheduler is not blocked
    this.executeNodeAsync(node, abortCtrl.signal).catch(err => {
      logger.error(`[workflow-v2] node ${nodeId} unexpected error:`, err)
      this.failNode(nodeId, String(err))
    })
  }

  private areAllPredecessorsCompleted(nodeId: string): boolean {
    const incoming = this.workflow.edges.filter(e => e.to === nodeId)
    if (incoming.length === 0) return true
    return incoming.every(e => this.execution._completedNodeIds.has(e.from))
  }

  // ---------------------------------------------------------------------------
  // Node execution
  // ---------------------------------------------------------------------------

  private async executeNodeAsync(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const state = this.execution.nodeStates[node.id]
    const maxRetries = node.retryCount ?? 0
    const retryDelay = node.retryDelayMs ?? 5_000

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) {
        state.status = 'cancelled'
        state.endedAt = Date.now()
        this.broadcastNodeUpdate(node.id)
        return
      }

      state.status = attempt > 0 ? 'retrying' : 'running'
      state.startedAt = state.startedAt || Date.now()
      this.broadcastNodeUpdate(node.id)

      try {
        await this.executeNodeAttempt(node, signal)
        // Success — clear any previous error
        state.error = undefined

        if (state.status !== 'cancelled') {
          state.status = 'completed'
          state.endedAt = Date.now()
          this.broadcastNodeUpdate(node.id)
          await this.onNodeComplete(node.id)
        }
        return
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.error(`[workflow-v2] node ${node.id} attempt ${attempt + 1}/${maxRetries + 1} failed:`, errMsg)

        if (attempt < maxRetries) {
          // Wait before retry
          await this.sleepWithAbort(retryDelay, signal)
        } else {
          // All retries exhausted
          throw error
        }
      }
    }
  }

  private async executeNodeAttempt(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const state = this.execution.nodeStates[node.id]

    switch (node.type) {
      case 'send':
      case 'agent':
        await this.executeAgentNode(node, signal)
        break
      case 'terminal':
        await this.executeTerminalNode(node, signal)
        break
      case 'wait':
        await this.executeWaitNode(node, signal)
        break
      case 'condition':
        await this.executeConditionNode(node)
        break
      case 'human':
        await this.executeHumanNode(node, signal)
        break
      case 'parallel':
        await this.executeParallelNode(node, signal)
        break
      case 'join':
        await this.executeJoinNode(node)
        break
      case 'loop':
        await this.executeLoopNode(node, signal)
        break
      case 'mcp':
        await this.executeMcpNode(node, signal)
        break
      case 'start':
      case 'end':
        state.output = node.type
        break
      default:
        state.output = `Unknown node type: ${node.type}`
    }

    if (signal.aborted) {
      state.status = 'cancelled'
      state.endedAt = Date.now()
      this.broadcastNodeUpdate(node.id)
      return
    }
  }

  private failNode(nodeId: string, error: string): void {
    const state = this.execution.nodeStates[nodeId]
    state.status = 'failed'
    state.error = error
    state.endedAt = Date.now()
    this.execution._runningNodeIds.delete(nodeId)
    this.execution.currentNodeIds = Array.from(this.execution._runningNodeIds)
    this.broadcastNodeUpdate(nodeId)

    // By default, fail the entire execution
    this.execution.status = 'failed'
    this.execution.error = error
    this.execution.endedAt = Date.now()
    this.broadcastExecutionUpdate()
    void this.saveExecution()
  }

  // ---------------------------------------------------------------------------
  // Specific node types
  // ---------------------------------------------------------------------------

  private async executeAgentNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const state = this.execution.nodeStates[node.id]
    const prompt = this.resolveTemplate(node.prompt || '')
    const terminalId = node.terminalId || ''

    if (!terminalId || !prompt) {
      state.output = 'Missing terminalId or prompt'
      return
    }

    state.status = 'waiting_agent'
    this.broadcastNodeUpdate(node.id)

    const dispatchOptions: AgentDispatchOptions = {
      terminalId,
      prompt,
      agentPreset: node.agentPreset === 'inherit' ? undefined : node.agentPreset,
      waitForComplete: node.waitForComplete ?? true,
      timeoutMs: node.timeoutMs || 600_000,
      signal,
      contextPackageIds: node.contextPackageIds ?? [],
      analyticsSource: 'automation',
      onProgress: (meta: AgentProgressMeta) => {
        state.agentTurns = meta.turns
        state.agentTokensIn = meta.inputTokens
        state.agentTokensOut = meta.outputTokens
        state.toolCalls = meta.toolCalls
        this.broadcastNodeUpdate(node.id)
      },
    }

    const result = await this.dispatcher.dispatch(dispatchOptions)
    state.output = result.output
    state.agentCostUsd = result.costUsd
  }

  private async executeTerminalNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const command = this.resolveTemplate(node.command || '')
    const terminalId = node.terminalId || ''

    if (!terminalId || !command) {
      this.execution.nodeStates[node.id].output = 'Missing terminalId or command'
      return
    }

    // For terminal nodes, we just send the command and optionally wait
    await this.dispatcher.dispatch({
      terminalId,
      prompt: command,
      waitForComplete: node.waitForComplete ?? false,
      timeoutMs: node.timeoutMs || 60_000,
      signal,
      onProgress: () => {},
    })

    this.execution.nodeStates[node.id].output = command
  }

  private async executeWaitNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const duration = node.durationMs || 5000
    await this.sleepWithAbort(duration, signal)
  }

  private async executeConditionNode(node: WorkflowNode): Promise<void> {
    const expr = this.resolveTemplate(node.condition || 'true')
    const result = this.evaluateCondition(expr)
    this.execution.nodeStates[node.id].output = String(result)
  }

  private async executeHumanNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const state = this.execution.nodeStates[node.id]
    state.status = 'waiting_human'
    this.broadcastNodeUpdate(node.id)

    const executionId = this.execution.id
    const nodeId = node.id
    const key = `${executionId}:${nodeId}`
    const timeout = node.timeoutMs || 300_000

    // Broadcast to all renderers asking for human confirmation
    this.broadcast('workflow:human-confirm-request', executionId, nodeId, {
      title: node.confirmTitle || 'Workflow requires confirmation',
      description: node.confirmDescription || 'Please confirm to continue.',
      timeoutMs: timeout,
    })

    const approved = await new Promise<boolean>((resolve, reject) => {
      humanConfirmResolvers.set(key, { resolve, reject })

      const onAbort = () => {
        humanConfirmResolvers.delete(key)
        reject(new Error('Cancelled'))
      }
      signal.addEventListener('abort', onAbort)

      // Timeout fallback
      setTimeout(() => {
        if (humanConfirmResolvers.has(key)) {
          humanConfirmResolvers.delete(key)
          signal.removeEventListener('abort', onAbort)
          resolve(false)
        }
      }, timeout)
    })

    if (!approved) {
      throw new Error('Human confirmation rejected or timed out')
    }
    state.output = 'approved'
  }

  private async executeParallelNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const childIds = node.parallelNodeIds || []
    const children = this.workflow.nodes.filter(n => childIds.includes(n.id))
    await Promise.all(children.map(n => this.executeNodeAsync(n, signal)))
  }

  private async executeJoinNode(node: WorkflowNode): Promise<void> {
    // Join logic is handled by areAllPredecessorsCompleted in the scheduler.
    // When we reach here, all predecessors are already done.
    this.execution.nodeStates[node.id].output = 'joined'
  }

  private async executeLoopNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const count = node.loopCount || 1
    const child = this.workflow.nodes.find(n => n.id === node.loopNodeId)
    if (!child) {
      this.execution.nodeStates[node.id].output = 'Loop child not found'
      return
    }

    for (let i = 0; i < count; i++) {
      if (signal.aborted) break
      this.loopIndex = i + 1 // 1-based for user-facing templates
      await this.executeNodeAsync(child, signal)
    }
    this.loopIndex = 0
  }

  private async executeMcpNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const state = this.execution.nodeStates[node.id]
    const serverId = node.mcpServerId || ''
    const toolName = node.mcpToolName || ''
    const toolInput = node.mcpToolInput || {}

    if (!serverId || !toolName) {
      state.output = 'Missing mcpServerId or mcpToolName'
      return
    }

    if (signal.aborted) {
      state.status = 'cancelled'
      return
    }

    const result = await mcpManager.callMcpTool(serverId, toolName, toolInput, node.timeoutMs || 30_000)
    if (!result.ok) {
      throw new Error(result.error || 'MCP tool call failed')
    }
    state.output = typeof result.result === 'string' ? result.result : JSON.stringify(result.result)
  }

  // ---------------------------------------------------------------------------
  // Completion & downstream scheduling
  // ---------------------------------------------------------------------------

  private async onNodeComplete(nodeId: string): Promise<void> {
    this.execution._completedNodeIds.add(nodeId)
    this.execution._runningNodeIds.delete(nodeId)
    this.execution._abortControllers.delete(nodeId)
    this.execution.currentNodeIds = Array.from(this.execution._runningNodeIds)

    const outgoing = this.workflow.edges.filter(e => e.from === nodeId)

    for (const edge of outgoing) {
      // Check condition edge
      if (edge.conditionValue) {
        const nodeOutput = this.execution.nodeStates[nodeId]?.output || ''
        if (nodeOutput !== edge.conditionValue) {
          this.markNodeSkipped(edge.to)
          continue
        }
      }

      // Check if all predecessors of target are completed
      if (this.areAllPredecessorsCompleted(edge.to)) {
        await this.scheduleNode(edge.to)
      }
    }

    // Check if execution is finished
    if (this.execution._runningNodeIds.size === 0 && this.areAllNodesFinished()) {
      this.execution.status = 'completed'
      this.execution.endedAt = Date.now()
      this.broadcastExecutionUpdate()
      logger.log(`[workflow-v2] execution ${this.execution.id} completed`)
      void this.saveExecution()
    }
  }

  private markNodeSkipped(nodeId: string): void {
    const state = this.execution.nodeStates[nodeId]
    if (state.status === 'pending') {
      state.status = 'skipped'
      state.endedAt = Date.now()
      this.broadcastNodeUpdate(nodeId)
      // Also mark downstream as skipped
      this.workflow.edges
        .filter(e => e.from === nodeId)
        .forEach(e => this.markNodeSkipped(e.to))
    }
  }

  private areAllNodesFinished(): boolean {
    return this.workflow.nodes.every(n => {
      const s = this.execution.nodeStates[n.id]?.status
      return s === 'completed' || s === 'failed' || s === 'skipped' || s === 'cancelled'
    })
  }

  // ---------------------------------------------------------------------------
  // Template & condition evaluation
  // ---------------------------------------------------------------------------

  private resolveTemplate(template: string): string {
    const nodeContext: Record<string, string> = {}
    for (const [nodeId, state] of Object.entries(this.execution.nodeStates)) {
      if (state.output !== undefined) nodeContext[`${nodeId}.output`] = state.output
      if (state.status !== undefined) nodeContext[`${nodeId}.status`] = state.status
      if (state.error !== undefined) nodeContext[`${nodeId}.error`] = state.error
    }

    return template.replace(/\{\{([^{}]+)\}\}/g, (_match, inner) => {
      const key = inner.trim()

      // Node state variables: {{nodeId.output}}, {{nodeId.status}}, {{nodeId.error}}
      if (nodeContext[key] !== undefined) return nodeContext[key]

      // Workflow metadata
      if (key === 'workflow.name') return this.workflow.name
      if (key === 'workflow.id') return this.workflow.id

      // Execution metadata
      if (key === 'execution.id') return this.execution.id
      if (key === 'execution.status') return this.execution.status

      // Date / time helpers
      if (key === 'date') return new Date().toISOString().slice(0, 10)
      if (key === 'now') return String(Date.now())
      if (key.startsWith('date:')) {
        const fmt = key.slice(5)
        const now = new Date()
        return fmt
          .replace('YYYY', String(now.getFullYear()))
          .replace('MM', String(now.getMonth() + 1).padStart(2, '0'))
          .replace('DD', String(now.getDate()).padStart(2, '0'))
          .replace('HH', String(now.getHours()).padStart(2, '0'))
          .replace('mm', String(now.getMinutes()).padStart(2, '0'))
          .replace('ss', String(now.getSeconds()).padStart(2, '0'))
      }

      // Loop index
      if (key === 'loop.index') return String(this.loopIndex)

      // Webhook context: {{webhook.body}}, {{webhook.body.key}}
      if (key.startsWith('webhook.') && this.execution.context) {
        const webhookData = this.execution.context.webhook
        if (webhookData !== undefined) {
          const subKey = key.slice(8) // after 'webhook.'
          if (subKey === 'body') {
            return typeof webhookData === 'string' ? webhookData : JSON.stringify(webhookData)
          }
          if (subKey.startsWith('body.')) {
            const path = subKey.slice(5)
            if (typeof webhookData === 'object' && webhookData !== null) {
              const val = (webhookData as Record<string, unknown>)[path]
              return val !== undefined ? String(val) : ''
            }
          }
        }
      }

      return ''
    })
  }

  private evaluateCondition(expr: string): boolean {
    expr = expr.trim().toLowerCase()
    if (expr === 'true' || expr === 'success') return true
    if (expr === 'false' || expr === 'failed') return false

    const eqMatch = expr.match(/^(.+?)\s*===?\s*(.+)$/)
    if (eqMatch) {
      return eqMatch[1].trim() === eqMatch[2].trim().replace(/^["']|["']$/g, '')
    }
    const neMatch = expr.match(/^(.+?)\s*!==?\s*(.+)$/)
    if (neMatch) {
      return neMatch[1].trim() !== neMatch[2].trim().replace(/^["']|["']$/g, '')
    }

    return !!expr
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('Cancelled'))
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Broadcasting
  // ---------------------------------------------------------------------------

  private broadcastNodeUpdate(nodeId: string): void {
    const state = this.execution.nodeStates[nodeId]
    this.broadcast('workflow:execution-update', this.execution.id, nodeId, state)
  }

  private broadcastExecutionUpdate(): void {
    this.broadcast('workflow:execution-update', this.execution.id, '__execution__', {
      status: this.execution.status,
      currentNodeIds: this.execution.currentNodeIds,
      error: this.execution.error,
      endedAt: this.execution.endedAt,
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getActiveExecution(id: string): WorkflowExecutionV2 | undefined {
  return activeExecutions.get(id)
}

export function cancelExecution(id: string): boolean {
  const exec = activeExecutions.get(id)
  if (!exec) return false
  // Find the executor instance... we need to store them too.
  // For now, just mark as cancelled in memory.
  if (exec.status !== 'running') return false
  exec.status = 'cancelled'
  for (const [, ctrl] of exec._abortControllers) {
    ctrl.abort()
  }
  exec.endedAt = Date.now()
  return true
}

// Store executor instances for cancellation
const executorInstances = new Map<string, WorkflowExecutorV2>()

export async function runWorkflowV2(
  workflow: WorkflowDefinition,
  dispatcher: AgentDispatcher,
  broadcast: BroadcastFn,
  initialContext?: Record<string, unknown>,
): Promise<WorkflowExecution> {
  const executor = new WorkflowExecutorV2(workflow, dispatcher, broadcast, initialContext)
  executorInstances.set(executor.getExecution().id, executor)
  const result = await executor.start()
  executorInstances.delete(result.id)
  return result
}

export function cancelWorkflowExecution(id: string): boolean {
  const executor = executorInstances.get(id)
  if (executor) {
    return executor.cancel()
  }
  return cancelExecution(id)
}
