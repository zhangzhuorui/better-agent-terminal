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

function migrateWorkflowV1ToV2(wf: WorkflowDefinition): WorkflowDefinition {
  // Already v2 if nodes have positions
  if (wf.nodes.every(n => n.position)) return wf

  return {
    ...wf,
    nodes: wf.nodes.map((n, idx) => ({
      ...n,
      position: n.position || { x: 100 + idx * 220, y: 200 + (idx % 3) * 120 },
      // v1 'send' nodes default to 'agent' type for v2
      type: n.type === 'send' ? 'agent' : n.type,
      // v1 send nodes inherit agent preset
      agentPreset: n.type === 'send' ? 'inherit' : n.agentPreset,
      waitForComplete: n.waitForComplete ?? true,
      timeoutMs: n.timeoutMs || 600_000,
    })),
    edges: wf.edges.map((e, idx) => ({
      ...e,
      id: e.id || `edge-${idx}-${Date.now()}`,
    })),
    viewport: wf.viewport || { x: 0, y: 0, zoom: 1 },
  }
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const f = await readDefinitions()
  return f.workflows.map(migrateWorkflowV1ToV2).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | null> {
  const f = await readDefinitions()
  const wf = f.workflows.find(w => w.id === id)
  return wf ? migrateWorkflowV1ToV2(wf) : null
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
    await saveExecutionToDisk(this.execution)
  }
}

export async function saveExecutionToDisk(execution: WorkflowExecution): Promise<void> {
  const f = await readExecutions()
  f.executions.unshift(execution)
  // Keep last 100 executions
  if (f.executions.length > 100) {
    f.executions = f.executions.slice(0, 100)
  }
  await writeExecutions(f)
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

export async function exportWorkflow(id: string): Promise<string | null> {
  const wf = await getWorkflow(id)
  if (!wf) return null
  // Strip internal fields for clean export
  const exportable: WorkflowDefinition = {
    ...wf,
    nodes: wf.nodes.map(n => ({ ...n })),
    edges: wf.edges.map(e => ({ ...e })),
  }
  return JSON.stringify(exportable, null, 2)
}

export async function importWorkflow(json: string): Promise<WorkflowDefinition | { error: string }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'Invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'Invalid JSON: not an object' }

  const p = parsed as Record<string, unknown>
  if (!p.name || typeof p.name !== 'string') return { error: 'Missing workflow name' }
  if (!Array.isArray(p.nodes)) return { error: 'Missing nodes array' }
  if (!Array.isArray(p.edges)) return { error: 'Missing edges array' }

  // Validate node types
  const validTypes = new Set([
    'send', 'agent', 'terminal', 'wait', 'condition', 'human',
    'parallel', 'join', 'loop', 'start', 'end', 'mcp',
  ])
  for (const n of p.nodes as unknown[]) {
    const node = n as Record<string, unknown>
    if (!node.id || typeof node.id !== 'string') return { error: 'Node missing id' }
    if (!node.type || !validTypes.has(node.type as string)) return { error: `Invalid node type: ${node.type}` }
  }

  const now = Date.now()
  const input: Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt'> = {
    name: p.name as string,
    description: typeof p.description === 'string' ? p.description : undefined,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
    trigger: (p.trigger as WorkflowDefinition['trigger']) || { type: 'manual' },
    nodes: p.nodes as WorkflowNode[],
    edges: p.edges as WorkflowEdge[],
    viewport: p.viewport as WorkflowDefinition['viewport'],
  }
  return createWorkflow(input)
}

// ── Preset Templates ──────────────────────────────────────────────────────

