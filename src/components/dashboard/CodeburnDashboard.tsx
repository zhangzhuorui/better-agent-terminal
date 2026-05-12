import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CodeburnReport } from '../../types/codeburn'

interface Props {
  report: CodeburnReport
}

/* ─── Color tokens — harmonized with project accent-color via CSS vars ─── */
const C = {
  overview: 'var(--cb-panel-overview)',
  daily: 'var(--cb-panel-daily)',
  project: 'var(--cb-panel-project)',
  topSessions: 'var(--cb-panel-top)',
  activity: 'var(--cb-panel-activity)',
  model: 'var(--cb-panel-model)',
  tools: 'var(--cb-panel-tools)',
  shell: 'var(--cb-panel-shell)',
  mcp: 'var(--cb-panel-mcp)',
  dim: 'var(--text-secondary)',
} as const

const ACTIVITY_COLORS: Record<string, string> = {
  Coding: '#4a9fe0',
  Debugging: '#c06060',
  'Feature Dev': '#3da080',
  Refactoring: '#c4a030',
  Testing: '#7b7ec0',
  Exploration: '#3da898',
  Planning: '#5a90d0',
  Delegation: '#c4883b',
  'Git Ops': '#888888',
  'Build/Deploy': '#3da070',
  Conversation: '#777777',
  Brainstorming: '#b07098',
  General: '#666666',
}

/* ─── Reusable Panel ─── */
function Panel({
  title,
  borderColor,
  fullWidth = false,
  children,
}: {
  title: string
  borderColor: string
  fullWidth?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={`codeburn-panel ${fullWidth ? 'codeburn-panel--full' : ''}`}
      style={{ '--panel-border': borderColor } as React.CSSProperties}
    >
      {title && <div className="codeburn-panel-title" style={{ color: borderColor }}>{title}</div>}
      <div className="codeburn-panel-body">{children}</div>
    </div>
  )
}

/* ─── Horizontal gradient bar ─── */
function HBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0
  return (
    <div className="codeburn-hbar-track">
      <div className="codeburn-hbar" style={{ width: `${pct}%` }} />
    </div>
  )
}

/* ─── Overview ─── */
function Overview({ report }: { report: CodeburnReport }) {
  const { t } = useTranslation()
  const tok = report.overview.tokens
  return (
    <div className="codeburn-overview">
      <div className="codeburn-overview-brand">
        <span className="codeburn-brand-name">CodeBurn</span>
        <span className="codeburn-brand-period">{report.period}</span>
      </div>
      <div className="codeburn-overview-metrics">
        <div className="codeburn-metric">
          <span className="codeburn-metric-value codeburn-metric--gold">
            ${report.overview.cost.toFixed(2)}
          </span>
          <span className="codeburn-metric-label">{t('platform.codeburn.totalCost')}</span>
        </div>
        <div className="codeburn-metric">
          <span className="codeburn-metric-value">{report.overview.calls.toLocaleString()}</span>
          <span className="codeburn-metric-label">{t('platform.codeburn.totalCalls')}</span>
        </div>
        <div className="codeburn-metric">
          <span className="codeburn-metric-value">{report.overview.sessions}</span>
          <span className="codeburn-metric-label">{t('platform.codeburn.sessions')}</span>
        </div>
        <div className="codeburn-metric">
          <span className="codeburn-metric-value">{report.overview.cacheHitPercent.toFixed(1)}%</span>
          <span className="codeburn-metric-label">{t('platform.codeburn.cacheHit')}</span>
        </div>
      </div>
      <div className="codeburn-overview-tokens">
        {(tok.input + tok.output + tok.cacheRead + tok.cacheWrite) > 0 && (
          <>
            <span>{tok.input.toLocaleString()} {t('platform.codeburn.tokensIn')}</span>
            <span>{tok.output.toLocaleString()} {t('platform.codeburn.tokensOut')}</span>
            {tok.cacheRead > 0 && <span>{tok.cacheRead.toLocaleString()} {t('platform.codeburn.tokensCached')}</span>}
            {tok.cacheWrite > 0 && <span>{tok.cacheWrite.toLocaleString()} {t('platform.codeburn.tokensWritten')}</span>}
          </>
        )}
      </div>
    </div>
  )
}

