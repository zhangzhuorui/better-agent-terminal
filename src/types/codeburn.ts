export interface CodeburnReport {
  generated: string
  currency: string
  period: string
  periodKey: string
  overview: {
    cost: number
    calls: number
    sessions: number
    cacheHitPercent: number
    tokens: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
  }
  daily: Array<{
    date: string
    cost: number
    calls: number
  }>
  projects: Array<{
    name: string
    path: string
    cost: number
    avgCostPerSession: number | null
    calls: number
    sessions: number
  }>
  models: Array<{
    name: string
    calls: number
    cost: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }>
  activities: Array<{
    category: string
    cost: number
    turns: number
    editTurns: number
    oneShotTurns: number
    oneShotRate: number | null
  }>
  tools: Array<{ name: string; calls: number }>
  mcpServers: Array<{ name: string; calls: number }>
  shellCommands: Array<{ name: string; calls: number }>
  topSessions: Array<{
    project: string
    sessionId: string
    date: string | null
    cost: number
    calls: number
  }>
  plan?: {
    id: string
    budget: number
    spent: number
    percentUsed: number
    status: 'under' | 'near' | 'over'
    projectedMonthEnd: number
    daysUntilReset: number
    periodStart: string
    periodEnd: string
  }
}

export interface CodeburnError {
  error: string
  available: boolean
}

export type CodeburnPeriod = 'today' | 'week' | 'month' | '30days'
