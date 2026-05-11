import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { logger } from './logger'
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowExecutionStatus,
  WorkflowNodeState,
  WorkflowNode,
} from '../src/types/platform-extensions'

const DEFINITIONS_FILE = 'workflow-definitions.json'
const EXECUTIONS_FILE = 'workflow-executions.json'

// In-memory execution registry
const activeExecutions = new Map<string, WorkflowExecution>()

interface DefinitionsFile {
  version: 1
  workflows: WorkflowDefinition[]
}

interface ExecutionsFile {
  version: 1
  executions: WorkflowExecution[]
}

function definitionsPath(): string {
  return path.join(app.getPath('userData'), DEFINITIONS_FILE)
}

function executionsPath(): string {
  return path.join(app.getPath('userData'), EXECUTIONS_FILE)
}

async function readDefinitions(): Promise<DefinitionsFile> {
  try {
    const raw = await fs.readFile(definitionsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as DefinitionsFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.workflows)) {
      return { version: 1, workflows: [] }
    }
    return parsed
  } catch {
    return { version: 1, workflows: [] }
  }
}

async function writeDefinitions(data: DefinitionsFile): Promise<void> {
  const p = definitionsPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

async function readExecutions(): Promise<ExecutionsFile> {
  try {
    const raw = await fs.readFile(executionsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as ExecutionsFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.executions)) {
      return { version: 1, executions: [] }
    }
    return parsed
  } catch {
    return { version: 1, executions: [] }
  }
}

async function writeExecutions(data: ExecutionsFile): Promise<void> {
  const p = executionsPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const f = await readDefinitions()
  return f.workflows.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | null> {
  const f = await readDefinitions()
  return f.workflows.find(w => w.id === id) ?? null
}

export async function createWorkflow(input: Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt'>): Promise<WorkflowDefinition> {
  const now = Date.now()
  const wf: WorkflowDefinition = {
    id: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  const f = await readDefinitions()
  f.workflows.push(wf)
  await writeDefinitions(f)
  logger.log(`[workflow] created ${wf.id} "${wf.name}"`)
  return wf
}

export async function updateWorkflow(id: string, updates: Partial<Omit<WorkflowDefinition, 'id' | 'createdAt'>>): Promise<WorkflowDefinition | null> {
  const f = await readDefinitions()
  const idx = f.workflows.findIndex(w => w.id === id)
  if (idx === -1) return null
  const cur = f.workflows[idx]
  const next: WorkflowDefinition = { ...cur, ...updates, updatedAt: Date.now() }
  f.workflows[idx] = next
  await writeDefinitions(f)
  return next
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const f = await readDefinitions()
  const len = f.workflows.length
  f.workflows = f.workflows.filter(w => w.id !== id)
  if (f.workflows.length === len) return false
  await writeDefinitions(f)
  return true
}

// Simple template engine: replace {{prev.output}}, {{prev.status}}, etc.
function resolveTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{(\w+)(?:\.(\w+))?\}\}/g, (_match, key1, key2) => {
    const key = key2 ? `${key1}.${key2}` : key1
    return context[key] ?? ''
  })
}

export class WorkflowExecutor {
  private execution: WorkflowExecution
  private workflow: WorkflowDefinition
  private sendMessageFn: (terminalId: string, prompt: string) => Promise<boolean>
  private context: Record<string, string> = {}

  constructor(
    workflow: WorkflowDefinition,
    sendMessageFn: (terminalId: string, prompt: string) => Promise<boolean>
  ) {
    this.workflow = workflow
    this.sendMessageFn = sendMessageFn
    this.execution = {
      id: randomUUID(),
      workflowId: workflow.id,
      status: 'pending' as WorkflowExecutionStatus,
      nodeStates: {},
      startedAt: Date.now(),
    }
    // Initialize all node states
    for (const node of workflow.nodes) {
      this.execution.nodeStates[node.id] = { status: 'pending' }
    }
    activeExecutions.set(this.execution.id, this.execution)
  }

  getExecution(): WorkflowExecution {
    return this.execution
  }

