import { memo } from 'react'
import type { WorkflowEdge as WorkflowEdgeType, WorkflowNode } from '../../types/platform-extensions'

interface WorkflowEdgeProps {
  edge: WorkflowEdgeType
  fromNode: WorkflowNode | undefined
  toNode: WorkflowNode | undefined
  isSelected: boolean
  onClick: (edgeId: string) => void
  NODE_WIDTH: number
  NODE_HEIGHT: number
}

function getNodeCenter(node: WorkflowNode | undefined, w: number, h: number): { x: number; y: number } {
  if (!node) return { x: 0, y: 0 }
  return {
    x: (node.position?.x ?? 0) + w / 2,
    y: (node.position?.y ?? 0) + h / 2,
  }
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  // Simple bezier curve
  const dx = Math.abs(x2 - x1) * 0.5
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export const WorkflowEdge = memo(function WorkflowEdge({
  edge,
  fromNode,
  toNode,
  isSelected,
  onClick,
  NODE_WIDTH,
  NODE_HEIGHT,
}: WorkflowEdgeProps) {
  const from = getNodeCenter(fromNode, NODE_WIDTH, NODE_HEIGHT)
  const to = getNodeCenter(toNode, NODE_WIDTH, NODE_HEIGHT)
  const d = edgePath(from.x, from.y, to.x, to.y)
  const edgeId = edge.id || `${edge.from}-${edge.to}`

  // Arrowhead marker
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const arrowLen = 10
  const arrowX = to.x - arrowLen * Math.cos(angle)
  const arrowY = to.y - arrowLen * Math.sin(angle)

  return (
    <g
      className={`wf-edge ${isSelected ? 'selected' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onClick(edgeId)
      }}
      style={{ cursor: 'pointer' }}
    >
      {/* Invisible wider path for easier clicking */}
      <path
        d={d}
        stroke="transparent"
        strokeWidth={12}
        fill="none"
      />
      {/* Visible path */}
      <path
        d={d}
        stroke={isSelected ? 'var(--accent-color)' : 'var(--border-color)'}
        strokeWidth={isSelected ? 2.5 : 1.5}
        fill="none"
        strokeDasharray={edge.conditionValue ? '6,4' : 'none'}
      />
      {/* Arrowhead */}
      <polygon
        points={`${to.x},${to.y} ${arrowX - 4 * Math.sin(angle)},${arrowY + 4 * Math.cos(angle)} ${arrowX + 4 * Math.sin(angle)},${arrowY - 4 * Math.cos(angle)}`}
        fill={isSelected ? 'var(--accent-color)' : 'var(--border-color)'}
      />
      {/* Condition label */}
      {edge.conditionValue && (
        <text
          x={(from.x + to.x) / 2}
          y={(from.y + to.y) / 2 - 6}
          fontSize={11}
          fill="var(--text-secondary)"
          textAnchor="middle"
        >
          {edge.conditionValue}
        </text>
      )}
      {/* Edge label */}
      {edge.label && !edge.conditionValue && (
        <text
          x={(from.x + to.x) / 2}
          y={(from.y + to.y) / 2 - 6}
          fontSize={11}
          fill="var(--text-secondary)"
          textAnchor="middle"
        >
          {edge.label}
        </text>
      )}
    </g>
  )
})
