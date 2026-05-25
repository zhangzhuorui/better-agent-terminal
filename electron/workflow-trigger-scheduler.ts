import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { URL } from 'url'
import { logger } from './logger'
import * as workflowEngine from './workflow-engine'
import * as workflowExecutorV2 from './workflow-executor-v2'
import type { AgentDispatcher } from './agent-dispatcher'
import type { WorkflowDefinition, WorkflowTrigger } from '../src/types/platform-extensions'

interface BroadcastFn {
  (channel: string, ...args: unknown[]): void
}

function parseHm(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return { h, m: min }
}

function sameLocalMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  )
}

/** Lightweight cron matcher: supports `* * * * *` (minute hour day month weekday) */
function matchCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [minStr, hourStr, dayStr, monthStr, weekdayStr] = parts

  const matchField = (str: string, value: number, max: number): boolean => {
    if (str === '*') return true
    if (str === '*/2') return value % 2 === 0
    if (str === '*/3') return value % 3 === 0
    if (str === '*/5') return value % 5 === 0
    if (str === '*/10') return value % 10 === 0
    if (str === '*/15') return value % 15 === 0
    if (str === '*/30') return value % 30 === 0
    // Range e.g. 1-5
    const range = /^(-?\d+)-(-?\d+)$/.exec(str)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      return value >= start && value <= end
    }
    // Step e.g. */n or 1-5/2
    const stepMatch = /^(.+?)\/(-?\d+)$/.exec(str)
    if (stepMatch) {
      const base = stepMatch[1]
      const step = Number(stepMatch[2])
      if (base === '*') return value % step === 0
      const r = /^(-?\d+)-(-?\d+)$/.exec(base)
      if (r) {
        const start = Number(r[1])
        return value >= start && (value - start) % step === 0
      }
    }
    // List e.g. 1,3,5
    const list = str.split(',').map(s => Number(s.trim()))
    if (list.every(n => !isNaN(n))) {
      return list.includes(value)
    }
    return false
  }

  // Month in cron is 1-12, JS Date is 0-11
  return (
    matchField(minStr, date.getMinutes(), 59) &&
    matchField(hourStr, date.getHours(), 23) &&
    matchField(dayStr, date.getDate(), 31) &&
    matchField(monthStr, date.getMonth() + 1, 12) &&
    matchField(weekdayStr, date.getDay(), 6)
  )
}

function triggerMatchesNow(trigger: WorkflowTrigger, now: Date, lastTriggeredAt?: number): boolean {
  if (trigger.type === 'manual') return false

  if (trigger.type === 'schedule') {
    const schedule = trigger.schedule || ''
    if (!schedule) return false

    // Check if already triggered in this minute
    if (lastTriggeredAt && sameLocalMinute(new Date(lastTriggeredAt), now)) return false

    // Try HH:mm first
    const hm = parseHm(schedule)
    if (hm) {
      if (now.getHours() !== hm.h || now.getMinutes() !== hm.m) return false
      const wd = now.getDay()
      const weekdays = trigger.weekdays
      if (weekdays && weekdays.length > 0 && !weekdays.includes(wd)) return false
      return true
    }

    // Try cron
    return matchCron(schedule, now)
  }

  return false
}

export class WorkflowTriggerScheduler {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private httpServer: ReturnType<typeof createServer> | null = null
  private dispatcher: AgentDispatcher | null = null
  private broadcast: BroadcastFn | null = null
  private lastTriggeredAt = new Map<string, number>() // workflowId -> timestamp
  private webhookPort = 9877

  setDependencies(dispatcher: AgentDispatcher, broadcast: BroadcastFn): void {
    this.dispatcher = dispatcher
    this.broadcast = broadcast
  }