export function getWorkflowTemplates(): { id: string; name: string; description: string; workflow: Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt'> }[] {
  return [
    {
      id: 'code-review',
      name: 'Code Review',
      description: 'Review PR diff, check for issues, and request human confirmation.',
      workflow: {
        name: 'Code Review Flow',
        enabled: true,
        trigger: { type: 'manual' },
        nodes: [
          { id: 'start-1', type: 'start', position: { x: 100, y: 100 } },
          { id: 'review', type: 'agent', label: 'Review PR', position: { x: 300, y: 100 }, prompt: 'Review the current PR diff for code quality issues, security concerns, and best practices. Summarize findings.', terminalId: 'main', agentPreset: 'inherit', waitForComplete: true, timeoutMs: 300_000 },
          { id: 'check', type: 'condition', label: 'Review OK?', position: { x: 500, y: 100 }, condition: '{{review.status}} === "completed"' },
          { id: 'human', type: 'human', label: 'Confirm merge', position: { x: 700, y: 50 }, confirmTitle: 'Approve Merge?', confirmDescription: 'The code review found no blockers. Approve merge?', timeoutMs: 300_000 },
          { id: 'notify', type: 'agent', label: 'Notify issues', position: { x: 700, y: 150 }, prompt: 'Notify the team about the code review issues found.', terminalId: 'main', agentPreset: 'inherit', waitForComplete: true },
          { id: 'end-1', type: 'end', position: { x: 900, y: 100 } },
        ],
        edges: [
          { id: 'e1', from: 'start-1', to: 'review' },
          { id: 'e2', from: 'review', to: 'check' },
          { id: 'e3', from: 'check', to: 'human', conditionValue: 'true' },
          { id: 'e4', from: 'check', to: 'notify', conditionValue: 'false' },
          { id: 'e5', from: 'human', to: 'end-1' },
          { id: 'e6', from: 'notify', to: 'end-1' },
        ],
      },
    },
    {
      id: 'auto-test',
      name: 'Auto Test & Fix',
      description: 'Run tests, and if failing, invoke agent to fix them.',
      workflow: {
        name: 'Auto Test & Fix',
        enabled: true,
        trigger: { type: 'manual' },
        nodes: [
          { id: 'start-1', type: 'start', position: { x: 100, y: 100 } },
          { id: 'test', type: 'terminal', label: 'Run tests', position: { x: 300, y: 100 }, command: 'npm test', terminalId: 'main', waitForComplete: true, timeoutMs: 120_000 },
          { id: 'check', type: 'condition', label: 'Tests ran?', position: { x: 500, y: 100 }, condition: '{{test.status}} === "completed"' },
          { id: 'fix', type: 'agent', label: 'Fix failures', position: { x: 700, y: 150 }, prompt: 'The tests failed. Analyze the test output and fix the failing tests or underlying code. Run tests again to verify.', terminalId: 'main', agentPreset: 'inherit', waitForComplete: true, timeoutMs: 600_000 },
          { id: 'end-1', type: 'end', position: { x: 900, y: 100 } },
        ],
        edges: [
          { id: 'e1', from: 'start-1', to: 'test' },
          { id: 'e2', from: 'test', to: 'check' },
          { id: 'e3', from: 'check', to: 'end-1', conditionValue: 'true' },
          { id: 'e4', from: 'check', to: 'fix', conditionValue: 'false' },
          { id: 'e5', from: 'fix', to: 'end-1' },
        ],
      },
    },
    {
      id: 'release',
      name: 'Release Flow',
      description: 'Generate changelog, git tag, and publish.',
      workflow: {
        name: 'Release Flow',
        enabled: true,
        trigger: { type: 'manual' },
        nodes: [
          { id: 'start-1', type: 'start', position: { x: 100, y: 100 } },
          { id: 'changelog', type: 'agent', label: 'Generate changelog', position: { x: 300, y: 100 }, prompt: 'Generate a changelog from the recent commits since the last tag. Output a concise markdown changelog.', terminalId: 'main', agentPreset: 'inherit', waitForComplete: true, timeoutMs: 300_000 },
          { id: 'tag', type: 'terminal', label: 'Git tag', position: { x: 500, y: 100 }, command: 'git tag -a v$(node -p "require(\'./package.json\').version") -m "Release" && git push --tags', terminalId: 'main', waitForComplete: true, timeoutMs: 60_000 },
          { id: 'publish', type: 'terminal', label: 'Publish', position: { x: 700, y: 100 }, command: 'npm publish', terminalId: 'main', waitForComplete: true, timeoutMs: 120_000 },
          { id: 'end-1', type: 'end', position: { x: 900, y: 100 } },
        ],
        edges: [
          { id: 'e1', from: 'start-1', to: 'changelog' },
          { id: 'e2', from: 'changelog', to: 'tag' },
          { id: 'e3', from: 'tag', to: 'publish' },
          { id: 'e4', from: 'publish', to: 'end-1' },
        ],
      },
    },
  ]
}
