import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { AgentPresetId } from '../src/types/agent-presets'
import { logger } from './logger'

const FILE = 'injection-rules.json'

export interface InjectionRule {
  id: string
  name: string
  enabled: boolean
  conditions: {
    workspacePathPattern?: string
    agentPreset?: AgentPresetId
    timeRange?: { start: string; end: string; weekdays: number[] }
    messageKeyword?: string
  }[]
  action: {
    contextPackageIds: string[]
    injectPosition: 'prepend' | 'append'
    deduplicate: boolean
  }
  createdAt: number
  updatedAt: number
}

interface FileShape {
  version: 1
  rules: InjectionRule[]
}

function dataPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(dataPath(), 'utf-8')
    const parsed = JSON.parse(raw) as FileShape
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rules)) {
      return { version: 1, rules: [] }
    }
    return parsed
  } catch {
    return { version: 1, rules: [] }
  }
}

async function writeFile(data: FileShape): Promise<void> {
  const p = dataPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

export async function listInjectionRules(): Promise<InjectionRule[]> {
  const f = await readFile()
  return f.rules.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getInjectionRule(id: string): Promise<InjectionRule | null> {
  const f = await readFile()
  return f.rules.find(r => r.id === id) ?? null
}

export async function createInjectionRule(input: Omit<InjectionRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<InjectionRule> {
  const now = Date.now()
  const rule: InjectionRule = {
    id: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  const f = await readFile()
  f.rules.push(rule)
  await writeFile(f)
  logger.log(`[injection-engine] created rule ${rule.id} "${rule.name}"`)
  return rule
}

export async function updateInjectionRule(id: string, updates: Partial<Omit<InjectionRule, 'id' | 'createdAt'>>): Promise<InjectionRule | null> {
  const f = await readFile()
  const idx = f.rules.findIndex(r => r.id === id)
  if (idx === -1) return null
  const cur = f.rules[idx]
  const next: InjectionRule = { ...cur, ...updates, updatedAt: Date.now() }
  f.rules[idx] = next
  await writeFile(f)
  return next
}

export async function deleteInjectionRule(id: string): Promise<boolean> {
  const f = await readFile()
  const len = f.rules.length
  f.rules = f.rules.filter(r => r.id !== id)
  if (f.rules.length === len) return false
  await writeFile(f)
  return true
}

export interface InjectionContext {
  workspacePath: string
  agentPreset?: AgentPresetId
  messageText: string
  existingPackageIds: string[]
}

export interface InjectionResult {
  matchedRuleIds: string[]
  mergedPackageIds: string[]
  appliedRules: string[]
}

function matchesCondition(condition: InjectionRule['conditions'][number], ctx: InjectionContext): boolean {
  if (condition.workspacePathPattern) {
    try {
      const regex = new RegExp(condition.workspacePathPattern)
      if (!regex.test(ctx.workspacePath)) return false
    } catch {
      return false
    }
  }
  if (condition.agentPreset && condition.agentPreset !== ctx.agentPreset) {
    return false
  }
  if (condition.timeRange) {
    const now = new Date()
    const [startH, startM] = condition.timeRange.start.split(':').map(Number)
    const [endH, endM] = condition.timeRange.end.split(':').map(Number)
    const currentMin = now.getHours() * 60 + now.getMinutes()
    const startMin = (startH || 0) * 60 + (startM || 0)
    const endMin = (endH || 23) * 60 + (endM || 59)
    if (currentMin < startMin || currentMin > endMin) return false
    if (condition.timeRange.weekdays?.length && !condition.timeRange.weekdays.includes(now.getDay())) {
      return false
    }
  }
  if (condition.messageKeyword) {
    const keyword = condition.messageKeyword.toLowerCase()
    if (!ctx.messageText.toLowerCase().includes(keyword)) return false
  }
  return true
}

export async function evaluateInjectionRules(ctx: InjectionContext): Promise<InjectionResult> {
  const f = await readFile()
  const enabledRules = f.rules.filter(r => r.enabled)
  const matched: InjectionRule[] = []

  for (const rule of enabledRules) {
    // Conditions are OR relationship — any condition matching triggers the rule
    const hit = rule.conditions.length === 0 || rule.conditions.some(c => matchesCondition(c, ctx))
    if (hit) matched.push(rule)
  }

  const merged: string[] = [...ctx.existingPackageIds]
  const applied: string[] = []

  for (const rule of matched) {
    const action = rule.action
    for (const pkgId of action.contextPackageIds) {
      if (action.deduplicate && merged.includes(pkgId)) continue
      if (action.injectPosition === 'prepend') {
        const idx = merged.indexOf(pkgId)
        if (idx !== -1) merged.splice(idx, 1)
        merged.unshift(pkgId)
      } else {
        if (!merged.includes(pkgId)) merged.push(pkgId)
      }
    }
    applied.push(rule.name)
  }

  return {
    matchedRuleIds: matched.map(r => r.id),
    mergedPackageIds: merged,
    appliedRules: applied,
  }
}