  start(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => this.tick().catch(e => logger.error('[workflow-scheduler] tick error:', e)), 30_000)
    this.tick().catch(e => logger.error('[workflow-scheduler] initial tick error:', e))
    this.startWebhookServer()
    logger.log('[workflow-scheduler] started (30s interval, webhook port', this.webhookPort, ')')
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.httpServer) {
      this.httpServer.close(() => {
        logger.log('[workflow-scheduler] webhook server closed')
      })
      this.httpServer = null
    }
  }

  getWebhookUrl(workflowId: string): string {
    return `http://localhost:${this.webhookPort}/webhook/${workflowId}`
  }

  private async tick(): Promise<void> {
    if (!this.dispatcher || !this.broadcast) return

    const now = new Date()
    const workflows = await workflowEngine.listWorkflows()

    for (const wf of workflows) {
      if (!wf.enabled) continue
      if (!wf.trigger) continue
      const lastAt = this.lastTriggeredAt.get(wf.id)
      if (triggerMatchesNow(wf.trigger, now, lastAt)) {
        logger.log(`[workflow-scheduler] schedule trigger fired for "${wf.name}" (${wf.id})`)
        this.lastTriggeredAt.set(wf.id, now.getTime())
        this.executeWorkflow(wf).catch(err => {
          logger.error(`[workflow-scheduler] execution error for ${wf.id}:`, err)
        })
      }
    }
  }

  private async executeWorkflow(wf: WorkflowDefinition, initialContext?: Record<string, unknown>): Promise<void> {
    if (!this.dispatcher || !this.broadcast) return
    try {
      await workflowExecutorV2.runWorkflowV2(wf, this.dispatcher, this.broadcast, initialContext)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[workflow-scheduler] failed to execute workflow ${wf.id}:`, msg)
    }
  }

  private startWebhookServer(): void {
    this.httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || '/', `http://localhost:${this.webhookPort}`)
        const match = url.pathname.match(/^\/webhook\/([^/]+)$/)

        if (!match) {
          res.writeHead(404)
          res.end(JSON.stringify({ ok: false, error: 'Not found' }))
          return
        }

        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }))
          return
        }

        const workflowId = match[1]
        const wf = await workflowEngine.getWorkflow(workflowId)
        if (!wf) {
          res.writeHead(404)
          res.end(JSON.stringify({ ok: false, error: 'Workflow not found' }))
          return
        }

        if (!wf.enabled) {
          res.writeHead(403)
          res.end(JSON.stringify({ ok: false, error: 'Workflow is disabled' }))
          return
        }

        if (wf.trigger?.type !== 'webhook') {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: 'Workflow trigger is not webhook' }))
          return
        }

        const secret = req.headers['x-webhook-secret'] as string | undefined
        if (wf.trigger.webhookSecret && secret !== wf.trigger.webhookSecret) {
          res.writeHead(401)
          res.end(JSON.stringify({ ok: false, error: 'Invalid webhook secret' }))
          return
        }

        // Read body
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk)
        }
        const bodyText = Buffer.concat(chunks).toString('utf-8')
        let bodyJson: unknown = undefined
        try { bodyJson = JSON.parse(bodyText) } catch { /* ignore non-JSON body */ }

        logger.log(`[workflow-scheduler] webhook triggered for "${wf.name}" (${wf.id})`)
        this.lastTriggeredAt.set(wf.id, Date.now())

        // Execute workflow (fire-and-forget from HTTP perspective)
        // Inject webhook body as template context
        this.executeWorkflow(wf, { webhook: bodyJson ?? bodyText }).catch(err => {
          logger.error(`[workflow-scheduler] webhook execution error for ${wf.id}:`, err)
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, executionId: 'pending' }))
      } catch (err: unknown) {
        logger.error('[workflow-scheduler] webhook server error:', err)
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, error: 'Internal server error' }))
      }
    })

    this.httpServer.listen(this.webhookPort, () => {
      logger.log(`[workflow-scheduler] webhook server listening on port ${this.webhookPort}`)
    })

    this.httpServer.on('error', (err: Error) => {
      logger.error('[workflow-scheduler] webhook server error:', err.message)
    })
  }
}
