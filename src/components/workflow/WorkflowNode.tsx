import { memo } from 'react'
import type { WorkflowNode as WorkflowNodeType, WorkflowNodeExecutionStatus } from '../../types/platform-extensions'
import { getAgentPreset } from '../../types/agent-presets'

interface WorkflowNodeProps {
  node: WorkflowNodeType
  isSelected: boolean
  executionStatus?: WorkflowNodeExecutionStatus
  onMouseDown: (e: React.MouseEvent, nodeId: string) => void
  onClick: (e: React.MouseEvent, nodeId: string) => void
  onAnchorMouseDown: (e: React.MouseEvent, nodeId: string, anchor: 'top' | 'right' | 'bottom' | 'left') => void
  onAnchorMouseUp: (e: React.MouseEvent, nodeId: string, anchor: 'top' | 'right' | 'bottom' | 'left') => void
  NODE_WIDTH: number
  NODE_HEIGHT: number
}

const STATUS_DOT: Record<WorkflowNodeExecutionStatus, string> = {
  pending: '○',
  queued: '○',
  running: '●',
  waiting_agent: '◐',
  waiting_human: '◐',
  waiting_event: '◐',
  completed: '✓',
  failed: '✗',
  skipped: '⊘',
  timeout: '⊘',
  cancelled: '⊘',
}

export const WorkflowNode = memo(function WorkflowNode({
  node,
  isSelected,
  executionStatus,
  onMouseDown,
  onClick,
  onAnchorMouseDown,
  onAnchorMouseUp,
  NODE_WIDTH,
  NODE_HEIGHT,
}: WorkflowNodeProps) {
  const preset = getAgentPreset(node.agentPreset || 'none')
  const status = executionStatus || 'pending'
  const dot = STATUS_DOT[status]
  const x = node.position?.x ?? 0
  const y = node.position?.y ?? 0

  return (
    <g
      transform={`translate(${x}, ${y})`}
      className={`wf-node ${isSelected ? 'selected' : ''} ${status}`}
      onMouseDown={(e) => onMouseDown(e, node.id)}
      onClick={(e) => onClick(e, node.id)}
      style={{ cursor: 'grab' }}
    >
      {/* Background */}
      <rect
        className="wf-node-bg"
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={8}
        fill={isSelected ? 'var(--bg-tertiary)' : 'var(--bg-secondary)'}
        stroke={isSelected ? 'var(--accent-color)' : 'var(--border-color)'}
        strokeWidth={isSelected ? 2 : 1}
      />

      {/* Agent color accent bar */}
      <rect
        className="wf-node-accent"
        width={NODE_WIDTH}
        height={4}
        rx={2}
        fill={preset?.color || 'var(--border-color)'}
      />

      {/* Icon */}
      <text
        className="wf-node-icon"
        x={12}
        y={28}
        fontSize={14}
        fill="var(--text-primary)"
      >
        {preset?.icon || '⌘'}
      </text>

      {/* Label */}
      <text
        className="wf-node-label"
        x={32}
        y={28}
        fontSize={13}
        fontWeight={500}
        fill="var(--text-primary)"
      >
        {node.label || node.type}
      </text>

      {/* Agent name */}
      <text
        className="wf-node-preset"
        x={12}
        y={50}
        fontSize={11}
        fill="var(--text-secondary)"
      >
        {preset?.name || node.type}
      </text>

      {/* Status indicator */}
      <text
        className={`wf-node-status ${status}`}
        x={NODE_WIDTH - 16}
        y={20}
        fontSize={14}
        textAnchor="middle"
      >
        {dot}
      </text>

      {/* Connection anchors */}
      {(['top', 'right', 'bottom', 'left'] as const).map((anchor) => {
        const cx = anchor === 'left' ? 0 : anchor === 'right' ? NODE_WIDTH : NODE_WIDTH / 2
        const cy = anchor === 'top' ? 0 : anchor === 'bottom' ? NODE_HEIGHT : NODE_HEIGHT / 2
        return (
          <circle
            key={anchor}
            className="wf-anchor"
            cx={cx}
            cy={cy}
            r={5}
            fill="var(--bg-tertiary)"
            stroke="var(--border-color)"
            strokeWidth={1}
            style={{ cursor: 'crosshair' }}
            onMouseDown={(e) => onAnchorMouseDown(e, node.id, anchor)}
            onMouseUp={(e) => onAnchorMouseUp(e, node.id, anchor)}
          />
        )
      })}
    </g>
  )
})
