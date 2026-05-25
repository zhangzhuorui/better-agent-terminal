import { useTranslation } from 'react-i18next'
import type { WorkflowNodeType } from '../../types/platform-extensions'
import { v4 as uuidv4 } from 'uuid'

interface WorkflowToolbarProps {
  onAddNode: (type: WorkflowNodeType) => void
  onRun: () => void
  onSave: () => void
  onValidate: () => void
  isRunning: boolean
}

const NODE_TYPE_ICONS: Record<WorkflowNodeType, string> = {
  start: '▶',
  agent: '✦',
  terminal: '⌘',
  wait: '⏱',
  condition: '◆',
  human: '👤',
  parallel: '⫯',
  join: '⫰',
  loop: '↻',
  mcp: '🔌',
  end: '■',
  send: '✉',
}

export function WorkflowToolbar({ onAddNode, onRun, onSave, onValidate, isRunning }: WorkflowToolbarProps) {
  const { t } = useTranslation()

  const nodeTypes: WorkflowNodeType[] = ['start', 'agent', 'terminal', 'wait', 'condition', 'human', 'parallel', 'join', 'loop', 'mcp', 'end']

  return (
    <div className="workflow-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {nodeTypes.map(type => {
          const labelKey = `platform.workflow.nodeType${type.charAt(0).toUpperCase() + type.slice(1)}` as const
          const label = t(labelKey)
          return (
            <button
              key={type}
              className="action-btn"
              title={`${t('platform.workflow.addNode')}: ${label}`}
              onClick={() => onAddNode(type)}
              style={{ fontSize: 12 }}
            >
              {NODE_TYPE_ICONS[type]} {label}
            </button>
          )
        })}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        <button className="action-btn" onClick={onValidate}>
          {t('platform.workflow.validate')}
        </button>
        <button className="action-btn" onClick={onSave}>
          {t('common.save')}
        </button>
        <button className="settings-save-btn" onClick={onRun} disabled={isRunning}>
          {isRunning ? t('platform.workflow.running') : t('platform.workflow.execute')}
        </button>
      </div>
    </div>
  )
}