  async start(): Promise<WorkflowExecution> {
    this.execution.status = 'running'
    logger.log(`[workflow] starting execution ${this.execution.id} for "${this.workflow.name}"`)

    try {
      // Find start nodes (no incoming edges)
      const incoming = new Set(this.workflow.edges.map(e => e.to))
      const startNodes = this.workflow.nodes.filter(n => !incoming.has(n.id))

      for (const node of startNodes) {
        await this.executeNode(node)
      }

      this.execution.status = 'completed'
      this.execution.endedAt = Date.now()
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      this.execution.status = 'failed'
      this.execution.error = errMsg
      this.execution.endedAt = Date.now()
      logger.error(`[workflow] execution ${this.execution.id} failed:`, errMsg)
    }

    await this.saveExecution()
    return this.execution
  }

  private async executeNode(node: WorkflowNode): Promise<void> {
    const state = this.execution.nodeStates[node.id]
    state.status = 'running'
    state.startedAt = Date.now()
    logger.log(`[workflow] node ${node.id} (${node.type}) running`)

    try {
      switch (node.type) {
        case 'send': {
          const prompt = resolveTemplate(node.prompt || '', this.context)
          const terminalId = node.terminalId || ''
          if (terminalId && prompt) {
            const ok = await this.sendMessageFn(terminalId, prompt)
            this.context[`${node.id}.status`] = ok ? 'success' : 'failed'
            if (!ok) {
              state.status = 'failed'
              state.error = 'sendMessage returned false'
              state.endedAt = Date.now()
              return
            }
          }
          this.context[`${node.id}.output`] = prompt
          break
        }
        case 'wait': {
          const duration = node.durationMs || 5000
          await new Promise(r => setTimeout(r, duration))
          break
        }
        case 'condition': {
          const expr = resolveTemplate(node.condition || 'true', this.context)
          // Simple evaluation: only support === and !== comparisons
          const result = this.evaluateCondition(expr)
          this.context[`${node.id}.output`] = String(result)
          this.context[`${node.id}.status`] = result ? 'true' : 'false'
          break
        }
        case 'human': {
          // For now, auto-approve after timeout or immediately
          // In a real implementation, this would emit an IPC event and wait for user response
          const timeout = node.timeoutMs || 30000
          await new Promise(r => setTimeout(r, Math.min(timeout, 1000))) // Minimum wait for demo
          this.context[`${node.id}.output`] = 'approved'
          break
        }
        case 'parallel': {
          const childIds = node.parallelNodeIds || []
          const children = this.workflow.nodes.filter(n => childIds.includes(n.id))
          await Promise.all(children.map(n => this.executeNode(n)))
          break
        }
        case 'loop': {
          const count = node.loopCount || 1
          const child = this.workflow.nodes.find(n => n.id === node.loopNodeId)
          if (child) {
            for (let i = 0; i < count; i++) {
              this.context[`${node.id}.iteration`] = String(i + 1)
              await this.executeNode(child)
            }
          }
          break
        }
      }

      state.status = 'completed'
      state.endedAt = Date.now()
      this.context[`${node.id}.status`] = 'success'

      // Execute downstream nodes
      const outgoing = this.workflow.edges.filter(e => e.from === node.id)
      for (const edge of outgoing) {
        const target = this.workflow.nodes.find(n => n.id === edge.to)
        if (target) {
          await this.executeNode(target)
        }
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      state.status = 'failed'
      state.error = errMsg
      state.endedAt = Date.now()
      this.context[`${node.id}.status`] = 'failed'
      throw error
    }
  }

  private evaluateCondition(expr: string): boolean {
    // Very simple condition evaluator
    // Supports: 'true', 'false', 'success', 'failed', and simple comparisons
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

  private async saveExecution(): Promise<void> {
    const f = await readExecutions()
    f.executions.unshift(this.execution)
    // Keep last 100 executions
    if (f.executions.length > 100) {
      f.executions = f.executions.slice(0, 100)
    }
    await writeExecutions(f)
  }
}

export async function listExecutions(workflowId?: string, limit = 50): Promise<WorkflowExecution[]> {
  const f = await readExecutions()
  let list = f.executions
  if (workflowId) {
    list = list.filter(e => e.workflowId === workflowId)
  }
  return list.slice(0, limit)
}

export async function getExecution(id: string): Promise<WorkflowExecution | null> {
  const f = await readExecutions()
  return f.executions.find(e => e.id === id) ?? null
}

export async function cancelExecution(id: string): Promise<boolean> {
  const exec = activeExecutions.get(id)
  if (!exec || exec.status !== 'running') return false
  exec.status = 'cancelled'
  exec.endedAt = Date.now()
  return true
}
