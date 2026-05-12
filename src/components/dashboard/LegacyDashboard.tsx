import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { PlatformAnalyticsSummary } from '../../types/platform-extensions'

interface Props {
  summary: PlatformAnalyticsSummary | null
  onRefresh: () => void
}

export function LegacyDashboard({ summary, onRefresh }: Props) {
  const { t } = useTranslation()

  const last7Days = useMemo(() => {
    const out: string[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      out.push(`${y}-${m}-${day}`)
    }
    return out
  }, [])

  return (
    <div className="platform-section">
      <p className="platform-muted">{t('platform.dashboard.hint')}</p>
      {summary && (
        <>
          <div className="platform-stat-grid">
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.userMessages')}</span>
              <span className="platform-stat-value">{summary.totals.userMessages}</span>
            </div>
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.autoMessages')}</span>
              <span className="platform-stat-value">{summary.totals.automationUserMessages}</span>
            </div>
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.agentTurns')}</span>
              <span className="platform-stat-value">{summary.totals.agentTurns}</span>
            </div>
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.inputTokens')}</span>
              <span className="platform-stat-value">{summary.totals.inputTokens.toLocaleString()}</span>
            </div>
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.outputTokens')}</span>
              <span className="platform-stat-value">{summary.totals.outputTokens.toLocaleString()}</span>
            </div>
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.costUsd')}</span>
              <span className="platform-stat-value">${summary.totals.costUsd.toFixed(4)}</span>
            </div>
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.autoRuns')}</span>
              <span className="platform-stat-value">{summary.totals.automationRuns}</span>
            </div>
            <div className="platform-stat-card">
              <span className="platform-stat-label">{t('platform.dashboard.autoFails')}</span>
              <span className="platform-stat-value">{summary.totals.automationFailures}</span>
            </div>
          </div>
          <h3 className="platform-subhead">{t('platform.dashboard.last7')}</h3>
          <div className="platform-table-wrap">
            <table className="platform-table">
              <thead>
                <tr>
                  <th>{t('platform.dashboard.col.date')}</th>
                  <th>{t('platform.dashboard.col.userMsg')}</th>
                  <th>{t('platform.dashboard.col.turns')}</th>
                  <th>{t('platform.dashboard.col.tokens')}</th>
                  <th>{t('platform.dashboard.col.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {last7Days.map(day => {
                  const row = summary.byDay[day]
                  return (
                    <tr key={day}>
                      <td>{day}</td>
                      <td>{row ? row.userMessages + row.automationUserMessages : 0}</td>
                      <td>{row?.agentTurns ?? 0}</td>
                      <td>{row ? (row.inputTokens + row.outputTokens).toLocaleString() : 0}</td>
                      <td>{row ? `$${row.costUsd.toFixed(4)}` : '$0'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="platform-dashboard-actions">
        <button type="button" className="settings-save-btn" onClick={onRefresh}>
          {t('platform.dashboard.refresh')}
        </button>
      </div>
    </div>
  )
}
