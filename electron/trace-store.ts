import { app } from 'electron'
import * as path from 'path'
import Database from 'better-sqlite3'
import { logger } from './logger'

const DB_FILE = 'traces.db'

export interface AgentTrace {
  id: string
  sessionId: string
  terminalId: string
  rootTraceId: string
  parentTraceId?: string
  type: 'turn' | 'tool_call' | 'tool_result' | 'thinking' | 'subagent' | 'message'
  name: string
  status: 'started' | 'completed' | 'error'
  startedAt: number
  endedAt?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  metadata?: string // JSON string
}

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), DB_FILE)
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        root_trace_id TEXT NOT NULL,
        parent_trace_id TEXT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd REAL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
      CREATE INDEX IF NOT EXISTS idx_traces_terminal ON traces(terminal_id);
      CREATE INDEX IF NOT EXISTS idx_traces_root ON traces(root_trace_id);
      CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at);
    `)
    logger.log('[trace-store] SQLite initialized')
  }
  return db
}

export function insertTrace(trace: AgentTrace): void {
  try {
    const d = getDb()
    d.prepare(`
      INSERT INTO traces (id, session_id, terminal_id, root_trace_id, parent_trace_id, type, name, status, started_at, ended_at, duration_ms, input_tokens, output_tokens, cost_usd, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.id,
      trace.sessionId,
      trace.terminalId,
      trace.rootTraceId,
      trace.parentTraceId ?? null,
      trace.type,
      trace.name,
      trace.status,
      trace.startedAt,
      trace.endedAt ?? null,
      trace.durationMs ?? null,
      trace.inputTokens ?? null,
      trace.outputTokens ?? null,
      trace.costUsd ?? null,
      trace.metadata ? JSON.stringify(trace.metadata) : null
    )
  } catch (e) {
    logger.log(`[trace-store] insert error: ${e}`)
  }
}

export function updateTraceStatus(id: string, status: AgentTrace['status'], endedAt?: number, durationMs?: number, meta?: Partial<Pick<AgentTrace, 'inputTokens' | 'outputTokens' | 'costUsd'>>): void {
  try {
    const d = getDb()
    d.prepare(`
      UPDATE traces SET status = ?, ended_at = ?, duration_ms = ?, input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens), cost_usd = COALESCE(?, cost_usd)
      WHERE id = ?
    `).run(status, endedAt ?? null, durationMs ?? null, meta?.inputTokens ?? null, meta?.outputTokens ?? null, meta?.costUsd ?? null, id)
  } catch (e) {
    logger.log(`[trace-store] update error: ${e}`)
  }
}

export interface TraceQuery {
  sessionId?: string
  terminalId?: string
  rootTraceId?: string
  limit?: number
  offset?: number
}

export function queryTraces(q: TraceQuery): AgentTrace[] {
  try {
    const d = getDb()
    const conditions: string[] = []
    const params: unknown[] = []
    if (q.sessionId) { conditions.push('session_id = ?'); params.push(q.sessionId) }
    if (q.terminalId) { conditions.push('terminal_id = ?'); params.push(q.terminalId) }
    if (q.rootTraceId) { conditions.push('root_trace_id = ?'); params.push(q.rootTraceId) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = q.limit ?? 500
    const offset = q.offset ?? 0
    const rows = d.prepare(`SELECT * FROM traces ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[]
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      terminalId: r.terminal_id,
      rootTraceId: r.root_trace_id,
      parentTraceId: r.parent_trace_id ?? undefined,
      type: r.type,
      name: r.name,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      inputTokens: r.input_tokens ?? undefined,
      outputTokens: r.output_tokens ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      metadata: r.metadata ?? undefined,
    }))
  } catch (e) {
    logger.log(`[trace-store] query error: ${e}`)
    return []
  }
}

export function getTraceStats(sessionId: string): { totalTurns: number; totalDurationMs: number; totalCostUsd: number; toolCalls: number } {
  try {
    const d = getDb()
    const row = d.prepare(`
      SELECT COUNT(*) as turns, COALESCE(SUM(duration_ms), 0) as duration, COALESCE(SUM(cost_usd), 0) as cost,
        SUM(CASE WHEN type = 'tool_call' THEN 1 ELSE 0 END) as tools
      FROM traces WHERE session_id = ? AND type IN ('turn', 'tool_call')
    `).get(sessionId) as any
    return {
      totalTurns: row.turns ?? 0,
      totalDurationMs: row.duration ?? 0,
      totalCostUsd: row.cost ?? 0,
      toolCalls: row.tools ?? 0,
    }
  } catch (e) {
    logger.log(`[trace-store] stats error: ${e}`)
    return { totalTurns: 0, totalDurationMs: 0, totalCostUsd: 0, toolCalls: 0 }
  }
}

export function trimOldTraces(keepDays = 90): void {
  try {
    const d = getDb()
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    const result = d.prepare('DELETE FROM traces WHERE started_at < ?').run(cutoff)
    logger.log(`[trace-store] trimmed ${result.changes} old traces`)
  } catch (e) {
    logger.log(`[trace-store] trim error: ${e}`)
  }
}
