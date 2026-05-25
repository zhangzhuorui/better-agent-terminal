import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkflowExecution } from '../../types/platform-extensions'

interface WorkflowExecOverlayProps {
  execution: WorkflowExecution
}

export const WorkflowExecOverlay = memo(function WorkflowExecOverlay({ execution }: WorkflowExecOverlayProps) {
  const { t } = useTranslation()
  const totalNodes = Object.keys(execution.nodeStates).length
  const completedNodes = Object.values(execution.nodeStates).filter(
    s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped' || s.status === 'cancelled'
  ).length
  const progress = totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0

  const statusClass = execution.status === 'running' ? 'running'
    : execution.status === 'completed' ? 'completed'
    : execution.status === 'failed' ? 'failed'
    : ''

  return (
    <div className="workflow-exec-overlay">
      <span className={`exec-status ${statusClass}`}>
        {execution.status.toUpperCase()}
      </span>
      <span className="platform-muted">
        {completedNodes} / {totalNodes} {t('platform.workflow.nodes')}
      </span>
      <div className="exec-progress">
        <div
          className="exec-progress-bar"
          style={{ width: `${progress}%` }}
        />
      </div>
      {execution.error && (
        <span className="exec-error-text">
          {execution.error}
        </span>
      )}
    </div>
  )
})