/* ─── Daily Activity ─── */
function DailyActivity({ daily }: { daily: CodeburnReport['daily'] }) {
  const { t } = useTranslation()
  const maxCost = useMemo(() => Math.max(...daily.map(d => d.cost), 0.01), [daily])
  return (
    <div className="codeburn-daily-list">
      <div className="codeburn-daily-header">
        <span />
        <span>{t('platform.codeburn.col.cost')}</span>
        <span>{t('platform.codeburn.col.calls')}</span>
      </div>
      {daily.map(day => (
        <div key={day.date} className="codeburn-daily-row">
          <div className="codeburn-row-label-bar">
            <span className="codeburn-daily-date">{day.date.slice(5)}</span>
            <HBar value={day.cost} max={maxCost} />
          </div>
          <span className="codeburn-daily-cost">${day.cost.toFixed(2)}</span>
          <span className="codeburn-daily-calls">{day.calls}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── Project Breakdown ─── */
function ProjectBreakdown({ projects }: { projects: CodeburnReport['projects'] }) {
  const { t } = useTranslation()
  const maxCalls = useMemo(() => Math.max(...projects.map(p => p.calls), 1), [projects])
  return (
    <div className="codeburn-project-list">
      <div className="codeburn-project-header">
        <span />
        <span>{t('platform.codeburn.col.cost')}</span>
        <span>{t('platform.codeburn.col.calls')}</span>
      </div>
      {projects.map(p => {
        const displayName = p.name.split(/[/\\]/).pop() || p.name
        return (
          <div key={p.name} className="codeburn-project-row">
            <div className="codeburn-row-label-bar" title={p.path}>
              <span className="codeburn-project-name">{displayName}</span>
              <HBar value={p.calls} max={maxCalls} />
            </div>
            <span className="codeburn-project-cost">${p.cost.toFixed(2)}</span>
            <span className="codeburn-project-calls">{p.calls}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ─── Top Sessions ─── */
function TopSessions({ sessions }: { sessions: CodeburnReport['topSessions'] }) {
  const { t } = useTranslation()
  return (
    <div className="codeburn-top-sessions">
      <div className="codeburn-top-header">
        <span>{t('platform.codeburn.col.project')}</span>
        <span>{t('platform.codeburn.col.date')}</span>
        <span>{t('platform.codeburn.col.calls')}</span>
        <span>{t('platform.codeburn.col.cost')}</span>
      </div>
      {sessions.map(s => (
        <div key={s.sessionId} className="codeburn-top-row">
          <span className="codeburn-top-project" title={s.project}>
            {s.project.slice(0, 45)}{s.project.length > 45 ? '…' : ''}
          </span>
          <span className="codeburn-top-date">{s.date || '—'}</span>
          <span className="codeburn-top-calls">{s.calls}</span>
          <span className="codeburn-top-cost">${s.cost.toFixed(2)}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── Activity Breakdown ─── */
function ActivityBreakdown({ activities }: { activities: CodeburnReport['activities'] }) {
  const { t } = useTranslation()
  const maxTurns = useMemo(() => Math.max(...activities.map(a => a.turns), 1), [activities])
  return (
    <div className="codeburn-activity-list">
      <div className="codeburn-activity-header">
        <span />
        <span>{t('platform.codeburn.col.cost')}</span>
        <span>{t('platform.codeburn.col.turns')}</span>
        <span>{t('platform.codeburn.col.1shot')}</span>
      </div>
      {activities.map(act => {
        const color = ACTIVITY_COLORS[act.category] || C.dim
        return (
          <div key={act.category} className="codeburn-activity-row">
            <div className="codeburn-row-label-bar">
              <span className="codeburn-activity-name" style={{ color }}>
                {act.category}
              </span>
              <HBar value={act.turns} max={maxTurns} />
            </div>
            <span className="codeburn-activity-cost">${act.cost.toFixed(2)}</span>
            <span className="codeburn-activity-turns">{act.turns}</span>
            <span className="codeburn-activity-shot">
              {act.oneShotRate !== null ? `${Math.round(act.oneShotRate * 100)}%` : '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* ─── Model Breakdown ─── */
function ModelBreakdown({ models }: { models: CodeburnReport['models'] }) {
  const { t } = useTranslation()
  const maxCalls = useMemo(() => Math.max(...models.map(m => m.calls), 1), [models])
  return (
    <div className="codeburn-model-list">
      <div className="codeburn-model-header">
        <span />
        <span>{t('platform.codeburn.col.cost')}</span>
        <span>{t('platform.codeburn.col.cache')}</span>
        <span>{t('platform.codeburn.col.calls')}</span>
      </div>
      {models.map(m => (
        <div key={m.name} className="codeburn-model-row">
          <div className="codeburn-row-label-bar">
            <span className="codeburn-model-name">{m.name}</span>
            <HBar value={m.calls} max={maxCalls} />
          </div>
          <span className="codeburn-model-cost">${m.cost.toFixed(2)}</span>
          <span className="codeburn-model-cache">
            {m.cacheReadTokens > 0
              ? `${Math.round((m.cacheReadTokens / (m.inputTokens + m.cacheReadTokens || 1)) * 100)}%`
              : '—'}
          </span>
          <span className="codeburn-model-calls">{m.calls}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── Tool Breakdown ─── */
function ToolBreakdown({ tools }: { tools: CodeburnReport['tools'] }) {
  const { t } = useTranslation()
  const maxCalls = useMemo(() => Math.max(...tools.map(t => t.calls), 1), [tools])
  return (
    <div className="codeburn-tool-list">
      <div className="codeburn-tool-header">
        <span />
        <span>{t('platform.codeburn.col.calls')}</span>
      </div>
      {tools.map(tool => (
        <div key={tool.name} className="codeburn-tool-row">
          <div className="codeburn-row-label-bar">
            <span className="codeburn-tool-name">{tool.name}</span>
            <HBar value={tool.calls} max={maxCalls} />
          </div>
          <span className="codeburn-tool-calls">{tool.calls}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── Shell Breakdown ─── */
function ShellBreakdown({ commands }: { commands: CodeburnReport['shellCommands'] }) {
  const { t } = useTranslation()
  const maxCalls = useMemo(() => Math.max(...commands.map(c => c.calls), 1), [commands])
  return (
    <div className="codeburn-shell-list">
      <div className="codeburn-shell-header">
        <span />
        <span>{t('platform.codeburn.col.calls')}</span>
      </div>
      {commands.map(cmd => (
        <div key={cmd.name} className="codeburn-shell-row">
          <div className="codeburn-row-label-bar">
            <span className="codeburn-shell-name">{cmd.name}</span>
            <HBar value={cmd.calls} max={maxCalls} />
          </div>
          <span className="codeburn-shell-calls">{cmd.calls}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── MCP Breakdown ─── */
function McpBreakdown({ servers }: { servers: CodeburnReport['mcpServers'] }) {
  const { t } = useTranslation()
  if (servers.length === 0) {
    return <div className="codeburn-mcp-empty">{t('platform.codeburn.noMcp')}</div>
  }
  const maxCalls = Math.max(...servers.map(s => s.calls), 1)
  return (
    <div className="codeburn-mcp-list">
      <div className="codeburn-mcp-header">
        <span />
        <span>{t('platform.codeburn.col.calls')}</span>
      </div>
      {servers.map(s => (
        <div key={s.name} className="codeburn-mcp-row">
          <div className="codeburn-row-label-bar">
            <span className="codeburn-mcp-name">{s.name}</span>
            <HBar value={s.calls} max={maxCalls} />
          </div>
          <span className="codeburn-mcp-calls">{s.calls}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── Main Dashboard ─── */
export function CodeburnDashboard({ report }: Props) {
  const { t } = useTranslation()
  return (
    <div className="codeburn-dashboard">
      {/* Overview */}
      <Panel title="" borderColor={C.overview} fullWidth>
        <Overview report={report} />
      </Panel>

      {/* Row 1: Daily + Projects */}
      <div className="codeburn-row">
        <Panel title={t('platform.codeburn.dailyTrend')} borderColor={C.daily}>
          <DailyActivity daily={report.daily} />
        </Panel>
        <Panel title={t('platform.codeburn.projects')} borderColor={C.project}>
          <ProjectBreakdown projects={report.projects} />
        </Panel>
      </div>

      {/* Top Sessions */}
      <Panel title={t('platform.codeburn.topSessions')} borderColor={C.topSessions} fullWidth>
        <TopSessions sessions={report.topSessions} />
      </Panel>

      {/* Row 2: Activity + Model */}
      <div className="codeburn-row">
        <Panel title={t('platform.codeburn.activities')} borderColor={C.activity}>
          <ActivityBreakdown activities={report.activities} />
        </Panel>
        <Panel title={t('platform.codeburn.models')} borderColor={C.model}>
          <ModelBreakdown models={report.models} />
        </Panel>
      </div>

      {/* Row 3: Tools + Shell */}
      <div className="codeburn-row">
        <Panel title={t('platform.codeburn.tools')} borderColor={C.tools}>
          <ToolBreakdown tools={report.tools} />
        </Panel>
        <Panel title={t('platform.codeburn.shellCommands')} borderColor={C.shell}>
          <ShellBreakdown commands={report.shellCommands} />
        </Panel>
      </div>

      {/* MCP Servers */}
      <Panel title={t('platform.codeburn.mcpServers')} borderColor={C.mcp} fullWidth>
        <McpBreakdown servers={report.mcpServers} />
      </Panel>
    </div>
  )
}
