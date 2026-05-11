import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { logger } from './logger'

const DIR = 'audit-logs'

export type ActionCategory = 'file_read' | 'file_write' | 'bash' | 'git' | 'network' | 'db' | 'other'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface AgentAction {
  id: string
  traceId?: string
  sessionId: string
  terminalId: string
  timestamp: number
  category: ActionCategory
  toolName: string
  description: string
  riskLevel: RiskLevel
  riskReasons: string[]
  autoApproved: boolean
  approvedBy?: 'user' | 'plan_mode' | 'bypass'
  payload?: Record<string, unknown>
}

export interface SecurityReport {
  period: { start: number; end: number }
  totalActions: number
  byCategory: Record<string, number>
  byRiskLevel: Record<string, number>
  highRiskActions: AgentAction[]
  autoApprovalRate: number
  securityScore: number
}

function auditDir(): string {
  return path.join(app.getPath('userData'), DIR)
}

function dailyFileName(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}.jsonl`
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(auditDir(), { recursive: true })
}

export async function appendAction(action: AgentAction): Promise<void> {
  await ensureDir()
  const file = path.join(auditDir(), dailyFileName())
  const line = JSON.stringify(action) + '\n'
  await fs.appendFile(file, line, 'utf-8')
}

// Risk detection rules
const HIGH_RISK_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /rm\s+-rf/i, reason: 'Dangerous recursive deletion' },
  { pattern: /sudo\s/i, reason: 'Elevated privilege execution' },
  { pattern: /chmod\s+777/i, reason: 'Overly permissive file permissions' },
  { pattern: /curl\s+.*\|.*sh/i, reason: 'Piped shell execution from network' },
  { pattern: /wget\s+.*\|.*sh/i, reason: 'Piped shell execution from network' },
  { pattern: /eval\s*\(/i, reason: 'Dynamic code evaluation' },
  { pattern: /\bdd\s+if=/i, reason: 'Raw disk operation' },
  { pattern: /mkfs\./i, reason: 'Filesystem formatting' },
  { pattern: /\blsof\b.*-i\b/i, reason: 'Network connection enumeration' },
]

const CRITICAL_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(rm\s+-rf\s+\/|rm\s+-rf\s+~\/\.)/i, reason: 'Potential home or root deletion' },
  { pattern: /\b(sudo\s+rm|sudo\s+dd|sudo\s+mkfs)/i, reason: 'Elevated destructive command' },
  { pattern: /\b(cat|less|more|head|tail|grep)\s+.*\.env/i, reason: 'Accessing environment secrets file' },
  { pattern: /\b(cat|less|more|head|tail|grep)\s+.*\.ssh\//i, reason: 'Accessing SSH keys directory' },
  { pattern: /\b(cat|less|more|head|tail|grep)\s+.*id_rsa/i, reason: 'Accessing private key' },
  { pattern: /\b(cat|less|more|head|tail)\s+.*\.bashrc|\.(zshrc|bash_profile|profile)/i, reason: 'Accessing shell profile' },
  { pattern: /\bcurl\s+.*-d\s+.*\.env/i, reason: 'Sending environment data externally' },
  { pattern: /\bwget\s+.*-post-data.*\.env/i, reason: 'Sending environment data externally' },
]

const SENSITIVE_PATHS = ['.env', '.ssh', '.aws', '.docker', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', '.bashrc', '.zshrc', '.bash_profile']

function detectRiskLevel(toolName: string, payload: Record<string, unknown> | undefined): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = []
  let level: RiskLevel = 'low'

  const text = JSON.stringify(payload).toLowerCase()
  const cmd = String(payload?.command || payload?.cmd || payload?.shell || '').toLowerCase()
  const filePath = String(payload?.path || payload?.file || payload?.filepath || '').toLowerCase()

  // Category-based baseline
  if (toolName === 'Bash' || toolName === 'bash') {
    level = 'medium'
    reasons.push('Shell command execution')
  } else if (toolName === 'Edit' || toolName === 'Write') {
    level = 'medium'
    reasons.push('File modification')
  } else if (toolName === 'Read') {
    level = 'low'
  }

  // Command pattern checks
  for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
    if (pattern.test(cmd)) {
      level = 'high'
      reasons.push(reason)
    }
  }

  for (const { pattern, reason } of CRITICAL_PATTERNS) {
    if (pattern.test(cmd) || pattern.test(filePath)) {
      level = 'critical'
      reasons.push(reason)
    }
  }

  // Sensitive path access
  for (const sp of SENSITIVE_PATHS) {
    if (filePath.includes(sp.toLowerCase())) {
      if (level === 'low') level = 'medium'
      reasons.push(`Accessing sensitive path: ${sp}`)
    }
  }

  // Network indicators
  if (/https?:\/\//i.test(text) && (toolName === 'Bash' || toolName === 'bash')) {
    if (level !== 'critical') level = 'high'
    reasons.push('Network request from shell')
  }

  return { level: reasons.length ? level : 'low', reasons: reasons.length ? reasons : ['No risk indicators'] }
}

export function classifyAction(
  toolName: string,
  payload: Record<string, unknown> | undefined,
  sessionId: string,
  terminalId: string,
  traceId: string | undefined,
  autoApproved: boolean,
  approvedBy?: AgentAction['approvedBy']
): AgentAction {
  const { level, reasons } = detectRiskLevel(toolName, payload)

  let category: ActionCategory = 'other'
  if (toolName === 'Read' || toolName === 'read') category = 'file_read'
  else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'write') category = 'file_write'
  else if (toolName === 'Bash' || toolName === 'bash') category = 'bash'
  else if (toolName === 'Git' || toolName === 'git') category = 'git'

  const description = payload?.command
    ? String(payload.command).slice(0, 200)
    : payload?.path
      ? `${toolName} ${String(payload.path).slice(0, 200)}`
      : `${toolName} (${JSON.stringify(payload).slice(0, 200)})`

  // Sanitize payload for storage
  const safePayload: Record<string, unknown> = {}
  if (payload) {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.length > 500) {
        safePayload[k] = v.slice(0, 500) + '...'
      } else {
        safePayload[k] = v
      }
    }
  }

  return {
    id: randomUUID(),
    traceId,
    sessionId,
    terminalId,
    timestamp: Date.now(),
    category,
    toolName,
    description,
    riskLevel: level,
    riskReasons: reasons,
    autoApproved,
    approvedBy,
    payload: safePayload,
  }
}

export async function getSecurityReport(days = 7): Promise<SecurityReport> {
  const end = Date.now()
  const start = end - days * 24 * 60 * 60 * 1000
  const actions: AgentAction[] = []

  try {
    await ensureDir()
    const files = await fs.readdir(auditDir())
    for (const file of files.filter(f => f.endsWith('.jsonl')).sort()) {
      const raw = await fs.readFile(path.join(auditDir(), file), 'utf-8')
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const action = JSON.parse(line) as AgentAction
          if (action.timestamp >= start && action.timestamp <= end) {
            actions.push(action)
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch {
    // no audit logs yet
  }

  const byCategory: Record<string, number> = {}
  const byRiskLevel: Record<string, number> = {}
  let autoApprovedCount = 0

  for (const a of actions) {
    byCategory[a.category] = (byCategory[a.category] || 0) + 1
    byRiskLevel[a.riskLevel] = (byRiskLevel[a.riskLevel] || 0) + 1
    if (a.autoApproved) autoApprovedCount++
  }

  const highRiskActions = actions.filter(a => a.riskLevel === 'high' || a.riskLevel === 'critical').slice(0, 50)
  const autoApprovalRate = actions.length ? autoApprovedCount / actions.length : 0

  // Security score: 100 - penalties
  let score = 100
  score -= (byRiskLevel['critical'] || 0) * 20
  score -= (byRiskLevel['high'] || 0) * 10
  score -= (byRiskLevel['medium'] || 0) * 2
  score -= Math.round(autoApprovalRate * 20)
  score = Math.max(0, Math.min(100, score))

  return {
    period: { start, end },
    totalActions: actions.length,
    byCategory,
    byRiskLevel,
    highRiskActions,
    autoApprovalRate,
    securityScore: score,
  }
}

export async function trimOldAuditLogs(keepDays = 90): Promise<void> {
  try {
    const files = await fs.readdir(auditDir())
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      // File name format: YYYY-MM-DD.jsonl
      const dayStr = file.replace('.jsonl', '')
      const ts = new Date(dayStr).getTime()
      if (ts < cutoff) {
        await fs.unlink(path.join(auditDir(), file))
      }
    }
    logger.log(`[audit-engine] trimmed old audit logs`)
  } catch (e) {
    logger.log(`[audit-engine] trim error: ${e}`)
  }
}
