import { useState, useCallback, useRef, useEffect } from 'react'
import type { WorkflowNode, WorkflowEdge, WorkflowNodePosition } from '../../types/platform-extensions'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasState {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  viewport: Viewport
  selectedNodeIds: string[]
  selectedEdgeId: string | null
  draggingNodeId: string | null
  connectingFrom: { nodeId: string; anchor: 'top' | 'right' | 'bottom' | 'left' } | null
  isPanning: boolean
}

const NODE_WIDTH = 200
const NODE_HEIGHT = 80

function screenToCanvas(screenX: number, screenY: number, viewport: Viewport): WorkflowNodePosition {
  return {
    x: (screenX - viewport.x) / viewport.zoom,
    y: (screenY - viewport.y) / viewport.zoom,
  }
}

function canvasToScreen(x: number, y: number, viewport: Viewport): { x: number; y: number } {
  return {
    x: x * viewport.zoom + viewport.x,
    y: y * viewport.zoom + viewport.y,
  }
}

function getAnchorPoint(node: WorkflowNode, anchor: 'top' | 'right' | 'bottom' | 'left'): WorkflowNodePosition {
  const x = node.position?.x ?? 0
  const y = node.position?.y ?? 0
  switch (anchor) {
    case 'top': return { x: x + NODE_WIDTH / 2, y }
    case 'right': return { x: x + NODE_WIDTH, y: y + NODE_HEIGHT / 2 }
    case 'bottom': return { x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT }
    case 'left': return { x, y: y + NODE_HEIGHT / 2 }
  }
}

function buildNodeSignature(nodes: WorkflowNode[]): string {
  return nodes.map(n => `${n.id}:${n.type}:${n.label || ''}`).join('|')
}

function buildEdgeSignature(edges: WorkflowEdge[]): string {
  return edges.map(e => `${e.id || e.from + '-' + e.to}:${e.label || ''}:${e.conditionValue || ''}`).join('|')
}

