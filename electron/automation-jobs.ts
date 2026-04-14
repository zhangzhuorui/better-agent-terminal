import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { AutomationJob } from '../src/types/platform-extensions'
import { logger } from './logger'

const FILE = 'automation-jobs.json'

function dataPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

async function readRaw(): Promise<AutomationJob[]> {
  try {
    const raw = await fs.readFile(dataPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed as AutomationJob[]
  } catch {
    return []
  }
}

async function writeRaw(jobs: AutomationJob[]): Promise<void> {
  const p = dataPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(jobs, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

export async function listAutomationJobs(): Promise<AutomationJob[]> {
  return readRaw()
}

export async function saveAutomationJobs(jobs: AutomationJob[]): Promise<boolean> {
  await writeRaw(jobs)
  return true
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

export function jobMatchesNow(job: AutomationJob, now: Date): boolean {
  if (!job.enabled) return false
  const hm = parseHm(job.runAtLocal)
  if (!hm) return false
  if (now.getHours() !== hm.h || now.getMinutes() !== hm.m) return false
  const wd = now.getDay()
  if (job.weekdays && job.weekdays.length > 0 && !job.weekdays.includes(wd)) return false
  if (job.lastRunAt && sameLocalMinute(new Date(job.lastRunAt), now)) return false
  return true
}

/**
 * Build the raw user text for `sendMessage` (before context packages are prepended in the manager).
 * When `promptDelivery === 'claude_loop'`, wraps into Claude Code `/loop [interval] [prompt]` syntax.
 */
export function buildAutomationPromptText(job: Pick<AutomationJob, 'prompt' | 'promptDelivery' | 'loopInterval'>): string {
  const p = (job.prompt ?? '').trim()
  if (job.promptDelivery !== 'claude_loop') return p
  if (/^\s*\/loop(\s|$)/i.test(p)) return p
  const iv = (job.loopInterval ?? '').trim()
  if (iv && p) return `/loop ${iv} ${p}`
  if (p) return `/loop ${p}`
  if (iv) return `/loop ${iv}`
  return '/loop'
}

export async function updateJobAfterRun(id: string, err?: string): Promise<void> {
  const jobs = await readRaw()
  const idx = jobs.findIndex(j => j.id === id)
  if (idx === -1) return
  const now = new Date()
  jobs[idx] = {
    ...jobs[idx],
    lastRunAt: now.getTime(),
    lastError: err,
  }
  await writeRaw(jobs)
  logger.log(`[automation] job ${id.slice(0, 8)} ${err ? `failed: ${err}` : 'ok'}`)
}
