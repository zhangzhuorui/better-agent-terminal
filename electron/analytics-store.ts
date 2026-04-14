import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PlatformAnalyticsSummary } from '../src/types/platform-extensions'
import { logger } from './logger'

const FILE = 'platform-analytics.json'

interface FileShape {
  version: 1
  updatedAt: number
  totals: PlatformAnalyticsSummary['totals']
  byDay: PlatformAnalyticsSummary['byDay']
  /** Per UI session / terminal id — SDK-reported cumulative metrics */
  sessionBaselines: Record<string, { input: number; output: number; cost: number }>
}

const emptyDay = () => ({
  userMessages: 0,
  automationUserMessages: 0,
  agentTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  automationRuns: 0,
  automationFailures: 0,
})

const emptyTotals = (): PlatformAnalyticsSummary['totals'] => ({
  userMessages: 0,
  automationUserMessages: 0,
  agentTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  automationRuns: 0,
  automationFailures: 0,
})

function dataPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(dataPath(), 'utf-8')
    const parsed = JSON.parse(raw) as FileShape
    if (!parsed || parsed.version !== 1) {
      return {
        version: 1,
        updatedAt: Date.now(),
        totals: emptyTotals(),
        byDay: {},
        sessionBaselines: {},
      }
    }
    return {
      version: 1,
      updatedAt: parsed.updatedAt || Date.now(),
      totals: { ...emptyTotals(), ...parsed.totals },
      byDay: parsed.byDay || {},
      sessionBaselines: parsed.sessionBaselines || {},
    }
  } catch {
    return {
      version: 1,
      updatedAt: Date.now(),
      totals: emptyTotals(),
      byDay: {},
      sessionBaselines: {},
    }
  }
}

async function writeFile(data: FileShape): Promise<void> {
  data.updatedAt = Date.now()
  const p = dataPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

function ensureDay(data: FileShape, day: string) {
  if (!data.byDay[day]) data.byDay[day] = emptyDay()
}

export async function getAnalyticsSummary(): Promise<PlatformAnalyticsSummary> {
  const data = await readFile()
  return {
    totals: { ...emptyTotals(), ...data.totals },
    byDay: { ...data.byDay },
    updatedAt: data.updatedAt,
  }
}

export async function recordUserMessage(source: 'user' | 'automation'): Promise<void> {
  const data = await readFile()
  const day = localDayKey()
  ensureDay(data, day)
  if (source === 'automation') {
    data.totals.automationUserMessages += 1
    data.byDay[day].automationUserMessages += 1
  } else {
    data.totals.userMessages += 1
    data.byDay[day].userMessages += 1
  }
  await writeFile(data)
}

export async function recordAgentTurn(
  sessionId: string,
  meta: { inputTokens: number; outputTokens: number; totalCost: number }
): Promise<void> {
  const data = await readFile()
  const day = localDayKey()
  ensureDay(data, day)

  const prev = data.sessionBaselines[sessionId] || { input: 0, output: 0, cost: 0 }
  const dIn = Math.max(0, meta.inputTokens - prev.input)
  const dOut = Math.max(0, meta.outputTokens - prev.output)
  const dCost = Math.max(0, meta.totalCost - prev.cost)

  data.sessionBaselines[sessionId] = {
    input: meta.inputTokens,
    output: meta.outputTokens,
    cost: meta.totalCost,
  }

  data.totals.agentTurns += 1
  data.totals.inputTokens += dIn
  data.totals.outputTokens += dOut
  data.totals.costUsd += dCost

  data.byDay[day].agentTurns += 1
  data.byDay[day].inputTokens += dIn
  data.byDay[day].outputTokens += dOut
  data.byDay[day].costUsd += dCost

  await writeFile(data)
}

export async function resetSessionBaseline(sessionId: string): Promise<void> {
  const data = await readFile()
  delete data.sessionBaselines[sessionId]
  await writeFile(data)
}

export async function recordAutomationRun(success: boolean): Promise<void> {
  const data = await readFile()
  const day = localDayKey()
  ensureDay(data, day)
  if (success) {
    data.totals.automationRuns += 1
    data.byDay[day].automationRuns += 1
  } else {
    data.totals.automationFailures += 1
    data.byDay[day].automationFailures += 1
  }
  await writeFile(data)
}

export async function trimOldDays(keepDays = 120): Promise<void> {
  const data = await readFile()
  const keys = Object.keys(data.byDay).sort()
  if (keys.length <= keepDays) return
  const drop = keys.slice(0, keys.length - keepDays)
  for (const k of drop) delete data.byDay[k]
  await writeFile(data)
  logger.log(`[analytics] trimmed ${drop.length} old day buckets`)
}