export function useWorkflowCanvas(initialNodes: WorkflowNode[], initialEdges: WorkflowEdge[]) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [state, setState] = useState<CanvasState>({
    nodes: initialNodes,
    edges: initialEdges,
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedNodeIds: [],
    selectedEdgeId: null,
    draggingNodeId: null,
    connectingFrom: null,
    isPanning: false,
  })

  // Sync external prop changes into internal state while preserving dragged positions
  const prevNodeSig = useRef(buildNodeSignature(initialNodes))
  const prevEdgeSig = useRef(buildEdgeSignature(initialEdges))

  useEffect(() => {
    const nodeSig = buildNodeSignature(initialNodes)
    const edgeSig = buildEdgeSignature(initialEdges)
    if (nodeSig === prevNodeSig.current && edgeSig === prevEdgeSig.current) return

    prevNodeSig.current = nodeSig
    prevEdgeSig.current = edgeSig

    setState(prev => {
      // Merge external nodes with internal positions
      const mergedNodes = initialNodes.map(n => {
        const existing = prev.nodes.find(pn => pn.id === n.id)
        return existing
          ? { ...n, position: existing.position }
          : n
      })
      return {
        ...prev,
        nodes: mergedNodes,
        edges: initialEdges,
      }
    })
  }, [initialNodes, initialEdges])

  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef({ x: 0, y: 0, viewportX: 0, viewportY: 0 })

  const setNodes = useCallback((updater: WorkflowNode[] | ((prev: WorkflowNode[]) => WorkflowNode[])) => {
    setState(prev => ({
      ...prev,
      nodes: typeof updater === 'function' ? updater(prev.nodes) : updater,
    }))
  }, [])

  const setEdges = useCallback((updater: WorkflowEdge[] | ((prev: WorkflowEdge[]) => WorkflowEdge[])) => {
    setState(prev => ({
      ...prev,
      edges: typeof updater === 'function' ? updater(prev.edges) : updater,
    }))
  }, [])

  const addNode = useCallback((node: WorkflowNode) => {
    setState(prev => ({
      ...prev,
      nodes: [...prev.nodes, node],
      selectedNodeIds: [node.id],
    }))
  }, [])

  const updateNode = useCallback((nodeId: string, updates: Partial<WorkflowNode>) => {
    setState(prev => ({
      ...prev,
      nodes: prev.nodes.map(n => n.id === nodeId ? { ...n, ...updates } : n),
    }))
  }, [])

  const removeNode = useCallback((nodeId: string) => {
    setState(prev => ({
      ...prev,
      nodes: prev.nodes.filter(n => n.id !== nodeId),
      edges: prev.edges.filter(e => e.from !== nodeId && e.to !== nodeId),
      selectedNodeIds: prev.selectedNodeIds.filter(id => id !== nodeId),
    }))
  }, [])

  const addEdge = useCallback((edge: WorkflowEdge) => {
    setState(prev => {
      // Prevent duplicate edges
      if (prev.edges.some(e => e.from === edge.from && e.to === edge.to)) return prev
      return { ...prev, edges: [...prev.edges, edge], connectingFrom: null }
    })
  }, [])

  const removeEdge = useCallback((edgeId: string) => {
    setState(prev => ({
      ...prev,
      edges: prev.edges.filter(e => (e.id || `${e.from}-${e.to}`) !== edgeId),
      selectedEdgeId: prev.selectedEdgeId === edgeId ? null : prev.selectedEdgeId,
    }))
  }, [])

  // Mouse event handlers
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const screenX = e.clientX - rect.left
    const screenY = e.clientY - rect.top

    // Click on blank canvas = start panning or deselect
    if ((e.target as Element).tagName === 'svg') {
      setState(prev => ({
        ...prev,
        isPanning: true,
        selectedNodeIds: [],
        selectedEdgeId: null,
        connectingFrom: null,
      }))
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        viewportX: state.viewport.x,
        viewportY: state.viewport.y,
      }
      return
    }
  }, [state.viewport])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const svg = svgRef.current
    if (!svg) return

    if (state.isPanning) {
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      setState(prev => ({
        ...prev,
        viewport: {
          ...prev.viewport,
          x: panStartRef.current.viewportX + dx,
          y: panStartRef.current.viewportY + dy,
        },
      }))
      return
    }

    if (state.draggingNodeId) {
      const canvasPos = screenToCanvas(e.clientX, e.clientY, state.viewport)
      setState(prev => ({
        ...prev,
        nodes: prev.nodes.map(n => {
          if (n.id !== state.draggingNodeId) return n
          return {
            ...n,
            position: {
              x: canvasPos.x - dragOffsetRef.current.x,
              y: canvasPos.y - dragOffsetRef.current.y,
            },
          }
        }),
      }))
    }
  }, [state.isPanning, state.draggingNodeId, state.viewport])

  const onMouseUp = useCallback(() => {
    setState(prev => ({
      ...prev,
      isPanning: false,
      draggingNodeId: null,
    }))
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setState(prev => {
      const newZoom = Math.max(0.2, Math.min(3, prev.viewport.zoom * delta))
      return {
        ...prev,
        viewport: { ...prev.viewport, zoom: newZoom },
      }
    })
  }, [])

  const onNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    const svg = svgRef.current
    if (!svg) return
    const node = state.nodes.find(n => n.id === nodeId)
    if (!node) return

    // Use clientX/clientY directly — same basis as onMouseMove
    const canvasPos = screenToCanvas(e.clientX, e.clientY, state.viewport)

    dragOffsetRef.current = {
      x: canvasPos.x - (node.position?.x ?? 0),
      y: canvasPos.y - (node.position?.y ?? 0),
    }

    setState(prev => ({
      ...prev,
      draggingNodeId: nodeId,
      selectedNodeIds: [nodeId],
      selectedEdgeId: null,
      connectingFrom: null,
    }))
  }, [state.nodes, state.viewport])

  const onNodeClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    setState(prev => ({
      ...prev,
      selectedNodeIds: [nodeId],
      selectedEdgeId: null,
      connectingFrom: null,
    }))
  }, [])

  const onAnchorMouseDown = useCallback((e: React.MouseEvent, nodeId: string, anchor: 'top' | 'right' | 'bottom' | 'left') => {
    e.stopPropagation()
    setState(prev => ({
      ...prev,
      connectingFrom: { nodeId, anchor },
    }))
  }, [])

  const onAnchorMouseUp = useCallback((e: React.MouseEvent, nodeId: string, anchor: 'top' | 'right' | 'bottom' | 'left') => {
    e.stopPropagation()
    setState(prev => {
      if (!prev.connectingFrom || prev.connectingFrom.nodeId === nodeId) return prev
      const newEdge: WorkflowEdge = {
        id: `${prev.connectingFrom.nodeId}-${nodeId}-${Date.now()}`,
        from: prev.connectingFrom.nodeId,
        to: nodeId,
      }
      if (prev.edges.some(e => e.from === newEdge.from && e.to === newEdge.to)) return { ...prev, connectingFrom: null }
      return {
        ...prev,
        edges: [...prev.edges, newEdge],
        connectingFrom: null,
      }
    })
  }, [])

  return {
    svgRef,
    state,
    setState,
    setNodes,
    setEdges,
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
    screenToCanvas,
    canvasToScreen,
    getAnchorPoint,
  }
}
