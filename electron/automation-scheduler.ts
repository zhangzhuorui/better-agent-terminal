import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import type { ClaudeAgentManager } from './claude-agent-manager'
import type { TerminalInstance } from '../src/types'
import type { AutomationJob } from '../src/types/platform-extensions'
import { buildAutomationPromptText, jobMatchesNow, listAutomationJobs, updateJobAfterRun } from './automation-jobs'
import * as analyticsStore from './analytics-store'
import { logger } from './logger'

function workspacesPath(): string {
  return path.join(app.getPath('userData'), 'workspaces.json')
}

interface WorkspacesPayload {
  terminals?: Partial<TerminalInstance>[]
}

async function loadTerminals(): Promise<Partial<TerminalInstance>[]> {
  try {
    const raw = await fs.readFile(workspacesPath(), 'utf-8')
    const parsed = JSON.parse(raw) as WorkspacesPayload
    return parsed.terminals || []
  } catch {
    return []
  }
}

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private getManager: () => ClaudeAgentManager | null

  constructor(getManager: () => ClaudeAgentManager | null) {
    this.getManager = getManager
  }

  /** Manual test run from UI — updates lastRunAt / lastError like a scheduled run. */
  async runOneJobById(id: string): Promise<{ ok: boolean; error?: string }> {
    const manager = this.getManager()
    if (!manager) return { ok: false, error: 'Claude manager not ready' }
    const jobs = await listAutomationJobs()
    const job = jobs.find(j => j.id === id)
    if (!job) return { ok: false, error: 'Job not found' }
    const terminals = await loadTerminals()
    const term = terminals.find(t => t.id === job.terminalId)
    const errMsg = await this.runJob(manager, job, term)
    if (errMsg) {
      await analyticsStore.recordAutomationRun(false)
      await updateJobAfterRun(job.id, errMsg)
      return { ok: false, error: errMsg }
    }
    await analyticsStore.recordAutomationRun(true)
    await updateJobAfterRun(job.id)
    return { ok: true }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick().catch(e => logger.error('[automation] tick', e)), 30_000)
    this.tick().catch(e => logger.error('[automation] initial tick', e))
    logger.log('[automation] scheduler started (30s interval)')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    const manager = this.getManager()
    if (!manager) return

    const now = new Date()
    const jobs = await listAutomationJobs()
    const terminals = await loadTerminals()

    for (const job of jobs) {
      if (!jobMatchesNow(job, now)) continue
      const term = terminals.find(t => t.id === job.terminalId)
      const errMsg = await this.runJob(manager, job, term)
      if (errMsg) {
        await analyticsStore.recordAutomationRun(false)
        await updateJobAfterRun(job.id, errMsg)
      } else {
        await analyticsStore.recordAutomationRun(true)
        await updateJobAfterRun(job.id)
      }
    }
  }

  private async runJob(
    manager: ClaudeAgentManager,
    job: AutomationJob,
    term: Partial<TerminalInstance> | undefined
  ): Promise<string | undefined> {
    if (!term?.cwd) {
      return 'Terminal not found or missing cwd (save workspace / check terminal id).'
    }
    if (term.agentPreset !== 'claude-code') {
      return 'Target is not a Claude Agent terminal (claude-code).'
    }
    const prompt = buildAutomationPromptText(job)
    if (!prompt) return 'Empty prompt.'

    const mode = (job.permissionMode || 'bypassPermissions') as import('@anthropic-ai/claude-agent-sdk').PermissionMode | 'bypassPlan' | 'bypassPermissions'

    try {
      const started = await manager.startSession(job.terminalId, {
        cwd: term.cwd,
        permissionMode: mode as never,
        model: term.model,
      })
      if (!started) return 'startSession returned false.'

      const ok = await manager.sendMessage(job.terminalId, prompt, undefined, {
        contextPackageIds: job.contextPackageIds ?? [],
        analyticsSource: 'automation',
      })
      if (!ok) return 'sendMessage returned false.'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error('[automation] runJob error:', e)
      return msg
    }
    return undefined
  }
}
