import { useCallback, useEffect, useRef } from 'react'
import type { WorkflowDefinition, WorkflowExecution } from '../../types/platform-extensions'
import { useWorkflowCanvas } from './useWorkflowCanvas'
import { WorkflowNode } from './WorkflowNode'
import { WorkflowEdge } from './WorkflowEdge'
import { WorkflowExecOverlay } from './WorkflowExecOverlay'

interface WorkflowCanvasProps {
  workflow: WorkflowDefinition
  execution?: WorkflowExecution | null
  onChange: (updates: Partial<WorkflowDefinition>) => void
  onNodeSelect: (nodeId: string | null) => void
  onEdgeSelect: (edgeId: string | null) => void
}

export function WorkflowCanvas({ workflow, execution, onChange, onNodeSelect, onEdgeSelect }: WorkflowCanvasProps) {
  const {
    svgRef,
    state,
    setState,
    addNode,
    updateNode,
    removeNode,
    addEdge,
    removeEdge,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel,
    onNodeMouseDown,
    onNodeClick,
    onAnchorMouseDown,
    onAnchorMouseUp,
    NODE_WIDTH,
    NODE_HEIGHT,
  } = useWorkflowCanvas(workflow.nodes, workflow.edges)

  // Sync dragged positions back to parent when drag ends
  const prevDraggingRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevDraggingRef.current && !state.draggingNodeId) {
      onChange({ nodes: state.nodes })
    }
    prevDraggingRef.current = state.draggingNodeId
  }, [state.draggingNodeId, state.nodes, onChange])

  // Sync canvas nodes/edges back to parent when they change
  const handleRemoveNode = useCallback((nodeId: string) => {
    removeNode(nodeId)
    onChange({
      nodes: state.nodes.filter(n => n.id !== nodeId),
      edges: state.edges.filter(e => e.from !== nodeId && e.to !== nodeId),
    })
    onNodeSelect(null)
  }, [removeNode, state.nodes, state.edges, onChange, onNodeSelect])

  const handleRemoveEdge = useCallback((edgeId: string) => {
    removeEdge(edgeId)
    onChange({
      edges: state.edges.filter(e => (e.id || `${e.from}-${e.to}`) !== edgeId),
    })
    onEdgeSelect(null)
  }, [removeEdge, state.edges, onChange, onEdgeSelect])

  const handleNodeClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    onNodeClick(e, nodeId)
    onNodeSelect(nodeId)
    onEdgeSelect(null)
  }, [onNodeClick, onNodeSelect, onEdgeSelect])

  const handleEdgeClick = useCallback((edgeId: string) => {
    setState(prev => ({
      ...prev,
      selectedEdgeId: edgeId,
      selectedNodeIds: [],
      connectingFrom: null,
    }))
    onEdgeSelect(edgeId)
    onNodeSelect(null)
  }, [setState, onEdgeSelect, onNodeSelect])

  // Keyboard delete
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedNodeIds.length > 0) {
        handleRemoveNode(state.selectedNodeIds[0])
      } else if (state.selectedEdgeId) {
        handleRemoveEdge(state.selectedEdgeId)
      }
    }
  }, [state.selectedNodeIds, state.selectedEdgeId, handleRemoveNode, handleRemoveEdge])

  return (
    <div
      className="workflow-canvas"
      style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative', outline: 'none' }}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {execution && execution.status === 'running' && (
        <WorkflowExecOverlay execution={execution} />
      )}
      <svg
        ref={svgRef}
        className="workflow-svg"
        style={{ width: '100%', height: '100%', cursor: state.isPanning ? 'grabbing' : 'default' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      >
        <g transform={`translate(${state.viewport.x}, ${state.viewport.y}) scale(${state.viewport.zoom})`}>
          {/* Grid background */}
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--border-color)" strokeWidth={0.5} strokeOpacity={0.3} />
          </pattern>
          <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#grid)" />

          {/* Edges */}
          {state.edges.map(edge => {
            const edgeId = edge.id || `${edge.from}-${edge.to}`
            return (
              <WorkflowEdge
                key={edgeId}
                edge={edge}
                fromNode={state.nodes.find(n => n.id === edge.from)}
                toNode={state.nodes.find(n => n.id === edge.to)}
                isSelected={state.selectedEdgeId === edgeId}
                onClick={handleEdgeClick}
                NODE_WIDTH={NODE_WIDTH}
                NODE_HEIGHT={NODE_HEIGHT}
              />
            )
          })}

          {/* Connecting line */}
          {state.connectingFrom && (
            <ConnectingLine
              fromNode={state.nodes.find(n => n.id === state.connectingFrom!.nodeId)}
              anchor={state.connectingFrom.anchor}
              NODE_WIDTH={NODE_WIDTH}
              NODE_HEIGHT={NODE_HEIGHT}
            />
          )}

          {/* Nodes */}
          {state.nodes.map(node => (
            <WorkflowNode
              key={node.id}
              node={node}
              isSelected={state.selectedNodeIds.includes(node.id)}
              executionStatus={execution?.nodeStates[node.id]?.status}
              onMouseDown={onNodeMouseDown}
              onClick={handleNodeClick}
              onAnchorMouseDown={onAnchorMouseDown}
              onAnchorMouseUp={onAnchorMouseUp}
              NODE_WIDTH={NODE_WIDTH}
              NODE_HEIGHT={NODE_HEIGHT}
            />
          ))}
        </g>
      </svg>
    </div>
  )
}

function ConnectingLine({
  fromNode,
  anchor,
  NODE_WIDTH,
  NODE_HEIGHT,
}: {
  fromNode: WorkflowDefinition['nodes'][number] | undefined
  anchor: 'top' | 'right' | 'bottom' | 'left'
  NODE_WIDTH: number
  NODE_HEIGHT: number
}) {
  if (!fromNode) return null
  const x = (fromNode.position?.x ?? 0) + (anchor === 'left' ? 0 : anchor === 'right' ? NODE_WIDTH : NODE_WIDTH / 2)
  const y = (fromNode.position?.y ?? 0) + (anchor === 'top' ? 0 : anchor === 'bottom' ? NODE_HEIGHT : NODE_HEIGHT / 2)
  return (
    <line
      x1={x}
      y1={y}
      x2={x + 100}
      y2={y + 100}
      stroke="var(--accent-color)"
      strokeWidth={1.5}
      strokeDasharray="4,4"
      pointerEvents="none"
    />
  )
}
